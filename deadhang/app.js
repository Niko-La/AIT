import { ArmStrapDetector, PocketDetector, PoseHangDetector, G, formatDuration } from './detectors.js';

const MEDIAPIPE = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35';
const POSE_MODEL =
  'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task';
const MODE_NAMES = { camera: 'Camera', pocket: 'Pocket', arm: 'Armband' };

const $ = (id) => document.getElementById(id);
const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v === null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* private mode: keep going without saving */
    }
  },
};

const settings = { voice: true, callouts: true, beeps: true, minDuration: 3, ...store.get('dh.settings', {}) };
let history = store.get('dh.history', []); // [{ at: epoch ms, duration: s, mode }]
let mode = MODE_NAMES[store.get('dh.mode', 'camera')] ? store.get('dh.mode', 'camera') : 'camera';
let session = null;
let lastResult = null; // { duration, best }

// ---------- UI helpers ----------

function setState(kind, label, sub = '', isError = false) {
  const el = $('state');
  el.dataset.kind = kind;
  el.textContent = label;
  $('sub').textContent = sub;
  $('sub').classList.toggle('error', isError);
}

function showClock(seconds, live) {
  const clock = $('clock');
  clock.textContent = formatDuration(seconds);
  clock.classList.toggle('live', live);
  if (!live && lastResult?.best) {
    const badge = document.createElement('span');
    badge.id = 'best-badge';
    badge.textContent = 'BEST';
    clock.append(badge);
  }
}

function render() {
  for (const input of document.querySelectorAll('input[name="mode"]')) input.checked = input.value === mode;
  $('mode-pill').textContent = MODE_NAMES[mode];
  $('set-voice').checked = settings.voice;
  $('set-callouts').checked = settings.callouts;
  $('set-beeps').checked = settings.beeps;
  $('set-min').value = String(settings.minDuration);
  renderHistory();
}

function renderHistory() {
  const best = history.reduce((m, h) => Math.max(m, h.duration), 0);
  const today = new Date().toDateString();
  const todays = history.filter((h) => new Date(h.at).toDateString() === today);
  $('stat-best').textContent = history.length ? formatDuration(best) : '–';
  $('stat-today').textContent = todays.length ? formatDuration(todays.reduce((s, h) => s + h.duration, 0)) : '–';
  $('stat-count').textContent = String(history.length);

  const list = $('history-list');
  list.replaceChildren();
  const fmt = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  history
    .map((h, index) => ({ ...h, index }))
    .reverse()
    .slice(0, 100)
    .forEach((h) => {
      const li = document.createElement('li');
      const when = document.createElement('span');
      when.className = 'when';
      when.textContent = `${fmt.format(h.at)} · ${MODE_NAMES[h.mode] ?? h.mode}`;
      const dur = document.createElement('span');
      dur.className = 'dur';
      dur.textContent = formatDuration(h.duration) + (h.duration === best ? ' ★' : '');
      const del = document.createElement('button');
      del.className = 'del';
      del.type = 'button';
      del.textContent = '×';
      del.setAttribute('aria-label', `Delete ${formatDuration(h.duration)} hang`);
      del.addEventListener('click', () => {
        history.splice(h.index, 1);
        store.set('dh.history', history);
        renderHistory();
      });
      li.append(when, dur, del);
      list.append(li);
    });
  $('history-empty').hidden = history.length > 0;
  $('export').hidden = history.length === 0;
}

// ---------- Sound + speech ----------

let audio = null;

function unlockAudio() {
  try {
    audio ??= new (window.AudioContext || window.webkitAudioContext)();
    audio.resume();
  } catch {
    audio = null;
  }
  if ('speechSynthesis' in window) {
    // iOS only allows speech after a tap has spoken once.
    const u = new SpeechSynthesisUtterance(' ');
    u.volume = 0;
    speechSynthesis.speak(u);
  }
}

function beep(freq = 880, ms = 120, times = 1) {
  if (!settings.beeps || !audio) return;
  for (let i = 0; i < times; i++) {
    const t0 = audio.currentTime + i * (ms / 1000 + 0.08);
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(0.4, t0 + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + ms / 1000);
    osc.connect(gain).connect(audio.destination);
    osc.start(t0);
    osc.stop(t0 + ms / 1000 + 0.02);
  }
}

function speak(text, { interrupt = false } = {}) {
  if (!settings.voice || !('speechSynthesis' in window)) return;
  if (interrupt) speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.rate = 1.05;
  speechSynthesis.speak(u);
}

function spokenDuration(s) {
  const total = Math.round(s);
  const m = Math.floor(total / 60);
  const sec = total % 60;
  const parts = [];
  if (m) parts.push(`${m} ${m === 1 ? 'minute' : 'minutes'}`);
  if (sec || !m) parts.push(`${sec} ${sec === 1 ? 'second' : 'seconds'}`);
  return parts.join(' ');
}

