"use strict";

const $ = (selector) => document.querySelector(selector);
const topCanvas = $("#top-canvas");
const quarterCanvas = $("#quarter-canvas");
const topCtx = topCanvas.getContext("2d");
const quarterCtx = quarterCanvas.getContext("2d");
const GCODE_WINDOW_LINES = 160;

function createWorkflow(constructCount, identifier) {
  const count = Math.max(1, Math.min(144, Number(constructCount) || 1));
  const sourceColumns = Math.ceil(count / 8);
  const sourcePlateCount = Math.ceil(count / 96);
  const destinationPlateCount = Math.ceil(count / 24);
  return {
    identifier: identifier || "MFG_Plating",
    constructCount: count,
    sourceColumns,
    sourceSlots: [7, 8].slice(0, sourcePlateCount),
    tipSlots: [10, 11].slice(0, sourcePlateCount),
    destinationSlots: Array.from({ length: destinationPlateCount }, (_item, index) => index + 1)
  };
}

const state = {
  model: null,
  filename: "",
  time: 0,
  playing: false,
  speed: 1,
  lastTime: 0,
  dirty: true,
  renderedStep: -1,
  gcodeKey: "",
  pending: null,
  running: false,
  engineVersion: null,
  pinRequired: false,
  generatedProtocol: ""
};

function destinationFor(sourceIndex) {
  const plate = Math.floor(sourceIndex / 3);
  const firstColumn = (sourceIndex % 3) * 4;
  return { plate, columns: [firstColumn, firstColumn + 1, firstColumn + 2, firstColumn + 3] };
}

