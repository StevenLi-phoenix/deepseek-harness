import AVFoundation
import Speech

// MARK: - Permissions

/// Microphone and speech recognition permissions.
enum SpeechPermissions {
    static var microphoneGranted: Bool {
        AVAudioApplication.shared.recordPermission == .granted
    }

    static var microphoneUndetermined: Bool {
        AVAudioApplication.shared.recordPermission == .undetermined
    }

    static func requestMicrophone() async -> Bool {
        await AVAudioApplication.requestRecordPermission()
    }

    static var recognitionStatus: SFSpeechRecognizerAuthorizationStatus {
        SFSpeechRecognizer.authorizationStatus()
    }

    static func requestRecognition() async -> SFSpeechRecognizerAuthorizationStatus {
        await withCheckedContinuation { continuation in
            SFSpeechRecognizer.requestAuthorization { status in
                continuation.resume(returning: status)
            }
        }
    }
}

// MARK: - Speaking (tts=device)

/// Speaks `say` frames with `AVSpeechSynthesizer` on the call's audio session, in the order received.
///
/// The synthesizer's output does not pass through WebRTC's echo canceller, so the server may hear it on
/// the microphone track. `recentSpeech()` lets on-device recognition ignore it.
@MainActor
final class DeviceSpeaker: NSObject, AVSpeechSynthesizerDelegate {
    /// How long after an utterance ends its text still counts as possible echo.
    static let echoTail: TimeInterval = 1.5

    /// Called with true when speaking starts and false when the queue is empty or stopped.
    var onSpeakingChanged: ((Bool) -> Void)?

    private let synthesizer: AVSpeechSynthesizer
    private var pending: [ObjectIdentifier: AVSpeechUtterance] = [:]
    private var recentlySpoken: [(text: String, endedAt: Date)] = []

    /// - Parameter synthesizer: Speaks on the application's audio session, which CallKit activates.
    init(synthesizer: AVSpeechSynthesizer = AVSpeechSynthesizer()) {
        self.synthesizer = synthesizer
        super.init()
        synthesizer.usesApplicationAudioSession = true
        synthesizer.delegate = self
    }

    var isSpeaking: Bool { !pending.isEmpty }

    /// Queues `text`. The voice is zh-CN unless the text is mostly ASCII letters (then en-US).
    func speak(_ text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        let utterance = AVSpeechUtterance(string: trimmed)
        utterance.voice = AVSpeechSynthesisVoice(language: SpeechLanguage.voiceLanguage(for: trimmed))
        let wasSpeaking = isSpeaking
        pending[ObjectIdentifier(utterance)] = utterance
        synthesizer.speak(utterance)
        if !wasSpeaking { onSpeakingChanged?(true) }
    }

    /// Stops at once and drops everything queued.
    func stop() {
        let wasSpeaking = isSpeaking
        let now = Date()
        recentlySpoken += pending.values.map { (text: $0.speechString, endedAt: now) }
        pending.removeAll()
        synthesizer.stopSpeaking(at: .immediate)
        if wasSpeaking { onSpeakingChanged?(false) }
    }

    /// The text being spoken now or within the last `echoTail` seconds.
    func recentSpeech(now: Date = Date()) -> String {
        recentlySpoken.removeAll { now.timeIntervalSince($0.endedAt) > Self.echoTail }
        return (pending.values.map(\.speechString) + recentlySpoken.map(\.text)).joined(separator: " ")
    }

    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        let id = ObjectIdentifier(utterance)
        Task { @MainActor in self.utteranceEnded(id) }
    }

    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        let id = ObjectIdentifier(utterance)
        Task { @MainActor in self.utteranceEnded(id) }
    }

    private func utteranceEnded(_ id: ObjectIdentifier) {
        guard let utterance = pending.removeValue(forKey: id) else { return }
        recentlySpoken.append((text: utterance.speechString, endedAt: Date()))
        if pending.isEmpty { onSpeakingChanged?(false) }
    }
}

// MARK: - Recognition (stt=device)

/// One result from a recognition task. `generation` identifies the task; results of replaced tasks are
/// dropped by the consumer.
struct RecognitionEvent: Equatable, Sendable {
    enum Kind: Equatable, Sendable {
        /// The task's cumulative text so far.
        case partial(String)
        /// The task ended with this text.
        case completed(String)
        /// The task failed; a new task can be started.
        case failed(String)
        /// Listening stopped and cannot continue.
        case stopped(String)
    }

    let generation: Int
    let kind: Kind
}

enum DeviceSpeechError: Error, Equatable, LocalizedError {
    case recognitionNotAuthorized
    case microphoneNotAuthorized
    case unsupportedLocale(String)
    case recognizerUnavailable
    case noAudioInput
    case engineFailed(String)

    var errorDescription: String? {
        switch self {
        case .recognitionNotAuthorized:
            return String(localized: "Speech recognition is not allowed. Turn it on in Settings.")
        case .microphoneNotAuthorized:
            return String(localized: "Microphone access is not allowed. Turn it on in Settings.")
        case .unsupportedLocale(let identifier):
            return String(localized: "Speech recognition does not support \(identifier).")
        case .recognizerUnavailable:
            return String(localized: "Speech recognition is not available right now.")
        case .noAudioInput:
            return String(localized: "No microphone input is available for speech recognition.")
        case .engineFailed(let message):
            return String(localized: "Speech recognition could not use the microphone: \(message)")
        }
    }
}

