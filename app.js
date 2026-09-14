"use strict";

const COLORS = {
  deck: "#1b252b", deckEdge: "#61727a", slot: "#111a1f", slotEdge: "#34454e",
  plate: "#d6e0e4", plateEdge: "#82949c", well: "#31434d", source: "#ffc247",
  destination: "#20d4e6", liquid: "#1aaee8", tip: "#e9f4cf", robot: "#dbe2e5",
  robotShade: "#87969d", dark: "#071017", path: "#25d8ea"
};

// OT-2 deck and labware geometry, in millimeters. Labware coordinates are
// taken from the official Opentrons definitions bundled for these load names.
const MOTION = {
  slotPitchX: 132.5,
  slotPitchY: 90.5,
  deckOffsetX: 115.65,
  deckOffsetY: 68.03,
  wellA1X: 14.38,
  wellA1Y: 74.24,
  wellPitch: 9,
  sourceBottomZ: 1.05,
  destinationBottomZ: 3.55,
  bottomClearance: 1,
  tipRackTopZ: 64.69,
  tipOverlap: 8.25,
  exposedTipLength: 30.95,
  safeZ: 111,
  gantrySpeed: 400,
  gantryAcceleration: 1000,
  zSpeed: 125,
  zAcceleration: 500,
  aspirateFlowRate: 7.6,
  dispenseFlowRate: 7.6,
  pickupSeconds: 3.5,
  dropSeconds: 2,
  commandSettleSeconds: 0.15
};

const $ = (selector) => document.querySelector(selector);
const topCanvas = $("#top-canvas");
const quarterCanvas = $("#quarter-canvas");
const topCtx = topCanvas.getContext("2d");
const quarterCtx = quarterCanvas.getContext("2d");

const state = {
  initialVolume: 130,
  stepIndex: 0,
  progress: 0,
  playing: false,
  speed: 1,
  lastTime: 0,
  steps: [],
  uploadedSource: ""
};

function destinationFor(sourceIndex) {
  const plate = Math.floor(sourceIndex / 3);
  const firstColumn = (sourceIndex % 3) * 4;
  return { plate, columns: [firstColumn, firstColumn + 1, firstColumn + 2, firstColumn + 3] };
}

function makeDeckLocation(kind, slot, column = 0) { return { kind, slot, column }; }

function buildSteps() {
  const steps = [];
  for (let source = 0; source < 12; source += 1) {
    const dest = destinationFor(source);
    const sourceLoc = makeDeckLocation("source", 5, source);
    const tipLoc = makeDeckLocation("tips", 6, source);
    const destLoc = (index) => makeDeckLocation("destination", dest.plate + 1, dest.columns[index]);
    const meta = { source, plate: dest.plate, columns: dest.columns };
    steps.push(
      { ...meta, type: "pickup", label: `Pick up 8 tips · rack column ${source + 1}`, volume: 0, location: tipLoc },
      { ...meta, type: "aspirate", label: `Aspirate 20 µL · source column ${source + 1}`, volume: 20, location: sourceLoc },
      { ...meta, type: "dispense", label: `Dispense 10 µL · plate ${dest.plate + 1}, column ${dest.columns[0] + 1}`, volume: 10, destColumn: dest.columns[0], location: destLoc(0) },
      { ...meta, type: "dispense", label: `Dispense 10 µL · plate ${dest.plate + 1}, column ${dest.columns[1] + 1}`, volume: 10, destColumn: dest.columns[1], location: destLoc(1) },
      { ...meta, type: "aspirate", label: `Aspirate 20 µL · source column ${source + 1}`, volume: 20, location: sourceLoc },
      { ...meta, type: "dispense", label: `Dispense 10 µL · plate ${dest.plate + 1}, column ${dest.columns[2] + 1}`, volume: 10, destColumn: dest.columns[2], location: destLoc(2) },
      { ...meta, type: "dispense", label: `Dispense 10 µL · plate ${dest.plate + 1}, column ${dest.columns[3] + 1}`, volume: 10, destColumn: dest.columns[3], location: destLoc(3) },
      { ...meta, type: "drop", label: "Drop 8 tips · fixed trash", volume: 0, location: makeDeckLocation("trash", 12, 0) }
    );
  }
  state.steps = steps;
}

