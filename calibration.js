"use strict";

// Equipment calibration screen. Runs the OT-2 App's calibration flows
// (calibration_flows.js) on a practice robot. Every setup step and question
// the OT-2 App asks is a pop-up; the operator jogs with the pad or the keys,
// watching a close-up of the pipette and its target.

const CAL_FLOW_TITLES = {
  deckCalibration: "Deck Calibration",
  tipLengthCalibration: "Tip Length Calibration",
  pipetteOffsetCalibration: "Pipette Offset Calibration",
  pipetteOffsetWithTipLength: "Tip Length and Pipette Offset Calibration",
  calibrationCheck: "Calibration Health Check"
};

const CAL_STEP_SIZES = [0.1, 1, 10];
const CAL_SETUP_STATES = ["sessionStarted", "labwareLoaded"];
const CAL_TIP_STATES = ["preparingPipette", "inspectingTip"];
// Progress milestones for each flow and the states that belong to them.
const CAL_MILESTONES = {
  deckCalibration: [["Deck setup", CAL_SETUP_STATES], ["Pick up tip", CAL_TIP_STATES], ["Z · slot 5", ["joggingToDeck"]], ["Slot 1", ["savingPointOne"]], ["Slot 3", ["savingPointTwo"]], ["Slot 7", ["savingPointThree"]], ["Done", ["calibrationComplete"]]],
  tipLengthCalibration: [["Deck setup", CAL_SETUP_STATES], ["Nozzle height", ["measuringNozzleOffset"]], ["Pick up tip", CAL_TIP_STATES], ["Tip height", ["measuringTipOffset"]], ["Done", ["calibrationComplete"]]],
  pipetteOffsetCalibration: [["Deck setup", CAL_SETUP_STATES], ["Pick up tip", CAL_TIP_STATES], ["Z · slot 5", ["joggingToDeck"]], ["Slot 1", ["savingPointOne"]], ["Done", ["calibrationComplete"]]],
  pipetteOffsetWithTipLength: [["Deck setup", CAL_SETUP_STATES], ["Nozzle height", ["measuringNozzleOffset"]], ["Pick up tip", CAL_TIP_STATES], ["Tip height", ["measuringTipOffset", "tipLengthComplete"]], ["Z · slot 5", ["joggingToDeck"]], ["Slot 1", ["savingPointOne"]], ["Done", ["calibrationComplete"]]],
  calibrationCheck: [["Deck setup", CAL_SETUP_STATES], ["Nozzle height", ["comparingNozzle"]], ["Pick up tip", CAL_TIP_STATES], ["Tip height", ["comparingTip"]], ["Z · slot 5", ["comparingHeight"]], ["Slot 1", ["comparingPointOne"]], ["Slot 3", ["comparingPointTwo"]], ["Slot 7", ["comparingPointThree"]], ["Return tip", ["returningTip"]], ["Results", ["resultsSummary"]]]
};

const CAL_POINT_SLOTS = { savingPointOne: 1, savingPointTwo: 3, savingPointThree: 7, comparingPointOne: 1, comparingPointTwo: 3, comparingPointThree: 7 };
const CAL_COMPARISON_LABELS = { comparingTip: "Tip height", comparingHeight: "Z · slot 5", comparingPointOne: "Slot 1 cross", comparingPointTwo: "Slot 3 cross", comparingPointThree: "Slot 7 cross" };
const CAL_SURFACE_COLORS = { deck: "#2c2331", "tip rack": "#3a2f41", tip: "#6f5a7c", "trash bin": "#120d15", "Calibration Block": "#9a929f" };

const calUI = {
  robot: new PracticeRobot({ left: "p20_multi_gen2", right: null }),
  session: null,
  stepSize: 1,
  display: null,
  promptedEntry: -1,
  crashed: false,
  exitedFrom: "",
  showOffsets: false,
  actions: [],
  dirty: true,
  frame: 0,
  lastTime: 0
};

function calNotice(message, isError = false) {
  const notice = $("#cal-notice");
  notice.hidden = !message;
  notice.classList.toggle("error", Boolean(isError));
  notice.textContent = message || "";
}

function calMountName(mount) { return mount === "left" ? "Left" : "Right"; }
function calTime(iso) { return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); }
function calSigned(value) { return `${value >= 0 ? "+" : "−"}${Math.abs(value).toFixed(2)}`; }
function calStepName(step) { const words = step.replace(/([A-Z])/g, " $1").toLowerCase(); return words[0].toUpperCase() + words.slice(1); }

function showCalibration() {
  renderCalPanel();
  renderCalStep();
  calUI.dirty = true;
  if (!calUI.frame) calUI.frame = requestAnimationFrame(calAnimate);
}

// ------------------------------------------------------------ status panel

function renderCalPanel() {
  const robot = calUI.robot;
  const cal = robot.calibration;
  const busy = Boolean(calUI.session);
  for (const mount of ["left", "right"]) {
    const select = $(`#cal-${mount}-pipette`);
    select.innerHTML = `<option value="">None</option>` + Object.entries(CAL_PIPETTES).map(([name, p]) => `<option value="${name}">${escapeHtml(p.label)}</option>`).join("");
    select.value = robot.pipettes[mount] || "";
    select.disabled = busy;
  }
  const button = (label, type, mount) => {
    const blocker = robot.readiness(type, mount);
    return `<button type="button" class="secondary-button" data-cal="${type}"${mount ? ` data-mount="${mount}"` : ""}${busy || blocker ? " disabled" : ""}>${label}</button>`;
  };
  const row = (title, detail, tone, action) => `<div class="cal-row ${tone}"><div><strong>${title}</strong><small>${escapeHtml(detail)}</small></div>${action}</div>`;
  const rows = [];
  const deck = cal.deck;
  rows.push(row("Deck", deck ? `${deck.bad ? "Recalibration recommended" : "Calibrated"} · ${calTime(deck.at)}` : "Not calibrated · start here",
    !deck ? "missing" : deck.bad ? "bad" : "ok", button(deck ? "Recalibrate" : "Calibrate", "deckCalibration")));
  for (const mount of robot.attachedMounts()) {
    const pipette = CAL_PIPETTES[robot.pipettes[mount]];
    const tip = cal.tipLength[mount];
    const offset = cal.pipetteOffset[mount];
    rows.push(`<div class="cal-mount"><b>${calMountName(mount)}</b> ${escapeHtml(pipette.label)}</div>`);
    rows.push(row("Tip length", tip ? `${tip.value.toFixed(2)} mm${tip.bad ? " · recalibration recommended" : ""} · ${calTime(tip.at)}` : "Not calibrated",
      !tip ? "missing" : tip.bad ? "bad" : "ok", button(tip ? "Recalibrate" : "Calibrate", "tipLengthCalibration", mount)));
    const offsetBlocker = robot.readiness("pipetteOffsetCalibration", mount);
    const offsetDetail = offset
      ? `X ${calSigned(offset.offset.x)} · Y ${calSigned(offset.offset.y)} · Z ${calSigned(offset.offset.z)}${offset.bad ? " · recalibration recommended" : ""}`
      : offsetBlocker || (tip ? "Not calibrated" : "Not calibrated · measures tip length first");
    rows.push(row("Pipette offset", offsetDetail, !offset ? "missing" : offset.bad ? "bad" : "ok", button(offset ? "Recalibrate" : "Calibrate", "pipetteOffsetCalibration", mount)));
  }
  if (!robot.attachedMounts().length) rows.push(`<p class="cal-empty-note">Attach a pipette to calibrate.</p>`);
  const health = cal.health;
  const healthPassed = health && calHealthPassed(health);
  const healthBlocker = robot.readiness("calibrationCheck");
  rows.push(row("Calibration Health Check", health ? `${healthPassed ? "Passed" : "Found calibrations to redo"} · ${calTime(health.at)}` : healthBlocker || "Ready",
    health ? (healthPassed ? "ok" : "bad") : healthBlocker ? "missing" : "", button("Check health", "calibrationCheck")));
  $("#cal-status").innerHTML = rows.join("");
  $("#cal-new-robot").disabled = busy;
}

