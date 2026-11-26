import Foundation

/// The life of one call as a pure state machine. `handle(_:)` returns the side effects the caller must
/// perform, in order; the machine itself touches no API, CallKit, or media. Once ended, every event is
/// ignored, so late timers and duplicate callbacks are harmless.
struct CallMachine: Equatable, Sendable {
    enum Direction: Equatable, Sendable {
        /// DSH calls the owner (VoIP push).
        case incoming
        /// The owner calls DSH.
        case outgoing
    }

    enum Phase: Equatable, Sendable {
        /// Incoming and reported to CallKit; not answered yet.
        case ringing
        /// Outgoing: the server call exists and CallKit has been asked to start it.
        case dialing
        /// Answered or started; WebRTC is negotiating.
        case connecting
        /// Media is connected.
        case active
        case ended(EndCause)
    }

    enum EndCause: Equatable, Sendable {
        /// The owner declined while it was ringing.
        case declined
        /// The owner hung up.
        case hungUp
        /// DSH ended the call (control-channel `hangup`, or 410 from connect).
        case remoteHangup
        /// Picked up on another of the owner's devices.
        case answeredElsewhere
        /// Declined on another of the owner's devices.
        case declinedElsewhere
        /// The server ended the call before it was answered.
        case remoteCancelled
        /// Nobody answered before the ring limit.
        case unanswered
        case failed(String)
    }

    /// Why the app (not the user) ended the call, as reported to CallKit.
    enum SystemEndReason: Equatable, Sendable {
        case failed
        case remoteEnded
        case unanswered
        case answeredElsewhere
        case declinedElsewhere
    }

    /// What polling `GET /calls/{id}` found while ringing.
    enum RemoteResolution: Equatable, Sendable {
        case answeredElsewhere
        case declinedElsewhere
        /// The server gave up ringing (outcome `missed`).
        case unanswered
        /// Ended for any other reason, for example DSH cancelled it.
        case ended
    }

    /// Why `POST /connect` refused the call.
    enum ConnectRejection: Equatable, Sendable {
        /// 409, and the call is in use on another device.
        case answeredElsewhere
        /// 409 for any other reason.
        case notConnectable
        /// 410: the call has ended.
        case gone
    }

    enum Event: Equatable, Sendable {
        /// CallKit performed the answer action.
        case answered
        /// CallKit performed the start action for an outgoing call.
        case started
        /// CallKit refused to start the outgoing call.
        case startRejected(String)
        case mediaConnected
        /// The owner ended the call through CallKit (decline while ringing, hang up otherwise).
        case userEnded
        /// DSH sent `hangup` on the control channel.
        case serverHangup
        case remoteResolved(RemoteResolution)
        case connectRejected(ConnectRejection)
        case connectFailed(String)
        /// Media did not connect within the connect timeout.
        case connectTimedOut
        /// ICE failed, or stayed disconnected too long.
        case mediaFailed(String)
        case ringTimedOut
        /// CallKit reset the provider; every call is already gone from the system UI.
        case systemReset
    }

    enum Effect: Equatable, Sendable {
        /// Create the WebRTC session and connect it.
        case startMedia
        /// Tell CallKit the outgoing call connected.
        case reportOutgoingConnected
        case postDecline
        /// Best-effort `{"type":"hangup"}` on the control channel.
        case sendHangupMessage
        case postHangup
        /// End the CallKit call from the app side. Not used when the owner ended it through CallKit.
        case reportEnded(SystemEndReason)
        /// Close media and forget the call.
        case teardown
    }

    let direction: Direction
    private(set) var phase: Phase

    init(direction: Direction) {
        self.direction = direction
        phase = direction == .incoming ? .ringing : .dialing
    }

    var isEnded: Bool {
        if case .ended = phase { return true }
        return false
    }

    var endCause: EndCause? {
        if case .ended(let cause) = phase { return cause }
        return nil
    }