// ---------- Screen wake lock ----------

async function lockScreen(s) {
  if (!('wakeLock' in navigator)) return false;
  try {
    const lock = await navigator.wakeLock.request('screen');
    if (session !== s) {
      lock.release().catch(() => {});
      return false;
    }
    s.wakeLock = lock;
    return true;
  } catch {
    return false;
  }
}

// iOS drops the wake lock whenever the page is hidden; take it back on return.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && session && (!session.wakeLock || session.wakeLock.released)) {
    lockScreen(session);
  }
});

// ---------- Session ----------

function start() {
  if (session) return;
  // Everything that needs the tap's user activation is kicked off before the first await.
  unlockAudio();
  const s = { mode, detector: null, hangStart: null, nextCallout: 10, cleanup: [], facing: 'user', live: '' };
  session = s;
  const motionPermission =
    mode !== 'camera' && typeof window.DeviceMotionEvent?.requestPermission === 'function'
      ? DeviceMotionEvent.requestPermission()
      : Promise.resolve('granted');
  const camera = mode === 'camera' ? openCamera(s.facing) : null;
  const wake = lockScreen(s);

  document.body.classList.add('running');
  $('start').hidden = true;
  $('stop').hidden = false;
  lastResult = null;
  showClock(0, false);

  const run = mode === 'camera' ? startCamera(s, camera) : startMotion(s, motionPermission);
  run
    .then(async () => {
      if (session === s && !(await wake)) {
        $('live').textContent = "Couldn't keep the screen on. Turn off Auto-Lock so timing doesn't pause.";
      }
    })
    .catch((err) => {
      if (session !== s) return;
      stop();
      setState('error', 'Problem', err.message, true);
    });
  frame(s);
}

function stop() {
  const s = session;
  if (!s) return;
  session = null;
  if ('speechSynthesis' in window) speechSynthesis.cancel();
  // A hang still in progress when you stop is kept (spoken and saved).
  if (s.detector) handle(s, s.detector.finish(performance.now() / 1000));
  for (const fn of s.cleanup) fn();
  s.wakeLock?.release().catch(() => {});
  document.body.classList.remove('running');
  $('start').hidden = false;
  $('stop').hidden = true;
  $('live').textContent = '';
  $('stage').classList.remove('camera');
  $('video').hidden = $('overlay').hidden = $('flip').hidden = true;
  setState('idle', 'Stopped', lastResult ? 'Nice work.' : 'Tap Start when you are ready.');
}

function waiting(s) {
  const sub = {
    camera: 'Get in frame and grab the bar.',
    pocket: 'Jump up to the bar. Your time is called out when you drop.',
    arm: 'Grab the bar whenever you are ready.',
  }[s.mode];
  setState('waiting', 'Waiting for hang', sub);
}

function handle(s, events) {
  for (const e of events) {
    if (e.type === 'start') {
      s.hangStart = e.t;
      s.nextCallout = 10;
      beep(988, 110);
      setState('hanging', 'Hanging', s.mode === 'pocket' ? 'Drop off the bar to finish.' : '');
    } else if (e.type === 'end') {
      s.hangStart = null;
      record(s, e);
    } else if (e.type === 'cancel') {
      s.hangStart = null;
      if (session === s) {
        waiting(s);
        $('sub').textContent = 'That one was too short or not a hang.';
      }
    }
  }
}

function record(s, e) {
  const duration = Math.round(e.duration * 10) / 10;
  const previousBest = history.reduce((m, h) => Math.max(m, h.duration), 0);
  const at = Date.now() - (performance.now() / 1000 - e.start) * 1000;
  history.push({ at: Math.round(at), duration, mode: s.mode });
  store.set('dh.history', history);
  const best = history.length > 1 && duration > previousBest;
  lastResult = { duration, best };
  showClock(duration, false);
  renderHistory();
  beep(660, 140, 2);
  speak(`${spokenDuration(duration)}.${best ? ' New best!' : ''}`, { interrupt: true });
  if (session === s) {
    waiting(s);
    $('sub').textContent = best ? 'New personal best! Go again whenever you like.' : 'Saved. Go again whenever you like.';
  }
}

function frame(s) {
  if (session !== s) return;
  if (s.hangStart !== null) {
    const elapsed = performance.now() / 1000 - s.hangStart;
    showClock(elapsed, true);
    if (settings.callouts && elapsed >= s.nextCallout) {
      speak(s.nextCallout % 60 === 0 ? spokenDuration(s.nextCallout) : String(s.nextCallout));
      s.nextCallout += 10;
    }
  }
  if (s.live) $('live').textContent = s.live;
  requestAnimationFrame(() => frame(s));
}

// ---------- Motion modes ----------