function derivedState() {
  const sources = Array.from({ length: 12 }, () => state.initialVolume);
  const destinations = Array.from({ length: 4 }, () => Array(12).fill(0));
  const usedTipColumns = new Set();
  let tipsAttached = false;
  let tipVolume = 0;

  state.steps.forEach((step, index) => {
    let fraction = index < state.stepIndex ? 1 : 0;
    if (index === state.stepIndex) {
      const plan = actionPlan(index);
      const operationStart = plan.retract + plan.traverse + plan.descend;
      const elapsed = state.progress * plan.total;
      fraction = plan.operation ? Math.max(0, Math.min(1, (elapsed - operationStart) / plan.operation)) : 1;
    }
    if (fraction <= 0) return;
    if (step.type === "pickup") {
      tipsAttached = fraction > 0.45;
      if (fraction > 0.45) usedTipColumns.add(step.source);
    } else if (step.type === "aspirate") {
      sources[step.source] -= step.volume * fraction;
      tipVolume += step.volume * fraction;
    } else if (step.type === "dispense") {
      destinations[step.plate][step.destColumn] += step.volume * fraction;
      tipVolume -= step.volume * fraction;
    } else if (step.type === "drop" && fraction > 0.6) {
      tipsAttached = false;
    }
  });

  return { sources, destinations, usedTipColumns, tipsAttached, tipVolume: Math.max(0, tipVolume) };
}

function previousLocation() {
  if (state.stepIndex === 0) return makeDeckLocation("home", 12, 0);
  return state.steps[state.stepIndex - 1].location;
}

function ease(t) { return t < .5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; }

function workHeight(loc) {
  if (loc.kind === "source") return MOTION.sourceBottomZ + MOTION.bottomClearance + MOTION.exposedTipLength;
  if (loc.kind === "destination") return MOTION.destinationBottomZ + MOTION.bottomClearance + MOTION.exposedTipLength;
  if (loc.kind === "tips") return MOTION.tipRackTopZ - MOTION.tipOverlap;
  if (loc.kind === "trash") return 80;
  return MOTION.safeZ;
}

function trapezoidSeconds(distance, maxSpeed, acceleration) {
  const d = Math.max(0, distance);
  if (!d) return 0;
  const distanceToMax = maxSpeed * maxSpeed / acceleration;
  if (d <= distanceToMax) return 2 * Math.sqrt(d / acceleration);
  return 2 * maxSpeed / acceleration + (d - distanceToMax) / maxSpeed;
}

function operationSeconds(step) {
  if (step.type === "aspirate") return step.volume / MOTION.aspirateFlowRate + MOTION.commandSettleSeconds;
  if (step.type === "dispense") return step.volume / MOTION.dispenseFlowRate + MOTION.commandSettleSeconds;
  if (step.type === "pickup") return MOTION.pickupSeconds;
  if (step.type === "drop") return MOTION.dropSeconds;
  return MOTION.commandSettleSeconds;
}

function actionPlan(index) {
  const step = state.steps[index];
  const previous = index === 0 ? makeDeckLocation("home", 12, 0) : state.steps[index - 1].location;
  const from = deckCoordinate(previous);
  const to = deckCoordinate(step.location);
  const fromZ = index === 0 ? MOTION.safeZ : workHeight(previous);
  const toZ = workHeight(step.location);
  const retract = trapezoidSeconds(MOTION.safeZ - fromZ, MOTION.zSpeed, MOTION.zAcceleration);
  const xyDistance = Math.hypot(to.x - from.x, to.y - from.y);
  const traverse = trapezoidSeconds(xyDistance, MOTION.gantrySpeed, MOTION.gantryAcceleration);
  const descend = trapezoidSeconds(MOTION.safeZ - toZ, MOTION.zSpeed, MOTION.zAcceleration);
  const operation = operationSeconds(step);
  const total = retract + traverse + descend + operation;
  return { step, from, to, fromZ, toZ, retract, traverse, descend, operation, total };
}

