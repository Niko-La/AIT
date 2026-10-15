import XCTest
@testable import DeadHangLogic

final class HangDetectorTests: XCTestCase {
    /// Runs 50 Hz samples where `gravity(t)` gives gravity toward the hand.
    private func run(
        _ detector: inout HangDetector,
        from start: TimeInterval = 0,
        to end: TimeInterval,
        gravity: (TimeInterval) -> Double
    ) -> [HangDetector.Event] {
        var events: [HangDetector.Event] = []
        var t = start
        while t < end {
            if let e = detector.update(.init(time: t, gravityTowardHand: gravity(t))) { events.append(e) }
            t += 0.02
        }
        return events
    }

    func testHangIsTimedFromArmUpToArmDown() {
        var d = HangDetector()
        let events = run(&d, to: 30) { t in
            switch t {
            case ..<5: return 0.95 // arm hanging at your side
            case ..<25: return -0.97 // overhead on the bar
            default: return 0.95
            }
        }
        XCTAssertEqual(events.count, 2)
        guard case let .started(at) = events[0], case let .finished(start, end) = events[1] else {
            return XCTFail("unexpected events \(events)")
        }
        XCTAssertEqual(at, 5, accuracy: 0.03)
        XCTAssertEqual(start, 5, accuracy: 0.03)
        XCTAssertEqual(end, 25, accuracy: 0.03)
    }

    func testSwingingOnTheBarDoesNotEndTheHang() {
        var d = HangDetector()
        let events = run(&d, to: 20) { t in
            guard t >= 2, t < 17 else { return 0.9 }
            return -0.75 + 0.25 * sin(t * 3) // dips to -0.5, still above the lowered threshold
        }
        XCTAssertEqual(events.count, 2)
        guard case let .finished(start, end) = events[1] else { return XCTFail("\(events)") }
        XCTAssertEqual(end - start, 15, accuracy: 0.05)
    }

    func testShortReachIsDiscarded() {
        var d = HangDetector(minimumDuration: 3)
        let events = run(&d, to: 6) { t in (2..<3.5).contains(t) ? -0.9 : 0.9 }
        guard case .discarded = events.last else { return XCTFail("\(events)") }
    }

    func testFlickerShorterThanOnDelayIsIgnored() {
        var d = HangDetector()
        let events = run(&d, to: 5) { t in (2..<2.2).contains(t) ? -0.9 : 0.1 }
        XCTAssertEqual(events, [])
    }

    func testArmHorizontalCheckingTheWatchIsNotAHang() {
        var d = HangDetector()
        XCTAssertEqual(run(&d, to: 10) { _ in 0.05 }, [])
    }

    func testStoppingMidHangKeepsIt() {
        var d = HangDetector()
        _ = run(&d, to: 8) { t in t < 1 ? 0.9 : -0.95 }
        XCTAssertTrue(d.isHanging)
        guard case let .finished(start, end) = d.finish(at: 8) else { return XCTFail() }
        XCTAssertEqual(end - start, 7, accuracy: 0.03)
        XCTAssertFalse(d.isHanging)
    }

    func testFormatting() {
        XCTAssertEqual(formatHang(4.26), "4.3s")
        XCTAssertEqual(formatHang(65.3), "1:05.3")
        XCTAssertEqual(formatHang(42.9, tenths: false), "42s")
        XCTAssertEqual(formatHang(125.7, tenths: false), "2:05")
        XCTAssertEqual(formatHang(-3), "0.0s")
    }
}
