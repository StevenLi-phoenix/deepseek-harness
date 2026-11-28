import Foundation

// Wire types for the DSH voice call API, version 1. Every server enum is decoded as an
// open string value, so a value added by a newer server decodes instead of failing.

/// The protocol version this client speaks on the REST API, in pushes, and on the control channel.
let voiceCallProtocolVersion = 1

/// A call as the server describes it (`Call` in the API contract).
struct Call: Codable, Equatable, Sendable {
    struct Initiator: RawRepresentable, Codable, Hashable, Sendable {
        let rawValue: String
        init(rawValue: String) { self.rawValue = rawValue }

        static let agent = Initiator(rawValue: "agent")
        static let owner = Initiator(rawValue: "owner")
    }

    struct State: RawRepresentable, Codable, Hashable, Sendable {
        let rawValue: String
        init(rawValue: String) { self.rawValue = rawValue }

        static let ringing = State(rawValue: "ringing")
        static let connecting = State(rawValue: "connecting")
        static let active = State(rawValue: "active")
        static let ended = State(rawValue: "ended")
    }

    struct Outcome: RawRepresentable, Codable, Hashable, Sendable {
        let rawValue: String
        init(rawValue: String) { self.rawValue = rawValue }

        static let completed = Outcome(rawValue: "completed")
        static let declined = Outcome(rawValue: "declined")
        static let missed = Outcome(rawValue: "missed")
        static let failed = Outcome(rawValue: "failed")
        static let cancelled = Outcome(rawValue: "cancelled")
    }

    let callId: String
    let initiator: Initiator
    let state: State
    let reason: String?
    /// Milliseconds since 1970.
    let createdAt: Double
    let answeredAt: Double?
    let endedAt: Double?
    let outcome: Outcome?
}

/// `GET /voice-call/v1/health`.
struct Health: Codable, Equatable, Sendable {
    struct SpeechMode: RawRepresentable, Codable, Hashable, Sendable {
        let rawValue: String
        init(rawValue: String) { self.rawValue = rawValue }

        /// The server does the work (it hears the audio track, or speaks into it).
        static let server = SpeechMode(rawValue: "server")
        /// The phone does the work (on-device recognition, or local speech synthesis).
        static let device = SpeechMode(rawValue: "device")
    }

    struct Speech: Codable, Equatable, Sendable {
        let stt: SpeechMode
        let tts: SpeechMode

        /// What the app assumes when the server cannot be asked: the server does both.
        static let serverDefault = Speech(stt: .server, tts: .server)
    }

    let v: Int
    let enabled: Bool
    let speech: Speech
}

/// A registered device as the server returns it.
struct RegisteredDevice: Codable, Equatable, Sendable {
    let deviceId: String
    let name: String
    let environment: String
    /// Milliseconds since 1970.
    let registeredAt: Double
}

/// The APNs environment the PushKit token belongs to.
enum PushEnvironment: String, Codable, Sendable {
    case sandbox
    case production

    /// Debug builds are signed with a development profile, so their tokens are sandbox tokens.
    static var current: PushEnvironment {
        #if DEBUG
        return .sandbox
        #else
        return .production
        #endif
    }
}

// MARK: - Request and response bodies

struct DeviceRegistrationBody: Codable, Equatable, Sendable {
    /// The longest device name the server accepts, in UTF-16 code units.
    static let maxNameLength = 100

    let voipToken: String
    let environment: String
    let name: String

    /// The name to register: trimmed, cut to `maxNameLength`, and "iPhone" when nothing is left.
    static func deviceName(_ raw: String) -> String {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines).truncated(toUTF16Length: maxNameLength)
        let name = trimmed.trimmingCharacters(in: .whitespacesAndNewlines)
        return name.isEmpty ? "iPhone" : name
    }
}

struct DeviceIdBody: Codable, Equatable, Sendable {
    let deviceId: String
}