async function startMotion(s, permission) {
  if (typeof DeviceMotionEvent === 'undefined') throw new Error('This browser has no motion sensors. Open this page on your iPhone.');
  setState('waiting', 'Starting', 'Allow motion access if asked.');
  let result;
  try {
    result = await permission;
  } catch {
    result = 'denied';
  }
  if (result !== 'granted') {
    throw new Error('Motion access was denied. Close and reopen this page in Safari, then tap Allow when asked.');
  }
  if (session !== s) return;

  const minDuration = settings.minDuration;
  s.detector = s.mode === 'pocket' ? new PocketDetector({ minDuration }) : new ArmStrapDetector({ minDuration });
  let lastT = null;
  let received = false;
  const onMotion = (e) => {
    const acc = e.accelerationIncludingGravity;
    if (!acc || acc.x === null) return;
    received = true;
    const t = performance.now() / 1000;
    // A long gap means the screen locked or the page was hidden: end any
    // hang at the last moment we actually saw it.
    if (lastT !== null && t - lastT > 1.5) handle(s, s.detector.finish(lastT));
    lastT = t;
    if (s.mode === 'pocket') {
      const a = Math.hypot(acc.x, acc.y, acc.z) / G;
      handle(s, s.detector.update(t, a));
      s.live = `Motion ${a.toFixed(2)} g`;
    } else {
      handle(s, s.detector.update(t, acc.x, acc.y, acc.z));
      if (s.detector.angle !== null) s.live = `Arm raised ${Math.round(s.detector.angle)}° (hang at 120°+)`;
    }
  };
  window.addEventListener('devicemotion', onMotion);
  s.cleanup.push(() => window.removeEventListener('devicemotion', onMotion));

  await sleep(1500);
  if (session !== s) return;
  if (!received) throw new Error('No motion sensor data. Open this page on your iPhone in Safari.');

  if (s.mode === 'arm') {
    setState('waiting', 'Calibrating', 'Let your arm hang relaxed at your side…');
    speak('Let your arm hang relaxed at your side.');
    for (let i = 3; i > 0; i--) {
      $('clock').textContent = String(i);
      await sleep(1000);
      if (session !== s) return;
    }
    if (!s.detector.calibrate()) throw new Error('Calibration failed. Try again.');
    showClock(0, false);
    beep(988, 90);
    speak('Ready.');
  } else {
    speak('Ready. Pocket your phone and jump up to the bar.');
  }
  waiting(s);
}

// ---------- Camera mode ----------

let landmarkerPromise = null;

function loadLandmarker() {
  landmarkerPromise ??= (async () => {
    const { FilesetResolver, PoseLandmarker } = await import(`${MEDIAPIPE}/vision_bundle.mjs`);
    const fileset = await FilesetResolver.forVisionTasks(`${MEDIAPIPE}/wasm`);
    const options = (delegate) => ({
      baseOptions: { modelAssetPath: POSE_MODEL, delegate },
      runningMode: 'VIDEO',
      numPoses: 1,
    });
    try {
      return await PoseLandmarker.createFromOptions(fileset, options('GPU'));
    } catch {
      return await PoseLandmarker.createFromOptions(fileset, options('CPU'));
    }
  })();
  landmarkerPromise.catch(() => (landmarkerPromise = null));
  return landmarkerPromise;
}

function openCamera(facing) {
  if (!navigator.mediaDevices?.getUserMedia) return Promise.reject(new Error('This browser cannot use the camera.'));
  return navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { facingMode: facing, width: { ideal: 640 }, height: { ideal: 480 } },
  });
}

async function attachStream(s, stream) {
  const video = $('video');
  s.stream?.getTracks().forEach((t) => t.stop());
  s.stream = stream;
  video.srcObject = stream;
  video.muted = true;
  video.classList.toggle('mirror', s.facing === 'user');
  $('overlay').classList.toggle('mirror', s.facing === 'user');
  await video.play();
}

