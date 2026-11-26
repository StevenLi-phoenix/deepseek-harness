import XCTest
@testable import DSHCall

final class CallMachineTests: XCTestCase {
    private func machine(_ direction: CallMachine.Direction, after events: [CallMachine.Event] = []) -> CallMachine {
        var machine = CallMachine(direction: direction)
        for event in events {
            _ = machine.handle(event)
        }
        return machine
    }

    private func failed(_ machine: CallMachine) -> Bool {
        if case .failed = machine.endCause { return true }
        return false
    }

    // MARK: - Incoming

    func testIncomingStartsRinging() {
        XCTAssertEqual(CallMachine(direction: .incoming).phase, .ringing)
    }

    func testAnswerConnectsAndBecomesActive() {
        var call = machine(.incoming)
        XCTAssertEqual(call.handle(.answered), [.startMedia])
        XCTAssertEqual(call.phase, .connecting)
        // An incoming call's connection is not reported to CallKit; only outgoing calls report it.
        XCTAssertEqual(call.handle(.mediaConnected), [])
        XCTAssertEqual(call.phase, .active)
    }

    func testDeclineWhileRinging() {
        var call = machine(.incoming)
        XCTAssertEqual(call.handle(.userEnded), [.postDecline, .teardown])
        XCTAssertEqual(call.endCause, .declined)
    }

    func testRemoteResolutionsWhileRinging() {
        let expectations: [(CallMachine.RemoteResolution, CallMachine.SystemEndReason, CallMachine.EndCause)] = [
            (.answeredElsewhere, .answeredElsewhere, .answeredElsewhere),
            (.declinedElsewhere, .declinedElsewhere, .declinedElsewhere),
            (.unanswered, .unanswered, .unanswered),
            (.ended, .remoteEnded, .remoteCancelled),
        ]
        for (resolution, reason, cause) in expectations {
            var call = machine(.incoming)
            XCTAssertEqual(call.handle(.remoteResolved(resolution)), [.reportEnded(reason), .teardown])
            XCTAssertEqual(call.endCause, cause)
        }
    }

    func testRingTimeout() {
        var call = machine(.incoming)
        XCTAssertEqual(call.handle(.ringTimedOut), [.reportEnded(.unanswered), .teardown])
        XCTAssertEqual(call.endCause, .unanswered)
    }

    func testRemoteResolutionAfterAnswerIsIgnored() {
        var call = machine(.incoming, after: [.answered])
        XCTAssertEqual(call.handle(.remoteResolved(.answeredElsewhere)), [])
        XCTAssertEqual(call.handle(.ringTimedOut), [])
        XCTAssertEqual(call.phase, .connecting)
    }

    // MARK: - Outgoing

    func testOutgoingStartsDialing() {
        XCTAssertEqual(CallMachine(direction: .outgoing).phase, .dialing)
    }

    func testOutgoingStartAndConnect() {
        var call = machine(.outgoing)
        XCTAssertEqual(call.handle(.started), [.startMedia])
        XCTAssertEqual(call.handle(.mediaConnected), [.reportOutgoingConnected])
        XCTAssertEqual(call.phase, .active)
    }

    func testOutgoingRejectedByCallKit() {
        var call = machine(.outgoing)
        XCTAssertEqual(call.handle(.startRejected("busy")), [.postHangup, .teardown])
        XCTAssertEqual(call.endCause, .failed("busy"))
    }

    func testOutgoingCancelledWhileDialing() {
        var call = machine(.outgoing)
        XCTAssertEqual(call.handle(.userEnded), [.postHangup, .teardown])
        XCTAssertEqual(call.endCause, .hungUp)
    }

    func testAnswerDoesNotApplyToOutgoing() {
        var call = machine(.outgoing)
        XCTAssertEqual(call.handle(.answered), [])
        XCTAssertEqual(call.phase, .dialing)
    }

    // MARK: - Connecting

    func testConnectRejections() {
        var elsewhere = machine(.incoming, after: [.answered])
        XCTAssertEqual(elsewhere.handle(.connectRejected(.answeredElsewhere)), [.reportEnded(.answeredElsewhere), .teardown])
        XCTAssertEqual(elsewhere.endCause, .answeredElsewhere)

        var gone = machine(.incoming, after: [.answered])
        XCTAssertEqual(gone.handle(.connectRejected(.gone)), [.reportEnded(.remoteEnded), .teardown])
        XCTAssertEqual(gone.endCause, .remoteHangup)

        var notConnectable = machine(.outgoing, after: [.started])
        XCTAssertEqual(notConnectable.handle(.connectRejected(.notConnectable)), [.reportEnded(.failed), .teardown])
        XCTAssertTrue(failed(notConnectable))
    }

