import AVFoundation
import CallKit
import UIKit

/// What `CallManager` needs from the rest of the app.
@MainActor
protocol CallServices: AnyObject {
    /// A client for the configured server, or nil when the address or token is missing.
    func makeAPIClient() -> APIClient?
    /// This device's ID, or nil while the Keychain is unreadable.
    func currentDeviceId() -> String?
    /// The locale for on-device recognition.
    var recognitionLocale: String { get }
    /// The speech modes from the last successful health check.
    var lastKnownSpeech: Health.Speech? { get }
}

/// Owns the app's only `CXProvider` and `CXCallController` and every call's state.
///
/// CallKit delivers delegate callbacks on the main queue. Each call has a `CallMachine`; CallKit actions,
/// server polling, and `CallSession` events are fed to it, and its effects are carried out here.
@MainActor
final class CallManager: NSObject, ObservableObject {
    /// The handle every call uses; there is only one callee.
    static let handleValue = "DSH"
    /// CallKit never stops ringing by itself; the app gives up after this long.
    static let ringLimit: TimeInterval = 60
    /// How often a ringing call is checked on the server (picked up or declined elsewhere, cancelled).
    static let ringPollInterval: TimeInterval = 2
    /// How long the ended call stays on screen.
    static let endedCallDisplayTime: TimeInterval = 2

    weak var services: CallServices?

    /// The call shown on the call screen, including one that just ended.
    @Published private(set) var activeCall: ActiveCall?
    @Published private(set) var lastSummary: CallSummary?
    @Published private(set) var isStartingCall = false
    /// A message for an alert on the main screen.
    @Published var alertMessage: String?

    private let provider: CXProvider
    private let callController = CXCallController()
    private var records: [UUID: CallRecord] = [:]
    private var isAudioSessionActive = false

    init(providerConfiguration: CXProviderConfiguration) {
        provider = CXProvider(configuration: providerConfiguration)
        super.init()
        provider.setDelegate(self, queue: nil)
    }

    static func makeProviderConfiguration() -> CXProviderConfiguration {
        let configuration = CXProviderConfiguration()
        configuration.supportsVideo = false
        configuration.maximumCallsPerCallGroup = 1
        configuration.supportedHandleTypes = [.generic]
        configuration.includesCallsInRecents = true
        if let icon = UIImage(named: "CallKitIcon") {
            configuration.iconTemplateImageData = icon.pngData()
        }
        return configuration
    }

    var hasCall: Bool { !records.isEmpty }

    // MARK: - Incoming (DSH calls the owner)

    /// Reports a VoIP push to CallKit. Must be called before the PushKit delegate method returns;
    /// `completion` is the PushKit completion handler.
    func reportIncomingPush(_ push: IncomingPushParse, completion: @escaping @Sendable () -> Void) {
        switch push {
        case .malformed(let reason):
            Log.push.error("Malformed VoIP push (\(reason, privacy: .public)); reporting and ending it")
            let uuid = UUID()
            provider.reportNewIncomingCall(with: uuid, update: makeUpdate(callerName: IncomingCallPush.defaultCaller)) { [weak self] error in
                completion()
                Task { @MainActor in
                    guard error == nil else { return }
                    self?.provider.reportCall(with: uuid, endedAt: Date(), reason: .failed)
                }
            }
        case .call(let incoming):
            reportIncoming(incoming, completion: completion)
        }
    }

    private func reportIncoming(_ push: IncomingCallPush, completion: @escaping @Sendable () -> Void) {
        let uuid = push.callUUID
        let callId = push.callId
        let update = makeUpdate(callerName: push.callKitName)

        if records[uuid] != nil {
            // A repeated push for a call already reported: CallKit answers callUUIDAlreadyExists, which is fine.
            Log.push.info("Repeated push for a known call")
            provider.reportNewIncomingCall(with: uuid, update: update) { _ in completion() }
            return
        }

        let busy = !records.isEmpty
        if !busy {
            let record = CallRecord(uuid: uuid, callId: callId, direction: .incoming, callerName: push.caller, reason: push.reason)
            records[uuid] = record
            activeCall = record.call
        }
        provider.reportNewIncomingCall(with: uuid, update: update) { [weak self] error in
            completion()
            Task { @MainActor in
                self?.incomingCallReported(uuid: uuid, callId: callId, busy: busy, error: error)
            }
        }
    }

