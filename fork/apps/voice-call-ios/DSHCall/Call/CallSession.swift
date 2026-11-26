import Foundation

/// Media and control for one answered or started call: the WebRTC connection, the control channel,
/// on-device speech, and the connect and disconnect timers.
///
/// Call-level outcomes go to `CallManager` through `onEvent`, which feeds them to the call's
/// `CallMachine`; everything the call screen shows is written to the `ActiveCall`.
@MainActor
final class CallSession {
    /// From the answer (or start) to a connected peer connection.
    static let connectTimeout: TimeInterval = 15
    /// How long to wait for ICE gathering before posting the offer with the candidates found so far.
    static let gatheringTimeout: TimeInterval = 3
    /// How long ICE may stay `disconnected` before the call ends.
    static let disconnectGrace: TimeInterval = 5
    /// The pause after the last new partial result that ends an utterance.
    static let endpointSilence: TimeInterval = 0.8
    /// Lets the control channel flush a `hangup` frame before the peer connection closes.
    static let hangupFlushDelay: TimeInterval = 0.25
    /// How long the microphone track stays silent after the phone stops speaking, so the end of its own
    /// speech does not reach the server.
    static let speakerMicrophoneTail: TimeInterval = 0.3
    /// The longest wait for the phone to finish speaking DSH's hangup reason before the call ends.
    static let farewellLimit: TimeInterval = 8

    struct Context {
        let callId: String
        let deviceId: String
        let client: APIClient
        let recognitionLocale: String
        /// The speech modes from the last health check, used if the check made for this call fails.
        let knownSpeech: Health.Speech?
    }

    private let context: Context
    private let call: ActiveCall
    private let onEvent: (CallMachine.Event) -> Void
    private let makeRecognizer: () -> DeviceSpeechRecognizing

    private var rtc: WebRTCClient?
    private var connectTask: Task<Void, Never>?
    private var deadlineTask: Task<Void, Never>?
    private var healthTask: Task<Void, Never>?
    private var eventsTask: Task<Void, Never>?
    private var disconnectTask: Task<Void, Never>?
    private var isConnected = false
    private var isClosed = false
    private var isAudioActive = false
    private var hangupSent = false
    /// Set when DSH hung up; the call ends once its reason has been spoken.
    private var isEnding = false
    private var farewellTask: Task<Void, Never>?
    private var speech: Health.Speech?

    private let speaker: DeviceSpeaker
    /// True while the phone speaks (and briefly after): the microphone track then sends silence.
    private var speakerHoldsMicrophone = false
    private var speakerTailTask: Task<Void, Never>?
    private var recognizer: DeviceSpeechRecognizing?
    private var recognitionTask: Task<Void, Never>?
    private var recognitionGeneration = 0
    private var recognitionFailures: [Date] = []
    private var gate = UtteranceGate()
    private var endpointTask: Task<Void, Never>?
    private var agentSpeechEndedAt: Date?

    init(
        context: Context,
        call: ActiveCall,
        makeRecognizer: @escaping () -> DeviceSpeechRecognizing = { EngineTapSpeechRecognizer() },
        onEvent: @escaping (CallMachine.Event) -> Void
    ) {
        self.context = context
        self.call = call
        self.makeRecognizer = makeRecognizer
        self.onEvent = onEvent
        speaker = DeviceSpeaker()
    }

    // MARK: - Lifecycle

