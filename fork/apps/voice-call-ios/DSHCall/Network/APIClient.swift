import Foundation

/// Where the server is and how to authenticate. Built only from a validated base URL.
struct APIConfiguration: Equatable, Sendable {
    /// HTTPS base URL without a trailing slash, for example `https://dsh.example.ts.net`.
    let baseURL: URL
    /// The bearer token. Never log it.
    let token: String

    /// Returns the normalized base URL for user input, or nil when it is not an absolute HTTPS URL
    /// with a host and no query or fragment. App Transport Security blocks plain HTTP anyway.
    static func validatedBaseURL(_ input: String) -> URL? {
        var text = input.trimmingCharacters(in: .whitespacesAndNewlines)
        while text.hasSuffix("/") { text.removeLast() }
        guard
            let components = URLComponents(string: text),
            components.scheme?.lowercased() == "https",
            let host = components.host, !host.isEmpty,
            components.query == nil,
            components.fragment == nil,
            components.user == nil,
            components.password == nil
        else { return nil }
        return components.url
    }
}

enum APIError: Error, Equatable, LocalizedError {
    case notConfigured
    case invalidURL
    case timeout
    case transport(String)
    case http(status: Int, message: String?)
    case invalidResponse
    case decoding(String)

    var errorDescription: String? {
        switch self {
        case .notConfigured:
            return String(localized: "The server is not set up. Enter its address and token in Settings.")
        case .invalidURL:
            return String(localized: "The server address is not a valid HTTPS URL.")
        case .timeout:
            return String(localized: "The server did not answer in time.")
        case .transport(let message):
            return String(localized: "Could not reach the server: \(message)")
        case .http(let status, let message):
            if let message, !message.isEmpty {
                return String(localized: "The server answered \(status): \(message)")
            }
            return String(localized: "The server answered with status \(status).")
        case .invalidResponse:
            return String(localized: "The server sent a response the app does not understand.")
        case .decoding(let message):
            return String(localized: "The server sent unexpected data: \(message)")
        }
    }

    var statusCode: Int? {
        if case .http(let status, _) = self { return status }
        return nil
    }
}

/// Client for the voice call API, version 1. Every method has its own deadline and maps every failure
/// to `APIError` (or `CancellationError` when the calling task is cancelled).
struct APIClient: Sendable {
    static let requestTimeout: TimeInterval = 10
    static let connectTimeout: TimeInterval = 20