    private func incomingCallReported(uuid: UUID, callId: String, busy: Bool, error: Error?) {
        if let error {
            // For example Do Not Disturb or a blocked handle. The server times the call out as missed.
            Log.call.error("CallKit did not show the incoming call: \(error.localizedDescription, privacy: .public)")
            if !busy, let record = records[uuid] {
                discard(record)
            }
            return
        }
        if busy {
            Log.call.info("Already in a call; declining the new one")
            provider.reportCall(with: uuid, endedAt: Date(), reason: .failed)
            post(.decline, callId: callId)
            return
        }
        guard let record = records[uuid], record.machine.phase == .ringing else { return }
        startRingWatch(record)
    }

    private func startRingWatch(_ record: CallRecord) {
        let uuid = record.uuid
        let callId = record.callId
        record.ringActivity = BackgroundActivity(name: "ringing")
        record.ringWatch = Task { [weak self] in
            let deadline = Date().addingTimeInterval(Self.ringLimit)
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(Self.ringPollInterval))
                guard !Task.isCancelled, let self else { return }
                if Date() >= deadline {
                    self.handle(.ringTimedOut, for: uuid)
                    return
                }
                guard let client = self.services?.makeAPIClient() else { continue }
                do {
                    let call = try await client.call(callId: callId)
                    guard !Task.isCancelled else { return }
                    if let resolution = CallMachine.ringingResolution(for: call) {
                        self.handle(.remoteResolved(resolution), for: uuid)
                        return
                    }
                } catch let error as APIError where error.statusCode == 404 || error.statusCode == 410 {
                    self.handle(.remoteResolved(.ended), for: uuid)
                    return
                } catch {
                    // Keep ringing; the next poll may get through.
                }
            }
        }
    }

    // MARK: - Outgoing (the owner calls DSH)

    /// Creates the call on the server, then asks CallKit to start it. Errors are shown in `alertMessage`.
    func startOwnerCall() async {
        guard !isStartingCall else { return }
        guard records.isEmpty else {
            alertMessage = String(localized: "A call is already in progress.")
            return
        }
        guard let services, let client = services.makeAPIClient() else {
            alertMessage = APIError.notConfigured.localizedDescription
            return
        }
        guard let deviceId = services.currentDeviceId() else {
            alertMessage = String(localized: "The device ID is not readable yet. Unlock the phone and try again.")
            return
        }
        isStartingCall = true
        defer { isStartingCall = false }

        if SpeechPermissions.microphoneUndetermined {
            _ = await SpeechPermissions.requestMicrophone()
        }
        guard SpeechPermissions.microphoneGranted else {
            alertMessage = String(localized: "DSH Call needs microphone access. Turn it on in Settings.")
            return
        }

        let call: Call
        do {
            call = try await client.createCall(deviceId: deviceId)
        } catch {
            alertMessage = error.localizedDescription
            return
        }
        guard let uuid = UUID(uuidString: call.callId) else {
            Log.call.error("The server's call ID is not a UUID")
            post(.hangup, callId: call.callId)
            alertMessage = APIError.invalidResponse.localizedDescription
            return
        }
        guard records.isEmpty else {
            // DSH called while the call was being created.
            post(.hangup, callId: call.callId)
            return
        }

        let record = CallRecord(uuid: uuid, callId: call.callId, direction: .outgoing, callerName: Self.handleValue, reason: nil)
        records[uuid] = record
        activeCall = record.call

        let action = CXStartCallAction(call: uuid, handle: CXHandle(type: .generic, value: Self.handleValue))
        action.isVideo = false
        callController.request(CXTransaction(action: action)) { [weak self] error in
            guard let error else { return }
            let message = error.localizedDescription
            Task { @MainActor in
                Log.call.error("CallKit did not start the call: \(message, privacy: .public)")
                self?.alertMessage = String(localized: "The call could not start: \(message)")
                self?.handle(.startRejected(message), for: uuid)
            }
        }
    }

    // MARK: - Call screen actions

    /// Answers the ringing call from the app's own screen, through CallKit.
    func answerCall() {
        guard let call = activeCall, records[call.id]?.machine.phase == .ringing else { return }
        let uuid = call.id
        callController.request(CXTransaction(action: CXAnswerCallAction(call: uuid))) { error in
            guard let error else { return }
            Log.call.error("CallKit did not answer the call: \(error.localizedDescription, privacy: .public)")
        }
    }

    /// Ends the current call through CallKit, which then performs `CXEndCallAction`.
    func endCall() {
        guard let call = activeCall else { return }
        let uuid = call.id
        guard records[uuid] != nil else {
            activeCall = nil
            return
        }
        callController.request(CXTransaction(action: CXEndCallAction(call: uuid))) { [weak self] error in
            guard let error else { return }
            let message = error.localizedDescription
            Task { @MainActor in
                Log.call.error("CallKit did not end the call: \(message, privacy: .public); ending it directly")
                self?.handle(.userEnded, for: uuid)
                self?.provider.reportCall(with: uuid, endedAt: Date(), reason: .failed)
            }
        }
    }

    /// Mutes or unmutes through CallKit so the system call UI stays in step.
    func setMuted(_ muted: Bool) {
        guard let call = activeCall, records[call.id] != nil else { return }
        let uuid = call.id
        callController.request(CXTransaction(action: CXSetMutedCallAction(call: uuid, muted: muted))) { [weak self] error in
            guard error != nil else { return }
            Task { @MainActor in
                _ = self?.applyMute(uuid: uuid, muted: muted)
            }
        }
    }

    func interrupt() {
        guard let call = activeCall else { return }
        records[call.id]?.session?.interrupt()
    }

    /// Clears an ended call from the screen.
    func dismissEndedCall() {
        guard let call = activeCall, records[call.id] == nil else { return }
        activeCall = nil
    }

    // MARK: - State machine

    private func handle(_ event: CallMachine.Event, for uuid: UUID) {
        guard let record = records[uuid] else { return }
        apply(event, to: record)
    }

    private func apply(_ event: CallMachine.Event, to record: CallRecord) {
        let effects = record.machine.handle(event)
        guard !effects.isEmpty || record.call.phase != record.machine.phase else { return }
        record.call.phase = record.machine.phase
        Log.call.info("Call \(record.callId, privacy: .private) is now \(String(describing: record.machine.phase), privacy: .public)")
        for effect in effects {
            perform(effect, for: record)
        }
    }

    private func perform(_ effect: CallMachine.Effect, for record: CallRecord) {
        switch effect {
        case .startMedia:
            startMedia(record)
        case .reportOutgoingConnected:
            provider.reportOutgoingCall(with: record.uuid, connectedAt: Date())
        case .postDecline:
            post(.decline, callId: record.callId)
        case .sendHangupMessage:
            record.session?.sendHangupMessage()
        case .postHangup:
            post(.hangup, callId: record.callId)
        case .reportEnded(let reason):
            provider.reportCall(with: record.uuid, endedAt: Date(), reason: reason.callKitReason)
        case .teardown:
            teardown(record)
        }
    }

    private func startMedia(_ record: CallRecord) {
        record.ringWatch?.cancel()
        record.ringWatch = nil
        record.ringActivity?.end()
        record.ringActivity = nil

        let uuid = record.uuid
        guard let services, let client = services.makeAPIClient(), let deviceId = services.currentDeviceId() else {
            // `.startMedia` is the only effect of its transition, so handling the failure here is safe.
            handle(.connectFailed(APIError.notConfigured.localizedDescription), for: uuid)
            return
        }
        if !SpeechPermissions.microphoneGranted {
            Log.call.error("Microphone access is not granted; DSH will not hear the owner")
        }
        if record.call.direction == .outgoing {
            provider.reportOutgoingCall(with: uuid, startedConnectingAt: Date())
        }
        let context = CallSession.Context(
            callId: record.callId,
            deviceId: deviceId,
            client: client,
            recognitionLocale: services.recognitionLocale,
            knownSpeech: services.lastKnownSpeech
        )
        let session = CallSession(context: context, call: record.call, onEvent: { [weak self] event in
            self?.handle(event, for: uuid)
        })
        record.session = session
        session.start()
        if isAudioSessionActive {
            session.audioSessionActivated()
        }
    }

    private func teardown(_ record: CallRecord) {
        discard(record)
        let call = record.call
        if let cause = record.machine.endCause {
            lastSummary = CallSummary(
                callerName: call.callerName,
                direction: call.direction,
                cause: cause,
                endedAt: Date(),
                duration: call.connectedAt.map { Date().timeIntervalSince($0) },
                hangupReason: call.hangupReason
            )
        }
        guard activeCall === call else { return }
        Task { [weak self] in
            try? await Task.sleep(for: .seconds(Self.endedCallDisplayTime))
            guard let self, self.activeCall === call else { return }
            self.activeCall = nil
        }
    }

    /// Stops a call's work and forgets it, without CallKit or server side effects.
    private func discard(_ record: CallRecord) {
        record.ringWatch?.cancel()
        record.ringWatch = nil
        record.ringActivity?.end()
        record.ringActivity = nil
        record.session?.close()
        record.session = nil
        records[record.uuid] = nil
        if activeCall === record.call, !record.machine.isEnded {
            activeCall = nil
        }
    }

    private enum PostKind {
        case decline
        case hangup
    }

    private func post(_ kind: PostKind, callId: String) {
        guard let services, let client = services.makeAPIClient(), let deviceId = services.currentDeviceId() else {
            Log.call.error("Cannot tell the server about the call: not configured")
            return
        }
        let activity = BackgroundActivity(name: kind == .decline ? "decline" : "hangup")
        Task {
            defer { activity.end() }
            do {
                switch kind {
                case .decline:
                    try await client.decline(callId: callId, deviceId: deviceId)
                case .hangup:
                    try await client.hangup(callId: callId, deviceId: deviceId)
                }
            } catch {
                Log.call.error("Telling the server failed: \(error.localizedDescription, privacy: .public)")
            }
        }
    }

    // MARK: - CallKit action handling (main actor)

    private func prepareToAnswer(_ uuid: UUID) -> Bool {
        guard let record = records[uuid], record.machine.phase == .ringing else { return false }
        CallAudio.prepareForCall()
        return true
    }

    private func prepareToStart(_ uuid: UUID) -> Bool {
        guard let record = records[uuid], record.machine.phase == .dialing else { return false }
        CallAudio.prepareForCall()
        return true
    }

    private func callStarted(_ uuid: UUID) {
        // Names the call in Recents and the system call screen.
        provider.reportCall(with: uuid, updated: makeUpdate(callerName: Self.handleValue))
        handle(.started, for: uuid)
    }

    private func applyMute(uuid: UUID, muted: Bool) -> Bool {
        guard let record = records[uuid] else { return false }
        if let session = record.session {
            session.setMuted(muted)
        } else {
            record.call.isMuted = muted
        }
        return true
    }

    private func audioSessionChanged(active: Bool) {
        isAudioSessionActive = active
        for record in records.values {
            if active {
                record.session?.audioSessionActivated()
            } else {
                record.session?.audioSessionDeactivated()
            }
        }
    }

    private func resetAllCalls() {
        Log.call.error("CallKit reset the provider")
        for record in Array(records.values) {
            apply(.systemReset, to: record)
        }
        isAudioSessionActive = false
    }

    private func makeUpdate(callerName: String) -> CXCallUpdate {
        let update = CXCallUpdate()
        update.remoteHandle = CXHandle(type: .generic, value: Self.handleValue)
        update.localizedCallerName = callerName
        update.hasVideo = false
        update.supportsHolding = false
        update.supportsGrouping = false
        update.supportsUngrouping = false
        update.supportsDTMF = false
        return update
    }
}

