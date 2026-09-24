"use strict";

// Runs every calibration flow on PracticeRobot with an operator who jogs
// exactly onto each target, in the command order the OT-2 App sends.
// Run directly with `node tests/calibration_flows.test.js` or via test_calibration.py.

const assert = require("node:assert/strict");
const path = require("node:path");
const {
  CAL_CMD, CAL_TRANSITIONS, PracticeRobot, calTipRackA1
} = require(path.join(__dirname, "..", "calibration_flows.js"));

function seeded(seed) {
  let value = seed;
  return () => {
    value = (value * 1664525 + 1013904223) % 4294967296;
    return value / 4294967296;
  };
}

// Jog so the physical lowest point sits exactly on the step's target.
function alignToTarget(session, { error = [0, 0, 0] } = {}) {
  const target = session.target();
  const physical = session.physical();
  let vector;
  if (target.kind === "tip") {
    vector = [target.x - physical.nozzle.x, target.y - physical.nozzle.y, target.z + 1 - physical.nozzle.z];
  } else if (target.kind === "cross") {
    vector = [target.x - physical.lowest.x, target.y - physical.lowest.y, target.z - physical.lowest.z];
  } else {
    vector = [0, 0, target.z - physical.lowest.z];
  }
  session.execute(CAL_CMD.jog, { vector: vector.map((v, i) => v + error[i]) });
}

function run(session, ...commands) {
  for (const command of commands) session.execute(command);
}

function pickUpTip(session) {
  alignToTarget(session);
  run(session, CAL_CMD.pickUpTip);
  assert.equal(session.tip.attached, true, "tip should seat when the nozzle is aligned");
}

function calibrateDeck(robot) {
  const session = robot.createSession("deckCalibration");
  run(session, CAL_CMD.loadLabware, CAL_CMD.moveToTipRack);
  pickUpTip(session);
  run(session, CAL_CMD.moveToDeck);
  alignToTarget(session);
  run(session, CAL_CMD.saveOffset, CAL_CMD.moveToPointOne);
  alignToTarget(session);
  run(session, CAL_CMD.saveOffset, CAL_CMD.moveToPointTwo);
  alignToTarget(session);
  run(session, CAL_CMD.saveOffset, CAL_CMD.moveToPointThree);
  alignToTarget(session);
  run(session, CAL_CMD.saveOffset, CAL_CMD.moveToTipRack);
  assert.equal(session.currentStep, "calibrationComplete");
  run(session, CAL_CMD.exit);
  assert.equal(session.currentStep, "sessionExited");
  return session;
}

function calibrateTipLength(robot, mount, hasCalibrationBlock) {
  const session = robot.createSession("tipLengthCalibration", { mount, hasCalibrationBlock });
  run(session, CAL_CMD.loadLabware, CAL_CMD.moveToReferencePoint);
  alignToTarget(session);
  run(session, CAL_CMD.saveOffset, CAL_CMD.moveToTipRack);
  pickUpTip(session);
  run(session, CAL_CMD.moveToReferencePoint);
  alignToTarget(session);
  run(session, CAL_CMD.saveOffset, CAL_CMD.moveToTipRack);
  assert.equal(session.currentStep, "calibrationComplete");
  run(session, CAL_CMD.exit);
}

function calibratePipetteOffset(robot, mount, { hasCalibrationBlock = true, error } = {}) {
  const session = robot.createSession("pipetteOffsetCalibration", { mount, hasCalibrationBlock });
  run(session, CAL_CMD.loadLabware);
  if (session.withTipLength) {
    run(session, CAL_CMD.moveToReferencePoint);
    alignToTarget(session);
    run(session, CAL_CMD.saveOffset, CAL_CMD.moveToTipRack);
    pickUpTip(session);
    run(session, CAL_CMD.moveToReferencePoint);
    alignToTarget(session);
    run(session, CAL_CMD.saveOffset);
    assert.equal(session.currentStep, "tipLengthComplete");
    run(session, CAL_CMD.moveToDeck);
  } else {
    run(session, CAL_CMD.moveToTipRack);
    pickUpTip(session);
    run(session, CAL_CMD.moveToDeck);
  }
  alignToTarget(session);
  run(session, CAL_CMD.saveOffset, CAL_CMD.moveToPointOne);
  alignToTarget(session, { error });
  run(session, CAL_CMD.saveOffset);
  assert.equal(session.currentStep, "calibrationComplete");
  run(session, CAL_CMD.moveToTipRack, CAL_CMD.exit);
  return session;
}

