# Dead Hang for Apple Watch

A watch-only SwiftUI app that times dead hangs from your wrist. When you hang from a bar, your forearm is vertical with the hand on top, which the watch's gravity sensor reads directly. The app:

- buzzes when the hang starts, taps every 10 s, and buzzes again with the result (a different buzz for a new best)
- keeps running with the screen off while your wrist is up, using a *physical therapy* extended runtime session (up to 1 hour)
- ignores reaches and stretches shorter than 3 s (adjustable)
- saves history on the watch

Swipe up/down between **Timer**, **History** (swipe left on a row to delete), and **Settings**.

## Install (needs a Mac with Xcode 15 or newer)

**Option A: XcodeGen (quickest)**

```sh
brew install xcodegen
cd deadhang/watch
xcodegen
open DeadHang.xcodeproj
```

**Option B: by hand**

1. In Xcode: File → New → Project → watchOS → **App**. Name it `DeadHang` and pick the plain **Watch App** (no companion iOS app).
2. Delete the generated `ContentView.swift` and `DeadHangApp.swift`. Drag in everything from `DeadHang/` here (the `.swift` files, `Logic/`, and `Assets.xcassets`), replacing the generated asset catalog.
3. Target → Signing & Capabilities → **+ Capability → Background Modes** → Session type **Physical therapy**.

**Then, either way:**

1. Target → Signing & Capabilities → choose your **Team** (a free Apple ID works). If Xcode says the bundle ID is taken, change `la.niko.deadhang.watchkitapp` to something unique.
2. Turn on Developer Mode on the watch (Settings → Privacy & Security → Developer Mode). With the iPhone it's paired to connected or on the same Wi-Fi, select the watch as the run destination and press Run.

With a free Apple ID, apps installed this way stop opening after 7 days. Press Run again to reinstall.

## First run: check the arm direction

Tap **Start**, then raise your arm straight overhead. The timer screen should say **Arm up**. If it says **Arm down**, turn on **Settings → Flip arm direction**. This depends on which wrist you wear the watch on and which side the crown faces. The app reads both from your watch settings, but the toggle is there in case.

## Tests

The detection logic (`DeadHang/Logic/HangDetector.swift`) has no Apple-only dependencies:

```sh
swift test
```
