import XCTest
@testable import DSHCall

final class APIClientTests: XCTestCase {
    private static let callId = "6f1c1b6e-2a4d-4c8e-9f3a-0d5b7e2c9a41"
    private static let deviceId = "0b8e4f2a-1c3d-4e5f-8a9b-7c6d5e4f3a2b"

    private static let callJSON = """
    {"call":{"callId":"6f1c1b6e-2a4d-4c8e-9f3a-0d5b7e2c9a41","initiator":"owner","state":"ringing",\
    "reason":null,"createdAt":1767225600000,"answeredAt":null,"endedAt":null,"outcome":null}}
    """

    override func tearDown() {
        StubURLProtocol.reset()
        super.tearDown()
    }

    private func makeClient(base: String = "https://dsh.example.ts.net", token: String = "secret-token") throws -> APIClient {
        let baseURL = try XCTUnwrap(APIConfiguration.validatedBaseURL(base))
        return APIClient(configuration: APIConfiguration(baseURL: baseURL, token: token), session: StubURLProtocol.makeSession())
    }

    private func reply(status: Int, json: String) {
        let body = Data(json.utf8)
        StubURLProtocol.setHandler { _ in .response(status: status, body: body) }
    }

    private func onlyRequest() throws -> StubURLProtocol.Recorded {
        let recorded = StubURLProtocol.recorded
        XCTAssertEqual(recorded.count, 1)
        return try XCTUnwrap(recorded.first)
    }

