import XCTest
@testable import DSHCall

final class PushPayloadTests: XCTestCase {
    private struct NotACall: Error {
        let result: IncomingPushParse
    }

    private static let callId = "6f1c1b6e-2a4d-4c8e-9f3a-0d5b7e2c9a41"

    /// A payload as PushKit delivers it: parsed JSON, with numbers as `NSNumber`.
    private func payload(_ json: String) throws -> [AnyHashable: Any] {
        try XCTUnwrap(JSONSerialization.jsonObject(with: Data(json.utf8)) as? [AnyHashable: Any])
    }

    private func parsedCall(_ json: String) throws -> IncomingCallPush {
        let result = IncomingPushParser.parse(try payload(json))
        guard case .call(let push) = result else {
            throw NotACall(result: result)
        }
        return push
    }

    func testParsesCompletePayload() throws {
        let push = try parsedCall("""
        {"aps":{},"dsh":{"v":1,"callId":"\(Self.callId)","reason":"服务器磁盘快满了","caller":"DSH","createdAt":1767225600000}}
        """)
        XCTAssertEqual(push.version, 1)
        XCTAssertEqual(push.callId, Self.callId)
        XCTAssertEqual(push.callUUID, UUID(uuidString: Self.callId))
        XCTAssertEqual(push.reason, "服务器磁盘快满了")
        XCTAssertEqual(push.caller, "DSH")
        XCTAssertEqual(push.createdAt, Date(timeIntervalSince1970: 1_767_225_600))
    }

    func testKeepsTheServerSpellingOfTheCallId() throws {
        let push = try parsedCall(#"{"dsh":{"callId":" \#(Self.callId) "}}"#)
        // API paths use the lower-case form the server sent; CallKit uses the UUID.
        XCTAssertEqual(push.callId, Self.callId)
        XCTAssertEqual(push.callUUID.uuidString, Self.callId.uppercased())
    }

    func testDefaultsForMissingOrEmptyFields() throws {
        let push = try parsedCall(#"{"dsh":{"callId":"\#(Self.callId)","reason":"  ","caller":""}}"#)
        XCTAssertNil(push.version)
        XCTAssertNil(push.reason)
        XCTAssertEqual(push.caller, IncomingCallPush.defaultCaller)
        XCTAssertNil(push.createdAt)
    }

    func testNewerVersionIsStillACall() throws {
        let push = try parsedCall(#"{"dsh":{"v":2,"callId":"\#(Self.callId)","extra":true}}"#)
        XCTAssertEqual(push.version, 2)
    }

    func testMalformedPayloads() throws {
        let cases = [
            #"{"aps":{}}"#,
            #"{"dsh":"call"}"#,
            #"{"dsh":{}}"#,
            #"{"dsh":{"callId":42}}"#,
            #"{"dsh":{"callId":"call-1"}}"#,
        ]
        for json in cases {
            guard case .malformed = IncomingPushParser.parse(try payload(json)) else {
                XCTFail("expected malformed for \(json)")
                continue
            }
        }
    }

    func testCallKitNameCarriesTheReason() throws {
        let plain = try parsedCall(#"{"dsh":{"callId":"\#(Self.callId)","reason":"","caller":"DSH"}}"#)
        XCTAssertEqual(plain.callKitName, "DSH")

        let short = try parsedCall(#"{"dsh":{"callId":"\#(Self.callId)","reason":"部署失败了","caller":"DSH"}}"#)
        XCTAssertEqual(short.callKitName, "DSH: 部署失败了")

        let longReason = String(repeating: "很", count: 100)
        let long = try parsedCall(#"{"dsh":{"callId":"\#(Self.callId)","reason":"\#(longReason)","caller":"DSH"}}"#)
        XCTAssertEqual(long.callKitName.count, IncomingCallPush.maxCallKitNameLength)
        XCTAssertTrue(long.callKitName.hasPrefix("DSH: 很"))
        XCTAssertTrue(long.callKitName.hasSuffix("\u{2026}"))
    }

    func testTokenHex() {
        XCTAssertEqual(Data([0x00, 0x0f, 0xab, 0xff]).lowercaseHexString, "000fabff")
        XCTAssertEqual(Data().lowercaseHexString, "")
    }
}