function calHealthPassed(results) {
  return Object.values(results.comparisonsByPipette).every((map) => Object.values(map).every((entry) => entry.status !== "OUTSIDE_THRESHOLD"));
}

// ------------------------------------------------------------ running a flow

async function startCalibration(type, mount) {
  if (calUI.session) return;
  const robot = calUI.robot;
  const blocker = robot.readiness(type, mount);
  if (blocker) { calNotice(blocker, true); return; }
  const intro = calIntro(type, mount);
  const actions = intro.askBlock
    ? [{ label: "Cancel", value: "cancel" }, { label: "Use trash bin", value: "trash" }, { label: "Use Calibration Block", value: "block", kind: "primary" }]
    : [{ label: "Cancel", value: "cancel" }, { label: "Get started", value: "start", kind: "primary" }];
  const choice = await showPrompt({ eyebrow: `Practice robot · ${intro.subject}`, title: intro.title, body: intro.body, actions, cancel: "cancel" });
  if (choice === "cancel" || !choice) return;
  try {
    calUI.session = robot.createSession(type, { mount, hasCalibrationBlock: choice === "block" });
  } catch (error) {
    calNotice(error.message, true);
    return;
  }
  calUI.display = { ...calUI.session.nozzle };
  calUI.promptedEntry = -1;
  calUI.crashed = false;
  calNotice("");
  renderCalPanel();
  await calSend({ command: CAL_CMD.loadLabware });
}

function calIntro(type, mount) {
  const robot = calUI.robot;
  const cal = robot.calibration;
  const warning = (text) => `<p class="prompt-warning">${text}</p>`;
  const blockQuestion = `<p class="prompt-question"><strong>Do you have a Calibration Block?</strong> Without one, the flat surface of the fixed trash bin is used instead.</p>`;
  if (type === "deckCalibration") {
    const deckMount = robot.deckCalibrationMount();
    const pipette = CAL_PIPETTES[robot.pipettes[deckMount]];
    const offsets = ["left", "right"].some((m) => cal.pipetteOffset[m]);
    return {
      title: "Deck Calibration", subject: `${pipette.label} · ${deckMount} mount`, askBlock: false,
      body: `<p>Deck calibration ensures positional accuracy so that your robot moves as expected. It will accurately establish the OT-2’s deck orientation relative to the gantry.</p>
        <p>You will use the <strong>${escapeHtml(pipette.label)}</strong> on the ${deckMount} mount with one tip from an ${escapeHtml(CAL_TIPRACKS[pipette.tipRack].label)} in slot 8, then jog it to the deck in slot 5 and the crosses in slots 1, 3, and 7.</p>`
        + (offsets ? warning("Recalibrating the deck clears pipette offset data. You will need to recalibrate each pipette’s offset afterward.") : "")
    };
  }
  if (type === "calibrationCheck") {
    const order = robot.checkOrder().map((m) => `${CAL_PIPETTES[robot.pipettes[m]].label} (${m})`).join(", then ");
    return {
      title: "Calibration Health Check", subject: "all pipettes", askBlock: true,
      body: `<p>Calibration Health Check diagnoses problems with Deck, Tip Length, and Pipette Offset Calibration.</p>
        <p>You will move the pipettes to various positions, which will be compared against your existing calibration data. If there is a large difference, you will be prompted to redo some or all of your calibrations.</p>
        <p>Order: ${escapeHtml(order)}.</p>${blockQuestion}`
    };
  }
  const pipette = CAL_PIPETTES[robot.pipettes[mount]];
  const subject = `${pipette.label} · ${mount} mount`;
  if (type === "tipLengthCalibration") {
    return {
      title: "Tip Length Calibration", subject, askBlock: true,
      body: `<p>Tip length calibration measures the distance between the bottom of the tip and the pipette’s nozzle.</p>`
        + (cal.pipetteOffset[mount] ? warning("Recalibrating tip length will clear pipette offset data.") : "") + blockQuestion
    };
  }
  const withTipLength = !cal.tipLength[mount];
  return {
    title: withTipLength ? "Tip Length and Pipette Offset Calibration" : "Pipette Offset Calibration", subject, askBlock: withTipLength,
    body: `<p>Calibrating pipette offset measures a pipette’s position relative to the pipette mount and the deck.</p>`
      + (withTipLength ? `<p>You don’t have a tip length saved with this pipette yet. You will need to calibrate tip length before calibrating your pipette offset.</p>${blockQuestion}` : "")
  };
}

async function calSend(...commands) {
  const session = calUI.session;
  if (!session) return;
  try {
    for (const { command, data } of commands) {
      if (command === CAL_CMD.exit) calUI.exitedFrom = session.currentStep;
      session.execute(command, data);
    }
  } catch (error) {
    calNotice(error.message, true);
  }
  if (session.currentStep === "sessionExited") { calFinish(session); return; }
  calUI.dirty = true;
  renderCalStep();
  const depth = session.crashDepth();
  if (depth < 0.5) calUI.crashed = false;
  if (depth > CAL_CRASH_MM && !calUI.crashed) {
    calUI.crashed = true;
    await calCrashPrompt(session, depth);
  }
  if (calUI.session === session) await calAfterStep();
}

// Pop-ups the OT-2 App shows when a flow enters these states.
const CAL_STATE_PROMPTS = {
  labwareLoaded: calDeckSetupPrompt,
  inspectingTip: calTipPrompt,
  tipLengthComplete: calTipLengthCompletePrompt,
  calibrationComplete: calCompletePrompt,
  returningTip: calReturnTipPrompt,
  resultsSummary: calResultsPrompt
};

async function calAfterStep() {
  const session = calUI.session;
  if (!session || session.entry === calUI.promptedEntry) return;
  calUI.promptedEntry = session.entry;
  const prompt = CAL_STATE_PROMPTS[session.currentStep];
  if (prompt) await prompt(session);
}

function calFinish(session) {
  const cal = calUI.robot.calibration;
  const from = calUI.exitedFrom;
  const mount = calMountName(session.mount).toLowerCase();
  let message = `${CAL_FLOW_TITLES[session.flowKey]} exited before it finished; unfinished steps were not saved.`;
  if (from === "calibrationComplete" && session.sessionType === "deckCalibration") message = "Deck calibration saved. Pipette offsets were cleared; calibrate each pipette’s offset next.";
  else if (from === "calibrationComplete" && session.sessionType === "tipLengthCalibration") message = `Tip length saved for the ${mount} pipette. Its pipette offset was cleared; recalibrate it next.`;
  else if (from === "calibrationComplete") message = `Pipette offset${session.withTipLength ? " and tip length" : ""} saved for the ${mount} pipette.`;
  else if (from === "resultsSummary" && cal.health) message = calHealthPassed(cal.health) ? "Calibration Health Check passed." : "Calibration Health Check found calibrations to redo; they are flagged on the left.";
  calUI.session = null;
  calUI.display = null;
  calUI.dirty = true;
  calNotice(message, false);
  renderCalPanel();
  renderCalStep();
}

