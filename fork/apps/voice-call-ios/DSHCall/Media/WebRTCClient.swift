import Foundation
import WebRTC

/// What the peer connection reports, as Sendable values for the main actor.
enum WebRTCEvent: Equatable, Sendable {
    enum ConnectionState: Equatable, Sendable {
        case new, connecting, connected, disconnected, failed, closed
    }

    enum IceState: Equatable, Sendable {
        case new, checking, connected, completed, disconnected, failed, closed
    }

    case connectionState(ConnectionState)
    case iceState(IceState)
    case controlChannelOpened
    case controlChannelClosed
    /// One UTF-8 text frame from the `control` data channel.
    case controlMessage(String)
}

enum WebRTCClientError: Error, LocalizedError {
    case peerConnectionUnavailable
    case audioTrackRejected
    case controlChannelUnavailable
    case offerFailed(String)
    case answerFailed(String)
    case missingLocalDescription
    case closed

    var errorDescription: String? {
        switch self {
        case .peerConnectionUnavailable:
            return String(localized: "The audio connection could not be created.")
        case .audioTrackRejected:
            return String(localized: "The microphone track could not be added.")
        case .controlChannelUnavailable:
            return String(localized: "The control channel could not be created.")
        case .offerFailed(let message):
            return String(localized: "Could not prepare the audio connection: \(message)")
        case .answerFailed(let message):
            return String(localized: "The server's audio answer was rejected: \(message)")
        case .missingLocalDescription:
            return String(localized: "The audio connection has no local description.")
        case .closed:
            return String(localized: "The audio connection was closed.")
        }
    }
}

/// One audio-only peer connection with a `control` data channel.
///
/// ICE is not trickled: `createOffer` waits for gathering to complete (or a timeout) and returns the
/// complete SDP. The SDP is never changed. WebRTC calls the delegates on its signaling thread; mutable
/// state is guarded by `lock` and events are forwarded through `events`.
final class WebRTCClient: NSObject, @unchecked Sendable {
    static let controlChannelLabel = "control"

    /// One factory per process. `RTCPeerConnectionFactory` is thread safe.
    nonisolated(unsafe) private static let factory: RTCPeerConnectionFactory = {
        _ = RTCInitializeSSL()
        return RTCPeerConnectionFactory()
    }()

    let events: AsyncStream<WebRTCEvent>

    private let continuation: AsyncStream<WebRTCEvent>.Continuation
    private let peerConnection: RTCPeerConnection
    private let audioTrack: RTCAudioTrack
    private let controlChannel: RTCDataChannel

    private let lock = NSLock()
    private var gatheringComplete = false
    private var gatheringWaiters: [UUID: CheckedContinuation<Void, Never>] = [:]
    private var isClosed = false

    /// Creates the peer connection, the microphone track (sendrecv), and the ordered `control` channel.
    init(streamId: String) throws {
        let configuration = RTCConfiguration()
        configuration.iceServers = []
        configuration.sdpSemantics = .unifiedPlan
        configuration.continualGatheringPolicy = .gatherOnce
        configuration.bundlePolicy = .maxBundle
        configuration.rtcpMuxPolicy = .require

        let constraints = RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)
        guard let peerConnection = Self.factory.peerConnection(with: configuration, constraints: constraints, delegate: nil) else {
            throw WebRTCClientError.peerConnectionUnavailable
        }

