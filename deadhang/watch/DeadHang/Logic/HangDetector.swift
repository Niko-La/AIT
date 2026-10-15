import Foundation

/// Decides when a dead hang starts and ends from Apple Watch motion data.
///
/// Hanging from a bar holds your forearm vertical with the hand on top, so
/// gravity runs from your hand toward your elbow. The watch measures that
/// directly. A short debounce filters out reaching and arm swings, and
/// hysteresis keeps a little swinging on the bar from ending the hang.
///
/// Pure logic with no Apple-only frameworks, so it's unit-testable anywhere
/// (`swift test` in the `watch` folder).
struct HangDetector {
    struct Sample {
        var time: TimeInterval
        /// Gravity along the forearm in g: +1 hand straight down, -1 hand straight up.
        var gravityTowardHand: Double
    }

    enum Event: Equatable {
        case started(at: TimeInterval)
        case finished(start: TimeInterval, end: TimeInterval)
        /// Arm was up, but not for `minimumDuration` (a reach or a stretch).
        case discarded(start: TimeInterval, end: TimeInterval)
    }

    var minimumDuration: TimeInterval
    /// Arm counts as raised when -gravityTowardHand reaches this (0.6 ≈ forearm within 53° of vertical).
    var raisedThreshold: Double
    /// ...and stays raised until it drops below this.
    var loweredThreshold: Double
    var onDelay: TimeInterval
    var offDelay: TimeInterval

    private(set) var hangStart: TimeInterval?
    private var pendingStart: TimeInterval?
    private var loweredSince: TimeInterval?

    init(
        minimumDuration: TimeInterval = 3,
        raisedThreshold: Double = 0.6,
        loweredThreshold: Double = 0.4,
        onDelay: TimeInterval = 0.4,
        offDelay: TimeInterval = 0.4
    ) {
        self.minimumDuration = minimumDuration
        self.raisedThreshold = raisedThreshold
        self.loweredThreshold = loweredThreshold
        self.onDelay = onDelay
        self.offDelay = offDelay
    }

    var isHanging: Bool { hangStart != nil }

    /// Feed every motion sample. Start and end times are back-dated to when the
    /// arm actually went up or came down, so the debounce doesn't skew the time.
    mutating func update(_ sample: Sample) -> Event? {
        let raise = -sample.gravityTowardHand
        if let start = hangStart {
            if raise >= loweredThreshold {
                loweredSince = nil
                return nil
            }
            let since = loweredSince ?? sample.time
            loweredSince = since
            guard sample.time - since >= offDelay else { return nil }
            return close(start: start, end: since)
        }
        // Same hysteresis while confirming a start, so swinging right after
        // catching the bar doesn't restart the debounce.
        guard raise >= (pendingStart == nil ? raisedThreshold : loweredThreshold) else {
            pendingStart = nil
            return nil
        }
        let since = pendingStart ?? sample.time
        pendingStart = since
        guard sample.time - since >= onDelay else { return nil }
        hangStart = since
        pendingStart = nil
        return .started(at: since)
    }

    /// Ends a hang in progress, e.g. when the session is stopped.
    mutating func finish(at time: TimeInterval) -> Event? {
        pendingStart = nil
        guard let start = hangStart else { return nil }
        return close(start: start, end: loweredSince ?? time)
    }

    private mutating func close(start: TimeInterval, end: TimeInterval) -> Event {
        hangStart = nil
        loweredSince = nil
        if end - start >= minimumDuration {
            return .finished(start: start, end: end)
        }
        return .discarded(start: start, end: end)
    }
}

/// "42.3s" under a minute, "1:05.3" above. Without tenths for the always-on display.
func formatHang(_ seconds: TimeInterval, tenths: Bool = true) -> String {
    let s = max(0, seconds)
    if s < 60 {
        return tenths ? String(format: "%.1fs", s) : String(format: "%.0fs", s.rounded(.down))
    }
    let minutes = Int(s / 60)
    let rest = s - Double(minutes * 60)
    return tenths
        ? String(format: "%d:%04.1f", minutes, rest)
        : String(format: "%d:%02d", minutes, Int(rest))
}