async function calConfirmExit() {
  const session = calUI.session;
  if (!session) return;
  const finished = ["calibrationComplete", "resultsSummary"].includes(session.currentStep);
  const choice = await showPrompt({
    eyebrow: CAL_FLOW_TITLES[session.flowKey],
    title: finished ? "Exit calibration?" : "Are you sure you want to exit?",
    body: finished ? "<p>Your calibration is saved. The pipette returns its tip before exiting.</p>" : "<p>Calibration progress will be lost. The pipette returns its tip to the tip rack before exiting.</p>",
    actions: [{ label: "Cancel", value: "cancel" }, { label: "Exit", value: "exit", kind: "danger" }],
    cancel: "cancel"
  });
  if (choice === "exit") await calSend({ command: CAL_CMD.exit });
}

// ------------------------------------------------------------ pop-ups

function calDeckMap(session) {
  const order = [10, 11, 12, 7, 8, 9, 4, 5, 6, 1, 2, 3];
  const block = session.usesBlock ? CAL_BLOCKS[session.blockKey].slot : null;
  return `<div class="work-deck prompt-deck">${order.map((slot) => {
    let item = { type: "empty", label: "Empty", detail: "" };
    if (slot === CAL_TIPRACK_SLOT) item = { type: "tips", label: "Tip rack", detail: session.tipRack.label.replace("Opentrons OT-2 96 ", "") };
    else if (slot === block) item = { type: "block", label: "Calibration Block", detail: "" };
    else if (slot === 12) item = { type: "trash", label: "Fixed trash", detail: session.usesBlock ? "" : "Reference surface" };
    return `<div class="deck-slot ${item.type}"><b>${slot}</b><div><span>${escapeHtml(item.label)}</span><small>${escapeHtml(item.detail)}</small></div></div>`;
  }).join("")}</div>`;
}

async function calDeckSetupPrompt(session) {
  const second = session.ranks && session.rank === "second";
  const checklist = [
    { label: "Clear all other deck slots", detail: "Remove every labware and module from the deck except the items below." },
    { label: `Place a full ${session.tipRack.label} into slot 8`, detail: `For the ${session.pipette.label} on the ${session.mount} mount${second ? "; swap out the first pipette’s rack if it takes different tips" : ""}.` }
  ];
  if (session.usesBlock) {
    const block = CAL_BLOCKS[session.blockKey];
    const tallLeft = block.heights[0] > block.heights[1];
    checklist.push({ label: `Place the Calibration Block into slot ${block.slot}`, detail: `Tall side to the ${tallLeft ? "left" : "right"}, short side to the ${tallLeft ? "right" : "left"}.` });
  } else if (session.sessionType !== "deckCalibration" && !(session.sessionType === "pipetteOffsetCalibration" && !session.withTipLength)) {
    checklist.push({ label: "Leave the fixed trash bin’s flat surface clear", detail: "Without a Calibration Block, heights are measured on the trash bin." });
  }
  const choice = await showPrompt({
    eyebrow: `${CAL_FLOW_TITLES[session.flowKey]}${session.ranks ? ` · pipette ${session.rankIndex + 1} of ${session.ranks.length}` : ""}`,
    title: "Prepare the deck",
    body: calDeckMap(session),
    checklist,
    actions: [{ label: "Exit", value: "exit" }, { label: "Confirm placement", value: "confirm", kind: "primary", needsChecklist: true }]
  });
  if (choice === "exit") { await calConfirmExit(); return; }
  if (choice !== "confirm") return;
  const move = session.canExecute(CAL_CMD.moveToTipRack) ? CAL_CMD.moveToTipRack : CAL_CMD.moveToReferencePoint;
  await calSend({ command: move });
}

function calTipMoveCommand(session) {
  return session.canExecute(CAL_CMD.moveToDeck) ? CAL_CMD.moveToDeck : CAL_CMD.moveToReferencePoint;
}

async function calTipPrompt(session) {
  const toDeck = calTipMoveCommand(session) === CAL_CMD.moveToDeck;
  const destination = toDeck ? "slot 5" : session.usesBlock ? "block" : "trash bin";
  const miss = calUI.showOffsets && session.tip && session.tip.miss ? `<p class="prompt-aid">Training aid: the tip did not seat. ${escapeHtml(session.tip.miss)}</p>` : "";
  const choice = await showPrompt({
    eyebrow: CAL_FLOW_TITLES[session.flowKey],
    title: "Did pipette pick up tip successfully?",
    body: `<canvas class="prompt-canvas" aria-label="The pipette's front nozzle after pick-up"></canvas><p>Look at the ${session.pipette.channels > 1 ? "front nozzle (closest to you)" : "nozzle"}: the tip should be on straight and pressed fully onto it.</p>${miss}`,
    actions: [{ label: "Try again", value: "retry" }, { label: `Yes, move to ${destination}`, value: "yes", kind: "primary" }],
    onOpen: (dialog) => drawTipInspection(dialog.querySelector(".prompt-canvas"), session)
  });
  if (choice === "retry") await calSend({ command: CAL_CMD.invalidateTip });
  else if (choice === "yes") await calSend({ command: calTipMoveCommand(session) });
}

async function calTipLengthCompletePrompt(session) {
  await showPrompt({
    eyebrow: CAL_FLOW_TITLES[session.flowKey],
    title: "Tip length calibration complete",
    body: `<p>Saved tip length: <strong>${session.saved.tipLength.toFixed(2)} mm</strong>.</p>${session.usesBlock ? "<p>You can remove the Calibration Block from the deck now.</p>" : ""}<p>Next, pipette offset: the pipette moves to slot 5.</p>`,
    actions: [{ label: "Continue to pipette offset", value: "go", kind: "primary" }]
  });
  if (calUI.session === session) await calSend({ command: CAL_CMD.moveToDeck });
}

async function calCompletePrompt(session) {
  const cal = calUI.robot.calibration;
  let body = "";
  if (session.sessionType === "deckCalibration") {
    body = `<p>The deck’s position relative to the gantry is saved. Pipette offset calibrations were cleared, so calibrate each pipette’s offset next.</p>`;
    if (calUI.showOffsets) body += `<p class="prompt-aid">Training aid: measured deck offset X ${calSigned(cal.deck.offset.x)} · Y ${calSigned(cal.deck.offset.y)} mm.</p>`;
  } else if (session.sessionType === "tipLengthCalibration") {
    body = `<p>Saved tip length: <strong>${cal.tipLength[session.mount].value.toFixed(2)} mm</strong>.</p>${session.usesBlock ? "<p>You can remove the Calibration Block from the deck now.</p>" : ""}<p>This pipette’s offset was cleared; recalibrate it next.</p>`;
  } else {
    const offset = cal.pipetteOffset[session.mount].offset;
    body = `<p>Saved pipette offset: <strong>X ${calSigned(offset.x)} · Y ${calSigned(offset.y)} · Z ${calSigned(offset.z)} mm</strong>.</p>`;
  }
  await showPrompt({
    eyebrow: CAL_FLOW_TITLES[session.flowKey],
    title: `${CAL_FLOW_TITLES[session.flowKey]} complete`,
    body,
    actions: [{ label: "Return tip and exit", value: "exit", kind: "primary" }]
  });
  if (calUI.session !== session) return;
  const commands = session.canExecute(CAL_CMD.moveToTipRack) ? [{ command: CAL_CMD.moveToTipRack }] : [];
  await calSend(...commands, { command: CAL_CMD.exit });
}