    mutating func handle(_ event: Event) -> [Effect] {
        switch (phase, event) {
        case (.ended, _):
            return []

        case (.connecting, .systemReset), (.active, .systemReset):
            phase = .ended(.failed(String(localized: "The system ended the call.")))
            return [.sendHangupMessage, .postHangup, .teardown]
        case (.ringing, .systemReset), (.dialing, .systemReset):
            phase = .ended(.failed(String(localized: "The system ended the call.")))
            return [.postHangup, .teardown]

        // Ringing (incoming).
        case (.ringing, .answered):
            phase = .connecting
            return [.startMedia]
        case (.ringing, .userEnded):
            phase = .ended(.declined)
            return [.postDecline, .teardown]
        case (.ringing, .remoteResolved(.answeredElsewhere)):
            phase = .ended(.answeredElsewhere)
            return [.reportEnded(.answeredElsewhere), .teardown]
        case (.ringing, .remoteResolved(.declinedElsewhere)):
            phase = .ended(.declinedElsewhere)
            return [.reportEnded(.declinedElsewhere), .teardown]
        case (.ringing, .remoteResolved(.unanswered)):
            phase = .ended(.unanswered)
            return [.reportEnded(.unanswered), .teardown]
        case (.ringing, .remoteResolved(.ended)):
            phase = .ended(.remoteCancelled)
            return [.reportEnded(.remoteEnded), .teardown]
        case (.ringing, .ringTimedOut):
            phase = .ended(.unanswered)
            return [.reportEnded(.unanswered), .teardown]

        // Dialing (outgoing).
        case (.dialing, .started):
            phase = .connecting
            return [.startMedia]
        case (.dialing, .startRejected(let message)):
            phase = .ended(.failed(message))
            return [.postHangup, .teardown]
        case (.dialing, .userEnded):
            phase = .ended(.hungUp)
            return [.postHangup, .teardown]

        // Connecting.
        case (.connecting, .mediaConnected):
            phase = .active
            return direction == .outgoing ? [.reportOutgoingConnected] : []
        case (.connecting, .connectRejected(.answeredElsewhere)):
            phase = .ended(.answeredElsewhere)
            return [.reportEnded(.answeredElsewhere), .teardown]
        case (.connecting, .connectRejected(.gone)):
            phase = .ended(.remoteHangup)
            return [.reportEnded(.remoteEnded), .teardown]
        case (.connecting, .connectRejected(.notConnectable)):
            phase = .ended(.failed(String(localized: "The call can no longer be connected.")))
            return [.reportEnded(.failed), .teardown]
        case (.connecting, .connectFailed(let message)):
            phase = .ended(.failed(message))
            return [.postHangup, .reportEnded(.failed), .teardown]
        case (.connecting, .connectTimedOut):
            phase = .ended(.failed(String(localized: "The audio connection timed out.")))
            return [.postHangup, .reportEnded(.failed), .teardown]

        // Connecting or active.
        case (.connecting, .mediaFailed(let message)), (.active, .mediaFailed(let message)):
            phase = .ended(.failed(message))
            return [.postHangup, .reportEnded(.failed), .teardown]
        case (.connecting, .userEnded), (.active, .userEnded):
            phase = .ended(.hungUp)
            return [.sendHangupMessage, .postHangup, .teardown]
        case (.connecting, .serverHangup), (.active, .serverHangup):
            phase = .ended(.remoteHangup)
            return [.reportEnded(.remoteEnded), .teardown]

        default:
            return []
        }
    }

    /// What a `GET /calls/{id}` result means for a call that is still ringing on this device, or nil
    /// while it is still ringing (or in a state this version does not know).
    static func ringingResolution(for call: Call) -> RemoteResolution? {
        switch call.state {
        case .ringing:
            return nil
        case .connecting, .active:
            return .answeredElsewhere
        case .ended:
            switch call.outcome {
            case .some(.declined): return .declinedElsewhere
            case .some(.missed): return .unanswered
            default: return .ended
            }
        default:
            return nil
        }
    }
}
