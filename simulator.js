"use strict";

// Playback model and renderers for simulation results produced by
// simulation/worker.py. All geometry is in OT-2 deck millimeters: +X to the
// right, +Y toward the back of the robot, +Z up.

const SIM_COLORS = {
  deck: "#29232d", deckEdge: "#76677b", slot: "#171219", slotEdge: "#4f4553", slotText: "#97879c",
  plate: "#d9d4dc", plateEdge: "#928899", tipRack: "#372d3d", well: "#65586a", tip: "#d8b6ff",
  tipUsed: "#211a25", received: "#41d8f2", liquid: "#f000dc", path: "#f000dc", robot: "#e5e2e6",
  collision: "#ff4d6d", warning: "#ffc247", module: "#433a48", trash: "#0e0a10"
};
const DECK_VIEW = { minX: -12, maxX: 412, minY: -12, maxY: 440 };
const INSTANT_STEP_SECONDS = 0.4;
const HOMING_SPEED_MM_S = 125;
const POLLING_CODES = new Set(["M400", "M114.2", "G4"]);

function simEase(t) { return t < .5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; }

function lowerBound(sorted, value, key) {
  let low = 0, high = sorted.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (key(sorted[mid]) <= value) low = mid + 1; else high = mid;
  }
  return low;
}

class SimulationModel {
  constructor(result) {
    this.result = result;
    this.commands = result.commands || [];
    this.labware = result.labware || [];
    this.labwareById = new Map(this.labware.map((lw) => [lw.id, lw]));
    this.modules = result.modules || [];
    this.pipettes = result.pipettes || [];
    this.pipetteByMount = Object.fromEntries(this.pipettes.map((p) => [p.mount, p]));
    this.gcode = result.gcode || [];
    this.safety = result.safety || { status: "pass", counts: {}, findings: [], liquid: { initial: {}, events: [] } };
    this.buildTimeline();
    this.buildGcodeTimes();
    this.buildLiquid();
    this.buildTipPickups();
  }

  buildTimeline() {
    const movesByCommand = new Map();
    for (const move of this.result.moves || []) {
      if (move.command === null || move.command === undefined) continue;
      if (!movesByCommand.has(move.command)) movesByCommand.set(move.command, []);
      movesByCommand.get(move.command).push(move);
    }
    this.steps = [];
    this.stepByCommand = new Map();
    for (const command of this.commands) {
      if (command.setup && !movesByCommand.has(command.index)) continue;
      this.stepByCommand.set(command.index, this.steps.length);
      this.steps.push({ command, segments: [], start: 0, duration: 0 });
    }
    // Findings on hidden setup commands jump to the next visible step.
    this.stepForCommand = (index) => {
      if (index === null || index === undefined) return 0;
      for (let i = index; i < this.commands.length; i += 1) if (this.stepByCommand.has(i)) return this.stepByCommand.get(i);
      return Math.max(0, this.steps.length - 1);
    };

    const firstMove = (this.result.moves || [])[0];
    this.initialPose = firstMove ? { ...firstMove.start } : null;
    this.initialTips = firstMove ? firstMove.tips : {};
    let pose = this.initialPose;
    let time = 0;
    this.segments = [];
    this.estimatedSeconds = 0;
    for (const step of this.steps) {
      step.start = time;
      for (const move of movesByCommand.get(step.command.index) || []) {
        if (pose && posesDiffer(pose, move.start)) {
          // Homing (G28.2) happens outside recorded moves; bridge the gap.
          const seconds = gapSeconds(pose, move.start);
          const gap = { start: pose, end: move.start, seconds, t0: time, tips: move.tips, mount: move.mount, gcode: null, plunger: false };
          step.segments.push(gap); this.segments.push(gap);
          time += seconds; this.estimatedSeconds += seconds;
        }
        const segment = {
          start: move.start, end: move.end, seconds: move.seconds, t0: time, tips: move.tips, mount: move.mount,
          gcode: move.gcode, plunger: plungerMoved(move)
        };
        step.segments.push(segment); this.segments.push(segment);
        time += move.seconds; this.estimatedSeconds += move.seconds;
        pose = move.end;
      }
      let dwell = 0;
      if (step.command.type === "waitForDuration") {
        dwell = Number(step.command.params.seconds) || 0;
        this.estimatedSeconds += dwell;
      }
      if (!step.segments.length && !dwell) dwell = INSTANT_STEP_SECONDS;
      time += dwell;
      step.duration = time - step.start;
    }
    this.totalSeconds = time;
  }