async function calReturnTipPrompt(session) {
  const last = !session.checkingBothPipettes || session.rank === "second";
  const next = last ? null : session.ranks[1];
  await showPrompt({
    eyebrow: `${CAL_FLOW_TITLES.calibrationCheck} · pipette ${session.rankIndex + 1} of ${session.ranks.length}`,
    title: "Return tip",
    body: `<p>The pipette returns its tip to A1 of the tip rack.</p>${next ? `<p>Next: the ${escapeHtml(CAL_PIPETTES[calUI.robot.pipettes[next]].label)} on the ${next} mount.</p>` : ""}`,
    actions: [{ label: last ? "Return tip and see calibration health check results" : "Return tip and continue to next pipette", value: "go", kind: "primary" }]
  });
  if (calUI.session !== session) return;
  await calSend({ command: CAL_CMD.returnTip }, { command: last ? CAL_CMD.transition : CAL_CMD.switchPipette });
}

function calResultsHtml(results) {
  const redo = new Set();
  const sections = results.pipettes.map((pipette) => {
    const label = CAL_PIPETTES[pipette.name].label;
    const map = results.comparisonsByPipette[pipette.rank];
    const rows = [["tipLength", "Tip length"], ["pipetteOffset", "Pipette offset"], ["deck", "Deck"]].filter(([key]) => map[key]).map(([key, name]) => {
      const entry = map[key];
      const failed = entry.status === "OUTSIDE_THRESHOLD";
      if (failed) redo.add(key === "deck" ? "Recalibrate the deck, then each pipette’s offset." : key === "tipLength" ? `Recalibrate tip length, then pipette offset, for the ${pipette.mount} pipette.` : `Recalibrate pipette offset for the ${pipette.mount} pipette.`);
      const checks = Object.entries(entry).filter(([k]) => k !== "status").map(([k, info]) => {
        const [dx, dy, dz] = info.differenceVector;
        const [tx, ty, tz] = info.thresholdVector;
        const moved = tz === 0 ? Math.hypot(dx, dy) : Math.abs(dz);
        return `<li class="${info.exceedsThreshold ? "fail" : ""}">${CAL_COMPARISON_LABELS[k]}: ${moved.toFixed(2)} mm (limit ${Math.hypot(tx, ty, tz).toFixed(2)})</li>`;
      }).join("");
      return `<tr><td>${name}</td><td><span class="result-chip ${failed ? "fail" : "pass"}">${failed ? "Recalibrate" : "Good"}</span></td><td><ul>${checks}</ul></td></tr>`;
    }).join("");
    return `<h3>${calMountName(pipette.mount)} · ${escapeHtml(label)}</h3><table class="results-table"><tbody>${rows}</tbody></table>`;
  }).join("");
  const advice = redo.size ? `<p class="prompt-warning">${[...redo].map(escapeHtml).join("<br>")}</p>` : "<p>Every calibration is within Opentrons’ tolerances.</p>";
  return sections + advice;
}

async function calResultsPrompt(session) {
  await showPrompt({
    eyebrow: "Calibration Health Check",
    title: calHealthPassed(session.results) ? "Calibration is good" : "Some calibrations need to be redone",
    body: `<p>How far you jogged from where the robot’s calibration placed the pipette:</p>${calResultsHtml(session.results)}`,
    actions: [{ label: "Finish", value: "done", kind: "primary" }]
  });
  if (calUI.session === session) await calSend({ command: CAL_CMD.exit });
}

async function calCrashPrompt(session, depth = 0) {
  const canRestart = session.canExecute(CAL_CMD.invalidateLastAction);
  const physical = session.physical();
  const part = physical.tipEnd ? "tip" : "nozzle";
  const body = (depth ? `<p>The ${part} pressed ${depth.toFixed(1)} mm into the ${escapeHtml(physical.surface.name)}. On a robot this bends the tip or pushes labware out of place.</p>` : "")
    + (canRestart
      ? "<p>Starting over will cancel your calibration progress. If you bent a tip, be sure to replace it with an undamaged tip in position A1 of the tip rack before resuming calibration.</p>"
      : "<p>Jog the pipette back up to continue.</p>");
  const actions = [{ label: depth ? "Jog back up" : "Cancel", value: "cancel" }];
  if (canRestart) actions.push({ label: "Start over", value: "restart", kind: "danger" });
  const choice = await showPrompt({ eyebrow: CAL_FLOW_TITLES[session.flowKey], title: depth ? "The pipette hit the surface" : "Jog too far or bend a tip?", body, actions, cancel: "cancel", tone: depth ? "danger" : "" });
  if (choice === "restart" && calUI.session === session) {
    calUI.crashed = false;
    await calSend({ command: CAL_CMD.invalidateLastAction });
  }
}

// ------------------------------------------------------------ step panel

