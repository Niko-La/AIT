// Dead hang detection logic. Pure functions/classes with no DOM access so the
// same code runs in the browser and in `node --test`.
//
// Every detector's update() returns a list of events:
//   { type: 'start',  t }                     a hang (probably) began at t
//   { type: 'end',    start, end, duration }  a hang finished and counts
//   { type: 'cancel', start, end?, duration? } a provisional hang was discarded
// Times are in seconds.

export const G = 9.80665;

// Debounces a noisy boolean "looks like hanging" signal into hang intervals.
// The start is back-dated to when the evidence first appeared and the end to
// when it first disappeared, so the delays don't distort the duration.
export class HangTimer {
  constructor({ onDelay = 0.5, offDelay = 0.6, minDuration = 2 } = {}) {
    this.onDelay = onDelay;
    this.offDelay = offDelay;
    this.minDuration = minDuration;
    this.reset();
  }

  reset() {
    this.phase = 'idle'; // idle | pending | hanging
    this.start = null;
    this.lostSince = null;
  }

  get hanging() {
    return this.phase === 'hanging';
  }

  update(t, evidence) {
    const events = [];
    if (this.phase === 'idle') {
      if (evidence) {
        this.phase = 'pending';
        this.start = t;
      }
    } else if (this.phase === 'pending') {
      if (!evidence) {
        this.reset();
      } else if (t - this.start >= this.onDelay) {
        this.phase = 'hanging';
        events.push({ type: 'start', t: this.start });
      }
    } else if (evidence) {
      this.lostSince = null;
    } else {
      if (this.lostSince === null) this.lostSince = t;
      if (t - this.lostSince >= this.offDelay) events.push(this._close(this.lostSince));
    }
    return events;
  }

  // Ends any hang in progress at time t (session stopped, sensor gap, ...).
  finish(t) {
    if (this.phase !== 'hanging') {
      this.reset();
      return [];
    }
    return [this._close(this.lostSince ?? t)];
  }

  _close(end) {
    const start = this.start;
    const duration = end - start;
    this.reset();
    return { type: duration >= this.minDuration ? 'end' : 'cancel', start, end, duration };
  }
}

const norm = (v) => Math.hypot(v[0], v[1], v[2]);
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

// Phone strapped to the upper arm or forearm. Calibrated with the arm relaxed
// at your side; hanging flips the arm (and the gravity vector) ~180 degrees.
export class ArmStrapDetector {
  constructor({ minDuration = 2, angleThreshold = 120, tau = 0.2 } = {}) {
    this.timer = new HangTimer({ onDelay: 0.4, offDelay: 0.4, minDuration });
    this.cosThreshold = Math.cos((angleThreshold * Math.PI) / 180);
    this.tau = tau;
    this.g = null; // low-passed gravity vector
    this.lastT = null;
    this.rest = null; // unit gravity vector with the arm down
    this.angle = null; // degrees between current and rest gravity
  }

  get calibrated() {
    return this.rest !== null;
  }