// MARK: - CXProviderDelegate (main queue)

extension CallManager: CXProviderDelegate {
    nonisolated func providerDidReset(_ provider: CXProvider) {
        MainActor.assumeIsolated { resetAllCalls() }
    }

    nonisolated func provider(_ provider: CXProvider, perform action: CXAnswerCallAction) {
        let uuid = action.callUUID
        let accepted = MainActor.assumeIsolated { prepareToAnswer(uuid) }
        guard accepted else {
            action.fail()
            return
        }
        // Fulfil at once; WebRTC connects afterwards so CallKit never waits on the network.
        action.fulfill()
        MainActor.assumeIsolated { handle(.answered, for: uuid) }
    }

    nonisolated func provider(_ provider: CXProvider, perform action: CXStartCallAction) {
        let uuid = action.callUUID
        let accepted = MainActor.assumeIsolated { prepareToStart(uuid) }
        guard accepted else {
            action.fail()
            return
        }
        action.fulfill()
        MainActor.assumeIsolated { callStarted(uuid) }
    }

    nonisolated func provider(_ provider: CXProvider, perform action: CXEndCallAction) {
        let uuid = action.callUUID
        MainActor.assumeIsolated { handle(.userEnded, for: uuid) }
        action.fulfill()
    }

    nonisolated func provider(_ provider: CXProvider, perform action: CXSetMutedCallAction) {
        let uuid = action.callUUID
        let muted = action.isMuted
        let applied = MainActor.assumeIsolated { applyMute(uuid: uuid, muted: muted) }
        if applied {
            action.fulfill()
        } else {
            action.fail()
        }
    }