struct ConnectBody: Codable, Equatable, Sendable {
    let deviceId: String
    let sdp: String
}

struct SDPBody: Codable, Equatable, Sendable {
    let sdp: String
}

struct CallEnvelope: Codable, Equatable, Sendable {
    let call: Call
}

struct DeviceEnvelope: Codable, Equatable, Sendable {
    let device: RegisteredDevice
}

struct ErrorEnvelope: Codable, Equatable, Sendable {
    let error: String
}

// MARK: - VoIP push payload

/// The `dsh` part of a VoIP push: `{"aps":{},"dsh":{"v":1,"callId":…,"reason":…,"caller":…,"createdAt":…}}`.
struct IncomingCallPush: Equatable, Sendable {
    /// The payload version, when present. Pushes from a newer server are still accepted while `callId` parses.
    let version: Int?
    /// The call ID exactly as the server sent it; used in API paths.
    let callId: String
    /// The same ID as a UUID; used as the CallKit call UUID.
    let callUUID: UUID
    /// Why DSH is calling, or nil when the server sent an empty reason.
    let reason: String?
    /// The name CallKit shows for the caller.
    let caller: String
    let createdAt: Date?

    static let defaultCaller = "DSH"
    /// The longest caller name given to CallKit, in characters; a longer one ends with an ellipsis.
    static let maxCallKitNameLength = 60

    /// The caller name CallKit shows: the caller followed by the reason, so the incoming-call screen
    /// (also on the lock screen) says why DSH is calling.
    var callKitName: String {
        guard let reason else { return caller }
        let full = "\(caller): \(reason)"
        guard full.count > Self.maxCallKitNameLength else { return full }
        return String(full.prefix(Self.maxCallKitNameLength - 1)) + "\u{2026}"
    }
}

/// The result of reading a VoIP push. A malformed push must still be reported to CallKit.
enum IncomingPushParse: Equatable, Sendable {
    case call(IncomingCallPush)
    case malformed(reason: String)
}

enum IncomingPushParser {
    /// Reads a PushKit `dictionaryPayload`. Never throws: anything unusable becomes `.malformed`.
    static func parse(_ payload: [AnyHashable: Any]) -> IncomingPushParse {
        guard let dsh = payload["dsh"] as? [String: Any] else {
            return .malformed(reason: "missing dsh object")
        }
        guard let rawCallId = dsh["callId"] as? String else {
            return .malformed(reason: "missing callId")
        }
        let callId = rawCallId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let uuid = UUID(uuidString: callId) else {
            return .malformed(reason: "callId is not a UUID")
        }
        let version = (dsh["v"] as? NSNumber)?.intValue
        let createdAt = (dsh["createdAt"] as? NSNumber).map { Date(timeIntervalSince1970: $0.doubleValue / 1000) }
        return .call(IncomingCallPush(
            version: version,
            callId: callId,
            callUUID: uuid,
            reason: nonEmptyString(dsh["reason"]),
            caller: nonEmptyString(dsh["caller"]) ?? IncomingCallPush.defaultCaller,
            createdAt: createdAt
        ))
    }

    private static func nonEmptyString(_ value: Any?) -> String? {
        guard let text = (value as? String)?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty else {
            return nil
        }
        return text
    }
}

extension String {
    /// The string cut at a character boundary to at most `limit` UTF-16 code units. The server's length
    /// limits count UTF-16 code units (JavaScript string length).
    func truncated(toUTF16Length limit: Int) -> String {
        guard utf16.count > limit else { return self }
        var result = ""
        var used = 0
        for character in self {
            let size = character.utf16.count
            guard used + size <= limit else { break }
            result.append(character)
            used += size
        }
        return result
    }
}

extension Data {
    /// Lowercase hexadecimal, two digits per byte: the form the server expects for `voipToken`.
    var lowercaseHexString: String {
        map { String(format: "%02x", $0) }.joined()
    }
}