  buildGcodeTimes() {
    const times = new Float64Array(this.gcode.length).fill(NaN);
    for (const segment of this.segments) {
      if (!segment.gcode) continue;
      const [first, last] = segment.gcode;
      const count = Math.max(1, last - first);
      for (let i = first; i < last; i += 1) times[i] = segment.t0 + segment.seconds * (i - first + 1) / count;
    }
    let latest = 0;
    for (let i = 0; i < times.length; i += 1) {
      if (Number.isNaN(times[i])) {
        const stepIndex = this.stepByCommand.get(this.gcode[i][0]);
        times[i] = stepIndex === undefined ? latest : Math.max(latest, this.steps[stepIndex].start);
      }
      times[i] = Math.max(latest, times[i]);
      latest = times[i];
    }
    this.gcodeTimes = times;
  }

  gcodeRevealedAt(t) {
    let low = 0, high = this.gcodeTimes.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (this.gcodeTimes[mid] <= t + 1e-6) low = mid + 1; else high = mid;
    }
    return low;
  }

  buildLiquid() {
    const liquid = this.safety.liquid || { initial: {}, events: [] };
    const colors = new Map((this.result.liquids || []).map((l) => [l.id, l.displayColor]));
    this.initialVolumes = liquid.initial || {};
    this.wellColors = new Map();
    for (const command of this.commands) {
      if (command.type !== "loadLiquid") continue;
      const color = colors.get(command.params.liquidId) || SIM_COLORS.liquid;
      for (const well of Object.keys(command.params.volumeByWell || {})) this.wellColors.set(`${command.params.labwareId}|${well}`, color);
    }
    const lastTips = {};
    this.liquidEvents = (liquid.events || []).map((event) => {
      const stepIndex = this.stepByCommand.get(event.command);
      const step = stepIndex === undefined ? null : this.steps[stepIndex];
      let t0 = step ? step.start + step.duration : 0, t1 = t0;
      if (step) {
        const plungerSegments = step.segments.filter((s) => s.plunger);
        if (plungerSegments.length) {
          const last = plungerSegments[plungerSegments.length - 1];
          t0 = plungerSegments[0].t0;
          t1 = last.t0 + last.seconds;
        }
      }
      const prevTips = lastTips[event.mount] || event.tips.map(() => 0);
      lastTips[event.mount] = event.tips;
      return { ...event, t0, t1, prevTips };
    }).sort((a, b) => a.t0 - b.t0);
  }

  liquidAt(t) {
    const volumes = new Map();
    for (const [labwareId, wells] of Object.entries(this.initialVolumes)) {
      for (const [well, volume] of Object.entries(wells)) volumes.set(`${labwareId}|${well}`, volume);
    }
    const tips = Object.fromEntries(this.pipettes.map((p) => [p.mount, Array(p.channels).fill(0)]));
    for (const event of this.liquidEvents) {
      if (t < event.t0) break;
      const fraction = t >= event.t1 ? 1 : (t - event.t0) / Math.max(1e-6, event.t1 - event.t0);
      for (const change of event.wells) {
        const key = `${change.labware}|${change.well}`;
        volumes.set(key, (volumes.get(key) || 0) + change.delta * fraction);
      }
      tips[event.mount] = event.prevTips.map((before, i) => before + (event.tips[i] - before) * fraction);
    }
    return { volumes, tips };
  }

  buildTipPickups() {
    this.tipPickups = [];
    for (const step of this.steps) {
      const command = step.command;
      if (command.type !== "pickUpTip") continue;
      const wells = this.wellsUnderChannels(command);
      const press = step.segments.find((s) => s.end && s.start && (s.end.Z_L < s.start.Z_L - 5 || s.end.Z_R < s.start.Z_R - 5));
      const time = press ? press.t0 + press.seconds : step.start + step.duration / 2;
      this.tipPickups.push({ time, labware: command.params.labwareId, wells });
    }
  }

  // Wells reached by every channel when the starting nozzle targets params.wellName.
  wellsUnderChannels(command) {
    const lw = this.labwareById.get(command.params.labwareId);
    const pipetteMount = this.mountForPipette(command.params.pipetteId);
    const pipette = this.pipetteByMount[pipetteMount];
    if (!lw || !pipette || !lw.wells[command.params.wellName]) return [];
    const target = lw.wells[command.params.wellName];
    const names = [];
    for (const channel of pipette.channelOffsets) {
      const x = target.x + channel.dx, y = target.y + channel.dy;
      for (const [name, well] of Object.entries(lw.wells)) {
        const reach = well.shape === "circular" ? well.diameter / 2 : Math.min(well.xDim, well.yDim) / 2;
        if (Math.hypot(x - well.x, y - well.y) <= Math.max(reach, 1)) { if (!names.includes(name)) names.push(name); break; }
      }
    }
    return names;
  }

  mountForPipette(pipetteId) {
    if (!this._mounts) {
      this._mounts = new Map();
      for (const command of this.commands) {
        if (command.type === "loadPipette" && command.result.pipetteId) this._mounts.set(command.result.pipetteId, command.params.mount);
      }
    }
    return this._mounts.get(pipetteId);
  }

  usedTipsAt(t) {
    const used = new Map();
    for (const pickup of this.tipPickups) {
      if (pickup.time > t) break;
      if (!used.has(pickup.labware)) used.set(pickup.labware, new Set());
      pickup.wells.forEach((well) => used.get(pickup.labware).add(well));
    }
    return used;
  }

  stepAt(t) {
    const index = lowerBound(this.steps, t, (step) => step.start) - 1;
    return Math.max(0, Math.min(this.steps.length - 1, index));
  }

  poseAt(t) {
    if (!this.segments.length) return { carriage: this.initialPose, tips: this.initialTips || {}, mount: "left", moving: false };
    const index = lowerBound(this.segments, t, (s) => s.t0) - 1;
    if (index < 0) return { carriage: this.segments[0].start, tips: this.segments[0].tips, mount: this.segments[0].mount, moving: false };
    const segment = this.segments[index];
    const raw = segment.seconds > 0 ? (t - segment.t0) / segment.seconds : 1;
    const progress = simEase(Math.max(0, Math.min(1, raw)));
    const carriage = {};
    for (const axis of Object.keys(segment.end)) {
      const from = segment.start[axis] ?? segment.end[axis];
      carriage[axis] = from + (segment.end[axis] - from) * progress;
    }
    return { carriage, tips: segment.tips || {}, mount: segment.mount, moving: raw < 1, segment };
  }

  // Nozzle ends (and tip ends) of every channel of a mount's pipette.
  channelsAt(mount, carriage, tipLength) {
    const pipette = this.pipetteByMount[mount];
    const zAxis = mount === "left" ? "Z_L" : "Z_R";
    if (!pipette || !carriage || carriage[zAxis] === undefined) return [];
    const [mx, my, mz] = pipette.mountOffset, [nx, ny, nz] = pipette.nozzleOffset;
    const x = carriage.X + mx + nx, y = carriage.Y + my + ny, z = carriage[zAxis] + mz + nz;
    return pipette.channelOffsets.map((channel) => ({
      name: channel.name, x: x + channel.dx, y: y + channel.dy, nozzleZ: z, endZ: z - (tipLength || 0)
    }));
  }

  highlightedWells(step) {
    const command = step && step.command;
    if (!command || !command.params.labwareId || !command.params.wellName) return null;
    return { labware: command.params.labwareId, wells: new Set(this.wellsUnderChannels(command)), type: command.type };
  }

  findingsForStep(stepIndex) {
    return this.safety.findings.filter((f) => this.stepForCommand(f.command) === stepIndex);
  }
}

