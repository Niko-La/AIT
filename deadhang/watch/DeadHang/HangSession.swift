import CoreMotion
import Foundation
import WatchKit

struct Hang: Codable, Identifiable, Equatable {
    var id = UUID()
    var date: Date
    var duration: TimeInterval
}

enum SettingKey {
    static let minimumDuration = "minimumDuration"
    static let flipArm = "flipArm"
    static let tenSecondTaps = "tenSecondTaps"
    static let hangs = "hangs"
}

/// Runs a timing session: reads wrist motion, feeds HangDetector, buzzes, and
/// keeps the history. A physical-therapy extended runtime session keeps the
/// sensors running while your wrist is up on the bar and the screen is off.
final class HangSession: NSObject, ObservableObject {
    @Published private(set) var isRunning = false
    @Published private(set) var hangStartDate: Date?
    @Published private(set) var armRaised = false
    @Published private(set) var hangs: [Hang] = HangSession.loadHangs()
    @Published private(set) var lastHang: Hang?
    @Published private(set) var lastWasBest = false
    @Published var notice: String?

    private let motion = CMMotionManager()
    private var runtimeSession: WKExtendedRuntimeSession?
    private var detector = HangDetector()
    private var towardHandSign = 1.0
    private var tenSecondTaps = true
    private var nextTap: TimeInterval = 10
    private let defaults = UserDefaults.standard

    var best: TimeInterval { hangs.map(\.duration).max() ?? 0 }

    func start() {
        guard !isRunning else { return }
        guard motion.isDeviceMotionAvailable else {
            notice = "This watch can't read motion."
            return
        }
        let minimum = defaults.object(forKey: SettingKey.minimumDuration) as? Double ?? 3
        detector = HangDetector(minimumDuration: minimum)
        towardHandSign = Self.towardHandSign(flipped: defaults.bool(forKey: SettingKey.flipArm))
        tenSecondTaps = defaults.object(forKey: SettingKey.tenSecondTaps) as? Bool ?? true
        lastHang = nil
        lastWasBest = false
        notice = nil

        let runtime = WKExtendedRuntimeSession()
        runtime.delegate = self
        runtime.start()
        runtimeSession = runtime

        motion.deviceMotionUpdateInterval = 1.0 / 50.0
        motion.startDeviceMotionUpdates(to: .main) { [weak self] data, _ in
            guard let self, let data else { return }
            self.process(time: data.timestamp, gravityX: data.gravity.x)
        }
        isRunning = true
        WKInterfaceDevice.current().play(.start)
    }

    func stop() {
        guard isRunning else { return }
        motion.stopDeviceMotionUpdates()
        if let event = detector.finish(at: ProcessInfo.processInfo.systemUptime) {
            handle(event)
        }
        runtimeSession?.invalidate()
        runtimeSession = nil
        isRunning = false
        hangStartDate = nil
        armRaised = false
        WKInterfaceDevice.current().play(.stop)
    }

    func delete(at offsets: IndexSet) {
        // The list shows newest first.
        let indices = offsets.map { hangs.count - 1 - $0 }
        for index in indices.sorted(by: >) { hangs.remove(at: index) }
        saveHangs()
    }

    // MARK: - Motion

    private func process(time: TimeInterval, gravityX: Double) {
        let towardHand = towardHandSign * gravityX
        let raised = -towardHand >= (detector.isHanging ? detector.loweredThreshold : detector.raisedThreshold)
        if raised != armRaised { armRaised = raised } // publish changes only, not 50 times a second
        if let event = detector.update(.init(time: time, gravityTowardHand: towardHand)) {
            handle(event)
        }
        if tenSecondTaps, let start = detector.hangStart, time - start >= nextTap {
            WKInterfaceDevice.current().play(.click)
            nextTap += 10
        }
    }

    private func handle(_ event: HangDetector.Event) {
        switch event {
        case let .started(at):
            hangStartDate = date(fromUptime: at)
            nextTap = 10
            WKInterfaceDevice.current().play(.directionUp)
        case let .finished(start, end):
            hangStartDate = nil
            let previousBest = best
            let hang = Hang(date: date(fromUptime: start), duration: ((end - start) * 10).rounded() / 10)
            hangs.append(hang)
            saveHangs()
            lastHang = hang
            lastWasBest = hangs.count > 1 && hang.duration > previousBest
            WKInterfaceDevice.current().play(lastWasBest ? .notification : .success)
        case .discarded:
            hangStartDate = nil
        }
    }

    /// CoreMotion's x axis points out of the side with the Digital Crown. Worn
    /// on the left wrist with the crown on the right (the default), or on the
    /// right wrist with the crown on the left, that side faces your hand.
    /// "Flip arm direction" in Settings covers anything else.
    private static func towardHandSign(flipped: Bool) -> Double {
        let device = WKInterfaceDevice.current()
        let crownTowardHand = (device.wristLocation == .left) == (device.crownOrientation == .right)
        return (crownTowardHand ? 1 : -1) * (flipped ? -1 : 1)
    }

    private func date(fromUptime uptime: TimeInterval) -> Date {
        Date().addingTimeInterval(uptime - ProcessInfo.processInfo.systemUptime)
    }

    // MARK: - Storage

    private static func loadHangs() -> [Hang] {
        guard let data = UserDefaults.standard.data(forKey: SettingKey.hangs) else { return [] }
        return (try? JSONDecoder().decode([Hang].self, from: data)) ?? []
    }

    private func saveHangs() {
        if let data = try? JSONEncoder().encode(hangs) {
            defaults.set(data, forKey: SettingKey.hangs)
        }
    }
}

extension HangSession: WKExtendedRuntimeSessionDelegate {
    func extendedRuntimeSessionDidStart(_ extendedRuntimeSession: WKExtendedRuntimeSession) {}

    func extendedRuntimeSessionWillExpire(_ extendedRuntimeSession: WKExtendedRuntimeSession) {
        DispatchQueue.main.async {
            self.notice = "Sessions last up to an hour. Tap Start to keep going."
            self.stop()
        }
    }

    func extendedRuntimeSession(
        _ extendedRuntimeSession: WKExtendedRuntimeSession,
        didInvalidateWith reason: WKExtendedRuntimeSessionInvalidationReason,
        error: Error?
    ) {
        DispatchQueue.main.async {
            guard extendedRuntimeSession === self.runtimeSession else { return }
            self.runtimeSession = nil
            if self.isRunning, reason == .error || reason == .suppressedBySystem {
                self.notice = "Keep the app open: background timing isn't available right now."
            }
        }
    }
}