    private func jsonObject(_ data: Data?) throws -> [String: String] {
        let data = try XCTUnwrap(data)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: String])
    }

    // MARK: - Base URL

    func testValidatedBaseURLAcceptsHTTPSAndDropsTrailingSlashes() {
        XCTAssertEqual(APIConfiguration.validatedBaseURL("  https://dsh.example.ts.net//  ")?.absoluteString, "https://dsh.example.ts.net")
        XCTAssertEqual(APIConfiguration.validatedBaseURL("https://dsh.example.ts.net:8443/dsh/")?.absoluteString, "https://dsh.example.ts.net:8443/dsh")
    }

    func testValidatedBaseURLRejectsOtherInput() {
        XCTAssertNil(APIConfiguration.validatedBaseURL(""))
        XCTAssertNil(APIConfiguration.validatedBaseURL("http://dsh.example.ts.net"))
        XCTAssertNil(APIConfiguration.validatedBaseURL("dsh.example.ts.net"))
        XCTAssertNil(APIConfiguration.validatedBaseURL("https://dsh.example.ts.net/?x=1"))
        XCTAssertNil(APIConfiguration.validatedBaseURL("https://dsh.example.ts.net/#top"))
        XCTAssertNil(APIConfiguration.validatedBaseURL("https://user:pass@dsh.example.ts.net"))
    }

    // MARK: - Request building

    func testURLAppendsVersionedPathToBasePath() throws {
        let client = try makeClient(base: "https://host.example/dsh/")
        let url = try client.url(for: client.endpoint(name: "get-call", method: "GET", path: ["calls", Self.callId]))
        XCTAssertEqual(url.absoluteString, "https://host.example/dsh/voice-call/v1/calls/\(Self.callId)")
    }

    func testURLEncodesEachSegmentAsOneSegment() throws {
        let client = try makeClient()
        let url = try client.url(for: client.endpoint(name: "x", method: "GET", path: ["devices", "a/b?c"]))
        XCTAssertEqual(url.absoluteString, "https://dsh.example.ts.net/voice-call/v1/devices/a%2Fb%3Fc")
    }

    func testURLRejectsEmptySegment() throws {
        let client = try makeClient()
        XCTAssertThrowsError(try client.url(for: client.endpoint(name: "x", method: "GET", path: ["calls", ""]))) { error in
            XCTAssertEqual(error as? APIError, .invalidURL)
        }
    }

    func testMakeRequestSetsHeadersAndTimeout() throws {
        let client = try makeClient()
        let request = try client.makeRequest(client.endpoint(name: "health", method: "GET", path: ["health"]))
        XCTAssertEqual(request.httpMethod, "GET")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer secret-token")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "application/json")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Accept"), "application/json")
        XCTAssertEqual(request.timeoutInterval, APIClient.requestTimeout)
    }

    // MARK: - Endpoints

    func testHealthDecodesSpeechModes() async throws {
        reply(status: 200, json: #"{"v":1,"enabled":true,"speech":{"stt":"device","tts":"server"}}"#)
        let health = try await makeClient().health()
        XCTAssertEqual(health, Health(v: 1, enabled: true, speech: Health.Speech(stt: .device, tts: .server)))
        let request = try onlyRequest().request
        XCTAssertEqual(request.httpMethod, "GET")
        XCTAssertEqual(request.url?.path, "/voice-call/v1/health")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer secret-token")
    }

    func testRegisterDeviceSendsPutWithBody() async throws {
        reply(status: 200, json: """
        {"device":{"deviceId":"\(Self.deviceId)","name":"iPhone","environment":"sandbox","registeredAt":1767225600000}}
        """)
        let device = try await makeClient().registerDevice(deviceId: Self.deviceId, voipToken: "00abff", environment: .sandbox, name: "iPhone")
        XCTAssertEqual(device.deviceId, Self.deviceId)
        XCTAssertEqual(device.registeredAt, 1_767_225_600_000)

        let recorded = try onlyRequest()
        XCTAssertEqual(recorded.request.httpMethod, "PUT")
        XCTAssertEqual(recorded.request.url?.path, "/voice-call/v1/devices/\(Self.deviceId)")
        XCTAssertEqual(recorded.request.value(forHTTPHeaderField: "Content-Type"), "application/json")
        XCTAssertEqual(try jsonObject(recorded.body), ["voipToken": "00abff", "environment": "sandbox", "name": "iPhone"])
    }

    func testUnregisterDeviceAcceptsNoContent() async throws {
        reply(status: 204, json: "")
        try await makeClient().unregisterDevice(deviceId: Self.deviceId)
        let request = try onlyRequest().request
        XCTAssertEqual(request.httpMethod, "DELETE")
        XCTAssertEqual(request.url?.path, "/voice-call/v1/devices/\(Self.deviceId)")
    }

    func testCreateCallPostsDeviceId() async throws {
        reply(status: 201, json: Self.callJSON)
        let call = try await makeClient().createCall(deviceId: Self.deviceId)
        XCTAssertEqual(call.callId, Self.callId)
        XCTAssertEqual(call.initiator, .owner)
        XCTAssertEqual(call.state, .ringing)
        XCTAssertNil(call.outcome)

        let recorded = try onlyRequest()
        XCTAssertEqual(recorded.request.httpMethod, "POST")
        XCTAssertEqual(recorded.request.url?.path, "/voice-call/v1/calls")
        XCTAssertEqual(try jsonObject(recorded.body), ["deviceId": Self.deviceId])
    }

    func testGetCall() async throws {
        reply(status: 200, json: Self.callJSON)
        let call = try await makeClient().call(callId: Self.callId)
        XCTAssertEqual(call.callId, Self.callId)
        let request = try onlyRequest().request
        XCTAssertEqual(request.httpMethod, "GET")
        XCTAssertEqual(request.url?.path, "/voice-call/v1/calls/\(Self.callId)")
    }

    func testConnectPostsOfferAndReturnsAnswer() async throws {
        reply(status: 200, json: #"{"sdp":"v=0\r\nanswer"}"#)
        let answer = try await makeClient().connect(callId: Self.callId, deviceId: Self.deviceId, sdp: "v=0\r\noffer")
        XCTAssertEqual(answer, "v=0\r\nanswer")

        let recorded = try onlyRequest()
        XCTAssertEqual(recorded.request.httpMethod, "POST")
        XCTAssertEqual(recorded.request.url?.path, "/voice-call/v1/calls/\(Self.callId)/connect")
        XCTAssertEqual(try jsonObject(recorded.body), ["deviceId": Self.deviceId, "sdp": "v=0\r\noffer"])
    }

    func testDeclineAndHangupPostDeviceId() async throws {
        reply(status: 204, json: "")
        let client = try makeClient()
        try await client.decline(callId: Self.callId, deviceId: Self.deviceId)
        try await client.hangup(callId: Self.callId, deviceId: Self.deviceId)

        let recorded = StubURLProtocol.recorded
        XCTAssertEqual(recorded.map { $0.request.url?.path }, [
            "/voice-call/v1/calls/\(Self.callId)/decline",
            "/voice-call/v1/calls/\(Self.callId)/hangup",
        ])
        XCTAssertEqual(recorded.map { $0.request.httpMethod }, ["POST", "POST"])
        for entry in recorded {
            XCTAssertEqual(try jsonObject(entry.body), ["deviceId": Self.deviceId])
        }
    }

    // MARK: - Errors

    func testConflictKeepsStatusAndServerMessage() async throws {
        reply(status: 409, json: #"{"error":"the call was already picked up"}"#)
        do {
            _ = try await makeClient().connect(callId: Self.callId, deviceId: Self.deviceId, sdp: "v=0")
            XCTFail("expected an error")
        } catch let error as APIError {
            XCTAssertEqual(error, .http(status: 409, message: "the call was already picked up"))
            XCTAssertEqual(error.statusCode, 409)
        }
    }

    func testGoneIsReportedAs410() async throws {
        reply(status: 410, json: #"{"error":"the call has ended"}"#)
        do {
            _ = try await makeClient().connect(callId: Self.callId, deviceId: Self.deviceId, sdp: "v=0")
            XCTFail("expected an error")
        } catch let error as APIError {
            XCTAssertEqual(error.statusCode, 410)
        }
    }

    func testErrorWithoutJSONBodyHasNoMessage() async throws {
        reply(status: 502, json: "<html>Bad gateway</html>")
        do {
            _ = try await makeClient().health()
            XCTFail("expected an error")
        } catch let error as APIError {
            XCTAssertEqual(error, .http(status: 502, message: nil))
        }
    }

    func testUnexpectedBodyIsADecodingError() async throws {
        reply(status: 200, json: "{}")
        do {
            _ = try await makeClient().health()
            XCTFail("expected an error")
        } catch let error as APIError {
            guard case .decoding = error else {
                return XCTFail("expected a decoding error, got \(error)")
            }
        }
    }

    func testURLTimeoutMapsToTimeout() async throws {
        StubURLProtocol.setHandler { _ in .failure(URLError(.timedOut)) }
        do {
            _ = try await makeClient().health()
            XCTFail("expected an error")
        } catch let error as APIError {
            XCTAssertEqual(error, .timeout)
        }
    }

    func testOtherURLErrorMapsToTransport() async throws {
        StubURLProtocol.setHandler { _ in .failure(URLError(.cannotConnectToHost)) }
        do {
            _ = try await makeClient().health()
            XCTFail("expected an error")
        } catch let error as APIError {
            guard case .transport = error else {
                return XCTFail("expected a transport error, got \(error)")
            }
        }
    }

    func testCancellingTheCallerThrowsCancellationError() async throws {
        StubURLProtocol.setHandler { _ in .hang }
        let client = try makeClient()
        let task = Task { try await client.health() }
        try await Task.sleep(nanoseconds: 100_000_000)
        task.cancel()
        do {
            _ = try await task.value
            XCTFail("expected cancellation")
        } catch {
            XCTAssertTrue(error is CancellationError, "got \(error)")
        }
    }

    func testErrorLogDescriptionNeverContainsTheToken() {
        let errors: [APIError] = [.notConfigured, .invalidURL, .timeout, .transport("offline"), .http(status: 401, message: "bearer token required"), .invalidResponse, .decoding("x")]
        for error in errors {
            XCTAssertFalse(error.logDescription.contains("secret-token"))
            XCTAssertNotNil(error.errorDescription)
        }
    }

    // MARK: - Deadline

    func testWithDeadlineReturnsTheResultInTime() async throws {
        let value = try await withDeadline(seconds: 5) { 42 }
        XCTAssertEqual(value, 42)
    }

    func testWithDeadlineThrowsTimeoutWhenTheOperationIsSlow() async {
        do {
            _ = try await withDeadline(seconds: 0.05) {
                try await Task.sleep(nanoseconds: 5_000_000_000)
                return 1
            }
            XCTFail("expected a timeout")
        } catch {
            XCTAssertEqual(error as? APIError, .timeout)
        }
    }
}
