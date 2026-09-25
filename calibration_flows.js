"use strict";

// OT-2 robot calibration flows, rebuilt from Opentrons robot-server
// (robot_server/robot/calibration/{deck,tip_length,pipette_offset,check}).
// State names, command names, and transitions match robot-server, so the
// calibration screen can drive either PracticeRobot (below) or, later, a real
// robot's /sessions API with the same commands.
//
// PracticeRobot stands in for the robot. Its deck, pipette mounts, and tips
// differ from nominal by hidden amounts; calibrations measure those amounts
// from where the operator jogs, exactly as the real flows do. LiveRobot sends
// the same commands to an OT-2 through server.py's /api/ot2/calibration.
// Geometry is in deck millimeters (+X right, +Y back, +Z up) from Opentrons
// definitions.

const CAL_CMD = {
  loadLabware: "calibration.loadLabware",
  jog: "calibration.jog",
  setHasCalibrationBlock: "calibration.setHasCalibrationBlock",
  moveToTipRack: "calibration.moveToTipRack",
  moveToPointOne: "calibration.moveToPointOne",
  moveToDeck: "calibration.moveToDeck",
  moveToReferencePoint: "calibration.moveToReferencePoint",
  pickUpTip: "calibration.pickUpTip",
  invalidateTip: "calibration.invalidateTip",
  saveOffset: "calibration.saveOffset",
  exit: "calibration.exitSession",
  invalidateLastAction: "calibration.invalidateLastAction",
  moveToPointTwo: "calibration.deck.moveToPointTwo",
  moveToPointThree: "calibration.deck.moveToPointThree",
  comparePoint: "calibration.check.comparePoint",
  switchPipette: "calibration.check.switchPipette",
  returnTip: "calibration.check.returnTip",
  transition: "calibration.check.transition"
};

// robot-server state machines; every flow also accepts exitSession from any state.
const CAL_TRANSITIONS = (() => {
  const c = CAL_CMD;
  return {
    deckCalibration: {
      sessionStarted: { [c.loadLabware]: "labwareLoaded" },
      labwareLoaded: { [c.moveToTipRack]: "preparingPipette" },
      preparingPipette: { [c.jog]: "preparingPipette", [c.pickUpTip]: "inspectingTip", [c.moveToTipRack]: "preparingPipette", [c.invalidateLastAction]: "preparingPipette" },
      inspectingTip: { [c.invalidateTip]: "preparingPipette", [c.moveToDeck]: "joggingToDeck" },
      joggingToDeck: { [c.jog]: "joggingToDeck", [c.saveOffset]: "joggingToDeck", [c.moveToPointOne]: "savingPointOne", [c.invalidateLastAction]: "preparingPipette" },
      savingPointOne: { [c.jog]: "savingPointOne", [c.saveOffset]: "savingPointOne", [c.moveToPointTwo]: "savingPointTwo", [c.invalidateLastAction]: "preparingPipette" },
      savingPointTwo: { [c.jog]: "savingPointTwo", [c.saveOffset]: "savingPointTwo", [c.moveToPointThree]: "savingPointThree", [c.invalidateLastAction]: "preparingPipette" },
      savingPointThree: { [c.jog]: "savingPointThree", [c.saveOffset]: "savingPointThree", [c.moveToTipRack]: "calibrationComplete", [c.invalidateLastAction]: "preparingPipette" }
    },
    tipLengthCalibration: {
      sessionStarted: { [c.loadLabware]: "labwareLoaded" },
      labwareLoaded: { [c.moveToReferencePoint]: "measuringNozzleOffset" },
      measuringNozzleOffset: { [c.saveOffset]: "measuringNozzleOffset", [c.jog]: "measuringNozzleOffset", [c.moveToTipRack]: "preparingPipette", [c.invalidateLastAction]: "measuringNozzleOffset" },
      preparingPipette: { [c.jog]: "preparingPipette", [c.pickUpTip]: "inspectingTip", [c.invalidateLastAction]: "preparingPipette" },
      inspectingTip: { [c.invalidateTip]: "preparingPipette", [c.moveToReferencePoint]: "measuringTipOffset" },
      measuringTipOffset: { [c.saveOffset]: "measuringTipOffset", [c.jog]: "measuringTipOffset", [c.moveToTipRack]: "calibrationComplete", [c.invalidateLastAction]: "preparingPipette" }
    },
    pipetteOffsetCalibration: {
      sessionStarted: { [c.loadLabware]: "labwareLoaded" },
      labwareLoaded: { [c.moveToTipRack]: "preparingPipette" },
      preparingPipette: { [c.jog]: "preparingPipette", [c.pickUpTip]: "inspectingTip", [c.invalidateLastAction]: "preparingPipette" },
      inspectingTip: { [c.invalidateTip]: "preparingPipette", [c.moveToDeck]: "joggingToDeck" },
      joggingToDeck: { [c.jog]: "joggingToDeck", [c.saveOffset]: "joggingToDeck", [c.moveToPointOne]: "savingPointOne", [c.invalidateLastAction]: "preparingPipette" },
      savingPointOne: { [c.jog]: "savingPointOne", [c.saveOffset]: "calibrationComplete", [c.invalidateLastAction]: "preparingPipette" },
      calibrationComplete: { [c.moveToTipRack]: "calibrationComplete" }
    },
    // A pipetteOffsetCalibration session that measures tip length first.
    pipetteOffsetWithTipLength: {
      sessionStarted: { [c.loadLabware]: "labwareLoaded" },
      labwareLoaded: { [c.moveToReferencePoint]: "measuringNozzleOffset" },
      measuringNozzleOffset: { [c.saveOffset]: "measuringNozzleOffset", [c.jog]: "measuringNozzleOffset", [c.moveToTipRack]: "preparingPipette", [c.invalidateLastAction]: "measuringNozzleOffset" },
      preparingPipette: { [c.jog]: "preparingPipette", [c.pickUpTip]: "inspectingTip", [c.invalidateLastAction]: "preparingPipette" },
      inspectingTip: { [c.invalidateTip]: "preparingPipette", [c.moveToReferencePoint]: "measuringTipOffset" },
      measuringTipOffset: { [c.jog]: "measuringTipOffset", [c.saveOffset]: "tipLengthComplete", [c.invalidateLastAction]: "preparingPipette" },
      tipLengthComplete: { [c.setHasCalibrationBlock]: "tipLengthComplete", [c.moveToDeck]: "joggingToDeck" },
      joggingToDeck: { [c.jog]: "joggingToDeck", [c.saveOffset]: "joggingToDeck", [c.moveToPointOne]: "savingPointOne", [c.invalidateLastAction]: "preparingPipette" },
      savingPointOne: { [c.jog]: "savingPointOne", [c.saveOffset]: "calibrationComplete", [c.invalidateLastAction]: "preparingPipette" },
      calibrationComplete: { [c.moveToTipRack]: "calibrationComplete" }
    },
    calibrationCheck: {
      sessionStarted: { [c.loadLabware]: "labwareLoaded" },
      labwareLoaded: { [c.moveToReferencePoint]: "comparingNozzle" },
      comparingNozzle: { [c.jog]: "comparingNozzle", [c.moveToTipRack]: "preparingPipette", [c.invalidateLastAction]: "comparingNozzle" },
      preparingPipette: { [c.jog]: "preparingPipette", [c.pickUpTip]: "inspectingTip", [c.invalidateLastAction]: "preparingPipette" },
      inspectingTip: { [c.invalidateTip]: "preparingPipette", [c.moveToReferencePoint]: "comparingTip" },
      comparingTip: { [c.comparePoint]: "comparingTip", [c.jog]: "comparingTip", [c.moveToDeck]: "comparingHeight", [c.invalidateLastAction]: "preparingPipette" },
      comparingHeight: { [c.jog]: "comparingHeight", [c.comparePoint]: "comparingHeight", [c.moveToPointOne]: "comparingPointOne", [c.invalidateLastAction]: "preparingPipette" },
      comparingPointOne: { [c.jog]: "comparingPointOne", [c.comparePoint]: "comparingPointOne", [c.moveToPointTwo]: "comparingPointTwo", [c.moveToTipRack]: "returningTip", [c.invalidateLastAction]: "preparingPipette" },
      comparingPointTwo: { [c.jog]: "comparingPointTwo", [c.comparePoint]: "comparingPointTwo", [c.moveToPointThree]: "comparingPointThree", [c.invalidateLastAction]: "preparingPipette" },
      comparingPointThree: { [c.jog]: "comparingPointThree", [c.comparePoint]: "comparingPointThree", [c.moveToTipRack]: "returningTip", [c.invalidateLastAction]: "preparingPipette" },
      returningTip: { [c.returnTip]: "returningTip", [c.transition]: "resultsSummary", [c.switchPipette]: "labwareLoaded" }
    }
  };
})();