function protocolSeconds() {
  return state.steps.reduce((sum, _step, index) => sum + actionPlan(index).total, 0);
}

function elapsedProtocolSeconds() {
  let elapsed = 0;
  for (let index = 0; index < state.stepIndex; index += 1) elapsed += actionPlan(index).total;
  return elapsed + actionPlan(state.stepIndex).total * state.progress;
}

function pipettePose() {
  const plan = actionPlan(state.stepIndex);
  const seconds = state.progress * plan.total;
  let x = plan.from.x, y = plan.from.y, z = plan.fromZ;
  if (seconds < plan.retract && plan.retract) {
    z = plan.fromZ + (MOTION.safeZ - plan.fromZ) * ease(seconds / plan.retract);
  } else if (seconds < plan.retract + plan.traverse && plan.traverse) {
    const p = ease((seconds - plan.retract) / plan.traverse);
    x = plan.from.x + (plan.to.x - plan.from.x) * p;
    y = plan.from.y + (plan.to.y - plan.from.y) * p;
    z = MOTION.safeZ;
  } else if (seconds < plan.retract + plan.traverse + plan.descend && plan.descend) {
    const p = ease((seconds - plan.retract - plan.traverse) / plan.descend);
    x = plan.to.x; y = plan.to.y;
    z = MOTION.safeZ + (plan.toZ - MOTION.safeZ) * p;
  } else {
    x = plan.to.x; y = plan.to.y; z = plan.toZ;
  }
  return { x, y, z, current: plan.step };
}

function deckCoordinate(loc) {
  if (loc.kind === "home") return { x: 355, y: 342 };
  if (loc.kind === "trash") return { x: 351.4, y: 342 };
  const col = (loc.slot - 1) % 3;
  const row = Math.floor((loc.slot - 1) / 3);
  const x = col * MOTION.slotPitchX + 64;
  const y = row * MOTION.slotPitchY + 43;
  if (["source", "destination", "tips"].includes(loc.kind)) {
    return {
      x: col * MOTION.slotPitchX + MOTION.wellA1X + loc.column * MOTION.wellPitch,
      y: row * MOTION.slotPitchY + MOTION.wellA1Y
    };
  }
  return { x, y };
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

function roundedRect(ctx, x, y, w, h, r) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  // Manual path instead of CanvasRenderingContext2D.roundRect(), which is
  // unavailable in some Safari and managed Ubuntu browser installations.
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

function slotPosition(slot, box) {
  const col = (slot - 1) % 3;
  const physicalRow = Math.floor((slot - 1) / 3);
  const displayRow = 3 - physicalRow;
  return { x: box.x + col * box.slotW, y: box.y + displayRow * box.slotH };
}

function drawPlateTop(ctx, x, y, w, h, type, values, highlightedColumns = []) {
  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,.45)"; ctx.shadowBlur = 10; ctx.shadowOffsetY = 4;
  roundedRect(ctx, x, y, w, h, 7); ctx.fillStyle = type === "tips" ? "#303a31" : COLORS.plate; ctx.fill();
  ctx.shadowColor = "transparent"; ctx.strokeStyle = COLORS.plateEdge; ctx.lineWidth = 1; ctx.stroke();
  const padX = w * .09, padY = h * .12;
  const dx = (w - 2 * padX) / 11, dy = (h - 2 * padY) / 7;
  for (let col = 0; col < 12; col += 1) {
    for (let row = 0; row < 8; row += 1) {
      const cx = x + padX + col * dx, cy = y + padY + row * dy;
      const active = highlightedColumns.includes(col);
      const radius = Math.max(1.5, Math.min(dx, dy) * .31);
      ctx.beginPath(); ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      if (type === "tips") {
        const used = values.has(col);
        ctx.fillStyle = used ? "#182126" : "#d7e64a";
      } else if (type === "source") {
        const volume = values[col];
        const alpha = .22 + .72 * Math.max(0, volume) / state.initialVolume;
        ctx.fillStyle = `rgba(255, 194, 71, ${alpha})`;
      } else {
        const volume = values[col];
        ctx.fillStyle = volume > 0 ? `rgba(32, 212, 230, ${.25 + volume / 16})` : "#71848d";
      }
      ctx.fill();
      ctx.lineWidth = active ? 1.5 : .6;
      ctx.strokeStyle = active ? (type === "source" ? COLORS.source : COLORS.destination) : "rgba(9,25,33,.65)";
      ctx.stroke();
    }
  }
  ctx.restore();
}