    nonisolated func provider(_ provider: CXProvider, perform action: CXSetHeldCallAction) {
        // Hold is not supported (supportsHolding is false on every call update).
        action.fail()
    }

    nonisolated func provider(_ provider: CXProvider, perform action: CXPlayDTMFCallAction) {
        action.fail()
    }

    nonisolated func provider(_ provider: CXProvider, perform action: CXSetGroupCallAction) {
        action.fail()
    }

    nonisolated func provider(_ provider: CXProvider, timedOutPerforming action: CXAction) {
        Log.call.error("CallKit action timed out: \(String(describing: type(of: action)), privacy: .public)")
    }

    nonisolated func provider(_ provider: CXProvider, didActivate audioSession: AVAudioSession) {
        CallAudio.didActivate(audioSession)
        MainActor.assumeIsolated { audioSessionChanged(active: true) }
    }

    nonisolated func provider(_ provider: CXProvider, didDeactivate audioSession: AVAudioSession) {
        CallAudio.didDeactivate(audioSession)
        MainActor.assumeIsolated { audioSessionChanged(active: false) }
    }
}

// MARK: - Call records

@MainActor
private final class CallRecord {
    let uuid: UUID
    let callId: String
    var machine: CallMachine
    let call: ActiveCall
    var session: CallSession?
    var ringWatch: Task<Void, Never>?
    var ringActivity: BackgroundActivity?

    init(uuid: UUID, callId: String, direction: CallMachine.Direction, callerName: String, reason: String?) {
        self.uuid = uuid
        self.callId = callId
        machine = CallMachine(direction: direction)
        call = ActiveCall(id: uuid, callId: callId, direction: direction, callerName: callerName, reason: reason)
    }
}

private extension CallMachine.SystemEndReason {
    var callKitReason: CXCallEndedReason {
        switch self {
        case .failed: return .failed
        case .remoteEnded: return .remoteEnded
        case .unanswered: return .unanswered
        case .answeredElsewhere: return .answeredElsewhere
        case .declinedElsewhere: return .declinedElsewhere
        }
    }
}