// Instructions and buttons for the current state, in the OT-2 App's wording and command order.
function calStepView(session) {
  const step = session.currentStep;
  const block = session.usesBlock;
  const blockSlot = block ? CAL_BLOCKS[session.blockKey].slot : null;
  const surface = block ? "block" : "trash bin";
  const onSurface = block ? `the block in slot ${blockSlot}` : "the flat surface of the trash bin";
  const command = (...names) => names.map((name) => ({ command: name }));
  const slot = CAL_POINT_SLOTS[step];
  const views = {
    labwareLoaded: { kicker: "Deck setup", title: "Prepare the deck", body: "Clear the deck and load the tip rack" + (block ? " and Calibration Block" : "") + ".", actions: [{ label: "Show deck setup", run: calDeckSetupPrompt, kind: "primary" }] },
    preparingPipette: {
      kicker: "Pick up tip", title: "Position pipette over A1", jog: true,
      body: `Jog the pipette until ${session.pipette.channels > 1 ? "the nozzle closest to you (channel H)" : "the nozzle"} is centered above the A1 position and level with the top of the tip. When the pipette is properly aligned, pick up the tip.`,
      actions: [{ label: "Pick up tip", commands: command(CAL_CMD.pickUpTip), kind: "primary" }]
    },
    inspectingTip: { kicker: "Pick up tip", title: "Did pipette pick up tip successfully?", body: "Check the tip before moving on.", actions: [{ label: "Check the tip", run: calTipPrompt, kind: "primary" }] },
    measuringNozzleOffset: {
      kicker: "Nozzle height", title: `Calibrate z-axis on ${surface}`, jog: true,
      body: `Jog the pipette until the nozzle is barely touching (less than 0.1 mm) ${onSurface}.`,
      actions: [{ label: "Save nozzle z-axis", commands: command(CAL_CMD.saveOffset, CAL_CMD.moveToTipRack), kind: "primary" }]
    },
    comparingNozzle: {
      kicker: "Nozzle height", title: `Check z-axis on ${surface}`, jog: true,
      body: `Jog the pipette until the nozzle is barely touching (less than 0.1 mm) ${onSurface}.`,
      actions: [{ label: "Check z-axis", commands: command(CAL_CMD.moveToTipRack), kind: "primary" }]
    },
    measuringTipOffset: {
      kicker: "Tip height", title: `Calibrate tip on ${surface}`, jog: true,
      body: `Jog the pipette until the tip is barely touching (less than 0.1 mm) ${onSurface}.`,
      actions: [{ label: "Save tip length", commands: session.withTipLength ? command(CAL_CMD.saveOffset) : command(CAL_CMD.saveOffset, CAL_CMD.moveToTipRack), kind: "primary" }]
    },
    comparingTip: {
      kicker: "Tip height", title: `Check tip on ${surface}`, jog: true,
      body: `Jog the pipette until the tip is barely touching (less than 0.1 mm) ${onSurface}.`,
      actions: [{ label: "Check tip length", commands: command(CAL_CMD.comparePoint, CAL_CMD.moveToDeck), kind: "primary" }]
    },
    tipLengthComplete: { kicker: "Tip height", title: "Tip length calibration complete", body: "Continue to pipette offset calibration.", actions: [{ label: "Continue", run: calTipLengthCompletePrompt, kind: "primary" }] },
    joggingToDeck: {
      kicker: "Z · slot 5", title: "Calibrate z-axis in slot 5", jog: true,
      body: "Jog the pipette until the tip is barely touching (less than 0.1 mm) the deck in slot 5. If the pipette is over the embossed 5, on the ridge of the slot, or hard to see, switch to the x- and y-axis controls to move the pipette across the deck.",
      actions: [{ label: "Save z-axis and move to slot 1", commands: command(CAL_CMD.saveOffset, CAL_CMD.moveToPointOne), kind: "primary" }]
    },
    comparingHeight: {
      kicker: "Z · slot 5", title: "Check z-axis on slot 5", jog: true,
      body: "Jog the pipette until the tip is barely touching (less than 0.1 mm) the deck in slot 5.",
      actions: [{ label: "Check z-axis and move to slot 1", commands: command(CAL_CMD.comparePoint, CAL_CMD.moveToPointOne), kind: "primary" }]
    },
    calibrationComplete: { kicker: "Done", title: `${CAL_FLOW_TITLES[session.flowKey]} complete`, body: "Return the tip and exit.", actions: [{ label: "Finish", run: calCompletePrompt, kind: "primary" }] },
    returningTip: { kicker: "Return tip", title: "Return tip", body: "Return the tip to the tip rack.", actions: [{ label: "Return tip", run: calReturnTipPrompt, kind: "primary" }] },
    resultsSummary: { kicker: "Results", title: "Calibration Health Check results", body: "Review the results.", actions: [{ label: "Show results", run: calResultsPrompt, kind: "primary" }] }
  };
  if (slot) {
    const check = step.startsWith("comparing");
    const save = check ? CAL_CMD.comparePoint : CAL_CMD.saveOffset;
    let next = [];
    let label = check ? "Check x- and y-axis" : "Save calibration";
    if (step.endsWith("One") && session.canExecute(CAL_CMD.moveToPointTwo) && !(check && session.checkingBothPipettes && session.rank === "first")) { next = [CAL_CMD.moveToPointTwo]; label += " and move to slot 3"; }
    else if (step.endsWith("Two")) { next = [CAL_CMD.moveToPointThree]; label += " and move to slot 7"; }
    else if (step.endsWith("Three") || check) next = [CAL_CMD.moveToTipRack];
    return {
      kicker: `Slot ${slot}`, title: `${check ? "Check" : "Calibrate"} x- and y-axis in slot ${slot}`, jog: true,
      body: `Jog the pipette until the tip is precisely centered above the cross in slot ${slot}.`,
      actions: [{ label, commands: command(save, ...next), kind: "primary" }]
    };
  }
  return views[step] || { kicker: "", title: calStepName(step), body: "", actions: [] };
}

function renderCalStep() {
  const session = calUI.session;
  $("#cal-empty").hidden = Boolean(session);
  $("#cal-exit").hidden = !session;
  document.querySelectorAll(".jog-pad button[data-jog]").forEach((button) => { button.disabled = !session || !session.canExecute(CAL_CMD.jog); });
  if (!session) {
    $("#cal-flow-kicker").textContent = "Practice mode · simulated OT-2";
    $("#cal-flow-title").textContent = "Choose a calibration";
    $("#cal-step-chip").textContent = "Idle";
    $("#cal-progress").innerHTML = "";
    $("#cal-step-kicker").textContent = "—";
    $("#cal-step-title").textContent = "No calibration running";
    $("#cal-step-body").textContent = "Start with deck calibration on a new robot. Each flow asks you to set up the deck in a pop-up, then you jog the pipette to each target and save.";
    $("#cal-step-actions").innerHTML = "";
    $("#cal-crash").hidden = true;
    $("#cal-target-label").textContent = "—";
    return;
  }
  const view = calStepView(session);
  const pipette = `${session.pipette.label} · ${session.mount} mount`;
  $("#cal-flow-kicker").textContent = session.ranks ? `Practice robot · pipette ${session.rankIndex + 1} of ${session.ranks.length} · ${pipette}` : `Practice robot · ${pipette}`;
  $("#cal-flow-title").textContent = CAL_FLOW_TITLES[session.flowKey];
  $("#cal-step-chip").textContent = calStepName(session.currentStep);
  const milestones = CAL_MILESTONES[session.flowKey];
  const current = milestones.findIndex(([, states]) => states.includes(session.currentStep));
  $("#cal-progress").innerHTML = milestones.map(([label], i) => `<li class="${i < current ? "done" : i === current ? "active" : ""}">${escapeHtml(label)}</li>`).join("");
  $("#cal-step-kicker").textContent = view.kicker;
  $("#cal-step-title").textContent = view.title;
  $("#cal-step-body").textContent = view.body;
  calUI.actions = view.actions;
  $("#cal-step-actions").innerHTML = view.actions.map((action, i) => `<button type="button" class="${action.kind === "primary" ? "primary-button" : "secondary-button"}" data-cal-action="${i}">${escapeHtml(action.label)}</button>`).join("");
  $("#cal-crash").hidden = !view.jog || !session.canExecute(CAL_CMD.invalidateLastAction);
  const target = session.target();
  $("#cal-target-label").textContent = target ? target.label : "—";
}

function calJog(axis, direction) {
  const session = calUI.session;
  if (!session || !session.canExecute(CAL_CMD.jog)) return;
  const vector = [0, 0, 0];
  vector["xyz".indexOf(axis)] = direction * calUI.stepSize;
  calSend({ command: CAL_CMD.jog, data: { vector } });
}

function setCalStepSize(size) {
  calUI.stepSize = size;
  document.querySelectorAll(".jog-steps button").forEach((button) => button.classList.toggle("active", Number(button.dataset.step) === size));
}

// ------------------------------------------------------------ rendering

function calAnimate(time) {
  if ($("#cal-screen").hidden) { calUI.frame = 0; calUI.lastTime = 0; return; }
  const dt = calUI.lastTime ? Math.min(0.1, (time - calUI.lastTime) / 1000) : 0;
  calUI.lastTime = time;
  const session = calUI.session;
  let moving = false;
  if (session && calUI.display) {
    const k = 1 - Math.exp(-dt * 9);
    for (const axis of ["x", "y", "z"]) {
      const delta = session.nozzle[axis] - calUI.display[axis];
      if (Math.abs(delta) > 0.005) { calUI.display[axis] += delta * k; moving = true; } else calUI.display[axis] = session.nozzle[axis];
    }
  }
  if (moving || calUI.dirty) {
    try {
      drawCalDeck($("#cal-deck-canvas"), session, calUI.display);
      drawCalCloseup($("#cal-closeup-canvas"), session, calUI.display);
      const point = session && calUI.display ? session.criticalPoint(calUI.display) : null;
      $("#cal-pos-x").textContent = point ? point.x.toFixed(1) : "—";
      $("#cal-pos-y").textContent = point ? point.y.toFixed(1) : "—";
      $("#cal-pos-z").textContent = point ? point.z.toFixed(1) : "—";
    } catch (error) {
      calNotice(`Renderer error: ${error.message}`, true);
      console.error(error);
    }
    calUI.dirty = false;
  }
  calUI.frame = requestAnimationFrame(calAnimate);
}