const CAL_PIPETTES = {
  p20_multi_gen2: { label: "P20 8-Channel GEN2", family: "p20", channels: 8, maxVolume: 20, tipRack: "opentrons_96_tiprack_20ul" },
  p300_multi_gen2: { label: "P300 8-Channel GEN2", family: "p300", channels: 8, maxVolume: 300, tipRack: "opentrons_96_tiprack_300ul" },
  p20_single_gen2: { label: "P20 Single-Channel GEN2", family: "p20", channels: 1, maxVolume: 20, tipRack: "opentrons_96_tiprack_20ul" },
  p300_single_gen2: { label: "P300 Single-Channel GEN2", family: "p300", channels: 1, maxVolume: 300, tipRack: "opentrons_96_tiprack_300ul" },
  p1000_single_gen2: { label: "P1000 Single-Channel GEN2", family: "p1000", channels: 1, maxVolume: 1000, tipRack: "opentrons_96_tiprack_1000ul" }
};

// tipLength and tipOverlap from the labware definitions; top is the height of the tip openings.
const CAL_TIPRACKS = {
  opentrons_96_tiprack_20ul: { label: "Opentrons OT-2 96 Tip Rack 20 µL", tipLength: 39.2, overlap: 8.25, top: 64.69, diameter: 3.27, endDiameter: 0.8 },
  opentrons_96_tiprack_300ul: { label: "Opentrons OT-2 96 Tip Rack 300 µL", tipLength: 59.3, overlap: 7.47, top: 64.69, diameter: 5.23, endDiameter: 1.0 },
  opentrons_96_tiprack_1000ul: { label: "Opentrons OT-2 96 Tip Rack 1000 µL", tipLength: 88, overlap: 7.95, top: 97.47, diameter: 7.23, endDiameter: 1.3 }
};