function healthCheck(robot, hasCalibrationBlock = true) {
  const session = robot.createSession("calibrationCheck", { hasCalibrationBlock });
  run(session, CAL_CMD.loadLabware);
  for (let pipette = 0; pipette < session.ranks.length; pipette += 1) {
    const finalPipette = pipette === session.ranks.length - 1;
    run(session, CAL_CMD.moveToReferencePoint);
    alignToTarget(session);
    run(session, CAL_CMD.moveToTipRack);
    pickUpTip(session);
    run(session, CAL_CMD.moveToReferencePoint);
    alignToTarget(session);
    run(session, CAL_CMD.comparePoint, CAL_CMD.moveToDeck);
    alignToTarget(session);
    run(session, CAL_CMD.comparePoint, CAL_CMD.moveToPointOne);
    alignToTarget(session);
    if (session.checkingBothPipettes && session.rank === "first") {
      run(session, CAL_CMD.comparePoint, CAL_CMD.moveToTipRack);
    } else {
      run(session, CAL_CMD.comparePoint, CAL_CMD.moveToPointTwo);
      alignToTarget(session);
      run(session, CAL_CMD.comparePoint, CAL_CMD.moveToPointThree);
      alignToTarget(session);
      run(session, CAL_CMD.comparePoint, CAL_CMD.moveToTipRack);
    }
    assert.equal(session.currentStep, "returningTip");
    run(session, CAL_CMD.returnTip, finalPipette ? CAL_CMD.transition : CAL_CMD.switchPipette);
  }
  assert.equal(session.currentStep, "resultsSummary");
  run(session, CAL_CMD.exit);
  return session.results;
}

function statuses(results) {
  const out = [];
  for (const pipette of results.pipettes) {
    for (const [kind, map] of Object.entries(results.comparisonsByPipette[pipette.rank])) out.push([pipette.mount, kind, map.status]);
  }
  return out;
}