function drawTop() {
  const size = fitCanvas(topCanvas, topCtx); const ctx = topCtx;
  ctx.clearRect(0, 0, size.width, size.height);
  const margin = 22;
  const deckW = Math.min(size.width - margin * 2, (size.height - margin * 2) * .79);
  const deckH = Math.min(size.height - margin * 2, deckW / .79);
  const x = (size.width - deckW) / 2, y = (size.height - deckH) / 2;
  const box = { x: x + deckW * .07, y: y + deckH * .06, slotW: deckW * .286, slotH: deckH * .224 };
  roundedRect(ctx, x, y, deckW, deckH, 16); ctx.fillStyle = COLORS.deck; ctx.fill();
  ctx.strokeStyle = COLORS.deckEdge; ctx.lineWidth = 2; ctx.stroke();
  ctx.fillStyle = "#83939a"; ctx.font = "600 9px system-ui"; ctx.textAlign = "left";
  const liquids = derivedState(); const current = state.steps[state.stepIndex];

  for (let slot = 1; slot <= 12; slot += 1) {
    const p = slotPosition(slot, box); const sw = box.slotW * .92, sh = box.slotH * .84;
    ctx.fillStyle = "#72828a"; ctx.fillText(String(slot), p.x + 2, p.y + 10);
    roundedRect(ctx, p.x + 10, p.y + 3, sw - 12, sh - 5, 6); ctx.fillStyle = COLORS.slot; ctx.fill(); ctx.strokeStyle = COLORS.slotEdge; ctx.stroke();
    const lx = p.x + 14, ly = p.y + 7, lw = sw - 20, lh = sh - 13;
    if (slot >= 1 && slot <= 4) {
      const highlighted = current.plate === slot - 1 ? current.columns : [];
      drawPlateTop(ctx, lx, ly, lw, lh, "destination", liquids.destinations[slot - 1], highlighted);
    } else if (slot === 5) {
      drawPlateTop(ctx, lx, ly, lw, lh, "source", liquids.sources, [current.source]);
    } else if (slot === 6) {
      drawPlateTop(ctx, lx, ly, lw, lh, "tips", liquids.usedTipColumns, current.type === "pickup" ? [current.source] : []);
    } else if (slot === 12) {
      roundedRect(ctx, lx, ly, lw, lh, 7); ctx.fillStyle = "#080c0f"; ctx.fill(); ctx.strokeStyle = "#47555b"; ctx.stroke();
      ctx.fillStyle = "#87979f"; ctx.textAlign = "center"; ctx.font = "700 8px system-ui"; ctx.fillText("FIXED TRASH", lx + lw / 2, ly + lh / 2 + 3); ctx.textAlign = "left";
    }
  }

  const pose = pipettePose();
  const px = box.x + pose.x / 397.5 * box.slotW * 3;
  const py = box.y + (4 - pose.y / MOTION.slotPitchY) * box.slotH;
  ctx.save(); ctx.setLineDash([5, 5]); ctx.strokeStyle = COLORS.path; ctx.lineWidth = 1.5;
  const dest = deckCoordinate(current.location); const prev = deckCoordinate(previousLocation());
  ctx.beginPath();
  ctx.moveTo(box.x + prev.x / 397.5 * box.slotW * 3, box.y + (4 - prev.y / MOTION.slotPitchY) * box.slotH);
  ctx.lineTo(box.x + dest.x / 397.5 * box.slotW * 3, box.y + (4 - dest.y / MOTION.slotPitchY) * box.slotH); ctx.stroke();
  ctx.setLineDash([]); ctx.beginPath(); ctx.arc(px, py, 9, 0, Math.PI * 2); ctx.fillStyle = "rgba(32,212,230,.18)"; ctx.fill(); ctx.strokeStyle = COLORS.path; ctx.lineWidth = 2; ctx.stroke();
  if (["source", "destination", "tips"].includes(current.location.kind)) {
    const pyH = box.y + (4 - (pose.y - 7 * MOTION.wellPitch) / MOTION.slotPitchY) * box.slotH;
    ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(px, pyH); ctx.strokeStyle = COLORS.path; ctx.lineWidth = 2; ctx.stroke();
  }
  ctx.beginPath(); ctx.arc(px, py, 2.5, 0, Math.PI * 2); ctx.fillStyle = COLORS.path; ctx.fill(); ctx.restore();
}

