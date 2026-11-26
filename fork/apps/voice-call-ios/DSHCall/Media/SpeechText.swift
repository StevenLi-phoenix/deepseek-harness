import Foundation

/// Picks the synthesis voice language for a `say` frame.
enum SpeechLanguage {
    static let chinese = "zh-CN"
    static let english = "en-US"

    /// `en-US` when at least 80% of the letters are ASCII, otherwise `zh-CN` (also for text without
    /// letters, such as numbers).
    static func voiceLanguage(for text: String) -> String {
        var letters = 0
        var asciiLetters = 0
        for character in text where character.isLetter {
            letters += 1
            if character.isASCII { asciiLetters += 1 }
        }
        guard letters > 0 else { return chinese }
        return Double(asciiLetters) / Double(letters) >= 0.8 ? english : chinese
    }
}

/// Recognizes the phone's own speech coming back through the microphone.
///
/// The on-device recognizer listens to the raw microphone (no echo cancellation), so while the phone is
/// speaking a `say` frame, the recognizer also transcribes that speech. A partial result whose character
/// pairs mostly occur in the text being spoken is treated as echo.
enum EchoGuard {
    /// The share of the partial's character pairs that must occur in the spoken text.
    static let threshold = 0.5

    static func isLikelyEcho(partial: String, spoken: String) -> Bool {
        let heard = normalized(partial)
        let said = normalized(spoken)
        guard !heard.isEmpty else { return true }
        guard !said.isEmpty else { return false }
        if heard.count == 1 {
            return said.contains(heard[0])
        }
        let saidPairs = Set(pairs(said))
        let heardPairs = pairs(heard)
        let matched = heardPairs.filter { saidPairs.contains($0) }.count
        return Double(matched) / Double(heardPairs.count) >= threshold
    }

    /// Lowercased letters and digits only, so punctuation and spacing differences do not matter.
    static func normalized(_ text: String) -> [Character] {
        text.lowercased().filter { $0.isLetter || $0.isNumber }.map { $0 }
    }

    private static func pairs(_ characters: [Character]) -> [String] {
        guard characters.count >= 2 else { return [] }
        return (0..<(characters.count - 1)).map { String(characters[$0]) + String(characters[$0 + 1]) }
    }
}

/// Turns the recognizer's cumulative partial results into utterances.
///
/// A recognition task's partial results grow as the owner speaks. The first non-echo partial starts an
/// utterance (the app then sends `speaking`); the session ends it after a pause and sends the text. When
/// echo was heard before the owner started, that echo text is removed from the front of the utterance.
struct UtteranceGate: Equatable, Sendable {
    enum Update: Equatable, Sendable {
        /// The first real partial of an utterance.
        case began
        /// A later partial with new text.
        case changed
        /// Nothing new.
        case unchanged
    }

    private(set) var text = ""
    private(set) var isActive = false
    /// The last echo partial seen before the utterance began, removed from the front of the result.
    private(set) var echoPrefix = ""
    /// Whether the current recognition task has heard echo without any owner speech yet.
    var heardOnlyEcho: Bool { !isActive && !echoPrefix.isEmpty }

    /// Records a partial that was judged to be echo.
    mutating func echo(_ partial: String) {
        guard !isActive else { return }
        echoPrefix = partial.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Records a partial (or final) result that is not echo.
    mutating func heard(_ partial: String) -> Update {
        let cleaned = strippingEcho(partial)
        guard !cleaned.isEmpty else { return .unchanged }
        if !isActive {
            isActive = true
            text = cleaned
            return .began
        }
        guard cleaned != text else { return .unchanged }
        text = cleaned
        return .changed
    }

    /// The longest `utterance` text the server accepts, in UTF-16 code units; a longer frame is dropped.
    static let maxLength = 4000

    /// Ends the utterance and returns its text, cut to `maxLength`, or nil when nothing was said.
    /// Resets the gate.
    mutating func finish() -> String? {
        let result = isActive ? text.trimmingCharacters(in: .whitespacesAndNewlines) : ""
        reset()
        return result.isEmpty ? nil : result.truncated(toUTF16Length: Self.maxLength)
    }

    mutating func reset() {
        text = ""
        isActive = false
        echoPrefix = ""
    }

    private func strippingEcho(_ partial: String) -> String {
        let trimmed = partial.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !echoPrefix.isEmpty, trimmed.hasPrefix(echoPrefix) else { return trimmed }
        return String(trimmed.dropFirst(echoPrefix.count))
            .trimmingCharacters(in: .whitespacesAndNewlines.union(.punctuationCharacters))
    }
}
