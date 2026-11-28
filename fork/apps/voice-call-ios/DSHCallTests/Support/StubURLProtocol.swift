import Foundation

/// Answers every request of a stubbed `URLSession` from a handler set by the test, and records the
/// requests with their bodies.
final class StubURLProtocol: URLProtocol {
    struct Recorded: Sendable {
        let request: URLRequest
        let body: Data?
    }

    enum Reply: Sendable {
        case response(status: Int, body: Data)
        case failure(URLError)
        /// Never answers; the request stays open until it is cancelled.
        case hang
    }

    typealias Handler = @Sendable (URLRequest) -> Reply

    private final class State: @unchecked Sendable {
        let lock = NSLock()
        var handler: Handler?
        var recorded: [Recorded] = []
    }

    private static let state = State()

    /// A session whose requests are all answered by this protocol.
    static func makeSession() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubURLProtocol.self]
        return URLSession(configuration: configuration)
    }

    static func setHandler(_ handler: @escaping Handler) {
        state.lock.lock()
        defer { state.lock.unlock() }
        state.handler = handler
        state.recorded = []
    }

    static func reset() {
        state.lock.lock()
        defer { state.lock.unlock() }
        state.handler = nil
        state.recorded = []
    }

    static var recorded: [Recorded] {
        state.lock.lock()
        defer { state.lock.unlock() }
        return state.recorded
    }

    override class func canInit(with request: URLRequest) -> Bool {
        true
    }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest {
        request
    }

    override func startLoading() {
        let state = Self.state
        state.lock.lock()
        let handler = state.handler
        state.recorded.append(Recorded(request: request, body: Self.body(of: request)))
        state.lock.unlock()

        guard let handler, let url = request.url else {
            client?.urlProtocol(self, didFailWithError: URLError(.unsupportedURL))
            return
        }
        switch handler(request) {
        case .response(let status, let body):
            let response = HTTPURLResponse(
                url: url,
                statusCode: status,
                httpVersion: "HTTP/1.1",
                headerFields: ["Content-Type": "application/json; charset=utf-8"]
            )
            if let response {
                client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            }
            client?.urlProtocol(self, didLoad: body)
            client?.urlProtocolDidFinishLoading(self)
        case .failure(let error):
            client?.urlProtocol(self, didFailWithError: error)
        case .hang:
            break
        }
    }

    override func stopLoading() {}

    /// URLSession hands a protocol the body as a stream, not as `httpBody`.
    private static func body(of request: URLRequest) -> Data? {
        if let body = request.httpBody { return body }
        guard let stream = request.httpBodyStream else { return nil }
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 4096)
        while stream.hasBytesAvailable {
            let count = stream.read(&buffer, maxLength: buffer.count)
            guard count > 0 else { break }
            data.append(buffer, count: count)
        }
        return data
    }
}
