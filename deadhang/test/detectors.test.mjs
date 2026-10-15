// Run with: node --test deadhang/test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HangTimer,
  ArmStrapDetector,
  PocketDetector,
  PoseHangDetector,
  armsOverhead,
  formatDuration,
} from '../detectors.js';

const HZ = 60;
const DT = 1 / HZ;

// Deterministic noise so failures are reproducible.
function rng(seed = 1) {
  return () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647 - 0.5;
  };
}

// Builds a |a| (in g) trace from segments of [seconds, fn(localT) -> g].
function trace(segments, seed = 1) {
  const noise = rng(seed);
  const out = [];
  let t = 0;
  for (const [dur, fn] of segments) {
    const n = Math.round(dur * HZ);
    for (let i = 0; i < n; i++) {
      out.push([t, fn(i * DT) + noise() * 0.03]);
      t += DT;
    }
  }
  return out;
}

const stand = (s) => [s, () => 1];
const walk = (s) => [s, (t) => 1 + 0.45 * Math.sin(2 * Math.PI * 2 * t)];
const hang = (s) => [s, (t) => 1 + 0.08 * Math.sin(2 * Math.PI * 0.45 * t)];
const level = (s, g) => [s, () => g];
const jumpUp = [level(0.15, 0.55), level(0.2, 1.9), level(0.3, 0.05)]; // dip, push, airborne
const catchBar = [level(0.1, 1.6), level(0.3, 1.15)];
const landFeet = [level(0.08, 3.2), level(0.15, 1.3)];
const release = [level(DT, 0.6), level(0.18, 0.05), level(0.08, 3.0), level(0.2, 1.2)];
// Time at which the next segment would start.
const at = (segments) => segments.reduce((s, [d]) => s + Math.round(d * HZ) * DT, 0);

function run(detector, samples) {
  const events = [];
  for (const [t, a] of samples) for (const e of detector.update(t, a)) events.push({ ...e, at: t });
  return events;
}

const ends = (events) => events.filter((e) => e.type === 'end');

test('HangTimer back-dates start and end', () => {
  const timer = new HangTimer({ onDelay: 0.5, offDelay: 0.6, minDuration: 2 });
  const events = [];
  for (let t = 0; t < 20; t += 0.05) {
    const evidence = t >= 3 && t < 13;
    events.push(...timer.update(t, evidence));
  }
  assert.equal(events.length, 2);
  assert.equal(events[0].type, 'start');
  assert.ok(Math.abs(events[0].t - 3) < 0.06);
  assert.equal(events[1].type, 'end');
  assert.ok(Math.abs(events[1].duration - 10) < 0.1, `duration ${events[1].duration}`);
});

test('HangTimer ignores flicker and drops hangs under the minimum', () => {
  const timer = new HangTimer({ onDelay: 0.5, offDelay: 0.6, minDuration: 2 });
  const events = [];
  for (let t = 0; t < 10; t += 0.05) {
    const flicker = t > 1 && t < 1.3; // shorter than onDelay
    const short = t > 4 && t < 5.2; // shorter than minDuration
    events.push(...timer.update(t, flicker || short));
  }
  assert.deepEqual(events.map((e) => e.type), ['start', 'cancel']);
});

test('HangTimer.finish closes an open hang', () => {
  const timer = new HangTimer({ minDuration: 1 });
  for (let t = 0; t <= 5; t += 0.1) timer.update(t, true);
  const [e] = timer.finish(5);
  assert.equal(e.type, 'end');
  assert.ok(Math.abs(e.duration - 5) < 0.01);
});

test('arm strap: hang measured from arm up to arm down', () => {
  const d = new ArmStrapDetector({ minDuration: 2 });
  const events = [];
  const feed = (from, to, v) => {
    for (let t = from; t < to; t += DT) events.push(...d.update(t, ...v));
  };
  feed(0, 2, [0.3, -9.7, 0.5]); // arm relaxed at side
  assert.ok(d.calibrate());
  feed(2, 5, [0.5, -9.6, 1.0]);
  feed(5, 6, [6.0, 0, 7.0]); // raising the arm
  feed(6, 26, [0.2, 9.7, -0.6]); // overhead
  feed(26, 30, [0.3, -9.7, 0.5]);
  const e = ends(events);
  assert.equal(e.length, 1);
  assert.ok(Math.abs(e[0].duration - 20.5) < 0.6, `duration ${e[0].duration}`);
  assert.ok(d.angle < 20);
});

test('arm strap: nothing before calibration, raised arm briefly is ignored', () => {
  const d = new ArmStrapDetector({ minDuration: 2 });
  const events = [];
  for (let t = 0; t < 2; t += DT) events.push(...d.update(t, 0, 9.8, 0));
  d.calibrate();
  for (let t = 2; t < 4; t += DT) events.push(...d.update(t, 0, 9.8, 0));
  for (let t = 4; t < 5; t += DT) events.push(...d.update(t, 0, -9.8, 0)); // 1s reach
  for (let t = 5; t < 8; t += DT) events.push(...d.update(t, 0, 9.8, 0));
  assert.equal(ends(events).length, 0);
});

test('pocket: jump, hang 20s, drop', () => {
  const before = [stand(3), ...jumpUp];
  const catchAt = at(before);
  const toRelease = [...before, ...catchBar, hang(20 - at(catchBar))];
  const releaseAt = at(toRelease);
  const samples = trace([...toRelease, ...release, stand(3), walk(3)]);
  const events = run(new PocketDetector(), samples);

  const starts = events.filter((e) => e.type === 'start');
  assert.equal(starts.length, 1, 'provisional start shown while hanging');
  assert.ok(Math.abs(starts[0].t - catchAt) < 0.05);
  const e = ends(events);
  assert.equal(e.length, 1, JSON.stringify(events));
  assert.ok(Math.abs(e[0].start - catchAt) < 0.05, `start ${e[0].start} vs ${catchAt}`);
  assert.ok(Math.abs(e[0].end - releaseAt) < 0.05, `end ${e[0].end} vs ${releaseAt}`);
  assert.ok(Math.abs(e[0].duration - 20) < 0.1);
  assert.equal(events.filter((x) => x.type === 'cancel').length, 0);
});