    func testConnectFailureAndTimeoutHangUpOnTheServer() {
        var failure = machine(.incoming, after: [.answered])
        XCTAssertEqual(failure.handle(.connectFailed("offline")), [.postHangup, .reportEnded(.failed), .teardown])
        XCTAssertEqual(failure.endCause, .failed("offline"))

        var timeout = machine(.outgoing, after: [.started])
        XCTAssertEqual(timeout.handle(.connectTimedOut), [.postHangup, .reportEnded(.failed), .teardown])
        XCTAssertTrue(failed(timeout))
    }

    func testConnectTimeoutAfterConnectingIsIgnored() {
        var call = machine(.incoming, after: [.answered, .mediaConnected])
        XCTAssertEqual(call.handle(.connectTimedOut), [])
        XCTAssertEqual(call.phase, .active)
    }

    // MARK: - Active

    func testOwnerHangsUp() {
        var call = machine(.incoming, after: [.answered, .mediaConnected])
        XCTAssertEqual(call.handle(.userEnded), [.sendHangupMessage, .postHangup, .teardown])
        XCTAssertEqual(call.endCause, .hungUp)
    }

    func testOwnerHangsUpWhileConnecting() {
        var call = machine(.outgoing, after: [.started])
        XCTAssertEqual(call.handle(.userEnded), [.sendHangupMessage, .postHangup, .teardown])
    }

    func testServerHangsUp() {
        var call = machine(.outgoing, after: [.started, .mediaConnected])
        XCTAssertEqual(call.handle(.serverHangup), [.reportEnded(.remoteEnded), .teardown])
        XCTAssertEqual(call.endCause, .remoteHangup)
    }

    func testMediaFailure() {
        var call = machine(.incoming, after: [.answered, .mediaConnected])
        XCTAssertEqual(call.handle(.mediaFailed("lost")), [.postHangup, .reportEnded(.failed), .teardown])
        XCTAssertEqual(call.endCause, .failed("lost"))
    }

    func testSystemReset() {
        var active = machine(.incoming, after: [.answered, .mediaConnected])
        XCTAssertEqual(active.handle(.systemReset), [.sendHangupMessage, .postHangup, .teardown])
        XCTAssertTrue(failed(active))

        var ringing = machine(.incoming)
        XCTAssertEqual(ringing.handle(.systemReset), [.postHangup, .teardown])

        var dialing = machine(.outgoing)
        XCTAssertEqual(dialing.handle(.systemReset), [.postHangup, .teardown])
    }

    // MARK: - Ended

    func testEveryEventIsIgnoredOnceEnded() {
        let events: [CallMachine.Event] = [
            .answered, .started, .startRejected("x"), .mediaConnected, .userEnded, .serverHangup,
            .remoteResolved(.ended), .connectRejected(.gone), .connectFailed("x"), .connectTimedOut,
            .mediaFailed("x"), .ringTimedOut, .systemReset,
        ]
        for event in events {
            var call = machine(.incoming, after: [.userEnded])
            XCTAssertEqual(call.handle(event), [], "\(event)")
            XCTAssertEqual(call.endCause, .declined)
            XCTAssertTrue(call.isEnded)
        }
    }

    // MARK: - Ring watch

    private func call(state: String, outcome: String?) -> Call {
        Call(
            callId: "6f1c1b6e-2a4d-4c8e-9f3a-0d5b7e2c9a41",
            initiator: .agent,
            state: Call.State(rawValue: state),
            reason: nil,
            createdAt: 0,
            answeredAt: nil,
            endedAt: nil,
            outcome: outcome.map { Call.Outcome(rawValue: $0) }
        )
    }

    func testRingingResolution() {
        XCTAssertNil(CallMachine.ringingResolution(for: call(state: "ringing", outcome: nil)))
        XCTAssertEqual(CallMachine.ringingResolution(for: call(state: "connecting", outcome: nil)), .answeredElsewhere)
        XCTAssertEqual(CallMachine.ringingResolution(for: call(state: "active", outcome: nil)), .answeredElsewhere)
        XCTAssertEqual(CallMachine.ringingResolution(for: call(state: "ended", outcome: "declined")), .declinedElsewhere)
        XCTAssertEqual(CallMachine.ringingResolution(for: call(state: "ended", outcome: "missed")), .unanswered)
        XCTAssertEqual(CallMachine.ringingResolution(for: call(state: "ended", outcome: "cancelled")), .ended)
        XCTAssertEqual(CallMachine.ringingResolution(for: call(state: "ended", outcome: "failed")), .ended)
        XCTAssertEqual(CallMachine.ringingResolution(for: call(state: "ended", outcome: nil)), .ended)
        XCTAssertNil(CallMachine.ringingResolution(for: call(state: "parked", outcome: nil)))
    }
}