function isoProject(x, y, z, view) {
  const scale = Math.min(view.width / 610, view.height / 455);
  return {
    x: view.width * .49 + (x - y * .73) * scale,
    y: view.height * .79 - (y * .37 + z) * scale
  };
}

function polygon(ctx, points, fill, stroke = null) {
  ctx.beginPath(); points.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)); ctx.closePath();
  ctx.fillStyle = fill; ctx.fill(); if (stroke) { ctx.strokeStyle = stroke; ctx.stroke(); }
}

function prism(ctx, x, y, z, w, d, h, view, colors) {
  const p = (dx, dy, dz) => isoProject(x + dx, y + dy, z + dz, view);
  polygon(ctx, [p(0,0,h), p(w,0,h), p(w,d,h), p(0,d,h)], colors.top, colors.edge);
  polygon(ctx, [p(w,0,0), p(w,d,0), p(w,d,h), p(w,0,h)], colors.side, colors.edge);
  polygon(ctx, [p(0,d,0), p(w,d,0), p(w,d,h), p(0,d,h)], colors.front, colors.edge);
}

function drawPlateIso(ctx, slot, type, values, highlighted, view) {
  const col = (slot - 1) % 3, row = Math.floor((slot - 1) / 3);
  const x = col * MOTION.slotPitchX, y = row * MOTION.slotPitchY;
  const h = type === "tips" ? 64.69 : type === "source" ? 16 : 14.22;
  prism(ctx, x, y, 0, 127.76, 85.48, h, view, { top: type === "tips" ? "#39443a" : "#bfcbd0", side: "#65757c", front: "#778890", edge: "#17242b" });
  for (let c = 0; c < 12; c += 1) {
    for (let r = 0; r < 8; r += 1) {
      const point = isoProject(x + MOTION.wellA1X + c * MOTION.wellPitch, y + MOTION.wellA1Y - r * MOTION.wellPitch, h + .6, view);
      const rx = Math.max(1.3, view.width / 720 * 2.2), ry = rx * .55;
      ctx.beginPath(); ctx.ellipse(point.x, point.y, rx, ry, 0, 0, Math.PI * 2);
      if (type === "tips") ctx.fillStyle = values.has(c) ? "#263139" : "#ddea55";
      else if (type === "source") ctx.fillStyle = `rgba(255,194,71,${.3 + values[c] / 200})`;
      else ctx.fillStyle = values[c] > 0 ? "#20d4e6" : "#6d7f87";
      ctx.fill();
      if (highlighted.includes(c)) { ctx.strokeStyle = type === "source" ? COLORS.source : COLORS.destination; ctx.lineWidth = 1.2; ctx.stroke(); }
    }
  }
}