function drawCalDeck(canvas, session, nozzle) {
  const ctx = canvas.getContext("2d");
  drawTopView(canvas, ctx, null, 0);
  const rect = canvas.getBoundingClientRect();
  const pad = 16;
  const spanX = DECK_VIEW.maxX - DECK_VIEW.minX, spanY = DECK_VIEW.maxY - DECK_VIEW.minY;
  const s = Math.min((rect.width - pad * 2) / spanX, (rect.height - pad * 2) / spanY);
  const ox = (rect.width - spanX * s) / 2, oy = (rect.height - spanY * s) / 2;
  const X = (x) => ox + (x - DECK_VIEW.minX) * s;
  const Y = (y) => oy + (DECK_VIEW.maxY - y) * s;
  const target = session ? session.target() : null;

  for (const [id, point] of Object.entries(CAL_POINTS)) {
    const active = target && target.point === id;
    ctx.strokeStyle = active ? SIM_COLORS.path : "#a99bae";
    ctx.lineWidth = active ? 2 : 1.2;
    ctx.beginPath();
    ctx.moveTo(X(point.x - 5), Y(point.y)); ctx.lineTo(X(point.x + 5), Y(point.y));
    ctx.moveTo(X(point.x), Y(point.y - 5)); ctx.lineTo(X(point.x), Y(point.y + 5));
    ctx.stroke();
  }
  if (!session) return;

  if (session.labwareOnDeck) {
    const [sx, sy] = CAL_SLOT_ORIGINS[CAL_TIPRACK_SLOT];
    simRoundedRect(ctx, X(sx), Y(sy + 85.48), 127.76 * s, 85.48 * s, 5);
    ctx.fillStyle = SIM_COLORS.tipRack; ctx.fill(); ctx.strokeStyle = SIM_COLORS.plateEdge; ctx.lineWidth = 1; ctx.stroke();
    const a1 = calTipRackA1();
    for (let col = 0; col < 12; col += 1) {
      for (let row = 0; row < 8; row += 1) {
        const empty = col === 0 && row === 0 && session.tip && session.tip.attached;
        ctx.beginPath();
        ctx.arc(X(a1.x + col * CAL_CHANNEL_PITCH), Y(a1.y - row * CAL_CHANNEL_PITCH), Math.max(1, session.tipRack.diameter / 2 * s), 0, Math.PI * 2);
        ctx.fillStyle = empty ? SIM_COLORS.tipUsed : SIM_COLORS.tip;
        ctx.fill();
      }
    }
  }
  if (session.blockOnDeck) {
    const block = CAL_BLOCKS[session.blockKey];
    const [bx, by] = CAL_SLOT_ORIGINS[block.slot];
    const half = CAL_BLOCK_SIZE.x / 2;
    block.heights.forEach((height, i) => {
      ctx.fillStyle = height > 50 ? "#b3abb8" : "#7d7483";
      ctx.fillRect(X(bx + i * half), Y(by + CAL_BLOCK_SIZE.y), half * s, CAL_BLOCK_SIZE.y * s);
    });
    ctx.strokeStyle = "#e0d8e4"; ctx.lineWidth = 1; ctx.strokeRect(X(bx), Y(by + CAL_BLOCK_SIZE.y), CAL_BLOCK_SIZE.x * s, CAL_BLOCK_SIZE.y * s);
  }
  if (target) {
    ctx.save(); ctx.setLineDash([4, 4]); ctx.strokeStyle = SIM_COLORS.path; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(X(target.x), Y(target.y), 11, 0, Math.PI * 2); ctx.stroke(); ctx.restore();
  }
  if (!nozzle) return;
  const channels = session.channels(nozzle);
  if (channels.length > 1) {
    ctx.strokeStyle = SIM_COLORS.path; ctx.lineWidth = 2; ctx.beginPath();
    ctx.moveTo(X(channels[0].x), Y(channels[0].y)); ctx.lineTo(X(channels[channels.length - 1].x), Y(channels[channels.length - 1].y)); ctx.stroke();
  }
  channels.forEach((channel, i) => {
    const front = i === channels.length - 1;
    ctx.beginPath(); ctx.arc(X(channel.x), Y(channel.y), front ? 4.5 : 3, 0, Math.PI * 2);
    ctx.fillStyle = front && session.tip && session.tip.attached ? SIM_COLORS.path : "rgba(240,0,220,.25)";
    ctx.fill(); ctx.strokeStyle = SIM_COLORS.path; ctx.lineWidth = 1.5; ctx.stroke();
  });
}

function drawCalCloseup(canvas, session, nozzle) {
  const ctx = canvas.getContext("2d");
  const size = fitCanvas(canvas, ctx);
  ctx.clearRect(0, 0, size.width, size.height);
  if (!session || !nozzle) {
    $("#cal-aid").hidden = true;
    ctx.fillStyle = "#a68fad"; ctx.font = "600 12px system-ui"; ctx.textAlign = "center";
    ctx.fillText("Start a calibration to see the pipette up close.", size.width / 2, size.height / 2);
    ctx.textAlign = "left";
    return;
  }
  const physical = session.physical(nozzle);
  const target = session.target();
  const half = size.width / 2;
  drawCalTopZoom(ctx, { x: 0, y: 0, w: half, h: size.height }, session, physical, target);
  drawCalSideZoom(ctx, { x: half, y: 0, w: half, h: size.height }, session, physical, target);
  ctx.strokeStyle = "rgba(195,117,214,.2)"; ctx.beginPath(); ctx.moveTo(half, 12); ctx.lineTo(half, size.height - 12); ctx.stroke();
  const aid = $("#cal-aid");
  aid.hidden = !(calUI.showOffsets && target);
  if (!aid.hidden) {
    const lowest = physical.lowest;
    const parts = [];
    if (target.kind === "cross") parts.push(`Off the cross X ${calSigned(lowest.x - target.x)} · Y ${calSigned(lowest.y - target.y)} mm`);
    if (target.kind === "tip" && !physical.tipEnd) parts.push(`Nozzle off A1 X ${calSigned(physical.nozzle.x - target.x)} · Y ${calSigned(physical.nozzle.y - target.y)} · Z ${calSigned(physical.nozzle.z - target.z)} mm`);
    else parts.push(`Gap to ${physical.surface.name} ${calSigned(physical.gap)} mm`);
    aid.textContent = `Training aid · ${parts.join(" · ")}`;
  }
}

function calPanelTitle(ctx, box, text) {
  ctx.fillStyle = "#a68aab"; ctx.font = "700 9px system-ui"; ctx.textAlign = "left";
  ctx.fillText(text, box.x + 12, box.y + 18);
}