    func start() {
        speaker.onSpeakingChanged = { [weak self] speaking in
            self?.deviceSpeakingChanged(speaking)
        }
        deadlineTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(Self.connectTimeout))
            guard !Task.isCancelled else { return }
            self?.connectDeadlinePassed()
        }
        let client = context.client
        healthTask = Task { [weak self] in
            let health: Health?
            do {
                health = try await client.health()
            } catch {
                Log.call.error("Health check for the call failed: \(error.localizedDescription, privacy: .public)")
                health = nil
            }
            guard !Task.isCancelled else { return }
            self?.speechModesKnown(health?.speech)
        }
        connectTask = Task { [weak self] in
            await self?.connect()
        }
    }

    /// Stops everything. When a `hangup` frame was just sent, the peer connection closes a moment later
    /// so the frame can leave. Safe to call more than once.
    func close() {
        guard !isClosed else { return }
        isClosed = true
        for task in [connectTask, deadlineTask, healthTask, eventsTask, disconnectTask, endpointTask, recognitionTask, speakerTailTask, farewellTask] {
            task?.cancel()
        }
        speaker.onSpeakingChanged = nil
        speaker.stop()
        recognizer?.stop()
        recognizer = nil
        guard let rtc else { return }
        self.rtc = nil
        if hangupSent {
            Task {
                try? await Task.sleep(for: .seconds(Self.hangupFlushDelay))
                rtc.close()
            }
        } else {
            rtc.close()
        }
    }

    // MARK: - Owner actions

    func setMuted(_ muted: Bool) {
        call.isMuted = muted
        applyMicrophoneState()
        if muted, gate.isActive || gate.heardOnlyEcho {
            restartRecognition()
        }
    }

    /// The Interrupt button: stop local speech now and ask DSH to stop.
    func interrupt() {
        speaker.stop()
        send(.interrupt)
    }

    /// Best effort, before `POST /hangup`.
    func sendHangupMessage() {
        hangupSent = send(.hangup(reason: nil))
    }

    // MARK: - Audio session (from CallKit)

    func audioSessionActivated() {
        isAudioActive = true
        updateDeviceListening()
    }

    func audioSessionDeactivated() {
        isAudioActive = false
        stopRecognizer()
    }

    // MARK: - Connecting

    private func connect() async {
        let rtc: WebRTCClient
        do {
            rtc = try WebRTCClient(streamId: "dsh")
        } catch {
            report(.connectFailed(error.localizedDescription))
            return
        }
        guard !isClosed else {
            rtc.close()
            return
        }
        self.rtc = rtc
        applyMicrophoneState()
        eventsTask = Task { [weak self] in
            for await event in rtc.events {
                self?.handle(event)
            }
        }

        do {
            let offer = try await rtc.createOffer(gatheringTimeout: Self.gatheringTimeout)
            guard !isClosed else { return }
            let answer = try await context.client.connect(callId: context.callId, deviceId: context.deviceId, sdp: offer)
            guard !isClosed else { return }
            try await rtc.applyAnswer(answer)
        } catch is CancellationError {
            return
        } catch let error as APIError {
            guard !isClosed else { return }
            switch error.statusCode {
            case 409:
                let rejection = await conflictRejection()
                report(.connectRejected(rejection))
            case 410:
                report(.connectRejected(.gone))
            default:
                report(.connectFailed(error.localizedDescription))
            }
        } catch {
            guard !isClosed else { return }
            report(.connectFailed(error.localizedDescription))
        }
    }

    /// A 409 means picked up elsewhere or not connectable; the call's state tells which.
    private func conflictRejection() async -> CallMachine.ConnectRejection {
        guard let call = try? await context.client.call(callId: context.callId) else { return .notConnectable }
        return call.state == .connecting || call.state == .active ? .answeredElsewhere : .notConnectable
    }

    private func connectDeadlinePassed() {
        guard !isConnected, !isClosed else { return }
        Log.call.error("Not connected \(Self.connectTimeout, privacy: .public) s after the answer")
        report(.connectTimedOut)
    }

    private func speechModesKnown(_ fetched: Health.Speech?) {
        let resolved = fetched ?? context.knownSpeech ?? .serverDefault
        speech = resolved
        Log.call.info("Speech modes: stt=\(resolved.stt.rawValue, privacy: .public) tts=\(resolved.tts.rawValue, privacy: .public)")
        updateDeviceListening()
    }

    // MARK: - WebRTC events

    private func handle(_ event: WebRTCEvent) {
        // After DSH hung up, the server closes its side; the call ends on the hangup, not as a failure.
        guard !isClosed, !isEnding else { return }
        switch event {
        case .connectionState(.connected):
            guard !isConnected else { return }
            isConnected = true
            deadlineTask?.cancel()
            call.connectedAt = Date()
            report(.mediaConnected)
            updateDeviceListening()
        case .connectionState(.failed):
            report(.mediaFailed(String(localized: "The audio connection failed.")))
        case .connectionState:
            break
        case .iceState(.disconnected):
            startDisconnectTimer()
        case .iceState(.connected), .iceState(.completed):
            disconnectTask?.cancel()
            disconnectTask = nil
        case .iceState(.failed):
            report(.mediaFailed(String(localized: "The audio connection failed.")))
        case .iceState:
            break
        case .controlChannelOpened, .controlChannelClosed:
            break
        case .controlMessage(let text):
            handleControl(text)
        }
    }

    private func startDisconnectTimer() {
        guard disconnectTask == nil else { return }
        disconnectTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(Self.disconnectGrace))
            guard !Task.isCancelled else { return }
            self?.report(.mediaFailed(String(localized: "The audio connection was lost.")))
        }
    }

    // MARK: - Control channel

    private func handleControl(_ text: String) {
        let message: ControlMessage
        do {
            message = try ControlMessage.decode(text)
        } catch {
            Log.call.error("Ignored an unreadable control frame (\(text.utf8.count, privacy: .public) bytes)")
            return
        }
        switch message {
        case .state(let activity):
            let wasSpeaking = call.activity == AgentActivity.speaking
            call.activity = activity
            if wasSpeaking, activity != .speaking {
                agentSpeechEndedAt = Date()
                if gate.heardOnlyEcho { restartRecognition() }
            }
        case .transcript(let role, let text):
            call.appendTranscript(role: role, text: text)
        case .say(let text):
            speaker.speak(text)
        case .stopSpeaking:
            speaker.stop()
        case .hangup(let reason):
            serverHungUp(reason: reason)
        case .utterance, .speaking, .interrupt:
            Log.call.info("Ignored app-to-server message \(message.typeName, privacy: .public) from the server")
        case .unknown(let type):
            Log.call.info("Ignored control message \(type, privacy: .public)")
        }
    }

    /// DSH hung up. The server expects the phone to speak the reason, so the call ends once that is done.
    private func serverHungUp(reason: String?) {
        guard !isEnding else { return }
        isEnding = true
        deadlineTask?.cancel()
        disconnectTask?.cancel()
        stopRecognizer()
        speaker.stop()
        let spoken = reason?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        call.hangupReason = spoken.isEmpty ? nil : spoken
        guard !spoken.isEmpty, isAudioActive else {
            report(.serverHangup)
            return
        }
        speaker.speak(spoken)
        farewellTask = Task { [weak self] in
            let started = Date()
            while Date().timeIntervalSince(started) < Self.farewellLimit {
                try? await Task.sleep(for: .milliseconds(200))
                guard !Task.isCancelled, let self else { return }
                if !self.speaker.isSpeaking { break }
            }
            guard !Task.isCancelled else { return }
            self?.report(.serverHangup)
        }
    }

    @discardableResult
    private func send(_ message: ControlMessage) -> Bool {
        guard let rtc else { return false }
        let text: String
        do {
            text = try message.encodedText()
        } catch {
            Log.call.error("Could not encode \(message.typeName, privacy: .public): \(error.localizedDescription, privacy: .public)")
            return false
        }
        let sent = rtc.send(text)
        if !sent {
            Log.call.info("Control channel not open; dropped \(message.typeName, privacy: .public)")
        }
        return sent
    }

    // MARK: - On-device speech (stt=device)

    private func updateDeviceListening() {
        guard !isClosed, !isEnding, let speech else { return }
        guard speech.stt == .device else {
            call.speechStatus = .server
            return
        }
        guard isConnected, isAudioActive, recognizer == nil else { return }
        if case .unavailable = call.speechStatus { return }
        startRecognizer()
    }

    private func startRecognizer() {
        let recognizer = makeRecognizer()
        do {
            recognitionGeneration = try recognizer.start(localeIdentifier: context.recognitionLocale)
        } catch {
            Log.speech.error("On-device recognition unavailable: \(error.localizedDescription, privacy: .public)")
            call.speechStatus = .unavailable(error.localizedDescription)
            return
        }
        self.recognizer = recognizer
        call.speechStatus = .listening
        recognitionTask = Task { [weak self] in
            for await event in recognizer.events {
                self?.handleRecognition(event)
            }
        }
    }

    private func stopRecognizer() {
        endpointTask?.cancel()
        endpointTask = nil
        recognitionTask?.cancel()
        recognitionTask = nil
        recognizer?.stop()
        recognizer = nil
        gate.reset()
    }

    private func handleRecognition(_ event: RecognitionEvent) {
        guard !isClosed, event.generation == recognitionGeneration else { return }
        switch event.kind {
        case .partial(let text):
            consider(text, isFinal: false)
        case .completed(let text):
            consider(text, isFinal: true)
        case .failed(let message):
            Log.speech.info("Recognition task ended: \(message, privacy: .public)")
            if gate.isActive {
                finishUtterance()
            } else {
                restartRecognition(afterFailure: true)
            }
        case .stopped(let message):
            stopRecognizer()
            call.speechStatus = .unavailable(message)
        }
    }

    private func consider(_ text: String, isFinal: Bool) {
        if call.isMuted {
            if isFinal { restartRecognition() }
            return
        }
        if !gate.isActive, let reference = echoReference() {
            if reference.isEmpty || EchoGuard.isLikelyEcho(partial: text, spoken: reference) {
                gate.echo(text)
                if isFinal { restartRecognition() }
                return
            }
        }
        switch gate.heard(text) {
        case .began:
            send(.speaking)
            scheduleEndpoint()
        case .changed:
            scheduleEndpoint()
        case .unchanged:
            break
        }
        if isFinal { finishUtterance() }
    }

    /// What the microphone may be hearing from the phone's speaker: nil when nothing was played recently,
    /// an empty string when DSH is speaking through the audio track but its words are not known yet.
    private func echoReference(now: Date = Date()) -> String? {
        let deviceText = speaker.recentSpeech(now: now)
        let agentSpeaking = call.activity == AgentActivity.speaking
            || agentSpeechEndedAt.map { now.timeIntervalSince($0) < DeviceSpeaker.echoTail } == true
        guard speaker.isSpeaking || !deviceText.isEmpty || agentSpeaking else { return nil }
        let agentText = agentSpeaking ? call.recentAgentText(lines: 2) : ""
        return [deviceText, agentText].filter { !$0.isEmpty }.joined(separator: " ")
    }

    private func scheduleEndpoint() {
        endpointTask?.cancel()
        endpointTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(Self.endpointSilence))
            guard !Task.isCancelled else { return }
            self?.finishUtterance()
        }
    }

    private func finishUtterance() {
        endpointTask?.cancel()
        endpointTask = nil
        if let text = gate.finish() {
            send(.utterance(text: text))
        }
        restartRecognition()
    }

    private func restartRecognition(afterFailure: Bool = false) {
        endpointTask?.cancel()
        endpointTask = nil
        gate.reset()
        guard let recognizer else { return }
        if afterFailure {
            let now = Date()
            recognitionFailures = recognitionFailures.filter { now.timeIntervalSince($0) < 10 } + [now]
            if recognitionFailures.count >= 5 {
                stopRecognizer()
                call.speechStatus = .unavailable(String(localized: "Speech recognition keeps failing."))
                return
            }
        }
        recognitionGeneration = recognizer.restartTask()
    }

    private func deviceSpeakingChanged(_ speaking: Bool) {
        call.isDeviceSpeaking = speaking
        speakerTailTask?.cancel()
        speakerTailTask = nil
        if speaking {
            speakerHoldsMicrophone = true
            applyMicrophoneState()
        } else {
            speakerTailTask = Task { [weak self] in
                try? await Task.sleep(for: .seconds(Self.speakerMicrophoneTail))
                guard !Task.isCancelled, let self else { return }
                self.speakerHoldsMicrophone = false
                self.applyMicrophoneState()
            }
            if gate.heardOnlyEcho { restartRecognition() }
        }
    }

    /// The phone's own speech does not pass through WebRTC's echo canceller, so the microphone track is
    /// silenced while it plays; otherwise the server would hear it as the owner talking. On-device
    /// recognition still hears the microphone and can interrupt DSH.
    private func applyMicrophoneState() {
        rtc?.setMicrophoneEnabled(!call.isMuted && !speakerHoldsMicrophone)
    }

    private func report(_ event: CallMachine.Event) {
        guard !isClosed else { return }
        onEvent(event)
    }
}