async function startCamera(s, cameraPromise) {
  setState('waiting', 'Starting', 'Loading pose detection… (about 6 MB the first time)');
  $('stage').classList.add('camera');
  $('video').hidden = $('overlay').hidden = $('flip').hidden = false;
  s.cleanup.push(() => {
    s.stream?.getTracks().forEach((t) => t.stop());
    $('video').srcObject = null;
  });

  let stream;
  try {
    stream = await cameraPromise;
  } catch (err) {
    throw new Error(err?.name === 'NotAllowedError' ? 'Camera access was denied. Allow it in Settings → Safari → Camera.' : 'Could not open the camera.');
  }
  if (session !== s) return stream.getTracks().forEach((t) => t.stop());
  await attachStream(s, stream);

  let landmarker;
  try {
    landmarker = await loadLandmarker();
  } catch {
    throw new Error('Could not load pose detection. Check your connection and try again.');
  }
  if (session !== s) return;

  s.detector = new PoseHangDetector({ minDuration: settings.minDuration });
  const video = $('video');
  let lastRun = 0;
  let lastVideoTime = -1;
  const tick = () => {
    if (session !== s) return;
    const now = performance.now();
    if (video.readyState >= 2 && now - lastRun >= 50 && video.currentTime !== lastVideoTime) {
      lastRun = now;
      lastVideoTime = video.currentTime;
      let lm = null;
      try {
        lm = landmarker.detectForVideo(video, now).landmarks?.[0] ?? null;
      } catch {
        /* skip a frame the model couldn't read */
      }
      handle(s, s.detector.update(now / 1000, lm));
      drawPose(lm, s.detector.raw);
      s.live = lm ? (s.detector.raw ? 'Arms overhead ✓' : 'I can see you') : 'No one in view';
    }
    s.raf = requestAnimationFrame(tick);
  };
  s.cleanup.push(() => cancelAnimationFrame(s.raf));
  tick();
  speak('Ready. Get in frame and grab the bar.');
  waiting(s);
}

async function flipCamera() {
  const s = session;
  if (!s || s.mode !== 'camera') return;
  s.facing = s.facing === 'user' ? 'environment' : 'user';
  try {
    const stream = await openCamera(s.facing);
    if (session !== s) return stream.getTracks().forEach((t) => t.stop());
    await attachStream(s, stream);
  } catch {
    $('live').textContent = 'Could not switch cameras.';
  }
}

const ARM_LINES = [
  [11, 13], [13, 15], [12, 14], [14, 16], [11, 12], [11, 23], [12, 24], [23, 24],
];

function drawPose(lm, armsUp) {
  const canvas = $('overlay');
  const video = $('video');
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  const dpr = window.devicePixelRatio || 1;
  if (canvas.width !== Math.round(w * dpr)) canvas.width = Math.round(w * dpr);
  if (canvas.height !== Math.round(h * dpr)) canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  if (!lm || !video.videoWidth) return;
  // Match the video's object-fit: cover crop.
  const scale = Math.max(w / video.videoWidth, h / video.videoHeight);
  const ox = (w - video.videoWidth * scale) / 2;
  const oy = (h - video.videoHeight * scale) / 2;
  const px = (p) => [ox + p.x * video.videoWidth * scale, oy + p.y * video.videoHeight * scale];
  ctx.lineWidth = 5;
  ctx.lineCap = 'round';
  ctx.strokeStyle = armsUp ? '#34c759' : 'rgba(255,255,255,.7)';
  ctx.beginPath();
  for (const [a, b] of ARM_LINES) {
    if ((lm[a].visibility ?? 1) < 0.4 || (lm[b].visibility ?? 1) < 0.4) continue;
    ctx.moveTo(...px(lm[a]));
    ctx.lineTo(...px(lm[b]));
  }
  ctx.stroke();
}

// ---------- Misc ----------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function exportCsv() {
  const rows = [['date', 'seconds', 'mode'], ...history.map((h) => [new Date(h.at).toISOString(), h.duration, h.mode])];
  const blob = new Blob([rows.map((r) => r.join(',')).join('\n')], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'dead-hangs.csv';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function setupHoldToStop() {
  const btn = $('stop');
  let timer = null;
  const cancel = () => {
    clearTimeout(timer);
    timer = null;
    btn.classList.remove('pressing');
  };
  btn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    btn.classList.add('pressing');
    timer = setTimeout(() => {
      cancel();
      stop();
    }, 800);
  });
  for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) btn.addEventListener(ev, cancel);
  btn.addEventListener('contextmenu', (e) => e.preventDefault());
  // Keyboard users: Enter/Space stops immediately.
  btn.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') stop();
  });
}

function saveSettings() {
  store.set('dh.settings', settings);
}

function init() {
  for (const input of document.querySelectorAll('input[name="mode"]')) {
    input.addEventListener('change', () => {
      mode = input.value;
      store.set('dh.mode', mode);
      render();
    });
  }
  $('start').addEventListener('click', start);
  $('flip').addEventListener('click', flipCamera);
  $('export').addEventListener('click', exportCsv);
  $('set-voice').addEventListener('change', (e) => ((settings.voice = e.target.checked), saveSettings()));
  $('set-callouts').addEventListener('change', (e) => ((settings.callouts = e.target.checked), saveSettings()));
  $('set-beeps').addEventListener('change', (e) => ((settings.beeps = e.target.checked), saveSettings()));
  $('set-min').addEventListener('change', (e) => ((settings.minDuration = Number(e.target.value)), saveSettings()));
  setupHoldToStop();

  const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
  $('install-tip').hidden = !(ios && !standalone);

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  render();
  if (history.length) {
    const last = history[history.length - 1];
    showClock(last.duration, false);
    $('sub').textContent = 'Your last hang. Choose a mode and tap Start.';
  }
}

init();