const tests = {
  "every flow rejects commands its robot-server state machine does not allow"() {
    const robot = new PracticeRobot({ left: "p20_multi_gen2" }, seeded(1));
    const session = robot.createSession("deckCalibration");
    assert.throws(() => session.execute(CAL_CMD.pickUpTip), /not allowed while sessionStarted/);
    run(session, CAL_CMD.loadLabware);
    assert.throws(() => session.execute(CAL_CMD.moveToDeck), /not allowed/);
    assert.deepEqual(Object.keys(CAL_TRANSITIONS).sort(), ["calibrationCheck", "deckCalibration", "pipetteOffsetCalibration", "pipetteOffsetWithTipLength", "tipLengthCalibration"]);
  },

  "flows start only in the order the OT-2 App allows"() {
    const robot = new PracticeRobot({ left: "p20_multi_gen2" }, seeded(2));
    assert.match(robot.readiness("pipetteOffsetCalibration", "left"), /deck first/);
    assert.match(robot.readiness("calibrationCheck"), /deck first/);
    assert.equal(robot.readiness("tipLengthCalibration", "left"), null);
    assert.match(robot.readiness("tipLengthCalibration", "right"), /No pipette on the right/);
  },

  "careful calibration of a one-pipette robot passes the health check"() {
    const robot = new PracticeRobot({ left: "p20_multi_gen2" }, seeded(3));
    calibrateDeck(robot);
    assert.deepEqual(robot.calibration.pipetteOffset, { left: null, right: null });
    const offset = calibratePipetteOffset(robot, "left");
    assert.equal(offset.withTipLength, true, "no tip length yet, so the offset flow measures it first");
    assert.ok(Math.abs(robot.calibration.tipLength.left.value - robot.trueTipLength("left", "opentrons_96_tiprack_20ul")) < 1e-9);
    const results = healthCheck(robot);
    assert.deepEqual(statuses(results), [["left", "tipLength", "IN_THRESHOLD"], ["left", "pipetteOffset", "IN_THRESHOLD"], ["left", "deck", "IN_THRESHOLD"]]);
    for (const map of Object.values(results.comparisonsByPipette.first)) {
      for (const [key, info] of Object.entries(map)) if (key !== "status") info.differenceVector.forEach((v) => assert.ok(Math.abs(v) < 1e-9));
    }
  },

  "two pipettes are checked larger first, and only the second checks the deck"() {
    const robot = new PracticeRobot({ left: "p20_multi_gen2", right: "p300_single_gen2" }, seeded(4));
    assert.equal(robot.deckCalibrationMount(), "left");
    assert.deepEqual(robot.checkOrder(), ["right", "left"]);
    calibrateDeck(robot);
    calibrateTipLength(robot, "left", false);
    calibratePipetteOffset(robot, "left", { hasCalibrationBlock: false });
    calibratePipetteOffset(robot, "right");
    const results = healthCheck(robot);
    assert.deepEqual(statuses(results), [
      ["right", "tipLength", "IN_THRESHOLD"], ["right", "pipetteOffset", "IN_THRESHOLD"],
      ["left", "tipLength", "IN_THRESHOLD"], ["left", "pipetteOffset", "IN_THRESHOLD"], ["left", "deck", "IN_THRESHOLD"]
    ]);
  },

  "a pipette offset saved 3 mm off the cross fails the P20 check and is marked bad"() {
    const robot = new PracticeRobot({ left: "p20_multi_gen2" }, seeded(5));
    calibrateDeck(robot);
    calibratePipetteOffset(robot, "left", { error: [3, 0, 0] });
    const results = healthCheck(robot);
    const map = results.comparisonsByPipette.first;
    assert.equal(map.pipetteOffset.status, "OUTSIDE_THRESHOLD");
    assert.equal(map.pipetteOffset.comparingPointOne.exceedsThreshold, true);
    assert.ok(Math.abs(map.pipetteOffset.comparingPointOne.differenceVector[0] + 3) < 1e-9);
    assert.deepEqual(map.pipetteOffset.comparingPointOne.thresholdVector, [1.4, 1.4, 0]);
    assert.equal(robot.calibration.pipetteOffset.left.bad, true);
  },

  "recalibrating tip length clears that mount's pipette offset"() {
    const robot = new PracticeRobot({ left: "p300_multi_gen2" }, seeded(6));
    calibrateDeck(robot);
    calibratePipetteOffset(robot, "left");
    assert.ok(robot.calibration.pipetteOffset.left);
    calibrateTipLength(robot, "left", true);
    assert.equal(robot.calibration.pipetteOffset.left, null);
  },

  "a misaligned nozzle does not pick up a tip, and the retry puts A1 back"() {
    const robot = new PracticeRobot({ left: "p20_multi_gen2" }, seeded(7));
    const session = robot.createSession("deckCalibration");
    run(session, CAL_CMD.loadLabware, CAL_CMD.moveToTipRack);
    const a1 = calTipRackA1();
    const nozzle = session.physical().nozzle;
    session.execute(CAL_CMD.jog, { vector: [a1.x - nozzle.x + 2, a1.y - nozzle.y, 0] });
    run(session, CAL_CMD.pickUpTip);
    assert.equal(session.tip.attached, false);
    assert.match(session.tip.miss, /2\.0 mm from the center of A1/);
    run(session, CAL_CMD.invalidateTip);
    assert.equal(session.currentStep, "preparingPipette");
    assert.equal(session.tip, null);
  },

  "jogging a tip into the deck registers as a crash, and starting over returns the tip"() {
    const robot = new PracticeRobot({ left: "p20_single_gen2" }, seeded(8));
    const session = robot.createSession("deckCalibration");
    run(session, CAL_CMD.loadLabware, CAL_CMD.moveToTipRack);
    pickUpTip(session);
    run(session, CAL_CMD.moveToDeck);
    alignToTarget(session);
    assert.ok(session.crashDepth() < 1e-9);
    session.execute(CAL_CMD.jog, { vector: [0, 0, -2] });
    assert.ok(Math.abs(session.crashDepth() - 2) < 1e-9);
    run(session, CAL_CMD.invalidateLastAction);
    assert.equal(session.currentStep, "preparingPipette");
    assert.equal(session.tip, null);
  }
};

let failed = 0;
for (const [name, test] of Object.entries(tests)) {
  try {
    test();
    console.log(`ok - ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`not ok - ${name}\n${error.stack}`);
  }
}
process.exit(failed ? 1 : 0);