test('pocket: reach up without jumping, hang 15s, drop', () => {
  const before = [walk(3), level(0.1, 0.55)]; // last movement as feet leave the ground
  const hangAt = at(before);
  const samples = trace([...before, hang(15), ...release, stand(2)]);
  const e = ends(run(new PocketDetector(), samples));
  assert.equal(e.length, 1);
  assert.ok(Math.abs(e[0].start - hangAt) < 0.05, `start ${e[0].start} vs ${hangAt}`);
  assert.ok(Math.abs(e[0].duration - 15) < 0.1, `duration ${e[0].duration}`);
});

test('pocket: a jolt mid-hang does not end it', () => {
  const samples = trace([stand(2), ...jumpUp, ...catchBar, hang(8), level(0.05, 1.5), hang(8), ...release, stand(2)]);
  const events = run(new PocketDetector(), samples);
  const e = ends(events);
  assert.equal(e.length, 1);
  assert.ok(Math.abs(e[0].duration - 16.45) < 0.1, `duration ${e[0].duration}`);
});

test('pocket: jumping and landing on your feet is not a hang', () => {
  const samples = trace([walk(2), stand(2), ...jumpUp, ...landFeet, stand(6), walk(3)]);
  const events = run(new PocketDetector(), samples);
  assert.deepEqual(events, []);
});

test('pocket: jump, stand, jump again is not a hang', () => {
  const samples = trace([stand(2), ...jumpUp, ...landFeet, stand(6), ...jumpUp, ...landFeet, walk(3)]);
  assert.equal(ends(run(new PocketDetector(), samples)).length, 0);
});

test('pocket: a deep squat dip before a jump is not a drop', () => {
  const squatJump = [level(0.12, 0.2), level(0.2, 2.0), level(0.3, 0.05)];
  const samples = trace([walk(2), stand(6), ...squatJump, ...landFeet, stand(3), walk(2)]);
  assert.equal(ends(run(new PocketDetector(), samples)).length, 0);
});

test('pocket: walking produces nothing', () => {
  assert.deepEqual(run(new PocketDetector(), trace([walk(30)])), []);
});

test('pocket: walking away after a soft landing cancels the provisional hang', () => {
  const samples = trace([stand(2), ...jumpUp, ...catchBar, stand(4), walk(4)]);
  const events = run(new PocketDetector(), samples);
  assert.deepEqual(events.map((e) => e.type), ['start', 'cancel']);
});

test('pocket: two hangs in a row', () => {
  const one = [...jumpUp, ...catchBar, hang(10), ...release, stand(3)];
  const samples = trace([stand(2), ...one, walk(2), stand(2), ...one]);
  const e = ends(run(new PocketDetector(), samples));
  assert.equal(e.length, 2);
  for (const x of e) assert.ok(Math.abs(x.duration - 10.4) < 0.1, `duration ${x.duration}`);
});

function pose({ leftUp, rightUp, wristsVisible = true }) {
  const lm = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, visibility: 0.9 }));
  lm[0] = { x: 0.5, y: 0.35, visibility: 0.9 }; // nose
  lm[11] = { x: 0.6, y: 0.45, visibility: 0.9 };
  lm[12] = { x: 0.4, y: 0.45, visibility: 0.9 };
  const arm = (e, w, x, up) => {
    lm[e] = { x, y: up ? 0.3 : 0.6, visibility: 0.9 };
    lm[w] = { x, y: up ? 0.15 : 0.75, visibility: wristsVisible ? 0.9 : 0.1 };
  };
  arm(13, 15, 0.62, leftUp);
  arm(14, 16, 0.38, rightUp);
  return lm;
}

test('armsOverhead pose check', () => {
  assert.equal(armsOverhead(pose({ leftUp: true, rightUp: true })), true);
  assert.equal(armsOverhead(pose({ leftUp: true, rightUp: true, wristsVisible: false })), true);
  assert.equal(armsOverhead(pose({ leftUp: true, rightUp: false })), false);
  assert.equal(armsOverhead(pose({ leftUp: false, rightUp: false })), false);
  assert.equal(armsOverhead(null), false);
  const bentDown = pose({ leftUp: true, rightUp: true });
  bentDown[15].y = 0.4; // wrist below elbow
  assert.equal(armsOverhead(bentDown), false);
});

test('camera: hang with a few missed frames', () => {
  const d = new PoseHangDetector({ minDuration: 2 });
  const events = [];
  const up = pose({ leftUp: true, rightUp: true });
  const down = pose({ leftUp: false, rightUp: false });
  for (let t = 0; t < 30; t += 1 / 15) {
    let lm = t >= 5 && t < 17 ? up : down;
    if (t > 10 && t < 10.15) lm = null; // pose lost for a couple of frames
    events.push(...d.update(t, lm));
  }
  const e = ends(events);
  assert.equal(e.length, 1);
  assert.ok(Math.abs(e[0].duration - 12) < 0.3, `duration ${e[0].duration}`);
});

test('formatDuration', () => {
  assert.equal(formatDuration(4.26), '4.3s');
  assert.equal(formatDuration(59.94), '59.9s');
  assert.equal(formatDuration(65.3), '1:05.3');
  assert.equal(formatDuration(-1), '0.0s');
});
