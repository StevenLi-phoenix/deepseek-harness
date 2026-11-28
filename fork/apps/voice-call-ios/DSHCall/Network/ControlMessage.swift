import Foundation

/// What DSH is doing, as the server reports it in `state` messages.
struct AgentActivity: RawRepresentable, Codable, Hashable, Sendable {
    let rawValue: String
    init(rawValue: String) { self.rawValue = rawValue }

    static let listening = AgentActivity(rawValue: "listening")
    static let thinking = AgentActivity(rawValue: "thinking")
    static let speaking = AgentActivity(rawValue: "speaking")
}

/// Who said a transcript line.
struct TranscriptRole: RawRepresentable, Codable, Hashable, Sendable {
    let rawValue: String
    init(rawValue: String) { self.rawValue = rawValue }

    static let owner = TranscriptRole(rawValue: "owner")
    static let agent = TranscriptRole(rawValue: "agent")
}

/// One JSON text frame on the `control` data channel. Every frame carries `"v":1` and a `type`.
///
/// Decoding never fails on a `type` this version does not know: it becomes `.unknown(type:)`, and so does
/// a frame whose `v` is not 1, because its fields may mean something else.
enum ControlMessage: Equatable, Sendable {
    // Server to app.
    case state(AgentActivity)
    case transcript(role: TranscriptRole, text: String)
    case say(text: String)
    case stopSpeaking

    // Both directions. The server may give a reason; the app sends none.
    case hangup(reason: String?)

    // App to server.
    case utterance(text: String)
    case speaking
    case interrupt

    case unknown(type: String)
}

extension ControlMessage: Codable {
    private enum CodingKeys: String, CodingKey {
        case v
        case type
        case state
        case role
        case text
        case reason
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let type = try container.decode(String.self, forKey: .type)
        if let version = try? container.decodeIfPresent(Int.self, forKey: .v), version != voiceCallProtocolVersion {
            self = .unknown(type: type)
            return
        }
        switch type {
        case "state":
            self = .state(try container.decode(AgentActivity.self, forKey: .state))
        case "transcript":
            self = .transcript(
                role: try container.decode(TranscriptRole.self, forKey: .role),
                text: try container.decode(String.self, forKey: .text)
            )
        case "say":
            self = .say(text: try container.decode(String.self, forKey: .text))
        case "stop-speaking":
            self = .stopSpeaking
        case "hangup":
            self = .hangup(reason: try container.decodeIfPresent(String.self, forKey: .reason))
        case "utterance":
            self = .utterance(text: try container.decode(String.self, forKey: .text))
        case "speaking":
            self = .speaking
        case "interrupt":
            self = .interrupt
        default:
            self = .unknown(type: type)
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(voiceCallProtocolVersion, forKey: .v)
        try container.encode(typeName, forKey: .type)
        switch self {
        case .state(let activity):
            try container.encode(activity, forKey: .state)
        case .transcript(let role, let text):
            try container.encode(role, forKey: .role)
            try container.encode(text, forKey: .text)
        case .say(let text), .utterance(let text):
            try container.encode(text, forKey: .text)
        case .hangup(let reason):
            try container.encodeIfPresent(reason, forKey: .reason)
        case .stopSpeaking, .speaking, .interrupt, .unknown:
            break
        }
    }

    /// The wire `type` of this message.
    var typeName: String {
        switch self {
        case .state: return "state"
        case .transcript: return "transcript"
        case .say: return "say"
        case .stopSpeaking: return "stop-speaking"
        case .hangup: return "hangup"
        case .utterance: return "utterance"
        case .speaking: return "speaking"
        case .interrupt: return "interrupt"
        case .unknown(let type): return type
        }
    }

    /// Decodes one text frame. Throws only when the frame is not JSON or lacks a usable `type`.
    static func decode(_ text: String) throws -> ControlMessage {
        try JSONDecoder().decode(ControlMessage.self, from: Data(text.utf8))
    }

    /// Encodes the message as one UTF-8 JSON text frame with sorted keys.
    func encodedText() throws -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        let data = try encoder.encode(self)
        return String(decoding: data, as: UTF8.self)
    }
}