function drawQuarter() {
  const view = fitCanvas(quarterCanvas, quarterCtx); const ctx = quarterCtx;
  ctx.clearRect(0, 0, view.width, view.height);
  const liquids = derivedState(); const current = state.steps[state.stepIndex];
  const deckCorners = [[0,0],[397.5,0],[397.5,362],[0,362]].map(([x,y]) => isoProject(x,y,0,view));
  polygon(ctx, deckCorners, "#222d32", "#74848b");
  prism(ctx, -17, -12, -18, 432, 392, 18, view, { top: "#334047", side: "#121a1e", front: "#536168", edge: "#11191d" });

  for (let row = 3; row >= 0; row -= 1) {
    for (let col = 2; col >= 0; col -= 1) {
      const slot = row * 3 + col + 1;
      if (slot >= 1 && slot <= 4) drawPlateIso(ctx, slot, "destination", liquids.destinations[slot - 1], current.plate === slot - 1 ? current.columns : [], view);
      if (slot === 5) drawPlateIso(ctx, slot, "source", liquids.sources, [current.source], view);
      if (slot === 6) drawPlateIso(ctx, slot, "tips", liquids.usedTipColumns, current.type === "pickup" ? [current.source] : [], view);
      if (slot === 12) prism(ctx, col * 132.5 + 8, row * 90.5 + 5, 4, 118, 78, 48, view, { top: "#070b0d", side: "#11181c", front: "#1c252a", edge: "#56656b" });
    }
  }

  // OT-2 enclosure posts and upper gantry.
  prism(ctx, -30, 355, 0, 22, 22, 365, view, { top: "#263238", side: "#11191d", front: "#303d43", edge: "#0a0f12" });
  prism(ctx, 405, -6, 0, 22, 22, 365, view, { top: "#263238", side: "#11191d", front: "#303d43", edge: "#0a0f12" });
  prism(ctx, -20, 18, 300, 445, 28, 56, view, { top: "#f1f3f3", side: "#8d9ba1", front: "#dbe1e3", edge: "#65747b" });

  const pose = pipettePose();
  const bodyX = pose.x - 20, bodyY = pose.y - 42;
  prism(ctx, bodyX, bodyY, pose.z + 55, 40, 26, 76, view, { top: "#e8edef", side: "#6f7d83", front: "#bdc8cc", edge: "#45535a" });
  for (let channel = 0; channel < 8; channel += 1) {
    const channelY = pose.y - channel * MOTION.wellPitch;
    const tipPoint = isoProject(pose.x, channelY, pose.z, view);
    const barrel = isoProject(pose.x, channelY, pose.z + 64, view);
    ctx.strokeStyle = "#1c2529"; ctx.lineWidth = 4; ctx.beginPath(); ctx.moveTo(barrel.x, barrel.y); ctx.lineTo(tipPoint.x, tipPoint.y); ctx.stroke();
    if (liquids.tipsAttached) {
      const end = isoProject(pose.x, channelY, pose.z - MOTION.exposedTipLength, view);
      ctx.strokeStyle = COLORS.tip; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(tipPoint.x, tipPoint.y); ctx.lineTo(end.x, end.y); ctx.stroke();
      if (liquids.tipVolume > 0) { ctx.strokeStyle = COLORS.liquid; ctx.lineWidth = 1.2; ctx.beginPath(); ctx.moveTo(end.x, end.y); ctx.lineTo(tipPoint.x, tipPoint.y); ctx.stroke(); }
    }
  }

  const plan = actionPlan(state.stepIndex);
  const pathPoints = [
    isoProject(plan.from.x, plan.from.y, plan.fromZ, view),
    isoProject(plan.from.x, plan.from.y, MOTION.safeZ, view),
    isoProject(plan.to.x, plan.to.y, MOTION.safeZ, view),
    isoProject(plan.to.x, plan.to.y, plan.toZ, view)
  ];
  ctx.save(); ctx.strokeStyle = COLORS.path; ctx.lineWidth = 2; ctx.setLineDash([7,6]); ctx.beginPath();
  pathPoints.forEach((point, index) => index ? ctx.lineTo(point.x, point.y) : ctx.moveTo(point.x, point.y));
  ctx.stroke(); ctx.restore();

  const mmX = MOTION.deckOffsetX + pose.x, mmY = MOTION.deckOffsetY + pose.y;
  $("#telemetry-x").textContent = mmX.toFixed(1);
  $("#telemetry-y").textContent = mmY.toFixed(1);
  $("#telemetry-z").textContent = pose.z.toFixed(1);
  $("#tip-volume").textContent = `${liquids.tipVolume.toFixed(liquids.tipVolume % 1 ? 1 : 0)} µL × 8`;
  $("#tip-fill").style.width = `${Math.min(100, liquids.tipVolume / 20 * 100)}%`;
}