function posesDiffer(a, b) {
  return Object.keys(b).some((axis) => a[axis] !== undefined && Math.abs(a[axis] - b[axis]) > 0.01);
}

function gapSeconds(a, b) {
  const distance = Math.max(...Object.keys(b).map((axis) => (a[axis] === undefined ? 0 : Math.abs(a[axis] - b[axis]))));
  return Math.min(4, distance / HOMING_SPEED_MM_S + 0.25);
}

function plungerMoved(move) {
  return ["P_L", "P_R"].some((axis) => move.start[axis] !== undefined && Math.abs(move.end[axis] - move.start[axis]) > 1e-3);
}

// ---------------------------------------------------------------- rendering

function simRoundedRect(ctx, x, y, w, h, r) {
  const radius = Math.max(0, Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2));
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
  ctx.lineTo(x + radius, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

function wellFill(model, lw, name, well, liquid, usedTips, alpha = 1) {
  if (lw.isTiprack) {
    const used = usedTips.get(lw.id);
    return used && used.has(name) ? SIM_COLORS.tipUsed : SIM_COLORS.tip;
  }
  const key = `${lw.id}|${name}`;
  const volume = liquid.volumes.get(key) || 0;
  if (volume <= 0.01) return SIM_COLORS.well;
  const color = model.wellColors.get(key) || SIM_COLORS.received;
  const fraction = well.volume ? Math.min(1, volume / well.volume) : .5;
  return hexToRgba(color, (.35 + .65 * Math.sqrt(fraction)) * alpha);
}

function hexToRgba(hex, alpha) {
  const value = hex.replace("#", "");
  const full = value.length === 3 ? value.split("").map((c) => c + c).join("") : value.slice(0, 6);
  const n = parseInt(full, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha.toFixed(3)})`;
}

// A protocol's labware label as a tag straddling the back edge of the plate.
// A label too wide for the plate breaks before its "(…)" part, e.g. the antibiotic.
function drawLabwareLabel(ctx, text, centerX, topY, maxWidth) {
  ctx.save();
  ctx.textAlign = "center"; ctx.textBaseline = "bottom";
  const fits = (lines) => lines.every((line) => ctx.measureText(line).width <= maxWidth - 8);
  let lines = [text];
  for (const candidate of [[text], text.split(/ (?=\()/)]) {
    for (const size of [9, 8, 7]) {
      ctx.font = `700 ${size}px system-ui`;
      if (fits(candidate)) { lines = candidate; break; }
    }
    if (fits(candidate)) { lines = candidate; break; }
    lines = candidate;
  }
  lines = lines.map((line) => {
    let cut = line;
    while (cut.length > 4 && ctx.measureText(cut).width > maxWidth - 8) cut = cut.slice(0, -2);
    return cut === line ? line : `${cut.trimEnd()}…`;
  });
  const lineHeight = 11;
  const width = Math.min(maxWidth, Math.max(...lines.map((line) => ctx.measureText(line).width)) + 10);
  simRoundedRect(ctx, centerX - width / 2, topY - 7, width, lines.length * lineHeight + 3, 3);
  ctx.fillStyle = "rgba(12,8,14,.82)"; ctx.fill();
  ctx.fillStyle = "#ffe7a8";
  lines.forEach((line, i) => ctx.fillText(line, centerX, topY - 7 + (i + 1) * lineHeight));
  ctx.restore();
}

function drawTopView(canvas, ctx, model, t) {
  const size = fitCanvas(canvas, ctx);
  ctx.clearRect(0, 0, size.width, size.height);
  const pad = 16;
  const spanX = DECK_VIEW.maxX - DECK_VIEW.minX, spanY = DECK_VIEW.maxY - DECK_VIEW.minY;
  const s = Math.min((size.width - pad * 2) / spanX, (size.height - pad * 2) / spanY);
  const ox = (size.width - spanX * s) / 2, oy = (size.height - spanY * s) / 2;
  const X = (x) => ox + (x - DECK_VIEW.minX) * s;
  const Y = (y) => oy + (DECK_VIEW.maxY - y) * s;

  simRoundedRect(ctx, X(-10), Y(368), 414 * s, 380 * s, 14);
  ctx.fillStyle = SIM_COLORS.deck; ctx.fill(); ctx.strokeStyle = SIM_COLORS.deckEdge; ctx.lineWidth = 1.5; ctx.stroke();

  const deck = (model && model.result.deck) || defaultDeck();
  ctx.font = "600 9px system-ui"; ctx.textAlign = "left";
  for (const slot of deck.slots) {
    simRoundedRect(ctx, X(slot.x), Y(slot.y + slot.yDim), slot.xDim * s, slot.yDim * s, 5);
    ctx.fillStyle = SIM_COLORS.slot; ctx.fill(); ctx.strokeStyle = SIM_COLORS.slotEdge; ctx.lineWidth = 1; ctx.stroke();
    ctx.fillStyle = SIM_COLORS.slotText; ctx.fillText(slot.name, X(slot.x) + 4, Y(slot.y + slot.yDim) + 11);
  }
  const trash = deck.fixedTrash;
  if (trash) {
    simRoundedRect(ctx, X(trash.x), Y(trash.y + trash.yDim), trash.xDim * s, trash.yDim * s, 7);
    ctx.fillStyle = SIM_COLORS.trash; ctx.fill(); ctx.strokeStyle = "#5c5260"; ctx.stroke();
    ctx.fillStyle = "#a094a4"; ctx.textAlign = "center"; ctx.font = "700 8px system-ui";
    ctx.fillText("FIXED TRASH", X(trash.x + trash.xDim / 2), Y(trash.y + trash.yDim / 2)); ctx.textAlign = "left";
  }
  if (!model) return;

  const stepIndex = model.stepAt(t);
  const step = model.steps[stepIndex];
  const liquid = model.liquidAt(t);
  const usedTips = model.usedTipsAt(t);
  const highlight = model.highlightedWells(step);

  for (const module of model.modules) {
    simRoundedRect(ctx, X(module.origin.x), Y(module.origin.y + module.dimensions.y), module.dimensions.x * s, module.dimensions.y * s, 6);
    ctx.fillStyle = SIM_COLORS.module; ctx.fill(); ctx.strokeStyle = "#8a7b90"; ctx.stroke();
  }
  for (const lw of model.labware) {
    const o = lw.origin, d = lw.dimensions;
    ctx.save();
    ctx.shadowColor = "rgba(0,0,0,.45)"; ctx.shadowBlur = 8; ctx.shadowOffsetY = 3;
    simRoundedRect(ctx, X(o.x), Y(o.y + d.y), d.x * s, d.y * s, 5);
    ctx.fillStyle = lw.isTiprack ? SIM_COLORS.tipRack : SIM_COLORS.plate; ctx.fill();
    ctx.restore();
    ctx.strokeStyle = SIM_COLORS.plateEdge; ctx.lineWidth = 1; ctx.stroke();
    const targeted = highlight && highlight.labware === lw.id ? highlight.wells : null;
    for (const [name, well] of Object.entries(lw.wells)) {
      ctx.beginPath();
      if (well.shape === "circular") ctx.arc(X(well.x), Y(well.y), Math.max(1, well.diameter / 2 * s), 0, Math.PI * 2);
      else ctx.rect(X(well.x - well.xDim / 2), Y(well.y + well.yDim / 2), well.xDim * s, well.yDim * s);
      ctx.fillStyle = wellFill(model, lw, name, well, liquid, usedTips);
      ctx.fill();
      if (targeted && targeted.has(name)) {
        ctx.lineWidth = 1.6;
        ctx.strokeStyle = highlight.type.startsWith("dispense") ? SIM_COLORS.received : SIM_COLORS.path;
        ctx.stroke();
      }
    }
    if (lw.label) drawLabwareLabel(ctx, lw.label, X(o.x + d.x / 2), Y(o.y + d.y), d.x * s - 8);
  }

  // Current command path (starting nozzle), then the pipette channels.
  if (step && step.segments.length) {
    ctx.save(); ctx.setLineDash([5, 5]); ctx.strokeStyle = SIM_COLORS.path; ctx.lineWidth = 1.4; ctx.beginPath();
    step.segments.forEach((segment, i) => {
      const a = model.channelsAt(segment.mount, segment.start, 0)[0];
      const b = model.channelsAt(segment.mount, segment.end, 0)[0];
      if (!a || !b) return;
      if (i === 0) ctx.moveTo(X(a.x), Y(a.y));
      ctx.lineTo(X(b.x), Y(b.y));
    });
    ctx.stroke(); ctx.restore();
  }
  const pose = model.poseAt(t);
  for (const pipette of model.pipettes) {
    const channels = model.channelsAt(pipette.mount, pose.carriage, (pose.tips || {})[pipette.mount]);
    if (!channels.length) continue;
    const active = pipette.mount === pose.mount;
    ctx.globalAlpha = active ? 1 : .45;
    if (channels.length > 1) {
      ctx.strokeStyle = SIM_COLORS.path; ctx.lineWidth = 2; ctx.beginPath();
      ctx.moveTo(X(channels[0].x), Y(channels[0].y)); ctx.lineTo(X(channels[channels.length - 1].x), Y(channels[channels.length - 1].y)); ctx.stroke();
    }
    for (const channel of channels) {
      ctx.beginPath(); ctx.arc(X(channel.x), Y(channel.y), Math.max(2.5, 2.2 * s), 0, Math.PI * 2);
      ctx.fillStyle = "rgba(240,0,220,.25)"; ctx.fill(); ctx.strokeStyle = SIM_COLORS.path; ctx.lineWidth = 1.5; ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }
  drawFindingMarkers(ctx, model, stepIndex, (p) => ({ x: X(p.x), y: Y(p.y) }));
}

function drawFindingMarkers(ctx, model, stepIndex, project) {
  for (const finding of model.safety.findings) {
    if (!finding.point || finding.severity === "info") continue;
    const current = model.stepForCommand(finding.command) === stepIndex;
    const p = project(finding.point);
    const size = current ? 7 : 4;
    ctx.save();
    ctx.globalAlpha = current ? 1 : .55;
    ctx.strokeStyle = finding.severity === "error" ? SIM_COLORS.collision : SIM_COLORS.warning;
    ctx.lineWidth = current ? 2.5 : 1.5;
    ctx.beginPath(); ctx.moveTo(p.x - size, p.y - size); ctx.lineTo(p.x + size, p.y + size);
    ctx.moveTo(p.x + size, p.y - size); ctx.lineTo(p.x - size, p.y + size); ctx.stroke();
    if (current) { ctx.beginPath(); ctx.arc(p.x, p.y, size + 5, 0, Math.PI * 2); ctx.stroke(); }
    ctx.restore();
  }
}

function defaultDeck() {
  const slots = [];
  for (let i = 0; i < 11; i += 1) slots.push({ name: String(i + 1), x: (i % 3) * 132.5, y: Math.floor(i / 3) * 90.5, xDim: 128, yDim: 86 });
  return { slots, fixedTrash: { x: 294.285, y: 268.665, xDim: 107.11, yDim: 165.67, zDim: 82 } };
}

// Oblique projection fitted to the deck volume (x -30..430, y -20..440, z 0..290).
const ISO_BOUNDS = { minU: -30 - 440 * .73, maxU: 430 + 20 * .73, minV: -20 * .37, maxV: 440 * .37 + 290 };

function simIso(x, y, z, view) {
  const spanU = ISO_BOUNDS.maxU - ISO_BOUNDS.minU, spanV = ISO_BOUNDS.maxV - ISO_BOUNDS.minV;
  const scale = Math.min(view.width / spanU, view.height / spanV) * .96;
  const u = x - y * .73, v = y * .37 + z;
  return {
    x: view.width / 2 + (u - (ISO_BOUNDS.minU + ISO_BOUNDS.maxU) / 2) * scale,
    y: view.height / 2 - (v - (ISO_BOUNDS.minV + ISO_BOUNDS.maxV) / 2) * scale
  };
}

function simPolygon(ctx, points, fill, stroke) {
  ctx.beginPath(); points.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y))); ctx.closePath();
  ctx.fillStyle = fill; ctx.fill(); if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 1; ctx.stroke(); }
}

function simPrism(ctx, x, y, z, w, d, h, view, colors) {
  const p = (dx, dy, dz) => simIso(x + dx, y + dy, z + dz, view);
  simPolygon(ctx, [p(0, 0, h), p(w, 0, h), p(w, d, h), p(0, d, h)], colors.top, colors.edge);
  simPolygon(ctx, [p(w, 0, 0), p(w, d, 0), p(w, d, h), p(w, 0, h)], colors.side, colors.edge);
  simPolygon(ctx, [p(0, 0, 0), p(w, 0, 0), p(w, 0, h), p(0, 0, h)], colors.front, colors.edge);
}

function drawQuarterView(canvas, ctx, model, t) {
  const view = fitCanvas(canvas, ctx);
  ctx.clearRect(0, 0, view.width, view.height);
  simPrism(ctx, -17, -12, -18, 432, 400, 18, view, { top: "#3c3341", side: "#18111c", front: "#625767", edge: "#130d16" });
  const deck = (model && model.result.deck) || defaultDeck();
  for (const slot of deck.slots) {
    const corners = [[0, 0], [slot.xDim, 0], [slot.xDim, slot.yDim], [0, slot.yDim]].map(([dx, dy]) => simIso(slot.x + dx, slot.y + dy, 0, view));
    simPolygon(ctx, corners, "#241c28", "#4f4553");
  }

  // Draw back-to-front so nearer labware overlaps farther labware.
  const liquid = model ? model.liquidAt(t) : null;
  const usedTips = model ? model.usedTipsAt(t) : new Map();
  const stepIndex = model ? model.stepAt(t) : 0;
  const highlight = model ? model.highlightedWells(model.steps[stepIndex]) : null;
  const items = [];
  if (deck.fixedTrash) items.push({ kind: "trash", x: deck.fixedTrash.x, y: deck.fixedTrash.y, box: deck.fixedTrash });
  if (model) {
    model.modules.forEach((m) => items.push({ kind: "module", x: m.origin.x, y: m.origin.y, module: m }));
    model.labware.forEach((lw) => items.push({ kind: "labware", x: lw.origin.x, y: lw.origin.y, lw }));
  }
  items.sort((a, b) => b.y - a.y || b.x - a.x);
  for (const item of items) {
    if (item.kind === "trash") {
      const b = item.box;
      simPrism(ctx, b.x, b.y, 0, b.xDim, b.yDim, b.zDim, view, { top: "#0d090f", side: "#171019", front: "#241b27", edge: "#625766" });
    } else if (item.kind === "module") {
      const m = item.module;
      simPrism(ctx, m.origin.x, m.origin.y, 0, m.dimensions.x, m.dimensions.y, Math.max(1, m.labwareSeatZ), view, { top: "#554a5a", side: "#2c2430", front: "#3d3342", edge: "#1a131d" });
    } else {
      const lw = item.lw, o = lw.origin, d = lw.dimensions;
      const height = Math.max(1, lw.top - o.z);
      simPrism(ctx, o.x, o.y, o.z, d.x, d.y, height, view, {
        top: lw.isTiprack ? "#403449" : "#cfc9d2", side: "#706675", front: "#887d8c", edge: "#241a29"
      });
      const wells = Object.entries(lw.wells);
      if (wells.length > 400) continue;
      const targeted = highlight && highlight.labware === lw.id ? highlight.wells : null;
      const unit = Math.abs(simIso(1, 0, 0, view).x - simIso(0, 0, 0, view).x);
      const rx = Math.max(1.1, unit * Math.min(3.2, (wells[0][1].diameter || wells[0][1].xDim || 6) / 2));
      for (const [name, well] of wells) {
        const point = simIso(well.x, well.y, lw.top + .4, view);
        ctx.beginPath(); ctx.ellipse(point.x, point.y, rx, rx * .55, 0, 0, Math.PI * 2);
        ctx.fillStyle = wellFill(model, lw, name, well, liquid, usedTips);
        ctx.fill();
        if (targeted && targeted.has(name)) {
          ctx.strokeStyle = highlight.type.startsWith("dispense") ? SIM_COLORS.received : SIM_COLORS.path;
          ctx.lineWidth = 1.2; ctx.stroke();
        }
      }
    }
  }

  // Enclosure posts and gantry beam for scale.
  simPrism(ctx, -30, 420, 0, 18, 18, 330, view, { top: "#263238", side: "#11191d", front: "#303d43", edge: "#0a0f12" });
  simPrism(ctx, 412, -16, 0, 18, 18, 330, view, { top: "#263238", side: "#11191d", front: "#303d43", edge: "#0a0f12" });
  if (!model) return;

  const pose = model.poseAt(t);
  const step = model.steps[stepIndex];
  if (step && step.segments.length) {
    ctx.save(); ctx.strokeStyle = SIM_COLORS.path; ctx.lineWidth = 2; ctx.setLineDash([7, 6]); ctx.beginPath();
    step.segments.forEach((segment, i) => {
      const tip = (segment.tips || {})[segment.mount];
      const a = model.channelsAt(segment.mount, segment.start, tip)[0];
      const b = model.channelsAt(segment.mount, segment.end, tip)[0];
      if (!a || !b) return;
      const pa = simIso(a.x, a.y, a.endZ, view), pb = simIso(b.x, b.y, b.endZ, view);
      if (i === 0) ctx.moveTo(pa.x, pa.y);
      ctx.lineTo(pb.x, pb.y);
    });
    ctx.stroke(); ctx.restore();
  }

  for (const pipette of model.pipettes) {
    const tipLength = (pose.tips || {})[pipette.mount];
    const channels = model.channelsAt(pipette.mount, pose.carriage, tipLength);
    if (!channels.length) continue;
    const top = channels[0], bottom = channels[channels.length - 1];
    const bodyZ = top.nozzleZ + 45;
    simPrism(ctx, top.x - 16, bottom.y - 10, bodyZ, 32, top.y - bottom.y + 20, 90, view,
      pipette.mount === pose.mount
        ? { top: "#e8edef", side: "#6f7d83", front: "#bdc8cc", edge: "#45535a" }
        : { top: "#a9b0b3", side: "#4f585c", front: "#858e92", edge: "#353d41" });
    const tipLiquid = liquid.tips[pipette.mount] || [];
    channels.forEach((channel, index) => {
      const nozzleTop = simIso(channel.x, channel.y, bodyZ, view);
      const nozzle = simIso(channel.x, channel.y, channel.nozzleZ, view);
      ctx.strokeStyle = "#1c2529"; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(nozzleTop.x, nozzleTop.y); ctx.lineTo(nozzle.x, nozzle.y); ctx.stroke();
      if (tipLength) {
        const end = simIso(channel.x, channel.y, channel.endZ, view);
        ctx.strokeStyle = SIM_COLORS.tip; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(nozzle.x, nozzle.y); ctx.lineTo(end.x, end.y); ctx.stroke();
        const fill = Math.min(1, (tipLiquid[index] || 0) / (pipette.maxVolume || 1));
        if (fill > .01) {
          const level = simIso(channel.x, channel.y, channel.endZ + tipLength * fill * .7, view);
          ctx.strokeStyle = SIM_COLORS.liquid; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(end.x, end.y); ctx.lineTo(level.x, level.y); ctx.stroke();
        }
      }
    });
  }
  drawFindingMarkers(ctx, model, stepIndex, (p) => simIso(p.x, p.y, p.z, view));
}

// ---------------------------------------------------------------- G-code

const GCODE_HELP = {
  G0: "Linear move (X/Y gantry, Z left mount, A right mount, B/C plungers; F feed mm/min)",
  G4: "Dwell (P seconds)",
  "G28.2": "Home the listed axes",
  G38: "Probe", G90: "Absolute positioning", G91: "Relative positioning",
  M18: "Disengage motors", M17: "Engage motors",
  M114: "Report position", "M114.2": "Report position from encoders",
  "M203.1": "Set per-axis max speeds (mm/s)", M204: "Set acceleration",
  M369: "Read pipette ID", M371: "Read pipette model",
  M400: "Wait for motion to finish", M907: "Set motor currents (amps)",
  M104: "Set module temperature", M105: "Read module temperature",
  M140: "Set thermocycler lid temperature", M119: "Read module status"
};

function explainGcode(code) {
  const word = code.split(/\s+/)[0];
  return GCODE_HELP[word] || GCODE_HELP[word.replace(/\..*$/, "")] || "";
}

function isPollingGcode(row) {
  return row[4] === 1 || POLLING_CODES.has(row[2].split(/\s+/)[0]);
}

function gcodeFileText(model, filename) {
  const lines = [
    `; G-code captured from Opentrons OT-2 engine ${model.result.engine.opentronsVersion} running ${filename}`,
    "; against an emulated Smoothie motor controller. Default calibration; a calibrated robot differs slightly.",
    ""
  ];
  let lastCommand;
  let started = false;
  for (const row of model.gcode) {
    if (row[0] !== lastCommand) {
      lastCommand = row[0];
      const command = row[0] === null ? null : model.commands[row[0]];
      lines.push(command ? `; [${command.index + 1}] ${command.label}` : started ? "; end of run: reset and home" : "; robot startup");
      started = started || Boolean(command);
    }
    lines.push(`${row[1] === "smoothie" ? "" : `${row[1]}: `}${row[2]}${row[3] ? `  ; -> ${row[3]}` : ""}`);
  }
  return lines.join("\n") + "\n";
}