    /// A session without caches or cookies; per-request deadlines are enforced by `send`.
    static let defaultSession: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.urlCache = nil
        configuration.httpShouldSetCookies = false
        configuration.httpCookieAcceptPolicy = .never
        configuration.waitsForConnectivity = false
        configuration.timeoutIntervalForRequest = connectTimeout
        configuration.timeoutIntervalForResource = connectTimeout + 5
        return URLSession(configuration: configuration)
    }()

    struct Endpoint: Equatable, Sendable {
        let name: String
        let method: String
        let pathSegments: [String]
        let body: Data?
        let timeout: TimeInterval
    }

    let configuration: APIConfiguration
    let session: URLSession

    init(configuration: APIConfiguration, session: URLSession = APIClient.defaultSession) {
        self.configuration = configuration
        self.session = session
    }

    // MARK: - API

    func health() async throws -> Health {
        let data = try await send(endpoint(name: "health", method: "GET", path: ["health"]))
        return try decode(Health.self, from: data)
    }

    @discardableResult
    func registerDevice(deviceId: String, voipToken: String, environment: PushEnvironment, name: String) async throws -> RegisteredDevice {
        let body = DeviceRegistrationBody(voipToken: voipToken, environment: environment.rawValue, name: name)
        let request = try endpoint(name: "register-device", method: "PUT", path: ["devices", deviceId], body: body)
        let data = try await send(request)
        return try decode(DeviceEnvelope.self, from: data).device
    }

    func unregisterDevice(deviceId: String) async throws {
        _ = try await send(endpoint(name: "unregister-device", method: "DELETE", path: ["devices", deviceId]))
    }

    func createCall(deviceId: String) async throws -> Call {
        let request = try endpoint(name: "create-call", method: "POST", path: ["calls"], body: DeviceIdBody(deviceId: deviceId))
        let data = try await send(request)
        return try decode(CallEnvelope.self, from: data).call
    }

    func call(callId: String) async throws -> Call {
        let data = try await send(endpoint(name: "get-call", method: "GET", path: ["calls", callId]))
        return try decode(CallEnvelope.self, from: data).call
    }

    /// Posts the complete SDP offer and returns the complete SDP answer. 409: picked up elsewhere or not
    /// connectable; 410: the call has ended. Both arrive as `APIError.http`.
    func connect(callId: String, deviceId: String, sdp: String) async throws -> String {
        let request = try endpoint(
            name: "connect",
            method: "POST",
            path: ["calls", callId, "connect"],
            body: ConnectBody(deviceId: deviceId, sdp: sdp),
            timeout: Self.connectTimeout
        )
        let data = try await send(request)
        return try decode(SDPBody.self, from: data).sdp
    }

    func decline(callId: String, deviceId: String) async throws {
        let request = try endpoint(name: "decline", method: "POST", path: ["calls", callId, "decline"], body: DeviceIdBody(deviceId: deviceId))
        _ = try await send(request)
    }

    func hangup(callId: String, deviceId: String) async throws {
        let request = try endpoint(name: "hangup", method: "POST", path: ["calls", callId, "hangup"], body: DeviceIdBody(deviceId: deviceId))
        _ = try await send(request)
    }

    // MARK: - Request building

    func endpoint(name: String, method: String, path: [String], timeout: TimeInterval = APIClient.requestTimeout) -> Endpoint {
        Endpoint(name: name, method: method, pathSegments: ["voice-call", "v1"] + path, body: nil, timeout: timeout)
    }

    func endpoint<Body: Encodable>(name: String, method: String, path: [String], body: Body, timeout: TimeInterval = APIClient.requestTimeout) throws -> Endpoint {
        let data: Data
        do {
            data = try JSONEncoder().encode(body)
        } catch {
            throw APIError.decoding(String(describing: error))
        }
        return Endpoint(name: name, method: method, pathSegments: ["voice-call", "v1"] + path, body: data, timeout: timeout)
    }

    /// The URL for an endpoint: the base URL's path followed by each segment, percent-encoded as one segment.
    func url(for endpoint: Endpoint) throws -> URL {
        guard var components = URLComponents(url: configuration.baseURL, resolvingAgainstBaseURL: false) else {
            throw APIError.invalidURL
        }
        var basePath = components.percentEncodedPath
        while basePath.hasSuffix("/") { basePath.removeLast() }
        let segments = try endpoint.pathSegments.map { segment -> String in
            guard !segment.isEmpty, let encoded = segment.addingPercentEncoding(withAllowedCharacters: Self.segmentAllowed) else {
                throw APIError.invalidURL
            }
            return encoded
        }
        components.percentEncodedPath = basePath + "/" + segments.joined(separator: "/")
        guard let url = components.url else { throw APIError.invalidURL }
        return url
    }

    func makeRequest(_ endpoint: Endpoint) throws -> URLRequest {
        var request = URLRequest(url: try url(for: endpoint))
        request.httpMethod = endpoint.method
        request.timeoutInterval = endpoint.timeout
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.setValue("Bearer \(configuration.token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.httpBody = endpoint.body
        return request
    }

    private static let segmentAllowed: CharacterSet = {
        var allowed = CharacterSet.urlPathAllowed
        allowed.remove(charactersIn: "/;?#%")
        return allowed
    }()

    // MARK: - Transport

    private struct Response: Sendable {
        let status: Int
        let data: Data
    }

    private func send(_ endpoint: Endpoint) async throws -> Data {
        let request = try makeRequest(endpoint)
        let session = self.session
        let response: Response
        do {
            response = try await withDeadline(seconds: endpoint.timeout) {
                let (data, urlResponse) = try await session.data(for: request)
                guard let http = urlResponse as? HTTPURLResponse else { throw APIError.invalidResponse }
                return Response(status: http.statusCode, data: data)
            }
        } catch let error as APIError {
            Log.api.error("\(endpoint.name, privacy: .public) failed: \(error.logDescription, privacy: .public)")
            throw error
        } catch is CancellationError {
            throw CancellationError()
        } catch let error as URLError {
            if error.code == .cancelled, Task.isCancelled { throw CancellationError() }
            let mapped: APIError = error.code == .timedOut ? .timeout : .transport(error.localizedDescription)
            Log.api.error("\(endpoint.name, privacy: .public) failed: \(mapped.logDescription, privacy: .public)")
            throw mapped
        } catch {
            let mapped = APIError.transport(error.localizedDescription)
            Log.api.error("\(endpoint.name, privacy: .public) failed: \(mapped.logDescription, privacy: .public)")
            throw mapped
        }
        guard (200..<300).contains(response.status) else {
            let message = (try? JSONDecoder().decode(ErrorEnvelope.self, from: response.data))?.error
            Log.api.error("\(endpoint.name, privacy: .public) answered \(response.status, privacy: .public)")
            throw APIError.http(status: response.status, message: message)
        }
        Log.api.info("\(endpoint.name, privacy: .public) answered \(response.status, privacy: .public)")
        return response.data
    }

    private func decode<T: Decodable>(_ type: T.Type, from data: Data) throws -> T {
        do {
            return try JSONDecoder().decode(type, from: data)
        } catch {
            throw APIError.decoding(String(describing: error))
        }
    }
}

extension APIError {
    /// A description safe for logs: never contains the token or a request body.
    var logDescription: String {
        switch self {
        case .notConfigured: return "not configured"
        case .invalidURL: return "invalid URL"
        case .timeout: return "timeout"
        case .transport(let message): return "transport: \(message)"
        case .http(let status, let message): return "HTTP \(status): \(message ?? "-")"
        case .invalidResponse: return "invalid response"
        case .decoding(let message): return "decoding: \(message)"
        }
    }
}

/// Runs `operation` and throws `APIError.timeout` if it has not finished after `seconds`.
/// The operation is cancelled when the deadline passes.
func withDeadline<T: Sendable>(seconds: TimeInterval, operation: @escaping @Sendable () async throws -> T) async throws -> T {
    try await withThrowingTaskGroup(of: T.self) { group in
        group.addTask { try await operation() }
        group.addTask {
            try await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
            throw APIError.timeout
        }
        defer { group.cancelAll() }
        guard let first = try await group.next() else { throw APIError.timeout }
        return first
    }
}