function renderStepList() {
  const list = $("#step-list");
  const start = Math.max(0, Math.min(state.steps.length - 8, state.stepIndex - 3));
  list.innerHTML = state.steps.slice(start, start + 8).map((step, offset) => {
    const index = start + offset;
    return `<div class="step-row ${index === state.stepIndex ? "active" : index < state.stepIndex ? "done" : ""}"><span class="num">${String(index + 1).padStart(2,"0")}</span><span class="label">${step.label}</span><span class="amount">${step.volume ? `${step.volume} µL ×8` : ""}</span></div>`;
  }).join("");
}

function updateUI() {
  const step = state.steps[state.stepIndex];
  $("#step-fraction").textContent = `${state.stepIndex + 1} / ${state.steps.length}`;
  $("#timeline").value = state.stepIndex;
  $("#current-action").textContent = step.label;
  $("#cycle-label").textContent = `Source ${step.source + 1}/12 · Plate ${step.plate + 1} · Dest. ${step.columns[0] + 1}–${step.columns[3] + 1}`;
  updateTimeDisplay();
  $("#play-button").textContent = state.playing ? "Ⅱ" : "▶";
  renderStepList();
}

function formatDuration(seconds) {
  const rounded = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(rounded / 60);
  const remainder = rounded % 60;
  return `${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
}

function updateTimeDisplay() {
  $("#time-label").textContent = `${formatDuration(elapsedProtocolSeconds())} / ~${formatDuration(protocolSeconds())}`;
}

function draw() { drawTop(); drawQuarter(); }

function setStep(index, progress = 0) {
  state.stepIndex = Math.max(0, Math.min(state.steps.length - 1, index));
  state.progress = progress; updateUI(); draw();
}

function showRenderError(error) {
  state.playing = false;
  const notice = $("#protocol-notice");
  notice.hidden = false;
  notice.classList.add("error");
  notice.textContent = `Renderer error: ${error.message}. Reload after updating the app, or copy this message for troubleshooting.`;
  console.error(error);
}

function animate(time) {
  if (!state.lastTime) state.lastTime = time;
  const delta = time - state.lastTime; state.lastTime = time;
  if (state.playing) {
    state.progress += delta * state.speed / (actionPlan(state.stepIndex).total * 1000);
    if (state.progress >= 1) {
      if (state.stepIndex >= state.steps.length - 1) { state.progress = 1; state.playing = false; }
      else { state.stepIndex += 1; state.progress = 0; updateUI(); }
    }
    updateTimeDisplay();
  }
  try {
    draw();
    requestAnimationFrame(animate);
  } catch (error) {
    showRenderError(error);
  }
}

function parseProtocol(text, filename) {
  if (!/from\s+opentrons\s+import\s+protocol_api/.test(text) || !/load_instrument\s*\(/.test(text)) {
    throw new Error("This file does not look like an Opentrons Python API protocol.");
  }
  const nameMatch = text.match(/["']protocolName["']\s*:\s*["']([^"']+)/);
  const apiMatch = text.match(/["']apiLevel["']\s*:\s*["']([^"']+)/);
  const robotMatch = text.match(/["']robotType["']\s*:\s*["']([^"']+)/);
  const name = nameMatch ? nameMatch[1] : "";
  const api = apiMatch ? apiMatch[1] : "unknown";
  const robot = robotMatch ? robotMatch[1] : "OT-2";
  const gantryMatch = text.match(/\.default_speed\s*=\s*([0-9.]+)/);
  const aspirateFlowMatch = text.match(/\.flow_rate\.aspirate\s*=\s*([0-9.]+)/);
  const dispenseFlowMatch = text.match(/\.flow_rate\.dispense\s*=\s*([0-9.]+)/);
  const initialVolumeMatch = text.match(/load_liquid\s*\([\s\S]*?volume\s*=\s*([0-9.]+)/);
  MOTION.gantrySpeed = gantryMatch ? Number(gantryMatch[1]) : 400;
  MOTION.aspirateFlowRate = aspirateFlowMatch ? Number(aspirateFlowMatch[1]) : 7.6;
  MOTION.dispenseFlowRate = dispenseFlowMatch ? Number(dispenseFlowMatch[1]) : 7.6;
  if (initialVolumeMatch) {
    state.initialVolume = Number(initialVolumeMatch[1]);
    $("#start-volume").value = state.initialVolume;
  }
  $("#gantry-assumption").textContent = `${MOTION.gantrySpeed} mm/s`;
  $("#flow-assumption").textContent = `${MOTION.aspirateFlowRate}/${MOTION.dispenseFlowRate} µL/s`;
  $("#file-name").textContent = filename;
  $("#file-name").nextElementSibling.textContent = `Python API ${api} · ${robot}`;
  if (name) $("#protocol-title").textContent = name.replace(" - PCR Plate to Omnitrays", "");
  const notice = $("#protocol-notice");
  const hasExpectedLayout = /source_plate[\s\S]*?\b5\s*\)/.test(text) && /tiprack[\s\S]*?\b6\s*\)/.test(text) && /\[1\s*,\s*2\s*,\s*3\s*,\s*4\]/.test(text);
  const hasFlattenBug = /for\s+col\s+in\s+dest_columns\s+for\s+well\s+in\s+col/.test(text);
  notice.hidden = false;
  if (!hasExpectedLayout) {
    notice.textContent = "Uploaded successfully. This prototype currently renders the colony-rearray deck template; broader Python protocol parsing is the next integration step.";
  } else if (hasFlattenBug) {
    notice.textContent = "Column-selection issue detected. Previewing intended A-row primary targets across four destination columns.";
  } else {
    notice.textContent = "Protocol layout recognized. Preview generated locally.";
  }
  state.uploadedSource = text;
  setStep(0, 0);
}

$("#play-button").addEventListener("click", () => { if (state.stepIndex === state.steps.length - 1 && state.progress === 1) setStep(0,0); state.playing = !state.playing; updateUI(); });
$("#restart-button").addEventListener("click", () => { state.playing = false; setStep(0,0); });
$("#previous-button").addEventListener("click", () => { state.playing = false; setStep(state.stepIndex - 1,0); });
$("#next-button").addEventListener("click", () => { state.playing = false; setStep(state.stepIndex + 1,0); });
$("#timeline").addEventListener("input", (event) => { state.playing = false; setStep(Number(event.target.value),0); });
$("#speed-select").addEventListener("change", (event) => { state.speed = Number(event.target.value); });
$("#start-volume").addEventListener("change", (event) => {
  state.initialVolume = Math.max(40, Math.min(200, Number(event.target.value) || 130));
  event.target.value = state.initialVolume; $(".run-status .cyan").parentElement.innerHTML = `<i class="cyan"></i><strong>Liquid tracking</strong> ${state.initialVolume} µL initial`; draw();
});
function readLocalFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error || new Error("Unable to read this protocol file."));
    reader.readAsText(file);
  });
}

$("#protocol-file").addEventListener("change", async (event) => {
  const file = event.target.files[0]; if (!file) return;
  try { parseProtocol(await readLocalFile(file), file.name); }
  catch (error) { const notice = $("#protocol-notice"); notice.hidden = false; notice.textContent = error.message; }
});

buildSteps(); updateUI();
if ("ResizeObserver" in window) new ResizeObserver(draw).observe($(".view-grid"));
else window.addEventListener("resize", draw);
requestAnimationFrame(animate);
