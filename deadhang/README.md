# Dead Hang Timer

Automatically times your dead hangs. No buttons while you're on the bar.

- **iPhone:** a web app at <https://niko-la.github.io/AIT/deadhang/> that you can add to your home screen and that works offline.
- **Apple Watch:** a small native app in [`watch/`](watch/). Websites can't run on Apple Watch, so it's built with Xcode.

## iPhone: three ways to detect a hang

| Where the phone is | How it knows you're hanging | Notes |
|---|---|---|
| **Propped up, camera on you** | Pose detection: both elbows above your shoulders | Most accurate, and you can watch the timer. Runs on the phone with [MediaPipe](https://ai.google.dev/edge/mediapipe/solutions/vision/pose_landmarker); video never leaves the device. ~6 MB download on first use, then cached. |
| **In your pocket** | Accelerometer: catching the bar after a jump → letting go (free fall with no push, which can't happen from standing) → landing | Time is announced when you land. Jump up to the bar for an accurate start. Your feet have to leave the ground. |
| **In an armband** | Gravity direction flips ~180° when the arm goes overhead | Calibrates for 3 s with your arm relaxed when you tap Start. |

You get beeps when a hang starts, a spoken count every 10 s, and the final time read out (each can be switched off in Settings). History, best, and today's total are saved on the phone.

Safari needs permission for motion or camera on the first Start. While a session runs, the screen is kept awake. If the phone locks, timing pauses and any hang in progress ends at that moment.

## Files

- `index.html`, `app.js`: UI, sensors, camera, speech, history
- `detectors.js`: detection logic with no DOM code (`HangTimer`, `ArmStrapDetector`, `PocketDetector`, `PoseHangDetector`)
- `sw.js`, `manifest.webmanifest`, `icons/`: offline support and home-screen install
- `test/`: unit tests that feed synthetic sensor traces to the detectors
- `watch/`: Apple Watch app (SwiftUI + CoreMotion)

## Tests

```sh
node --test deadhang/test/*.test.mjs     # web detectors
cd deadhang/watch && swift test          # watch detector
```

To run it locally, serve the repo root over HTTP (`npx http-server .`) and open `/deadhang/`. Motion sensors and the camera need HTTPS on a real phone. GitHub Pages provides that.