const CAL_SLOT_ORIGINS = {
  1: [0, 0], 2: [132.5, 0], 3: [265, 0], 4: [0, 90.5], 5: [132.5, 90.5], 6: [265, 90.5],
  7: [0, 181], 8: [132.5, 181], 9: [265, 181], 10: [0, 271.5], 11: [132.5, 271.5], 12: [265, 271.5]
};
const CAL_SLOT_SIZE = { x: 128, y: 86 };
const CAL_POINTS = {
  "1BLC": { x: 12.13, y: 9, slot: 1 },
  "3BRC": { x: 380.87, y: 9, slot: 3 },
  "7TLC": { x: 12.13, y: 258, slot: 7 }
};
const CAL_TIPRACK_SLOT = 8;
// Slot 5 front edge plus MOVE_TO_DECK_SAFETY_BUFFER (0, 10, 5).
const CAL_DECK_TARGET = { x: 196.5, y: 100.5, z: 5 };
// Fixed trash A1 top plus TRASH_REF_POINT_OFFSET, used when there is no Calibration Block.
const CAL_TRASH_REFERENCE = { x: 290, y: 296.5, z: 82 };
const CAL_TRASH_BOX = { x: 265, y: 271.5, xDim: 172.86, yDim: 165.86, z: 82 };
// CAL_BLOCK_SETUP_BY_MOUNT and CAL_BLOCK_SETUP_CAL_CHECK: block, slot, and the well on its tall side.
const CAL_BLOCKS = {
  left: { slot: 3, loadName: "opentrons_calibrationblock_short_side_right", heights: [62.5, 33], well: "A1" },
  right: { slot: 1, loadName: "opentrons_calibrationblock_short_side_left", heights: [33, 62.5], well: "A2" },
  check: { slot: 6, loadName: "opentrons_calibrationblock_short_side_right", heights: [62.5, 33], well: "A1" }
};
const CAL_BLOCK_SIZE = { x: 127.75, y: 85.5 };
const CAL_REFERENCE_BUFFER = 5;
const CAL_TIPRACK_BUFFER = 10;
const CAL_HOME = { x: 330, y: 330, z: 200 };
const CAL_Z_MAX = 218;
const CAL_CHANNEL_PITCH = 9;
// PIPETTE_TOLERANCES from robot_server/robot/calibration/check/constants.py.
const CAL_TOLERANCES = {
  p1000_crosses: [2.7, 2.7, 0], p1000_height: [0, 0, 1.0], p300_crosses: [1.8, 1.8, 0], p20_crosses: [1.4, 1.4, 0],
  other_height: [0, 0, 0.8], p20_tip: [0, 0, 0.5], p300_tip: [0, 0, 1.0], p1000_tip: [0, 0, 1.0]
};
// Practice pick-up succeeds when the nozzle is this close to the A1 tip opening.
const CAL_PICKUP_XY_MM = 1.2;
const CAL_PICKUP_Z_MM = [-1.5, 4];
// Pressing further than this into a surface counts as a crash.
const CAL_CRASH_MM = 1.5;

function calTipRackA1() {
  const [ox, oy] = CAL_SLOT_ORIGINS[CAL_TIPRACK_SLOT];
  return { x: ox + 14.38, y: oy + 74.24 };
}

function calBlockTarget(key) {
  const block = CAL_BLOCKS[key];
  const [ox, oy] = CAL_SLOT_ORIGINS[block.slot];
  const tall = block.well === "A1" ? 0 : 1;
  return { x: ox + (tall ? 95.81 : 31.94), y: oy + 42.75, z: block.heights[tall] };
}

function calNominalTipLength(rackKey) {
  const rack = CAL_TIPRACKS[rackKey];
  return rack.tipLength - rack.overlap;
}

// Highest physical surface under (x, y) for a deck holding the given labware.
function calSurfaceAt(x, y, deck = {}) {
  let best = { z: 0, name: "deck" };
  const consider = (z, name) => { if (z > best.z) best = { z, name }; };
  if (x >= CAL_TRASH_BOX.x && x <= CAL_TRASH_BOX.x + CAL_TRASH_BOX.xDim && y >= CAL_TRASH_BOX.y && y <= CAL_TRASH_BOX.y + CAL_TRASH_BOX.yDim) {
    consider(CAL_TRASH_BOX.z, "trash bin");
  }
  if (deck.tipRack) {
    const rack = CAL_TIPRACKS[deck.tipRack];
    const [ox, oy] = CAL_SLOT_ORIGINS[CAL_TIPRACK_SLOT];
    if (x >= ox && x <= ox + 127.76 && y >= oy && y <= oy + 85.48) {
      const col = Math.round((x - ox - 14.38) / CAL_CHANNEL_PITCH), row = Math.round((oy + 74.24 - y) / CAL_CHANNEL_PITCH);
      const inGrid = col >= 0 && col < 12 && row >= 0 && row < 8;
      const wx = ox + 14.38 + col * CAL_CHANNEL_PITCH, wy = oy + 74.24 - row * CAL_CHANNEL_PITCH;
      const inOpening = inGrid && Math.hypot(x - wx, y - wy) < rack.diameter / 2;
      if (!inOpening) consider(rack.top, "tip rack");
      else if (col === 0 && row === 0 && deck.a1Empty) consider(rack.top - rack.tipLength, "tip rack");
      else consider(rack.top - rack.overlap, "tip");
    }
  }
  if (deck.block) {
    const block = CAL_BLOCKS[deck.block];
    const [ox, oy] = CAL_SLOT_ORIGINS[block.slot];
    if (x >= ox && x <= ox + CAL_BLOCK_SIZE.x && y >= oy && y <= oy + CAL_BLOCK_SIZE.y) {
      consider(block.heights[x - ox < CAL_BLOCK_SIZE.x / 2 ? 0 : 1], "Calibration Block");
    }
  }
  return best;
}

function calThreshold(pipette, step) {
  const crosses = ["comparingPointOne", "comparingPointTwo", "comparingPointThree"].includes(step);
  if (step === "comparingTip") return CAL_TOLERANCES[`${pipette.family === "p1000" ? "p1000" : pipette.family === "p20" ? "p20" : "p300"}_tip`];
  if (crosses) return CAL_TOLERANCES[`${pipette.family === "p1000" ? "p1000" : pipette.family === "p20" ? "p20" : "p300"}_crosses`];
  return pipette.family === "p1000" ? CAL_TOLERANCES.p1000_height : CAL_TOLERANCES.other_height;
}