// Signed-out or expired sessions get 401 from every API; send the user to sign in.
async function apiFetch(url, options) {
  const response = await fetch(url, options);
  if (response.status === 401) {
    window.location.href = "./";
    throw new Error("Your session has ended. Sign in again.");
  }
  return response;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function fitCanvas(canvas, ctx) {
  const rect = canvas.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const width = Math.max(1, Math.floor(rect.width * dpr));
  const height = Math.max(1, Math.floor(rect.height * dpr));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width; canvas.height = height;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { width: rect.width, height: rect.height };
}

function formatDuration(seconds) {
  const rounded = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(rounded / 60);
  const remainder = rounded % 60;
  return `${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
}


// ------------------------------------------------------------ simulation run

function showNotice(message, isError = false) {
  const notice = $("#protocol-notice");
  notice.hidden = !message;
  notice.classList.toggle("error", Boolean(isError));
  notice.textContent = message || "";
}

function showOverlay(title, detail, { sample = true } = {}) {
  $("#sim-overlay").hidden = false;
  $("#overlay-title").textContent = title;
  $("#overlay-detail").textContent = detail;
  $("#run-sample").hidden = !sample;
}

function updateRunButton() {
  const button = $("#run-simulation");
  button.disabled = state.running || !state.pending || (state.pinRequired && !$("#sim-pin").value);
  button.textContent = state.running ? "Running…" : "Run";
}

function simulatorFilename(name) {
  const base = String(name || "protocol").replace(/\.py$/i, "").replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^[_.]+|_+$/g, "");
  return `${(base || "protocol").slice(0, 110)}.py`;
}

function setPending(source) {
  state.pending = source;
  $("#file-name").textContent = source.sample ? "sample_protocol.py" : source.filename;
  $("#file-meta").textContent = state.model && state.filename === source.filename ? $("#file-meta").textContent : "Ready to simulate";
  updateRunButton();
}

async function runSimulation(source) {
  if (state.running) return;
  setPending(source);
  const pin = $("#sim-pin").value;
  if (state.pinRequired && !pin) {
    showNotice("Enter the simulation PIN, then press Run.");
    $("#sim-pin").focus();
    return;
  }
  state.running = true;
  state.playing = false;
  updateRunButton();
  showNotice("");
  const engine = state.engineVersion ? `Opentrons OT-2 engine ${state.engineVersion}` : "the Opentrons OT-2 engine";
  const started = Date.now();
  const tick = () => showOverlay(`Running on ${engine}…`, `Executing the protocol against an emulated motor controller · ${Math.round((Date.now() - started) / 1000)} s`, { sample: false });
  tick();
  const timer = window.setInterval(tick, 1000);
  try {
    const response = await apiFetch("./api/simulate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(source.sample ? { pin, sample: true } : { pin, filename: source.filename, protocol: source.protocol })
    });
    let result;
    try { result = await response.json(); } catch (_error) { throw new Error(`The server returned an unreadable response (${response.status}).`); }
    if (!response.ok) throw new Error(result.error || `Simulation failed (${response.status}).`);
    loadResult(result, source.sample ? "sample_protocol.py" : source.filename);
  } catch (error) {
    if (state.model) {
      $("#sim-overlay").hidden = true;
      showNotice(error.message, true);
    } else {
      showOverlay("The simulation did not run", error.message);
      showNotice(error.message, true);
    }
  } finally {
    window.clearInterval(timer);
    state.running = false;
    updateRunButton();
  }
}

function loadResult(result, filename) {
  const model = new SimulationModel(result);
  state.model = model;
  state.filename = filename;
  state.time = 0;
  state.playing = false;
  state.renderedStep = -1;
  state.gcodeKey = "";
  state.dirty = true;

  const metadata = result.metadata || {};
  $("#file-name").textContent = filename;
  $("#file-meta").textContent = `Python API ${result.engine.apiLevel || "?"} · OT-2`;
  $("#protocol-title").textContent = metadata.protocolName || filename;
  const pipettes = model.pipettes.map((p) => `${p.name} (${p.mount})`).join(", ") || "no pipettes";
  $("#protocol-description").textContent = `${model.labware.length} labware · ${pipettes}`;
  $("#stat-steps").textContent = model.steps.length;
  $("#stat-tips").textContent = model.tipPickups.length;
  $("#stat-gcode").textContent = model.gcode.length.toLocaleString();
  $("#stat-time").textContent = formatDuration(model.estimatedSeconds);
  $("#engine-version").textContent = `OT-2 ${result.engine.opentronsVersion}`;
  $("#engine-api").textContent = result.engine.apiLevel || "—";
  $("#status-engine").textContent = `OT-2 ${result.engine.opentronsVersion} · ${result.status}`;
  $("#status-engine-dot").className = result.status === "succeeded" ? "green" : "red";
  $("#timeline").max = Math.max(0, model.steps.length - 1);
  $("#gcode-download").disabled = !model.gcode.length;
  $("#sim-overlay").hidden = true;
  renderSafety(model);
  if (result.status !== "succeeded") {
    showNotice("The protocol stopped with an Opentrons engine error. Steps up to the failure are shown; see Safety checks.", true);
  } else {
    showNotice("");
  }
  updateUI();
}

// ------------------------------------------------------------ safety panel

function renderSafety(model) {
  const safety = model.safety;
  const counts = safety.counts || {};
  const card = $("#safety-card");
  card.dataset.status = safety.status;
  const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
  const title = safety.status === "fail"
    ? `${plural(counts.error, "error")}${counts.warning ? ` · ${plural(counts.warning, "warning")}` : ""}`
    : safety.status === "warn" ? plural(counts.warning, "warning") : "No problems found";
  $("#safety-title").textContent = title;
  $("#safety-pill").textContent = { pass: "PASS", warn: "WARN", fail: "FAIL" }[safety.status] || "—";
  $("#status-safety").textContent = title + (counts.info ? ` · ${plural(counts.info, "note")}` : "");
  $("#status-safety-dot").className = { pass: "green", warn: "amber", fail: "red" }[safety.status] || "cyan";
  const rows = safety.findings.slice(0, 150).map((finding, index) => {
    const step = model.stepForCommand(finding.command);
    return `<button class="finding ${finding.severity}" data-step="${step}" data-finding="${index}" type="button"><i></i><span>${escapeHtml(finding.message)}</span><b>Step ${step + 1}</b></button>`;
  });
  if (safety.truncated || safety.findings.length > 150) rows.push(`<p class="finding-more">Showing the first 150 findings.</p>`);
  $("#safety-findings").innerHTML = rows.join("");
  $("#safety-limitations").innerHTML = (safety.limitations || []).map((item) => `<li>${escapeHtml(item)}</li>`).join("");
}

// ------------------------------------------------------------ playback UI

function currentStepIndex() { return state.model ? state.model.stepAt(state.time) : 0; }

function setStep(index) {
  if (!state.model) return;
  const clamped = Math.max(0, Math.min(state.model.steps.length - 1, index));
  state.time = state.model.steps[clamped].start;
  state.dirty = true;
  updateUI();
}

function updateUI() {
  const model = state.model;
  $("#play-button").textContent = state.playing ? "Ⅱ" : "▶";
  if (!model) return;
  const index = currentStepIndex();
  const step = model.steps[index];
  $("#step-fraction").textContent = `${index + 1} / ${model.steps.length}`;
  $("#timeline").value = index;
  $("#current-action").textContent = step ? step.command.label : "—";
  const pipette = step && model.pipetteByMount[model.mountForPipette(step.command.params.pipetteId)];
  $("#cycle-label").textContent = step ? `Command ${step.command.index + 1}${pipette ? ` · ${pipette.name} (${pipette.mount})` : ""}` : "—";
  $("#time-label").textContent = `${formatDuration(state.time)} / ~${formatDuration(model.totalSeconds)}`;
  if (index !== state.renderedStep) {
    state.renderedStep = index;
    renderStepList(model, index);
    document.querySelectorAll("#safety-findings .finding").forEach((row) => row.classList.toggle("active", Number(row.dataset.step) === index));
  }
}

function renderStepList(model, index) {
  const start = Math.max(0, Math.min(model.steps.length - 8, index - 3));
  const severityByStep = new Map();
  for (const finding of model.safety.findings) {
    if (finding.severity === "info") continue;
    const step = model.stepForCommand(finding.command);
    if (severityByStep.get(step) !== "error") severityByStep.set(step, finding.severity);
  }
  $("#step-list").innerHTML = model.steps.slice(start, start + 8).map((step, offset) => {
    const i = start + offset;
    const command = step.command;
    const pipette = model.pipetteByMount[model.mountForPipette(command.params.pipetteId)];
    const volume = command.params.volume;
    const amount = typeof volume === "number" && pipette ? `${volume} µL${pipette.channels > 1 ? ` ×${pipette.channels}` : ""}` : "";
    const flag = severityByStep.get(i);
    const classes = ["step-row", i === index ? "active" : i < index ? "done" : "", flag ? `flag-${flag}` : ""].join(" ");
    return `<button class="${classes}" data-step="${i}" type="button"><span class="num">${String(i + 1).padStart(2, "0")}</span><span class="label">${escapeHtml(command.label)}</span><span class="amount">${amount}</span></button>`;
  }).join("");
}

function updateTelemetry() {
  const model = state.model;
  if (!model) return;
  const pose = model.poseAt(state.time);
  const channel = model.channelsAt(pose.mount, pose.carriage, (pose.tips || {})[pose.mount])[0];
  if (channel) {
    $("#telemetry-x").textContent = channel.x.toFixed(1);
    $("#telemetry-y").textContent = channel.y.toFixed(1);
    $("#telemetry-z").textContent = channel.endZ.toFixed(1);
  }
  const pipette = model.pipetteByMount[pose.mount];
  const tips = model.liquidAt(state.time).tips[pose.mount] || [];
  const filled = tips.filter((volume) => volume > .01);
  const maximum = filled.length ? Math.max(...filled) : 0;
  const shown = maximum % 1 ? maximum.toFixed(1) : maximum.toFixed(0);
  $("#tip-volume").textContent = filled.length ? `${shown} µL × ${filled.length}` : `0 µL × ${tips.length || 1}`;
  $("#tip-fill").style.width = `${Math.min(100, pipette ? maximum / pipette.maxVolume * 100 : 0)}%`;
}

function renderGcode() {
  const body = $("#gcode-lines");
  const model = state.model;
  if (!model) { body.innerHTML = ""; return; }
  const follow = $("#gcode-follow").checked;
  if (!follow && state.playing) return;
  const revealed = model.gcodeRevealedAt(state.time);
  const showPolling = $("#gcode-polling").checked;
  const stepCommand = (model.steps[currentStepIndex()] || {}).command;
  const key = `${revealed}|${showPolling}|${stepCommand ? stepCommand.index : ""}`;
  if (key === state.gcodeKey) return;
  state.gcodeKey = key;
  const rows = [];
  for (let i = revealed - 1; i >= 0 && rows.length < GCODE_WINDOW_LINES; i -= 1) {
    if (!showPolling && isPollingGcode(model.gcode[i])) continue;
    rows.push(i);
  }
  rows.reverse();
  const latest = rows[rows.length - 1];
  body.innerHTML = rows.map((i) => {
    const [command, device, code, response] = model.gcode[i];
    const classes = ["gline", stepCommand && command === stepCommand.index ? "current" : "", i === latest ? "latest" : ""].join(" ");
    const help = explainGcode(code);
    return `<div class="${classes}"${help ? ` title="${escapeHtml(help)}"` : ""}><span class="gnum">${i + 1}</span>${device === "smoothie" ? "" : `<span class="gdev">${escapeHtml(device)}</span>`}<span class="gcode">${escapeHtml(code)}</span>${response ? `<span class="gresp">→ ${escapeHtml(response)}</span>` : ""}</div>`;
  }).join("") || `<div class="gline empty">No G-code sent yet.</div>`;
  if (follow) body.scrollTop = body.scrollHeight;
  $("#gcode-status").textContent = `${revealed.toLocaleString()} / ${model.gcode.length.toLocaleString()} lines · Smoothie serial`;
}

function draw() {
  drawTopView(topCanvas, topCtx, state.model, state.time);
  drawQuarterView(quarterCanvas, quarterCtx, state.model, state.time);
  updateTelemetry();
  renderGcode();
  state.dirty = false;
}

function showRenderError(error) {
  state.playing = false;
  showNotice(`Renderer error: ${error.message}. Reload after updating the app, or copy this message for troubleshooting.`, true);
  console.error(error);
}

function animate(time) {
  if (!state.lastTime) state.lastTime = time;
  const delta = time - state.lastTime;
  state.lastTime = time;
  try {
    if (state.playing && state.model) {
      state.time += delta * state.speed / 1000;
      if (state.time >= state.model.totalSeconds) {
        state.time = state.model.totalSeconds;
        state.playing = false;
      }
      state.dirty = true;
      updateUI();
    }
    if (state.dirty && !$("#simulator-screen").hidden) draw();
    requestAnimationFrame(animate);
  } catch (error) {
    showRenderError(error);
  }
}

function routeTo(route) {
  $("#landing-screen").hidden = route !== "landing";
  $("#mfg-screen").hidden = route !== "mfg";
  $("#amp-screen").hidden = route !== "amp";
  $("#simulator-screen").hidden = route !== "simulator";
  const labels = {
    landing: ["OT-2 Manufacturing Tools", "Protocol planning, generation, and simulation"],
    mfg: ["MFG_Plating", "Work-list creation and protocol delivery"],
    amp: ["PCR->AMP plate transfer", "96-well PCR plates into a 384-well Echo plate"],
    simulator: ["WL Simulation", "OT-2 engine simulation, G-code, and safety checks"]
  };
  $("#app-title").textContent = labels[route][0];
  $("#app-subtitle").textContent = labels[route][1];
  if (route === "simulator") { state.dirty = true; window.setTimeout(draw, 0); }
}

async function checkSimulator() {
  try {
    const response = await apiFetch("./api/health", { cache: "no-store" });
    const health = await response.json();
    const simulator = health.simulator || {};
    state.engineVersion = simulator.engineVersion || null;
    state.pinRequired = Boolean(simulator.pinRequired);
    $("#sign-out").hidden = !health.siteLogin;
    $(".sim-pin-row").hidden = !state.pinRequired;
    updateRunButton();
    $("#engine-version").textContent = simulator.installed ? `OT-2 ${simulator.engineVersion || "unknown"}` : "Not installed";
    $("#status-engine").textContent = simulator.installed ? `OT-2 ${simulator.engineVersion || "unknown"} · ready` : "Not installed";
    if (!simulator.installed && !state.model) {
      showOverlay("The OT-2 simulator is not installed on this server", "Run scripts/setup_simulator.sh on the server, then restart server.py.", { sample: false });
    }
  } catch (_error) {
    $("#engine-version").textContent = "Server unavailable";
  }
}
function deckItemFor(workflow, slot) {
  const destination = workflow.destinationSlots.indexOf(slot);
  const source = workflow.sourceSlots.indexOf(slot);
  const tips = workflow.tipSlots.indexOf(slot);
  if (destination >= 0) return { type: "destination", label: `Destination ${destination + 1}`, detail: "Agar plate" };
  if (source >= 0) return { type: "source", label: `Source ${source + 1}`, detail: "PCR plate" };
  if (tips >= 0) return { type: "tips", label: `Tip rack ${tips + 1}`, detail: "20 µL tips" };
  if (slot === 12) return { type: "trash", label: "Fixed trash", detail: "Built in" };
  return { type: "empty", label: "Empty", detail: "" };
}

function renderWorklist(workflow) {
  $("#output-title").textContent = workflow.identifier;
  $("#required-sources").textContent = workflow.sourceSlots.length;
  $("#required-tips").textContent = workflow.tipSlots.length;
  $("#required-destinations").textContent = workflow.destinationSlots.length;
  $("#required-actions").textContent = workflow.sourceColumns * 8;
  $("#mapping-summary").textContent = `${workflow.constructCount} constructs · ${workflow.sourceColumns} source columns`;
  const deckOrder = [10, 11, 12, 7, 8, 9, 4, 5, 6, 1, 2, 3];
  $("#work-deck").innerHTML = deckOrder.map((slot) => {
    const item = deckItemFor(workflow, slot);
    return `<div class="deck-slot ${item.type}"><b>${slot}</b><div><span>${item.label}</span><small>${item.detail}</small></div></div>`;
  }).join("");
  const rows = [];
  for (let globalColumn = 0; globalColumn < workflow.sourceColumns; globalColumn += 1) {
    const first = globalColumn * 8 + 1;
    const last = Math.min(workflow.constructCount, first + 7);
    const sourcePlate = Math.floor(globalColumn / 12) + 1;
    const sourceColumn = globalColumn % 12 + 1;
    const destination = destinationFor(globalColumn);
    rows.push(`<tr><td>${first}–${last}${last - first < 7 ? " (partial)" : ""}</td><td>Plate ${sourcePlate}, column ${sourceColumn}</td><td>Plate ${destination.plate + 1}, columns ${destination.columns[0] + 1}–${destination.columns[3] + 1}</td></tr>`);
  }
  $("#mapping-body").innerHTML = rows.join("");
}

function pythonString(value) { return JSON.stringify(String(value)); }

function generateProtocol(workflow) {
  const sourceSlots = JSON.stringify(workflow.sourceSlots);
  const tipSlots = JSON.stringify(workflow.tipSlots);
  const destinationSlots = JSON.stringify(workflow.destinationSlots);
  return `from opentrons import protocol_api

metadata = {
    "protocolName": ${pythonString(`MFG_Plating - ${workflow.identifier}`)},
    "author": "OT-2 Manufacturing Tools",
    "description": "Four 10 uL destination replicates for ${workflow.constructCount} constructs",
    "worklistId": ${pythonString(workflow.identifier)},
}

requirements = {"robotType": "OT-2", "apiLevel": "2.28"}

WORKLIST_ID = ${pythonString(workflow.identifier)}
CONSTRUCT_COUNT = ${workflow.constructCount}
STARTING_VOLUME = 130
SOURCE_SLOTS = ${sourceSlots}
TIP_SLOTS = ${tipSlots}
DESTINATION_SLOTS = ${destinationSlots}


def run(protocol: protocol_api.ProtocolContext):
    source_plates = [
        protocol.load_labware("opentrons_96_wellplate_200ul_pcr_full_skirt", slot)
        for slot in SOURCE_SLOTS
    ]
    destination_plates = [
        protocol.load_labware("corning_96_wellplate_360ul_flat", slot)
        for slot in DESTINATION_SLOTS
    ]
    tip_racks = [
        protocol.load_labware("opentrons_96_tiprack_20ul", slot)
        for slot in TIP_SLOTS
    ]
    p20_multi = protocol.load_instrument("p20_multi_gen2", "left", tip_racks=tip_racks)

    culture = protocol.define_liquid(
        name="E. coli culture", description=WORKLIST_ID, display_color="#F000DC"
    )
    # wells() follows column-major order: A1-H1, then A2-H2.
    for construct_index in range(CONSTRUCT_COUNT):
        plate_index = construct_index // 96
        local_well_index = construct_index % 96
        source_plates[plate_index].wells()[local_well_index].load_liquid(
            liquid=culture, volume=STARTING_VOLUME
        )

    source_column_count = (CONSTRUCT_COUNT + 7) // 8
    for global_source_column in range(source_column_count):
        source_plate_index = global_source_column // 12
        local_source_column = global_source_column % 12
        source_well = source_plates[source_plate_index].columns()[local_source_column][0]

        destination_plate_index = global_source_column // 3
        first_destination_column = (global_source_column % 3) * 4
        destination_columns = destination_plates[destination_plate_index].columns()[
            first_destination_column:first_destination_column + 4
        ]
        destination_targets = [column[0] for column in destination_columns]

        # A partial final column intentionally uses all eight tips. Channels
        # aligned with unoccupied source wells will aspirate air.
        p20_multi.pick_up_tip()
        p20_multi.aspirate(20, source_well)
        p20_multi.dispense(10, destination_targets[0])
        p20_multi.dispense(10, destination_targets[1])
        p20_multi.aspirate(20, source_well)
        p20_multi.dispense(10, destination_targets[2])
        p20_multi.dispense(10, destination_targets[3])
        p20_multi.drop_tip()
`;
}

function safeFilename(identifier) {
  const cleaned = identifier.trim().replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  return `${cleaned || "MFG_Plating"}.py`;
}

function showMfgStatus(message, isError) {
  const status = $("#mfg-status");
  status.hidden = false;
  status.classList.toggle("error", Boolean(isError));
  status.textContent = message;
}

function readLocalFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error || new Error("Unable to read this protocol file."));
    reader.readAsText(file);
  });
}


$("#play-button").addEventListener("click", () => {
  if (!state.model) return;
  if (state.time >= state.model.totalSeconds) state.time = 0;
  state.playing = !state.playing;
  state.dirty = true;
  updateUI();
});
$("#restart-button").addEventListener("click", () => { state.playing = false; setStep(0); });
$("#previous-button").addEventListener("click", () => { state.playing = false; setStep(currentStepIndex() - 1); });
$("#next-button").addEventListener("click", () => { state.playing = false; setStep(currentStepIndex() + 1); });
$("#timeline").addEventListener("input", (event) => { state.playing = false; setStep(Number(event.target.value)); });
$("#speed-select").addEventListener("change", (event) => { state.speed = Number(event.target.value); });
$("#step-list").addEventListener("click", (event) => {
  const row = event.target.closest("[data-step]");
  if (row) { state.playing = false; setStep(Number(row.dataset.step)); }
});
$("#safety-findings").addEventListener("click", (event) => {
  const row = event.target.closest("[data-step]");
  if (row) { state.playing = false; setStep(Number(row.dataset.step)); }
});
$("#gcode-polling").addEventListener("change", () => { state.gcodeKey = ""; state.dirty = true; });
$("#gcode-follow").addEventListener("change", () => { state.gcodeKey = ""; state.dirty = true; });
$("#gcode-download").addEventListener("click", () => {
  if (!state.model) return;
  const blob = new Blob([gcodeFileText(state.model, state.filename)], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url; link.download = state.filename.replace(/\.py$/i, "") + ".gcode";
  document.body.appendChild(link); link.click(); link.remove(); URL.revokeObjectURL(url);
});

$("#protocol-file").addEventListener("change", async (event) => {
  const file = event.target.files[0];
  event.target.value = "";
  if (!file) return;
  try {
    const protocol = await readLocalFile(file);
    await runSimulation({ filename: simulatorFilename(file.name), protocol });
  } catch (error) {
    showNotice(error.message, true);
  }
});
$("#sim-pin").addEventListener("input", updateRunButton);
$("#sim-pin").addEventListener("keydown", (event) => { if (event.key === "Enter" && state.pending) runSimulation(state.pending); });
$("#run-simulation").addEventListener("click", () => { if (state.pending) runSimulation(state.pending); });
$("#run-sample").addEventListener("click", () => runSimulation({ sample: true, filename: "sample_protocol.py" }));

let draftWorkflow = null;

function invalidateWorklist() {
  if (!draftWorkflow) return;
  draftWorkflow = null;
  state.generatedProtocol = "";
  $("#machine-ready").disabled = true;
  $("#delivery-panel").hidden = true;
  $("#worklist-state").textContent = "Draft";
  $("#worklist-state").classList.remove("ready");
  showMfgStatus("Work-list details changed. Create the work list again before confirming the deck.", false);
}

$("#open-mfg").addEventListener("click", () => routeTo("mfg"));
$("#open-simulator").addEventListener("click", () => routeTo("simulator"));
$("#home-button").addEventListener("click", () => routeTo("landing"));
document.querySelectorAll("[data-route]").forEach((button) => button.addEventListener("click", () => routeTo(button.dataset.route)));
$("#worklist-id").addEventListener("input", invalidateWorklist);
$("#construct-count").addEventListener("input", invalidateWorklist);

$("#worklist-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const identifier = $("#worklist-id").value.trim();
  const count = Number($("#construct-count").value);
  if (!identifier) { showMfgStatus("Enter a unique identifier.", true); return; }
  if (!Number.isInteger(count) || count < 1 || count > 144) { showMfgStatus("Construct count must be a whole number from 1 through 144.", true); return; }
  draftWorkflow = createWorkflow(count, identifier);
  renderWorklist(draftWorkflow);
  $("#machine-ready").disabled = false;
  $("#delivery-panel").hidden = true;
  $("#worklist-state").textContent = "Setup calculated";
  $("#worklist-state").classList.remove("ready");
  showMfgStatus(`Mapped ${count} constructs across ${draftWorkflow.sourceColumns} source columns. Verify the deck before continuing.`, false);
});

$("#machine-ready").addEventListener("click", () => {
  if (!draftWorkflow) return;
  state.generatedProtocol = generateProtocol(draftWorkflow);
  $("#delivery-panel").hidden = false;
  $("#worklist-state").textContent = "Machine ready";
  $("#worklist-state").classList.add("ready");
  $("#machine-ready").disabled = true;
  showMfgStatus("Machine readiness confirmed. The protocol is ready to download, simulate, or upload for OT-2 analysis.", false);
});

$("#download-protocol").addEventListener("click", () => {
  if (!draftWorkflow || !state.generatedProtocol) return;
  const filename = safeFilename(draftWorkflow.identifier);
  downloadProtocol(filename, state.generatedProtocol);
  showMfgStatus(`Downloaded ${filename}. Import it into the Opentrons OT-2 App for analysis and setup.`, false);
});


$("#simulate-worklist").addEventListener("click", () => {
  if (!draftWorkflow || !state.generatedProtocol) return;
  openInSimulation(safeFilename(draftWorkflow.identifier), state.generatedProtocol, $("#upload-pin"));
});

function openInSimulation(filename, protocol, uploadPin) {
  if (!$("#sim-pin").value && uploadPin.value) $("#sim-pin").value = uploadPin.value;
  routeTo("simulator");
  runSimulation({ filename, protocol });
}

function downloadProtocol(filename, protocol) {
  const blob = new Blob([protocol], { type: "text/x-python;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url; link.download = filename;
  document.body.appendChild(link); link.click(); link.remove(); URL.revokeObjectURL(url);
}

async function uploadToRobot({ button, address, pin, filename, protocol, worklistId, report }) {
  button.disabled = true; button.textContent = "Uploading…";
  try {
    const response = await apiFetch("./api/ot2/upload", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ robotAddress: address.value.trim(), pin: pin.value, filename, protocol, worklistId })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `Upload failed (${response.status})`);
    report(`Uploaded to OT-2 for analysis. Protocol ID: ${result.protocolId || "returned by robot"}. Open the OT-2 App to review setup and start the run.`, false);
    pin.value = "";
  } catch (error) {
    report(error.message, true);
  } finally {
    button.disabled = false; button.textContent = "Upload to OT-2";
  }
}

$("#robot-upload-form").addEventListener("submit", (event) => {
  event.preventDefault();
  if (!draftWorkflow || !state.generatedProtocol) return;
  uploadToRobot({
    button: $("#upload-to-robot"), address: $("#robot-address"), pin: $("#upload-pin"),
    filename: safeFilename(draftWorkflow.identifier), protocol: state.generatedProtocol,
    worklistId: draftWorkflow.identifier, report: showMfgStatus
  });
});

// ------------------------------------------------------- PCR->AMP transfer

let ampCsv = "";
let ampPlan = null;
let ampConfirmed = false;

function showAmpStatus(message, isError, details = []) {
  const status = $("#amp-status");
  status.hidden = false;
  status.classList.toggle("error", Boolean(isError));
  status.innerHTML = escapeHtml(message) + (details.length ? `<ul>${details.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>` : "");
}

function resetAmpPlan() {
  ampPlan = null;
  ampConfirmed = false;
  $("#amp-machine-ready").disabled = true;
  $("#amp-delivery-panel").hidden = true;
  $("#amp-state").textContent = "Draft";
  $("#amp-state").classList.remove("ready");
}

function ampDeckItem(plan, slot) {
  const source = plan.sourcePlates.find((plate) => plate.slot === slot);
  const tips = plan.tipSlots.indexOf(slot);
  if (slot === plan.destinationSlot) return { type: "destination", label: plan.destinationPlate || "Echo plate", detail: "Echo 384PP" };
  if (source) return { type: "source", label: source.name, detail: `PCR plate · quadrant ${source.quadrant}` };
  if (tips >= 0) return { type: "tips", label: `Tip rack ${tips + 1}`, detail: "200 µL filter tips" };
  if (slot === 12) return { type: "trash", label: "Fixed trash", detail: "Built in" };
  return { type: "empty", label: "Empty", detail: "" };
}

function renderAmpPlan(plan) {
  $("#amp-output-title").textContent = plan.identifier;
  $("#amp-required-sources").textContent = plan.sourcePlates.length;
  $("#amp-required-tips").textContent = plan.tipSlots.length;
  $("#amp-required-samples").textContent = plan.sampleCount;
  $("#amp-required-actions").textContent = plan.transfers.length;
  $("#amp-mapping-summary").textContent = plan.sourcePlates.map((plate) => `${plate.name} → quadrant ${plate.quadrant}`).join(" · ");
  const deckOrder = [10, 11, 12, 7, 8, 9, 4, 5, 6, 1, 2, 3];
  $("#amp-deck").innerHTML = deckOrder.map((slot) => {
    const item = ampDeckItem(plan, slot);
    return `<div class="deck-slot ${item.type}"><b>${slot}</b><div><span>${escapeHtml(item.label)}</span><small>${escapeHtml(item.detail)}</small></div></div>`;
  }).join("");
  const names = Object.fromEntries(plan.sourcePlates.map((plate) => [plate.number, plate.name]));
  $("#amp-mapping-body").innerHTML = plan.transfers.map((transfer) => {
    const count = transfer.wells.length;
    const wells = `${transfer.wells[0]}–${transfer.wells[count - 1]}${count < 8 ? ` (${count} of 8)` : ""}`;
    const destinations = `${transfer.destinations[0]}–${transfer.destinations[count - 1]}, every other row`;
    return `<tr><td>${escapeHtml(names[transfer.plate])} · column ${transfer.column}</td><td>${escapeHtml(wells)}</td><td>${escapeHtml(count > 1 ? destinations : transfer.destinations[0])}</td></tr>`;
  }).join("");
}

async function calculateAmpPlan({ fillIdentifier = false } = {}) {
  if (!ampCsv) { showAmpStatus("Choose a PCR plan CSV.", true); return; }
  resetAmpPlan();
  showAmpStatus("Checking the PCR plan…", false);
  try {
    const response = await apiFetch("./api/pcr-amp/plan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        csv: ampCsv,
        identifier: fillIdentifier ? "" : $("#amp-id").value.trim(),
        transferVolume: Number($("#amp-transfer-volume").value),
        startingVolume: Number($("#amp-starting-volume").value)
      })
    });
    const result = await response.json();
    if (!response.ok) { showAmpStatus(result.error || `Planning failed (${response.status})`, true, result.errors || []); return; }
    ampPlan = result;
    if (fillIdentifier || !$("#amp-id").value.trim()) $("#amp-id").value = result.identifier;
    renderAmpPlan(result);
    $("#amp-machine-ready").disabled = false;
    $("#amp-state").textContent = "Setup calculated";
    const plates = result.sourcePlates.length;
    showAmpStatus(`Mapped ${result.sampleCount} wells from ${plates} PCR plate${plates === 1 ? "" : "s"} in ${result.transfers.length} column transfers. Verify the deck before continuing.`, false, result.warnings);
  } catch (error) {
    showAmpStatus(error.message, true);
  }
}

$("#open-amp").addEventListener("click", () => routeTo("amp"));

$("#amp-csv").addEventListener("change", async (event) => {
  const file = event.target.files[0];
  event.target.value = "";
  if (!file) return;
  try {
    ampCsv = await readLocalFile(file);
    $("#amp-csv-name").textContent = file.name;
    await calculateAmpPlan({ fillIdentifier: true });
  } catch (error) {
    showAmpStatus(error.message, true);
  }
});

["#amp-id", "#amp-transfer-volume", "#amp-starting-volume"].forEach((selector) => $(selector).addEventListener("input", () => {
  if (!ampPlan) return;
  resetAmpPlan();
  showAmpStatus("Work-list details changed. Calculate the deck setup again before confirming the deck.", false);
}));

$("#amp-form").addEventListener("submit", (event) => {
  event.preventDefault();
  if (!$("#amp-id").value.trim() && ampCsv) { showAmpStatus("Enter a unique identifier.", true); return; }
  calculateAmpPlan();
});

$("#amp-machine-ready").addEventListener("click", () => {
  if (!ampPlan) return;
  ampConfirmed = true;
  $("#amp-delivery-panel").hidden = false;
  $("#amp-state").textContent = "Machine ready";
  $("#amp-state").classList.add("ready");
  $("#amp-machine-ready").disabled = true;
  showAmpStatus("Machine readiness confirmed. The protocol is ready to download, simulate, or upload for OT-2 analysis.", false);
});

$("#amp-download").addEventListener("click", () => {
  if (!ampPlan || !ampConfirmed) return;
  downloadProtocol(ampPlan.filename, ampPlan.protocol);
  showAmpStatus(`Downloaded ${ampPlan.filename}. Import it into the Opentrons OT-2 App for analysis and setup.`, false);
});

$("#amp-simulate").addEventListener("click", () => {
  if (!ampPlan || !ampConfirmed) return;
  openInSimulation(ampPlan.filename, ampPlan.protocol, $("#amp-upload-pin"));
});

$("#amp-robot-upload-form").addEventListener("submit", (event) => {
  event.preventDefault();
  if (!ampPlan || !ampConfirmed) return;
  uploadToRobot({
    button: $("#amp-upload-to-robot"), address: $("#amp-robot-address"), pin: $("#amp-upload-pin"),
    filename: ampPlan.filename, protocol: ampPlan.protocol, worklistId: ampPlan.identifier, report: showAmpStatus
  });
});


if ("ResizeObserver" in window) new ResizeObserver(() => { state.dirty = true; }).observe($(".view-grid"));
else window.addEventListener("resize", () => { state.dirty = true; });
checkSimulator();
requestAnimationFrame(animate);
