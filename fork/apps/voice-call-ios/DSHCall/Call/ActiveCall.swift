import Foundation

/// What the call screen shows for the call in progress. Owned by `CallManager`, updated by it and by
/// `CallSession` on the main actor.
@MainActor
final class ActiveCall: ObservableObject, Identifiable {
    struct TranscriptLine: Identifiable, Equatable {
        let id: Int
        let role: TranscriptRole
        let text: String
    }

    /// Who turns the owner's speech into text.
    enum SpeechStatus: Equatable {
        /// The server listens to the audio track.
        case server
        /// On-device recognition is running.
        case listening
        /// On-device recognition was requested by the server but cannot run.
        case unavailable(String)
    }

    /// Older lines are dropped beyond this count.
    static let transcriptLimit = 200

    /// The CallKit UUID; equal to the server call ID.
    let id: UUID
    let callId: String
    let direction: CallMachine.Direction
    let callerName: String
    /// Why DSH is calling, from the push.
    let reason: String?

    @Published var phase: CallMachine.Phase
    @Published var activity: AgentActivity?
    @Published private(set) var transcript: [TranscriptLine] = []
    @Published var isMuted = false
    @Published var connectedAt: Date?
    @Published var speechStatus: SpeechStatus = .server
    @Published var isDeviceSpeaking = false
    /// The reason DSH gave when it hung up.
    @Published var hangupReason: String?

    private var nextLineId = 0

    init(id: UUID, callId: String, direction: CallMachine.Direction, callerName: String, reason: String?) {
        self.id = id
        self.callId = callId
        self.direction = direction
        self.callerName = callerName
        self.reason = reason
        phase = direction == .incoming ? .ringing : .dialing
    }

    func appendTranscript(role: TranscriptRole, text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        transcript.append(TranscriptLine(id: nextLineId, role: role, text: trimmed))
        nextLineId += 1
        if transcript.count > Self.transcriptLimit {
            transcript.removeFirst(transcript.count - Self.transcriptLimit)
        }
    }

    /// The most recent agent lines, newest last.
    func recentAgentText(lines: Int) -> String {
        transcript.filter { $0.role == .agent }.suffix(lines).map(\.text).joined(separator: " ")
    }
}

/// A short record of the last call, shown on the home screen.
struct CallSummary: Equatable {
    let callerName: String
    let direction: CallMachine.Direction
    let cause: CallMachine.EndCause
    let endedAt: Date
    let duration: TimeInterval?
    let hangupReason: String?

    var title: String {
        cause.localizedDescription
    }
}