// What the operator aligns to at a session's current step, in physical deck coordinates.
function calTarget(session) {
  const step = session.currentStep;
  if (step === "preparingPipette" || step === "inspectingTip") {
    const a1 = calTipRackA1();
    return { kind: "tip", x: a1.x, y: a1.y, z: session.tipRack.top, label: "Tip rack A1" };
  }
  if (["measuringNozzleOffset", "measuringTipOffset", "comparingNozzle", "comparingTip"].includes(step)) {
    const ref = calReferencePoint(session);
    return { kind: "surface", x: ref.x, y: ref.y, z: ref.z, label: session.usesBlock ? `Calibration Block · slot ${CAL_BLOCKS[session.blockKey].slot}` : "Trash bin" };
  }
  if (step === "joggingToDeck" || step === "comparingHeight") {
    return { kind: "surface", x: CAL_DECK_TARGET.x, y: CAL_DECK_TARGET.y, z: 0, label: "Deck · slot 5" };
  }
  const point = { savingPointOne: "1BLC", savingPointTwo: "3BRC", savingPointThree: "7TLC", comparingPointOne: "1BLC", comparingPointTwo: "3BRC", comparingPointThree: "7TLC" }[step];
  if (point) return { kind: "cross", x: CAL_POINTS[point].x, y: CAL_POINTS[point].y, z: 0, label: `Cross · slot ${CAL_POINTS[point].slot}`, point };
  return null;
}

function calReferencePoint(session) {
  return session.usesBlock ? calBlockTarget(session.blockKey) : CAL_TRASH_REFERENCE;
}

// Flow details both session kinds derive the same way.
const CAL_SESSION_GETTERS = {
  flowKey: { get() { return this.withTipLength ? "pipetteOffsetWithTipLength" : this.sessionType; } },
  pipette: { get() { return calPipetteInfo(this.pipetteName); } },
  tipRack: { get() { return calTipRackInfo(this.tipRackKey); } },
  rank: { get() { return this.rankIndex === 0 ? "first" : "second"; } },
  usesBlock: { get() { return this.hasCalibrationBlock && this.sessionType !== "deckCalibration" && (this.sessionType !== "pipetteOffsetCalibration" || this.withTipLength); } },
  blockKey: { get() { return this.sessionType === "calibrationCheck" ? "check" : this.mount; } },
  checkingBothPipettes: { get() { return Boolean(this.ranks && this.ranks.length === 2); } }
};

function calCanExecute(session, command) {
  if (command === CAL_CMD.exit) return true;
  // robot-server allows starting over here, but once tip length is saved the restarted
  // flow cannot leave inspectingTip; exiting and starting pipette offset again works.
  if (command === CAL_CMD.invalidateLastAction && session.flowKey === "pipetteOffsetWithTipLength" && session.tipLengthSaved) return false;
  return Boolean((CAL_TRANSITIONS[session.flowKey][session.currentStep] || {})[command]);
}

function calRandomTruth(random) {
  const r = (limit) => (random() * 2 - 1) * limit;
  let deck;
  do { deck = { x: r(2.5), y: r(2.5) }; } while (Math.hypot(deck.x, deck.y) < 1);
  const pipette = () => ({ x: r(1), y: r(1), z: r(1.5) });
  return { deck, pipette: { left: pipette(), right: pipette() }, tips: {} };
}

// Pipette details for any pipette name, including ones the practice robot does not offer.
function calPipetteInfo(name) {
  if (CAL_PIPETTES[name]) return CAL_PIPETTES[name];
  const volume = Number((/^p(\d+)/.exec(name || "") || [])[1]) || 300;
  const family = volume <= 20 ? "p20" : volume >= 1000 ? "p1000" : "p300";
  return { label: name || "Unknown pipette", family, channels: /multi/.test(name || "") ? 8 : 1, maxVolume: volume, tipRack: CAL_PIPETTES[`${family}_single_gen2`].tipRack };
}

function calTipRackInfo(loadName) {
  return CAL_TIPRACKS[loadName] || { ...CAL_TIPRACKS.opentrons_96_tiprack_300ul, label: loadName || "Tip rack" };
}

// Which flows a robot can run, and in what order, from its pipettes and saved calibrations.
class CalibrationRobot {
  constructor() {
    this.pipettes = { left: null, right: null };
    this.calibration = { deck: null, tipLength: { left: null, right: null }, pipetteOffset: { left: null, right: null }, health: null };
  }

  attachedMounts() { return ["left", "right"].filter((mount) => this.pipettes[mount]); }

  // Deck calibration's pipette: smaller max volume, then single-channel, then the right mount.
  deckCalibrationMount() {
    const mounts = this.attachedMounts();
    if (mounts.length < 2) return mounts[0] || null;
    const [l, r] = [calPipetteInfo(this.pipettes.left), calPipetteInfo(this.pipettes.right)];
    if (l.maxVolume !== r.maxVolume) return l.maxVolume < r.maxVolume ? "left" : "right";
    if (l.channels !== r.channels) return l.channels < r.channels ? "left" : "right";
    return "right";
  }

  // Health check order: the larger (or single-channel) pipette is checked first.
  checkOrder() {
    const mounts = this.attachedMounts();
    if (mounts.length < 2) return mounts;
    const [l, r] = [calPipetteInfo(this.pipettes.left), calPipetteInfo(this.pipettes.right)];
    return l.maxVolume > r.maxVolume || r.channels > l.channels ? ["left", "right"] : ["right", "left"];
  }

  // Why a flow cannot start yet, or null when it can.
  readiness(sessionType, mount) {
    const mounts = this.attachedMounts();
    if (!mounts.length) return "Attach a pipette first.";
    if (sessionType === "deckCalibration") return null;
    if (sessionType === "calibrationCheck") {
      if (!this.calibration.deck) return "Calibrate the deck first.";
      const missing = mounts.find((m) => !this.calibration.tipLength[m] || !this.calibration.pipetteOffset[m]);
      return missing ? `Calibrate tip length and pipette offset for the ${missing} pipette first.` : null;
    }
    if (!this.pipettes[mount]) return `No pipette on the ${mount} mount.`;
    if (sessionType === "pipetteOffsetCalibration" && !this.calibration.deck) return "Calibrate the deck first.";
    return null;
  }
}