// Arrow at the edge of a view pointing toward something outside it.
function calOffscreenArrow(ctx, from, toward, bounds, label) {
  const dx = toward.x - from.x, dy = toward.y - from.y;
  const scale = Math.min((bounds.w / 2 - 18) / Math.max(1e-6, Math.abs(dx)), (bounds.h / 2 - 18) / Math.max(1e-6, Math.abs(dy)));
  const x = from.x + dx * scale, y = from.y + dy * scale;
  const angle = Math.atan2(dy, dx);
  ctx.save();
  ctx.translate(x, y); ctx.rotate(angle);
  ctx.fillStyle = SIM_COLORS.path; ctx.beginPath(); ctx.moveTo(10, 0); ctx.lineTo(-6, -7); ctx.lineTo(-6, 7); ctx.closePath(); ctx.fill();
  ctx.restore();
  ctx.fillStyle = "#ffd6fb"; ctx.font = "600 10px system-ui"; ctx.textAlign = "center";
  ctx.fillText(label, Math.min(bounds.x + bounds.w - 44, Math.max(bounds.x + 44, x - Math.cos(angle) * 30)), Math.min(bounds.y + bounds.h - 6, Math.max(bounds.y + 12, y - Math.sin(angle) * 22)));
  ctx.textAlign = "left";
}

function drawCalTopZoom(ctx, box, session, physical, target) {
  const field = 5;
  const center = target && target.kind !== "surface" ? target : physical.lowest;
  const top = box.y + 28, avail = Math.min(box.w - 24, box.h - 46);
  const scale = avail / (2 * field);
  const view = { x: box.x + (box.w - avail) / 2, y: top, w: avail, h: avail };
  const cx = view.x + avail / 2, cy = view.y + avail / 2;
  const P = (x, y) => ({ x: cx + (x - center.x) * scale, y: cy - (y - center.y) * scale });
  calPanelTitle(ctx, box, `LOOKING DOWN · ${2 * field} mm FIELD`);
  ctx.save();
  simRoundedRect(ctx, view.x, view.y, view.w, view.h, 8); ctx.clip();
  const cells = 32, cell = 2 * field / cells;
  const deck = session.deckState();
  for (let i = 0; i < cells; i += 1) {
    for (let j = 0; j < cells; j += 1) {
      const x = center.x - field + (i + .5) * cell, y = center.y + field - (j + .5) * cell;
      const surface = calSurfaceAt(x, y, deck);
      ctx.fillStyle = CAL_SURFACE_COLORS[surface.name] || CAL_SURFACE_COLORS.deck;
      const p = P(x - cell / 2, y + cell / 2);
      ctx.fillRect(p.x, p.y, cell * scale + .6, cell * scale + .6);
    }
  }
  for (const point of Object.values(CAL_POINTS)) {
    if (Math.abs(point.x - center.x) > field + 6 || Math.abs(point.y - center.y) > field + 6) continue;
    const a = P(point.x - 6, point.y), b = P(point.x + 6, point.y), c = P(point.x, point.y - 6), d = P(point.x, point.y + 6);
    ctx.strokeStyle = "#efe8f1"; ctx.lineWidth = Math.max(1, .5 * scale);
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.moveTo(c.x, c.y); ctx.lineTo(d.x, d.y); ctx.stroke();
  }
  if (deck.tipRack) {
    const a1 = calTipRackA1();
    for (let col = 0; col < 12; col += 1) {
      for (let row = 0; row < 8; row += 1) {
        const wx = a1.x + col * CAL_CHANNEL_PITCH, wy = a1.y - row * CAL_CHANNEL_PITCH;
        if (Math.abs(wx - center.x) > field + 5 || Math.abs(wy - center.y) > field + 5) continue;
        if (col === 0 && row === 0 && deck.a1Empty) continue;
        const p = P(wx, wy);
        ctx.strokeStyle = SIM_COLORS.tip; ctx.lineWidth = Math.max(1, .35 * scale);
        ctx.beginPath(); ctx.arc(p.x, p.y, session.tipRack.diameter / 2 * scale, 0, Math.PI * 2); ctx.stroke();
      }
    }
  }
  const nozzleRadius = session.tipRack.diameter * .42 * scale;
  const n = P(physical.nozzle.x, physical.nozzle.y);
  const inView = Math.abs(physical.lowest.x - center.x) < field && Math.abs(physical.lowest.y - center.y) < field;
  if (inView) {
    ctx.strokeStyle = "#e8edef"; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(n.x, n.y, nozzleRadius, 0, Math.PI * 2); ctx.stroke();
    if (physical.tipEnd) {
      ctx.fillStyle = SIM_COLORS.path;
      ctx.beginPath(); ctx.arc(n.x, n.y, Math.max(2, session.tipRack.endDiameter / 2 * scale), 0, Math.PI * 2); ctx.fill();
    }
  }
  ctx.restore();
  if (!inView) {
    const distance = Math.hypot(physical.lowest.x - center.x, physical.lowest.y - center.y);
    calOffscreenArrow(ctx, { x: cx, y: cy }, n, view, `${physical.tipEnd ? "Tip" : "Nozzle"} ~${Math.round(distance)} mm`);
  }
  ctx.strokeStyle = "#5d3c66"; ctx.lineWidth = 1; simRoundedRect(ctx, view.x, view.y, view.w, view.h, 8); ctx.stroke();
  ctx.fillStyle = "#c9b7ce"; ctx.fillRect(view.x + 10, view.y + view.h - 12, scale, 2);
  ctx.font = "600 9px system-ui"; ctx.fillText("1 mm", view.x + 14 + scale, view.y + view.h - 8);
}