  // ax, ay, az: acceleration including gravity, any unit, any device axes.
  update(t, ax, ay, az) {
    const v = [ax, ay, az];
    if (this.g === null) {
      this.g = v;
    } else {
      const dt = Math.max(0, Math.min(t - this.lastT, 0.5));
      const k = dt / (this.tau + dt);
      for (let i = 0; i < 3; i++) this.g[i] += k * (v[i] - this.g[i]);
    }
    this.lastT = t;
    if (!this.rest) return [];
    const n = norm(this.g);
    if (n < 1e-6) return this.timer.update(t, this.timer.hanging);
    const cos = dot(this.g, this.rest) / n;
    this.angle = (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI;
    return this.timer.update(t, cos <= this.cosThreshold);
  }

  // Call while the arm hangs relaxed at your side.
  calibrate() {
    if (!this.g) return false;
    const n = norm(this.g);
    if (n < 1e-6) return false;
    this.rest = this.g.map((c) => c / n);
    return true;
  }

  get hanging() {
    return this.timer.hanging;
  }

  finish(t) {
    return this.timer.finish(t);
  }
}

// Phone in a pocket. Standing and hanging look the same to a pocketed phone,
// so this works from the transitions:
//  * A drop off the bar is free fall *without* a push beforehand (you can't
//    leave the ground from standing without pushing), followed by a landing.
//  * The hang began at the end of the last jump (catching the bar) or, if you
//    reached up without jumping, when the motion before the drop settled.
// While you hang after a jump it reports a provisional start; hangs entered
// without a jump are only reported once you drop.
export const POCKET = {
  freeFallG: 0.35, // |a| below this is free fall
  freeFallMin: 0.07, // s of free fall to count as airborne
  pushG: 1.35, // |a| above this shortly before take-off means you jumped
  pushWindow: 0.6,
  landG: 1.5, // impact after a drop
  landWindow: 1.0,
  hardLandingG: 2.6, // impact this hard right after a jump = feet, not the bar
  calmDev: 0.35, // |a - 1g| beyond this is movement (steps, adjusting)
  settle: 0.8, // s of jostling allowed after catching the bar
  provisionalCalm: 1.0, // s of calm after a catch before showing "hanging"
  guard: 0.5, // s after a landing in which another jump voids the drop
  history: 900, // s of samples kept for look-back
};

export class PocketDetector {
  constructor({ minDuration = 2, ...overrides } = {}) {
    this.c = { ...POCKET, ...overrides };
    this.minDuration = minDuration;
    this.reset();
  }

  reset() {
    this.samples = []; // [t, a]
    this.head = 0; // index of the oldest live sample
    this.lastPushT = -Infinity;
    this.airStart = null;
    this.airPushed = false;
    this.launch = null; // { airEnd, peak } most recent jump
    this.drop = null; // pending drop awaiting confirmation
    this.provisional = null; // { start, announced }
    this.lastDisturbT = -Infinity;
    this.a = 1;
  }

  get hanging() {
    return !!(this.provisional && this.provisional.announced);
  }

  // a: |acceleration including gravity| in g.
  update(t, a) {
    const c = this.c;
    const events = [];
    this.a = a;
    this.samples.push([t, a]);
    while (this.samples[this.head][0] < t - c.history) this.head++;
    if (this.head > 4096) {
      this.samples = this.samples.slice(this.head);
      this.head = 0;
    }

    // Free fall tracking.
    if (a < c.freeFallG) {
      if (this.airStart === null) {
        this.airStart = t;
        this.airPushed = t - this.lastPushT <= c.pushWindow;
      }
    } else if (this.airStart !== null) {
      const start = this.airStart;
      this.airStart = null;
      if (t - start >= c.freeFallMin) events.push(...this._airborne(start, t, this.airPushed));
    }
    if (a > c.pushG) this.lastPushT = t;
    if (Math.abs(a - 1) > c.calmDev) this.lastDisturbT = t;

    // Track the strongest impact after a jump to tell landings from catches.
    if (this.launch && t - this.launch.airEnd <= 0.3) this.launch.peak = Math.max(this.launch.peak, a);

    if (this.drop) {
      const d = this.drop;
      if (d.landedAt === null) {
        if (a > c.landG) d.landedAt = t;
        else if (t - d.airEnd > c.landWindow) this.drop = null; // never landed
      } else if (t - d.landedAt >= c.guard) {
        this.drop = null;
        events.push(...this._confirmDrop(d));
      }
    }

    // Provisional hang after a jump that wasn't a hard landing. Repeated
    // movement (walking off) voids it; a single jolt or the wobble right
    // before letting go of the bar doesn't.
    const p = this.provisional;
    if (p && !this.drop && this.airStart === null) {
      const calmFrom = p.start + c.settle;
      if (this.lastDisturbT > calmFrom && t - this.lastDisturbT <= 1.0) {
        p.disturbedAt ??= this.lastDisturbT;
        if (this.lastDisturbT - p.disturbedAt > 0.3) {
          this.provisional = null;
          if (p.announced) events.push({ type: 'cancel', start: p.start });
        }
      } else {
        p.disturbedAt = null;
        if (!p.announced && t - calmFrom >= c.provisionalCalm) {
          if (this.launch && this.launch.peak >= c.hardLandingG) {
            this.provisional = null; // landed on feet
          } else {
            p.announced = true;
            events.push({ type: 'start', t: p.start });
          }
        }
      }
    }
    return events;
  }