class PracticeRobot extends CalibrationRobot {
  constructor(pipettes = { left: "p20_multi_gen2", right: null }, random = Math.random) {
    super();
    this.random = random;
    this.pipettes = { left: pipettes.left || null, right: pipettes.right || null };
    this.reset();
  }

  reset() {
    this.truth = calRandomTruth(this.random);
    this.calibration = { deck: null, tipLength: { left: null, right: null }, pipetteOffset: { left: null, right: null }, health: null };
  }

  // Attaching a different pipette invalidates that mount's calibrations, as on the robot.
  setPipette(mount, name) {
    this.pipettes[mount] = CAL_PIPETTES[name] ? name : null;
    const r = (limit) => (this.random() * 2 - 1) * limit;
    this.truth.pipette[mount] = { x: r(1), y: r(1), z: r(1.5) };
    for (const key of Object.keys(this.truth.tips)) if (key.startsWith(`${mount}|`)) delete this.truth.tips[key];
    this.calibration.tipLength[mount] = null;
    this.calibration.pipetteOffset[mount] = null;
    this.calibration.health = null;
  }

  trueTipLength(mount, rackKey) {
    const key = `${mount}|${rackKey}`;
    if (this.truth.tips[key] === undefined) this.truth.tips[key] = calNominalTipLength(rackKey) + (this.random() * 2 - 1) * 0.7;
    return this.truth.tips[key];
  }

  createSession(sessionType, params = {}) {
    const blocker = this.readiness(sessionType, params.mount);
    if (blocker) throw new Error(blocker);
    return new PracticeSession(this, sessionType, params);
  }
}

class PracticeSession {
  constructor(robot, sessionType, params = {}) {
    this.robot = robot;
    this.sessionType = sessionType;
    this.hasCalibrationBlock = Boolean(params.hasCalibrationBlock);
    this.currentStep = "sessionStarted";
    this.entry = 0;
    this.ranks = sessionType === "calibrationCheck" ? robot.checkOrder() : null;
    this.rankIndex = 0;
    this.mount = sessionType === "deckCalibration" ? robot.deckCalibrationMount()
      : sessionType === "calibrationCheck" ? this.ranks[0] : params.mount;
    this.withTipLength = sessionType === "pipetteOffsetCalibration"
      && (Boolean(params.shouldRecalibrateTipLength) || !robot.calibration.tipLength[this.mount]);
    this.transitions = CAL_TRANSITIONS[this.flowKey];
    this.comparisons = { first: {}, second: {} };
    this.nozzle = { ...CAL_HOME };
    this.tip = null;
    this.tipOrigin = null;
    this.labwareOnDeck = false;
    this.blockOnDeck = false;
    this.saved = {};
    this.zReference = null;
    this.results = null;
  }

  get pipetteName() { return this.robot.pipettes[this.mount]; }
  get tipRackKey() { return this.pipette.tipRack; }
  get tipLengthSaved() { return this.saved.tipLength !== undefined; }

  supportedCommands() {
    return [...Object.keys(this.transitions[this.currentStep] || {}), CAL_CMD.exit];
  }

  canExecute(command) { return calCanExecute(this, command); }

  // Like robot-server: handlers see the state the command was sent in, then the state advances.
  execute(command, data = {}) {
    const next = command === CAL_CMD.exit ? "sessionExited" : (this.transitions[this.currentStep] || {})[command];
    if (!next) throw new Error(`${command} is not allowed while ${this.currentStep}.`);
    const handler = PRACTICE_HANDLERS[command];
    if (handler) handler.call(this, data);
    if (next !== this.currentStep) this.entry += 1;
    this.currentStep = next;
    return this.status();
  }

  status() {
    return {
      sessionType: this.sessionType,
      currentStep: this.currentStep,
      instrument: { mount: this.mount, name: this.pipetteName, label: this.pipette.label, rank: this.ranks ? this.rank : undefined },
      tipRack: { slot: CAL_TIPRACK_SLOT, loadName: this.tipRackKey, label: this.tipRack.label },
      hasCalibrationBlock: this.hasCalibrationBlock,
      supportedCommands: this.supportedCommands(),
      comparisonsByPipette: this.ranks ? this.comparisons : undefined
    };
  }

  // Tip length the robot applies to the attached tip.
  assumedTipLength() {
    const measuring = this.sessionType === "tipLengthCalibration" || (this.withTipLength && !this.saved.tipLength);
    const calibrated = this.robot.calibration.tipLength[this.mount];
    if (!measuring && calibrated && calibrated.rack === this.tipRackKey) return calibrated.value;
    return calNominalTipLength(this.tipRackKey);
  }

  // Robot position error at the pipette: true geometry minus the calibration this flow applies.
  // Deck calibration runs uncalibrated; pipette offset replaces the mount's offset it is measuring.
  // Fixed per session, like the hardware's loaded calibration, even after a save replaces it.
  errorVector(mount = this.mount) {
    this.errors = this.errors || {};
    if (!this.errors[mount]) this.errors[mount] = this.computeError(mount);
    return this.errors[mount];
  }

  computeError(mount) {
    const truth = this.robot.truth, cal = this.robot.calibration;
    const deck = this.sessionType !== "deckCalibration" && cal.deck ? cal.deck.offset : { x: 0, y: 0 };
    const usesOffset = this.sessionType === "calibrationCheck" || this.sessionType === "tipLengthCalibration";
    const offset = usesOffset && cal.pipetteOffset[mount] ? cal.pipetteOffset[mount].offset : { x: 0, y: 0, z: 0 };
    const pip = truth.pipette[mount];
    return { x: truth.deck.x + pip.x - deck.x - offset.x, y: truth.deck.y + pip.y - deck.y - offset.y, z: pip.z - offset.z };
  }