function drawCalSideZoom(ctx, box, session, physical, target) {
  const halfHeight = 4, halfWidth = 5;
  const lowest = physical.lowest;
  // Before pick-up the nozzle lines up with the tip tops; otherwise heights are above the surface below.
  const reference = target && target.kind === "tip" && !physical.tipEnd ? target.z : physical.surface.z;
  const midZ = reference + 1.5;
  const top = box.y + 28, availH = box.h - 46, availW = box.w - 48;
  const scale = Math.min(availW / (2 * halfWidth), availH / (2 * halfHeight));
  const view = { x: box.x + 36, y: top, w: 2 * halfWidth * scale, h: 2 * halfHeight * scale };
  const cx = view.x + view.w / 2, cy = view.y + view.h / 2;
  const P = (x, z) => ({ x: cx + (x - lowest.x) * scale, y: cy - (z - midZ) * scale });
  calPanelTitle(ctx, box, "FROM THE FRONT · HEIGHT");
  ctx.save();
  simRoundedRect(ctx, view.x, view.y, view.w, view.h, 8); ctx.clip();
  ctx.fillStyle = "#170f1b"; ctx.fillRect(view.x, view.y, view.w, view.h);
  // Surface profile along X at the pipette's Y.
  const samples = 90;
  const deck = session.deckState();
  ctx.beginPath();
  ctx.moveTo(view.x, view.y + view.h + 2);
  let surfaceUnder = null;
  for (let i = 0; i <= samples; i += 1) {
    const x = lowest.x - halfWidth + i * (2 * halfWidth / samples);
    const surface = calSurfaceAt(x, lowest.y, deck);
    const p = P(x, surface.z);
    ctx.lineTo(p.x, Math.min(view.y + view.h + 2, p.y));
    if (i === samples / 2) surfaceUnder = surface;
  }
  ctx.lineTo(view.x + view.w, view.y + view.h + 2);
  ctx.closePath();
  ctx.fillStyle = CAL_SURFACE_COLORS[surfaceUnder.name] || CAL_SURFACE_COLORS.deck; ctx.fill();
  const gap = physical.gap;
  const touching = gap <= 0.1 && gap >= -0.15;
  ctx.strokeStyle = gap < -0.15 ? SIM_COLORS.collision : touching ? "#48df8b" : "#cdbfd2";
  ctx.lineWidth = touching || gap < -0.15 ? 2.5 : 1.2; ctx.stroke();
  // Nozzle, and the tip pressed onto it.
  const rack = session.tipRack;
  const nozzleW = rack.diameter * .84 * scale;
  const nozzle = P(physical.nozzle.x, physical.nozzle.z);
  ctx.fillStyle = "#c3cbcf"; ctx.fillRect(nozzle.x - nozzleW / 2, view.y - 4, nozzleW, Math.max(0, nozzle.y - view.y + 4));
  if (physical.tipEnd) {
    const tipTop = P(physical.nozzle.x, physical.nozzle.z + rack.overlap);
    const end = P(physical.tipEnd.x, physical.tipEnd.z);
    const topW = rack.diameter * scale, endW = rack.endDiameter * scale;
    ctx.beginPath();
    ctx.moveTo(tipTop.x - topW / 2, tipTop.y); ctx.lineTo(tipTop.x + topW / 2, tipTop.y);
    ctx.lineTo(end.x + endW / 2, end.y); ctx.lineTo(end.x - endW / 2, end.y); ctx.closePath();
    ctx.fillStyle = "rgba(216,182,255,.55)"; ctx.fill(); ctx.strokeStyle = SIM_COLORS.tip; ctx.lineWidth = 1; ctx.stroke();
  }
  ctx.restore();
  // Height scale: millimeters above the surface (or tip top) under the pipette.
  ctx.fillStyle = "#a68fad"; ctx.strokeStyle = "#6c5373"; ctx.font = "600 9px system-ui"; ctx.textAlign = "right";
  for (let mm = -halfHeight; mm <= halfHeight + 1; mm += 0.5) {
    const y = P(0, reference + mm).y;
    if (y < view.y || y > view.y + view.h) continue;
    const major = Number.isInteger(mm);
    ctx.beginPath(); ctx.moveTo(view.x - (major ? 8 : 4), y); ctx.lineTo(view.x, y); ctx.stroke();
    if (major) ctx.fillText(String(mm), view.x - 10, y + 3);
  }
  ctx.textAlign = "left";
  const lowestY = P(lowest.x, lowest.z).y;
  if (lowestY < view.y) calOffscreenArrow(ctx, { x: cx, y: cy }, { x: cx, y: cy - 1000 }, view, `${physical.tipEnd ? "Tip" : "Nozzle"} ${Math.round(gap)} mm above`);
  else if (lowestY > view.y + view.h) calOffscreenArrow(ctx, { x: cx, y: cy }, { x: cx, y: cy + 1000 }, view, gap < 0 ? "Pressed into the surface" : `${physical.tipEnd ? "Tip" : "Nozzle"} below view`);
  ctx.strokeStyle = "#5d3c66"; ctx.lineWidth = 1; simRoundedRect(ctx, view.x, view.y, view.w, view.h, 8); ctx.stroke();
}

// The pipette end after pick-up, drawn whole so the operator can judge the tip.
function drawTipInspection(canvas, session) {
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const size = fitCanvas(canvas, ctx);
  ctx.clearRect(0, 0, size.width, size.height);
  const rack = session.tipRack;
  const tip = session.tip && session.tip.attached ? session.tip : null;
  const length = rack.tipLength;
  const scale = (size.height - 30) / (length + 30);
  const cx = size.width / 2, nozzleY = 12 + 22 * scale;
  ctx.fillStyle = "#c3cbcf";
  ctx.fillRect(cx - rack.diameter * .42 * scale, 4, rack.diameter * .84 * scale, nozzleY - 4);
  if (tip) {
    const topY = nozzleY - rack.overlap * scale, endY = nozzleY + (tip.trueLength) * scale;
    ctx.beginPath();
    ctx.moveTo(cx - rack.diameter / 2 * scale, topY); ctx.lineTo(cx + rack.diameter / 2 * scale, topY);
    ctx.lineTo(cx + rack.endDiameter / 2 * scale, endY); ctx.lineTo(cx - rack.endDiameter / 2 * scale, endY); ctx.closePath();
    ctx.fillStyle = "rgba(216,182,255,.55)"; ctx.fill(); ctx.strokeStyle = SIM_COLORS.tip; ctx.lineWidth = 1.5; ctx.stroke();
  } else {
    ctx.fillStyle = "#8c9599";
    ctx.fillRect(cx - rack.diameter * .3 * scale, nozzleY, rack.diameter * .6 * scale, 3 * scale);
  }
}

// ------------------------------------------------------------ events

$("#open-calibration").addEventListener("click", () => routeTo("calibration"));
$("#cal-status").addEventListener("click", (event) => {
  const button = event.target.closest("[data-cal]");
  if (button && !button.disabled) startCalibration(button.dataset.cal, button.dataset.mount);
});
["left", "right"].forEach((mount) => $(`#cal-${mount}-pipette`).addEventListener("change", (event) => {
  calUI.robot.setPipette(mount, event.target.value);
  calNotice("");
  renderCalPanel();
  calUI.dirty = true;
}));
$("#cal-show-offsets").addEventListener("change", (event) => { calUI.showOffsets = event.target.checked; calUI.dirty = true; });
$("#cal-new-robot").addEventListener("click", async () => {
  const choice = await showPrompt({
    eyebrow: "Practice robot",
    title: "Start with a new practice robot?",
    body: "<p>The new robot’s deck, mounts, and tips are off by different hidden amounts, and every saved calibration is cleared.</p>",
    actions: [{ label: "Cancel", value: "cancel" }, { label: "New robot", value: "new", kind: "primary" }],
    cancel: "cancel"
  });
  if (choice !== "new") return;
  calUI.robot.reset();
  calNotice("New practice robot. Start with deck calibration.");
  renderCalPanel();
  calUI.dirty = true;
});
$("#cal-exit").addEventListener("click", calConfirmExit);
$("#cal-crash").addEventListener("click", () => { if (calUI.session) calCrashPrompt(calUI.session); });
$("#cal-step-actions").addEventListener("click", (event) => {
  const button = event.target.closest("[data-cal-action]");
  const session = calUI.session;
  if (!button || !session) return;
  const action = calUI.actions[Number(button.dataset.calAction)];
  if (action.commands) calSend(...action.commands);
  else action.run(session);
});
document.querySelectorAll(".jog-pad button[data-jog]").forEach((button) => button.addEventListener("click", () => calJog(button.dataset.jog, Number(button.dataset.dir))));
document.querySelectorAll(".jog-steps button").forEach((button) => button.addEventListener("click", () => setCalStepSize(Number(button.dataset.step))));
document.addEventListener("keydown", (event) => {
  if ($("#cal-screen").hidden || $("#prompt-dialog").open || !calUI.session) return;
  if (event.target.closest("input, select, textarea") || event.metaKey || event.ctrlKey || event.altKey) return;
  const key = event.key;
  if (key === "ArrowLeft") calJog("x", -1);
  else if (key === "ArrowRight") calJog("x", 1);
  else if (key === "ArrowUp") calJog(event.shiftKey ? "z" : "y", 1);
  else if (key === "ArrowDown") calJog(event.shiftKey ? "z" : "y", -1);
  else if (key === "w" || key === "W") calJog("z", 1);
  else if (key === "s" || key === "S") calJog("z", -1);
  else if (["1", "2", "3"].includes(key)) setCalStepSize(CAL_STEP_SIZES[Number(key) - 1]);
  else return;
  event.preventDefault();
});
if ("ResizeObserver" in window) new ResizeObserver(() => { calUI.dirty = true; }).observe($(".cal-views"));