        let source = Self.factory.audioSource(with: RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil))
        let audioTrack = Self.factory.audioTrack(with: source, trackId: "microphone")
        guard peerConnection.add(audioTrack, streamIds: [streamId]) != nil else {
            peerConnection.close()
            throw WebRTCClientError.audioTrackRejected
        }

        let channelConfiguration = RTCDataChannelConfiguration()
        channelConfiguration.isOrdered = true
        guard let controlChannel = peerConnection.dataChannel(forLabel: Self.controlChannelLabel, configuration: channelConfiguration) else {
            peerConnection.close()
            throw WebRTCClientError.controlChannelUnavailable
        }

        let (stream, continuation) = AsyncStream.makeStream(of: WebRTCEvent.self, bufferingPolicy: .unbounded)
        self.events = stream
        self.continuation = continuation
        self.peerConnection = peerConnection
        self.audioTrack = audioTrack
        self.controlChannel = controlChannel
        super.init()
        peerConnection.delegate = self
        controlChannel.delegate = self
    }

    deinit {
        continuation.finish()
    }

    // MARK: - Negotiation

    /// Creates the offer, sets it as the local description, waits for ICE gathering to complete or for
    /// `gatheringTimeout`, and returns the local SDP with every gathered candidate.
    func createOffer(gatheringTimeout: TimeInterval) async throws -> String {
        let peerConnection = self.peerConnection
        let constraints = RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            peerConnection.offer(for: constraints) { description, error in
                guard let description else {
                    continuation.resume(throwing: WebRTCClientError.offerFailed(error?.localizedDescription ?? "-"))
                    return
                }
                peerConnection.setLocalDescription(description) { error in
                    if let error {
                        continuation.resume(throwing: WebRTCClientError.offerFailed(error.localizedDescription))
                    } else {
                        continuation.resume()
                    }
                }
            }
        }
        await waitForGathering(timeout: gatheringTimeout)
        try checkOpen()
        guard let sdp = peerConnection.localDescription?.sdp else {
            throw WebRTCClientError.missingLocalDescription
        }
        Log.media.info("Offer ready (\(sdp.utf8.count, privacy: .public) bytes, gathering complete: \(self.isGatheringComplete, privacy: .public))")
        return sdp
    }

    /// Applies the server's complete SDP answer.
    func applyAnswer(_ sdp: String) async throws {
        try checkOpen()
        let peerConnection = self.peerConnection
        let description = RTCSessionDescription(type: .answer, sdp: sdp)
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            peerConnection.setRemoteDescription(description) { error in
                if let error {
                    continuation.resume(throwing: WebRTCClientError.answerFailed(error.localizedDescription))
                } else {
                    continuation.resume()
                }
            }
        }
        Log.media.info("Answer applied (\(sdp.utf8.count, privacy: .public) bytes)")
    }

    // MARK: - Media and control

    /// Enables or disables the microphone track. A disabled track sends silence.
    func setMicrophoneEnabled(_ enabled: Bool) {
        audioTrack.isEnabled = enabled
    }

    /// Sends one text frame on the control channel. Returns false when the channel is not open.
    @discardableResult
    func send(_ text: String) -> Bool {
        guard !closedSnapshot, controlChannel.readyState == .open else { return false }
        return controlChannel.sendData(RTCDataBuffer(data: Data(text.utf8), isBinary: false))
    }

    var isControlChannelOpen: Bool {
        !closedSnapshot && controlChannel.readyState == .open
    }

    /// Closes the channel and the peer connection. Safe to call more than once.
    func close() {
        let waiters: [CheckedContinuation<Void, Never>]
        lock.lock()
        if isClosed {
            lock.unlock()
            return
        }
        isClosed = true
        waiters = Array(gatheringWaiters.values)
        gatheringWaiters.removeAll()
        lock.unlock()

        waiters.forEach { $0.resume() }
        controlChannel.delegate = nil
        peerConnection.delegate = nil
        controlChannel.close()
        peerConnection.close()
        continuation.finish()
        Log.media.info("Peer connection closed")
    }

    // MARK: - Private

    private var closedSnapshot: Bool {
        lock.lock()
        defer { lock.unlock() }
        return isClosed
    }

    private var isGatheringComplete: Bool {
        lock.lock()
        defer { lock.unlock() }
        return gatheringComplete
    }

    private func checkOpen() throws {
        if closedSnapshot { throw WebRTCClientError.closed }
    }

    private func waitForGathering(timeout: TimeInterval) async {
        let id = UUID()
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            lock.lock()
            if gatheringComplete || isClosed {
                lock.unlock()
                continuation.resume()
                return
            }
            gatheringWaiters[id] = continuation
            lock.unlock()
            DispatchQueue.global().asyncAfter(deadline: .now() + timeout) { [weak self] in
                self?.resumeGatheringWaiter(id, timedOut: true)
            }
        }
    }

    private func resumeGatheringWaiter(_ id: UUID, timedOut: Bool) {
        lock.lock()
        let waiter = gatheringWaiters.removeValue(forKey: id)
        lock.unlock()
        guard let waiter else { return }
        if timedOut { Log.media.info("ICE gathering timed out; sending the candidates gathered so far") }
        waiter.resume()
    }

    private func markGatheringComplete() {
        lock.lock()
        gatheringComplete = true
        let waiters = Array(gatheringWaiters.values)
        gatheringWaiters.removeAll()
        lock.unlock()
        waiters.forEach { $0.resume() }
    }

    private func emit(_ event: WebRTCEvent) {
        guard !closedSnapshot else { return }
        continuation.yield(event)
    }
}