  // Where the robot believes its critical point is: the tip end, or the front nozzle without a tip.
  criticalPoint(nozzle = this.nozzle) {
    return { x: nozzle.x, y: nozzle.y, z: nozzle.z - (this.tip ? this.tip.used : 0) };
  }

  moveCritical(point) {
    this.nozzle = { x: point.x, y: point.y, z: Math.min(CAL_Z_MAX, point.z + (this.tip ? this.tip.used : 0)) };
  }

  deckState() {
    return { tipRack: this.labwareOnDeck ? this.tipRackKey : null, block: this.blockOnDeck ? this.blockKey : null, a1Empty: Boolean(this.tip && this.tip.attached) };
  }

  // Physical front nozzle, tip end, and lowest point for a believed nozzle position.
  physical(nozzle = this.nozzle) {
    const e = this.errorVector();
    const front = { x: nozzle.x + e.x, y: nozzle.y + e.y, z: nozzle.z + e.z };
    const tipEnd = this.tip && this.tip.attached ? { x: front.x, y: front.y, z: front.z - this.tip.trueLength } : null;
    const lowest = tipEnd || front;
    const surface = calSurfaceAt(lowest.x, lowest.y, this.deckState());
    return { nozzle: front, tipEnd, lowest, surface, gap: lowest.z - surface.z };
  }

  // Nozzle positions of every channel; channel A is the back nozzle, H (the critical point) the front.
  channels(nozzle = this.nozzle) {
    const front = this.physical(nozzle).nozzle;
    return Array.from({ length: this.pipette.channels }, (_item, i) => ({ x: front.x, y: front.y + (this.pipette.channels - 1 - i) * CAL_CHANNEL_PITCH, z: front.z }));
  }

  crashDepth(nozzle = this.nozzle) {
    const physical = this.physical(nozzle);
    return Math.max(0, -physical.gap);
  }

  referencePoint() { return calReferencePoint(this); }
  target() { return calTarget(this); }

  returnTip() {
    this.tip = null;
    if (this.tipOrigin) this.moveCritical(this.tipOrigin);
  }

  recordComparison(kind, difference) {
    const threshold = calThreshold(this.pipette, this.currentStep);
    const [tx, ty, tz] = threshold;
    const magnitude = tz === 0 ? Math.hypot(difference[0], difference[1]) : Math.abs(difference[2]);
    const exceeds = magnitude > Math.hypot(tx, ty, tz);
    const info = { differenceVector: difference, thresholdVector: threshold, exceedsThreshold: exceeds };
    const status = exceeds ? "OUTSIDE_THRESHOLD" : "IN_THRESHOLD";
    const map = this.comparisons[this.rank];
    const worse = (old) => (old === "OUTSIDE_THRESHOLD" || exceeds ? "OUTSIDE_THRESHOLD" : "IN_THRESHOLD");
    const deckState = this.rank === "second" || !this.checkingBothPipettes;
    if (kind === "comparingTip") map.tipLength = { status, comparingTip: info };
    else if (kind === "comparingHeight") map.pipetteOffset = { status, comparingHeight: info };
    else if (kind === "comparingPointOne") {
      map.pipetteOffset = { ...(map.pipetteOffset || {}), comparingPointOne: info, status: worse(map.pipetteOffset && map.pipetteOffset.status) };
      if (deckState) map.deck = { status, comparingPointOne: info };
    } else if (deckState && map.deck) {
      map.deck = { ...map.deck, [kind]: info, status: worse(map.deck.status) };
    }
  }
}

Object.defineProperties(PracticeSession.prototype, CAL_SESSION_GETTERS);

