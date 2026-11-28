import XCTest
@testable import DSHCall

final class ModelsTests: XCTestCase {
    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONDecoder().decode(type, from: Data(json.utf8))
    }

    func testCallWithNulls() throws {
        let call = try decode(Call.self, """
        {"callId":"6f1c1b6e-2a4d-4c8e-9f3a-0d5b7e2c9a41","initiator":"agent","state":"ended","reason":null,\
        "createdAt":1767225600000,"answeredAt":null,"endedAt":1767225645000,"outcome":"missed"}
        """)
        XCTAssertEqual(call.initiator, .agent)
        XCTAssertEqual(call.state, .ended)
        XCTAssertEqual(call.outcome, .missed)
        XCTAssertNil(call.reason)
        XCTAssertNil(call.answeredAt)
        XCTAssertEqual(call.endedAt, 1_767_225_645_000)
    }

    func testCallWithValuesFromANewerServer() throws {
        let call = try decode(Call.self, """
        {"callId":"6f1c1b6e-2a4d-4c8e-9f3a-0d5b7e2c9a41","initiator":"scheduler","state":"parked","reason":"x",\
        "createdAt":1,"answeredAt":null,"endedAt":null,"outcome":"transferred","extra":{"a":1}}
        """)
        XCTAssertEqual(call.initiator.rawValue, "scheduler")
        XCTAssertEqual(call.state.rawValue, "parked")
        XCTAssertEqual(call.outcome?.rawValue, "transferred")
    }

    func testHealth() throws {
        let health = try decode(Health.self, #"{"v":1,"enabled":false,"speech":{"stt":"server","tts":"device"}}"#)
        XCTAssertFalse(health.enabled)
        XCTAssertEqual(health.speech.stt, .server)
        XCTAssertEqual(health.speech.tts, .device)
        XCTAssertEqual(Health.Speech.serverDefault, Health.Speech(stt: .server, tts: .server))
    }

    func testErrorEnvelope() throws {
        XCTAssertEqual(try decode(ErrorEnvelope.self, #"{"error":"bearer token required"}"#).error, "bearer token required")
    }

    func testRegistrationBodyKeys() throws {
        let data = try JSONEncoder().encode(DeviceRegistrationBody(voipToken: "ab", environment: "production", name: "iPhone"))
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: String])
        XCTAssertEqual(object, ["voipToken": "ab", "environment": "production", "name": "iPhone"])
    }

    func testDeviceNameFitsTheServerLimit() {
        XCTAssertEqual(DeviceRegistrationBody.deviceName("  iPhone  "), "iPhone")
        XCTAssertEqual(DeviceRegistrationBody.deviceName("   "), "iPhone")
        let long = String(repeating: "很", count: 150)
        XCTAssertEqual(DeviceRegistrationBody.deviceName(long).utf16.count, DeviceRegistrationBody.maxNameLength)
    }

    func testTruncatedToUTF16LengthKeepsWholeCharacters() {
        XCTAssertEqual("abc".truncated(toUTF16Length: 3), "abc")
        XCTAssertEqual("abcd".truncated(toUTF16Length: 3), "abc")
        // The emoji takes two UTF-16 code units and does not fit after "ab".
        XCTAssertEqual("ab\u{1F600}".truncated(toUTF16Length: 3), "ab")
        XCTAssertEqual("\u{1F600}\u{1F600}".truncated(toUTF16Length: 4), "\u{1F600}\u{1F600}")
    }

    func testPushEnvironmentMatchesTheBuild() {
        #if DEBUG
        XCTAssertEqual(PushEnvironment.current, .sandbox)
        #else
        XCTAssertEqual(PushEnvironment.current, .production)
        #endif
    }
}
