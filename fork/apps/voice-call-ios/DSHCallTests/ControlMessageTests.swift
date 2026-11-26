import XCTest
@testable import DSHCall

final class ControlMessageTests: XCTestCase {
    // MARK: - Server to app

    func testDecodesServerMessages() throws {
        XCTAssertEqual(try ControlMessage.decode(#"{"v":1,"type":"state","state":"thinking"}"#), .state(.thinking))
        XCTAssertEqual(
            try ControlMessage.decode(#"{"v":1,"type":"transcript","role":"agent","text":"好的，我查一下。"}"#),
            .transcript(role: .agent, text: "好的，我查一下。")
        )
        XCTAssertEqual(try ControlMessage.decode(#"{"v":1,"type":"say","text":"Hello"}"#), .say(text: "Hello"))
        XCTAssertEqual(try ControlMessage.decode(#"{"v":1,"type":"stop-speaking"}"#), .stopSpeaking)
        XCTAssertEqual(try ControlMessage.decode(#"{"v":1,"type":"hangup","reason":"通话时间到了"}"#), .hangup(reason: "通话时间到了"))
        XCTAssertEqual(try ControlMessage.decode(#"{"v":1,"type":"hangup"}"#), .hangup(reason: nil))
    }

    func testUnknownEnumValuesDecode() throws {
        XCTAssertEqual(try ControlMessage.decode(#"{"v":1,"type":"state","state":"dreaming"}"#), .state(AgentActivity(rawValue: "dreaming")))
        XCTAssertEqual(
            try ControlMessage.decode(#"{"v":1,"type":"transcript","role":"system","text":"x"}"#),
            .transcript(role: TranscriptRole(rawValue: "system"), text: "x")
        )
    }

    func testUnknownTypeBecomesUnknown() throws {
        XCTAssertEqual(try ControlMessage.decode(#"{"v":1,"type":"volume","level":3}"#), .unknown(type: "volume"))
    }

    func testOtherVersionBecomesUnknown() throws {
        XCTAssertEqual(try ControlMessage.decode(#"{"v":2,"type":"say","text":"Hello"}"#), .unknown(type: "say"))
    }

    func testMissingVersionIsReadAsVersionOne() throws {
        XCTAssertEqual(try ControlMessage.decode(#"{"type":"stop-speaking"}"#), .stopSpeaking)
    }

    func testUnreadableFramesThrow() {
        XCTAssertThrowsError(try ControlMessage.decode("not json"))
        XCTAssertThrowsError(try ControlMessage.decode(#"{"v":1}"#))
        XCTAssertThrowsError(try ControlMessage.decode(#"{"v":1,"type":"say"}"#))
    }

    // MARK: - App to server

    func testEncodesAppMessagesWithVersion() throws {
        XCTAssertEqual(try ControlMessage.utterance(text: "明天提醒我/开会").encodedText(), #"{"text":"明天提醒我/开会","type":"utterance","v":1}"#)
        XCTAssertEqual(try ControlMessage.speaking.encodedText(), #"{"type":"speaking","v":1}"#)
        XCTAssertEqual(try ControlMessage.interrupt.encodedText(), #"{"type":"interrupt","v":1}"#)
        XCTAssertEqual(try ControlMessage.hangup(reason: nil).encodedText(), #"{"type":"hangup","v":1}"#)
    }

    func testRoundTrip() throws {
        let messages: [ControlMessage] = [
            .state(.speaking),
            .transcript(role: .owner, text: "你好"),
            .say(text: "Hi"),
            .stopSpeaking,
            .hangup(reason: "bye"),
            .utterance(text: "line one\nline two"),
            .speaking,
            .interrupt,
        ]
        for message in messages {
            XCTAssertEqual(try ControlMessage.decode(message.encodedText()), message)
        }
    }

    func testTypeNames() {
        XCTAssertEqual(ControlMessage.stopSpeaking.typeName, "stop-speaking")
        XCTAssertEqual(ControlMessage.unknown(type: "volume").typeName, "volume")
    }
}