const PRACTICE_HANDLERS = {
  [CAL_CMD.loadLabware]() {
    this.labwareOnDeck = true;
    this.blockOnDeck = this.usesBlock;
  },
  [CAL_CMD.setHasCalibrationBlock](data) {
    this.hasCalibrationBlock = Boolean(data.hasBlock);
  },
  [CAL_CMD.jog](data) {
    const [dx, dy, dz] = data.vector || [0, 0, 0];
    this.nozzle = { x: this.nozzle.x + dx, y: this.nozzle.y + dy, z: Math.min(CAL_Z_MAX, this.nozzle.z + dz) };
  },
  [CAL_CMD.moveToTipRack]() {
    if (this.currentStep === "labwareLoaded") this.nozzle = { ...CAL_HOME };
    if (this.currentStep === "comparingNozzle") this.saved.nozzleReference = this.criticalPoint().z;
    if (!this.tipOrigin) {
      const a1 = calTipRackA1();
      this.tipOrigin = { x: a1.x, y: a1.y, z: this.tipRack.top + CAL_TIPRACK_BUFFER };
    }
    this.moveCritical(this.tipOrigin);
  },
  [CAL_CMD.pickUpTip]() {
    this.tipOrigin = this.criticalPoint();
    const front = this.physical().nozzle;
    const a1 = calTipRackA1();
    const offset = Math.hypot(front.x - a1.x, front.y - a1.y);
    const height = front.z - this.tipRack.top;
    let miss = "";
    if (offset > CAL_PICKUP_XY_MM) miss = `The nozzle was ${offset.toFixed(1)} mm from the center of A1.`;
    else if (height > CAL_PICKUP_Z_MM[1]) miss = `The nozzle was ${height.toFixed(1)} mm above the tip, too high to press it on.`;
    else if (height < CAL_PICKUP_Z_MM[0]) miss = `The nozzle was ${(-height).toFixed(1)} mm into the tip before pick-up.`;
    this.tip = { used: this.assumedTipLength(), attached: !miss, trueLength: this.robot.trueTipLength(this.mount, this.tipRackKey), miss };
  },
  [CAL_CMD.invalidateTip]() {
    this.tip = null;
    this.tipOrigin = null;
    PRACTICE_HANDLERS[CAL_CMD.moveToTipRack].call(this);
  },
  [CAL_CMD.moveToDeck]() {
    // After tip length, the operator removes the Calibration Block before pipette offset.
    if (this.withTipLength) this.blockOnDeck = false;
    this.moveCritical(CAL_DECK_TARGET);
  },
  [CAL_CMD.moveToPointOne]() { this.moveCritical({ ...CAL_POINTS["1BLC"], z: this.zReference ?? 0 }); },
  [CAL_CMD.moveToPointTwo]() { this.moveCritical({ ...CAL_POINTS["3BRC"], z: this.zReference ?? 0 }); },
  [CAL_CMD.moveToPointThree]() { this.moveCritical({ ...CAL_POINTS["7TLC"], z: this.zReference ?? 0 }); },
  [CAL_CMD.moveToReferencePoint]() {
    const ref = this.referencePoint();
    this.moveCritical({ x: ref.x, y: ref.y, z: ref.z + CAL_REFERENCE_BUFFER });
  },
  [CAL_CMD.saveOffset]() {
    const point = this.criticalPoint();
    const step = this.currentStep;
    const cal = this.robot.calibration;
    const at = new Date().toISOString();
    if (step === "joggingToDeck") {
      this.zReference = point.z;
      this.saved.height = point.z;
    } else if (step === "measuringNozzleOffset") {
      this.saved.nozzleReference = point.z;
    } else if (step === "measuringTipOffset") {
      const value = this.tip.used + (point.z - this.saved.nozzleReference);
      this.saved.tipLength = value;
      cal.tipLength[this.mount] = { value, rack: this.tipRackKey, at, block: this.usesBlock };
      cal.pipetteOffset[this.mount] = null;
      cal.health = null;
      this.tip.used = value;
    } else if (this.sessionType === "deckCalibration") {
      const id = { savingPointOne: "1BLC", savingPointTwo: "3BRC", savingPointThree: "7TLC" }[step];
      this.saved[id] = { x: CAL_POINTS[id].x - point.x, y: CAL_POINTS[id].y - point.y };
      if (step === "savingPointThree") {
        const ids = Object.keys(CAL_POINTS);
        const mean = (axis) => ids.reduce((sum, key) => sum + this.saved[key][axis], 0) / ids.length;
        cal.deck = { offset: { x: mean("x"), y: mean("y") }, at, mount: this.mount, pipette: this.pipetteName };
        cal.pipetteOffset = { left: null, right: null };
        cal.health = null;
      }
    } else if (step === "savingPointOne") {
      const cross = CAL_POINTS["1BLC"];
      cal.pipetteOffset[this.mount] = { offset: { x: cross.x - point.x, y: cross.y - point.y, z: -this.saved.height }, at, rack: this.tipRackKey };
      cal.health = null;
    }
  },
  [CAL_CMD.comparePoint]() {
    const point = this.criticalPoint();
    const step = this.currentStep;
    if (step === "comparingTip") {
      this.recordComparison(step, [0, 0, point.z - this.saved.nozzleReference]);
    } else if (step === "comparingHeight") {
      this.zReference = point.z;
      this.recordComparison(step, [0, 0, point.z]);
    } else {
      const id = { comparingPointOne: "1BLC", comparingPointTwo: "3BRC", comparingPointThree: "7TLC" }[step];
      this.recordComparison(step, [point.x - CAL_POINTS[id].x, point.y - CAL_POINTS[id].y, 0]);
    }
  },
  [CAL_CMD.returnTip]() { this.returnTip(); },
  [CAL_CMD.switchPipette]() {
    this.rankIndex = 1;
    this.mount = this.ranks[1];
    this.tip = null;
    this.tipOrigin = null;
    this.saved = {};
    this.zReference = null;
    this.nozzle = { ...CAL_HOME };
  },
  [CAL_CMD.transition]() {
    const cal = this.robot.calibration;
    this.results = { at: new Date().toISOString(), comparisonsByPipette: this.comparisons, pipettes: this.ranks.map((mount, i) => ({ mount, rank: i ? "second" : "first", name: this.robot.pipettes[mount] })) };
    cal.health = this.results;
    // Like mark_bad_calibration: flag every calibration that failed its check.
    for (const pip of this.results.pipettes) {
      const map = this.comparisons[pip.rank];
      if (map.tipLength && cal.tipLength[pip.mount]) cal.tipLength[pip.mount].bad = map.tipLength.status === "OUTSIDE_THRESHOLD";
      if (map.pipetteOffset && cal.pipetteOffset[pip.mount]) cal.pipetteOffset[pip.mount].bad = map.pipetteOffset.status === "OUTSIDE_THRESHOLD";
      if (map.deck && cal.deck) cal.deck.bad = map.deck.status === "OUTSIDE_THRESHOLD";
    }
  },
  [CAL_CMD.invalidateLastAction]() {
    if (this.currentStep === "measuringNozzleOffset" || this.currentStep === "comparingNozzle") {
      this.nozzle = { ...CAL_HOME };
      PRACTICE_HANDLERS[CAL_CMD.moveToReferencePoint].call(this);
      return;
    }
    this.nozzle = { ...CAL_HOME };
    this.returnTip();
    PRACTICE_HANDLERS[CAL_CMD.moveToTipRack].call(this);
  },
  [CAL_CMD.exit]() {
    if (this.tip) this.returnTip();
    this.labwareOnDeck = false;
    this.blockOnDeck = false;
  }
};

// A real OT-2. `request(op, payload)` performs one /api/ot2/calibration operation
// (status, create, command, session, delete) and resolves with its JSON.
class LiveRobot extends CalibrationRobot {
  constructor(request) {
    super();
    this.live = true;
    this.request = request;
    this.name = "";
    this.softwareVersion = "";
    this.serials = { left: null, right: null };
    this.sessions = [];
  }