/// On-device speech-to-text while WebRTC owns the microphone.
///
/// WebRTC's audio device module exposes no capture tap, so an implementation needs its own microphone
/// input. Keeping this behind a protocol allows replacing the best-effort engine tap with, for example, a
/// custom `RTCAudioDevice` that feeds both WebRTC and the recognizer.
protocol DeviceSpeechRecognizing: AnyObject, Sendable {
    var events: AsyncStream<RecognitionEvent> { get }
    /// Starts listening and the first recognition task; returns that task's generation.
    func start(localeIdentifier: String) throws -> Int
    /// Ends the current recognition task and starts a new one; returns the new generation.
    func restartTask() -> Int
    /// Stops listening and finishes `events`.
    func stop()
}

/// Best-effort recognizer: a second `AVAudioEngine` input tap next to WebRTC's voice-processing unit,
/// on the same CallKit audio session.
///
/// Limitations (see README): the tap hears the microphone without echo cancellation; iOS may refuse a
/// second input unit or reconfigure it on route changes (the engine is restarted on
/// `AVAudioEngineConfigurationChange`); recognition uses Apple's servers when the locale has no
/// on-device model.
final class EngineTapSpeechRecognizer: DeviceSpeechRecognizing, @unchecked Sendable {
    let events: AsyncStream<RecognitionEvent>

    private let continuation: AsyncStream<RecognitionEvent>.Continuation
    private let lock = NSLock()
    private var engine: AVAudioEngine?
    private var recognizer: SFSpeechRecognizer?
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var configurationObserver: NSObjectProtocol?
    private var generation = 0
    private var isStopped = false

    init() {
        let (stream, continuation) = AsyncStream.makeStream(of: RecognitionEvent.self, bufferingPolicy: .unbounded)
        events = stream
        self.continuation = continuation
    }

    deinit {
        continuation.finish()
    }

    func start(localeIdentifier: String) throws -> Int {
        guard SFSpeechRecognizer.authorizationStatus() == .authorized else {
            throw DeviceSpeechError.recognitionNotAuthorized
        }
        guard SpeechPermissions.microphoneGranted else {
            throw DeviceSpeechError.microphoneNotAuthorized
        }
        guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: localeIdentifier)) else {
            throw DeviceSpeechError.unsupportedLocale(localeIdentifier)
        }
        guard recognizer.isAvailable else {
            throw DeviceSpeechError.recognizerUnavailable
        }
        let engine = AVAudioEngine()
        try installTapAndStart(engine)
        let observer = NotificationCenter.default.addObserver(
            forName: .AVAudioEngineConfigurationChange,
            object: engine,
            queue: nil
        ) { [weak self] _ in
            self?.engineConfigurationChanged()
        }
        lock.withLock {
            self.engine = engine
            self.recognizer = recognizer
            self.configurationObserver = observer
            self.isStopped = false
        }
        Log.speech.info("Listening (\(localeIdentifier, privacy: .public), on-device: \(recognizer.supportsOnDeviceRecognition, privacy: .public))")
        return restartTask()
    }

    @discardableResult
    func restartTask() -> Int {
        lock.lock()
        request?.endAudio()
        let oldTask = task
        task = nil
        request = nil
        generation += 1
        let current = generation
        guard !isStopped, let recognizer else {
            lock.unlock()
            oldTask?.cancel()
            return current
        }
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        request.taskHint = .dictation
        request.addsPunctuation = true
        if recognizer.supportsOnDeviceRecognition {
            request.requiresOnDeviceRecognition = true
        }
        self.request = request
        lock.unlock()

        oldTask?.cancel()
        let newTask = recognizer.recognitionTask(with: request) { [weak self] result, error in
            self?.handle(result: result, error: error, generation: current)
        }
        lock.lock()
        if generation == current, !isStopped {
            task = newTask
            lock.unlock()
        } else {
            lock.unlock()
            newTask.cancel()
        }
        return current
    }

    func stop() {
        lock.lock()
        isStopped = true
        generation += 1
        let engine = self.engine
        let task = self.task
        let request = self.request
        let observer = configurationObserver
        self.engine = nil
        self.task = nil
        self.request = nil
        self.recognizer = nil
        configurationObserver = nil
        lock.unlock()

        if let observer { NotificationCenter.default.removeObserver(observer) }
        request?.endAudio()
        task?.cancel()
        if let engine {
            engine.inputNode.removeTap(onBus: 0)
            engine.stop()
        }
        continuation.finish()
        Log.speech.info("Stopped listening")
    }

    // MARK: - Private

    private func installTapAndStart(_ engine: AVAudioEngine) throws {
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else {
            throw DeviceSpeechError.noAudioInput
        }
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
            self?.append(buffer)
        }
        engine.prepare()
        do {
            try engine.start()
        } catch {
            input.removeTap(onBus: 0)
            throw DeviceSpeechError.engineFailed(error.localizedDescription)
        }
    }

    private func append(_ buffer: AVAudioPCMBuffer) {
        let request = lock.withLock { self.request }
        request?.append(buffer)
    }

    private func handle(result: SFSpeechRecognitionResult?, error: Error?, generation: Int) {
        let isCurrent = lock.withLock { generation == self.generation && !self.isStopped }
        guard isCurrent else { return }
        if let result {
            let text = result.bestTranscription.formattedString
            continuation.yield(RecognitionEvent(generation: generation, kind: result.isFinal ? .completed(text) : .partial(text)))
            if result.isFinal { return }
        }
        if let error {
            continuation.yield(RecognitionEvent(generation: generation, kind: .failed(error.localizedDescription)))
        }
    }

    private func engineConfigurationChanged() {
        let (engine, current) = lock.withLock { (self.isStopped ? nil : self.engine, self.generation) }
        guard let engine else { return }
        Log.speech.info("Audio engine configuration changed; restarting the input tap")
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        do {
            try installTapAndStart(engine)
        } catch {
            Log.speech.error("Input tap restart failed: \(error.localizedDescription, privacy: .public)")
            continuation.yield(RecognitionEvent(generation: current, kind: .stopped(error.localizedDescription)))
        }
    }
}