// MARK: - RTCPeerConnectionDelegate (signaling thread)

extension WebRTCClient: RTCPeerConnectionDelegate {
    func peerConnection(_ peerConnection: RTCPeerConnection, didChange stateChanged: RTCSignalingState) {}

    func peerConnection(_ peerConnection: RTCPeerConnection, didAdd stream: RTCMediaStream) {}

    func peerConnection(_ peerConnection: RTCPeerConnection, didRemove stream: RTCMediaStream) {}

    func peerConnectionShouldNegotiate(_ peerConnection: RTCPeerConnection) {}

    func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceConnectionState) {
        let state: WebRTCEvent.IceState
        switch newState {
        case .new: state = .new
        case .checking: state = .checking
        case .connected: state = .connected
        case .completed: state = .completed
        case .disconnected: state = .disconnected
        case .failed: state = .failed
        case .closed: state = .closed
        default: return
        }
        Log.media.info("ICE connection state: \(String(describing: state), privacy: .public)")
        emit(.iceState(state))
    }

    func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceGatheringState) {
        if newState == .complete {
            markGatheringComplete()
        }
    }

    func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCPeerConnectionState) {
        let state: WebRTCEvent.ConnectionState
        switch newState {
        case .new: state = .new
        case .connecting: state = .connecting
        case .connected: state = .connected
        case .disconnected: state = .disconnected
        case .failed: state = .failed
        case .closed: state = .closed
        @unknown default: return
        }
        Log.media.info("Peer connection state: \(String(describing: state), privacy: .public)")
        emit(.connectionState(state))
    }

    func peerConnection(_ peerConnection: RTCPeerConnection, didGenerate candidate: RTCIceCandidate) {}

    func peerConnection(_ peerConnection: RTCPeerConnection, didRemove candidates: [RTCIceCandidate]) {}

    func peerConnection(_ peerConnection: RTCPeerConnection, didOpen dataChannel: RTCDataChannel) {
        // The server does not open channels of its own; `control` is created locally before the offer.
    }
}

// MARK: - RTCDataChannelDelegate (signaling thread)

extension WebRTCClient: RTCDataChannelDelegate {
    func dataChannelDidChangeState(_ dataChannel: RTCDataChannel) {
        switch dataChannel.readyState {
        case .open:
            Log.media.info("Control channel open")
            emit(.controlChannelOpened)
        case .closed:
            Log.media.info("Control channel closed")
            emit(.controlChannelClosed)
        default:
            break
        }
    }

    func dataChannel(_ dataChannel: RTCDataChannel, didReceiveMessageWith buffer: RTCDataBuffer) {
        guard !buffer.isBinary, let text = String(data: buffer.data, encoding: .utf8) else {
            Log.media.error("Ignored a non-text control frame (\(buffer.data.count, privacy: .public) bytes)")
            return
        }
        emit(.controlMessage(text))
    }
}