  // Reads attached pipettes and saved calibrations the way the OT-2 App's calibration panel does.
  async refresh() {
    const status = await this.request("status");
    const health = this.calibration.health;
    this.name = status.health.name || "OT-2";
    this.softwareVersion = status.health.api_version || "";
    this.sessions = status.sessions || [];
    const calibration = { deck: null, tipLength: { left: null, right: null }, pipetteOffset: { left: null, right: null }, health };
    const deck = (status.calibration || {}).deckCalibration || {};
    if (deck.status && deck.status !== "IDENTITY") {
      const data = deck.data || {};
      calibration.deck = { at: data.lastModified, bad: deck.status !== "OK" || Boolean(data.status && data.status.markedBad) };
    }
    for (const mount of ["left", "right"]) {
      const pipette = (status.pipettes || {})[mount] || {};
      this.pipettes[mount] = pipette.model ? pipette.name : null;
      this.serials[mount] = pipette.id || null;
      if (!pipette.model) continue;
      const offset = (status.pipetteOffsets || []).find((item) => item.pipette === pipette.id && String(item.mount).toLowerCase() === mount);
      if (offset) {
        const [x, y, z] = offset.offset;
        calibration.pipetteOffset[mount] = { offset: { x, y, z }, at: offset.lastModified, bad: Boolean(offset.status && offset.status.markedBad) };
      }
      const rack = calPipetteInfo(pipette.name).tipRack;
      const tips = (status.tipLengths || []).filter((item) => item.pipette === pipette.id);
      const tip = tips.find((item) => String(item.uri || "").includes(`/${rack}/`)) || tips[0];
      if (tip) calibration.tipLength[mount] = { value: tip.tipLength, at: tip.lastModified, bad: Boolean(tip.status && tip.status.markedBad), rack: String(tip.uri || "").split("/")[1] || rack };
    }
    this.calibration = calibration;
    return this;
  }

  async createSession(sessionType, params = {}) {
    const blocker = this.readiness(sessionType, params.mount);
    if (blocker) throw new Error(blocker);
    const data = await this.request("create", { sessionType, createParams: params });
    return new LiveSession(this, data, params);
  }

  // Exiting first returns any tip to the rack; deleting alone would leave it on the pipette.
  async endSession(sessionId) {
    try {
      await this.request("command", { sessionId, command: CAL_CMD.exit });
    } catch (_error) {
      await this.request("delete", { sessionId });
    }
  }
}

// A calibration session running on a real OT-2's robot server.
class LiveSession {
  constructor(robot, data, params = {}) {
    this.robot = robot;
    this.live = true;
    this.id = data.id;
    this.sessionType = data.sessionType;
    this.hasCalibrationBlock = Boolean(params.hasCalibrationBlock);
    this.withTipLength = false;
    this.tipLengthSaved = false;
    this.currentStep = null;
    this.entry = 0;
    this.rankIndex = 0;
    this.ranks = null;
    this.comparisons = null;
    this.results = null;
    this.tip = null;
    this.saved = {};
    this.apply(data.details);
  }

  apply(details) {
    if (details.currentStep !== this.currentStep) {
      this.entry += 1;
      this.currentStep = details.currentStep;
      if (this.currentStep === "tipLengthComplete") this.tipLengthSaved = true;
    }
    if (this.currentStep === "sessionExited") return;
    const labware = details.labware || [];
    if (this.sessionType === "calibrationCheck") {
      const active = details.activePipette;
      this.mount = String(active.mount).toLowerCase();
      this.pipetteName = active.name;
      this.tipRackKey = active.tipRackLoadName;
      this.rankIndex = active.rank === "second" ? 1 : 0;
      const ordered = [...details.instruments].sort((a, b) => (a.rank === "first" ? 0 : 1) - (b.rank === "first" ? 0 : 1));
      this.ranks = ordered.map((pipette) => String(pipette.mount).toLowerCase());
      this.comparisons = details.comparisonsByPipette;
      if (this.currentStep === "resultsSummary") {
        this.results = {
          at: new Date().toISOString(),
          comparisonsByPipette: this.comparisons,
          pipettes: ordered.map((pipette) => ({ mount: String(pipette.mount).toLowerCase(), rank: pipette.rank, name: pipette.name }))
        };
        this.robot.calibration.health = this.results;
      }
    } else {
      this.mount = String(details.instrument.mount).toLowerCase();
      this.pipetteName = details.instrument.name;
      const rack = labware.find((item) => item.isTiprack);
      this.tipRackKey = rack ? rack.loadName : calPipetteInfo(this.pipetteName).tipRack;
      // The robot clears shouldPerformTipLength partway through but keeps its state machine; so do we.
      if (this.sessionType === "pipetteOffsetCalibration" && this.currentStep === "sessionStarted") this.withTipLength = Boolean(details.shouldPerformTipLength);
    }
    this.labwareOnDeck = this.currentStep !== "sessionStarted";
    this.blockOnDeck = this.labwareOnDeck && labware.some((item) => String(item.loadName).startsWith("opentrons_calibrationblock"));
  }

  canExecute(command) { return calCanExecute(this, command); }
  target() { return calTarget(this); }
  referencePoint() { return calReferencePoint(this); }

  // Resolves when the robot has finished the command.
  async execute(command, data = {}) {
    const payload = await this.robot.request("command", { sessionId: this.id, command, data });
    this.apply(payload.details);
    return this;
  }
}
Object.defineProperties(LiveSession.prototype, CAL_SESSION_GETTERS);

if (typeof module !== "undefined") {
  module.exports = { CAL_CMD, CAL_TRANSITIONS, CAL_PIPETTES, CAL_TIPRACKS, CAL_POINTS, CAL_TOLERANCES, PracticeRobot, PracticeSession, LiveRobot, LiveSession, calSurfaceAt, calTipRackA1, calBlockTarget, calNominalTipLength };
}