  _airborne(start, end, pushed) {
    if (this.drop) {
      // Jumped again right after "landing": the drop was really a squat dip.
      this.drop = null;
    }
    if (pushed) {
      // A jump. Whatever came before wasn't a hang; maybe one starts now.
      const events = [];
      if (this.provisional?.announced) events.push({ type: 'cancel', start: this.provisional.start });
      this.launch = { airEnd: end, peak: 0 };
      this.provisional = { start: end, announced: false, disturbedAt: null };
      return events;
    }
    this.drop = { airStart: start, airEnd: end, landedAt: null };
    return [];
  }

  _confirmDrop(d) {
    const c = this.c;
    const s = this.samples;
    // Release moment: last sample before free fall still near 1 g.
    let i = s.length - 1;
    while (i > this.head && s[i][0] >= d.airStart) i--;
    while (i > this.head && s[i][1] < 0.85) i--;
    const release = s[i][0];

    let start;
    const p = this.provisional;
    if (p && p.start < release) {
      start = p.start;
    } else {
      // Walk back to the last movement, ignoring the release transition.
      let j = i;
      while (j > this.head && s[j][0] > release - 0.25) j--;
      while (j > this.head && Math.abs(s[j][1] - 1) <= c.calmDev) j--;
      start = s[Math.min(j + 1, s.length - 1)][0];
    }
    this.provisional = null;
    this.launch = null;
    const duration = release - start;
    if (duration >= this.minDuration) return [{ type: 'end', start, end: release, duration }];
    return p?.announced ? [{ type: 'cancel', start }] : [];
  }

  finish() {
    const p = this.provisional;
    this.reset();
    return p?.announced ? [{ type: 'cancel', start: p.start }] : [];
  }
}

// MediaPipe pose landmark indices.
const L_SHOULDER = 11, R_SHOULDER = 12, L_ELBOW = 13, R_ELBOW = 14, L_WRIST = 15, R_WRIST = 16;

// Both arms raised overhead: elbows above shoulders and wrists not below
// elbows. Wrists often leave the top of the frame on a high bar, so a
// low-visibility wrist doesn't count against the pose.
export function armsOverhead(lm, minVisibility = 0.4) {
  if (!lm || lm.length < 17) return false;
  const seen = (p) => p && (p.visibility ?? 1) >= minVisibility;
  const armUp = (s, e, w) => {
    if (!seen(s) || !seen(e)) return false;
    if (e.y > s.y - 0.02) return false;
    if (seen(w) && w.y > e.y) return false;
    return true;
  };
  return armUp(lm[L_SHOULDER], lm[L_ELBOW], lm[L_WRIST]) && armUp(lm[R_SHOULDER], lm[R_ELBOW], lm[R_WRIST]);
}

// Camera pointed at you. Smooths the per-frame pose check over a short window
// so a dropped frame doesn't end the hang.
export class PoseHangDetector {
  constructor({ minDuration = 2, window = 0.4 } = {}) {
    this.timer = new HangTimer({ onDelay: 0.5, offDelay: 0.7, minDuration });
    this.window = window;
    this.recent = [];
    this.raw = false;
  }

  // landmarks: the first pose from PoseLandmarker (array of {x, y, visibility}) or null.
  update(t, landmarks) {
    this.raw = armsOverhead(landmarks);
    this.recent.push([t, this.raw]);
    while (this.recent.length && this.recent[0][0] < t - this.window) this.recent.shift();
    const up = this.recent.filter((r) => r[1]).length;
    return this.timer.update(t, up / this.recent.length >= 0.6);
  }

  get hanging() {
    return this.timer.hanging;
  }

  finish(t) {
    this.recent = [];
    return this.timer.finish(t);
  }
}

export function formatDuration(seconds) {
  const s = Math.max(0, seconds);
  if (s < 60) return s.toFixed(1) + 's';
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  return `${m}:${rest.toFixed(1).padStart(4, '0')}`;
}
