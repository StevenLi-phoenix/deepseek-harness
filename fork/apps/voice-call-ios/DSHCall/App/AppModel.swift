import Foundation
import Speech
import UIKit

/// The app's composition root: settings, the call manager, PushKit, device registration, and the
/// server health shown in the UI. One instance, created at launch by `AppDelegate`.
@MainActor
final class AppModel: ObservableObject {
    static let shared = AppModel()

    enum RegistrationState: Equatable {
        case notConfigured
        case waitingForToken
        case registering
        case registered(at: Date)
        case unregistering
        /// The owner pressed Unregister.
        case unregistered
        case failed(String)
    }

    enum HealthState: Equatable {
        case unknown
        case checking
        case ok(Health)
        case failed(String)
    }

    let settings: SettingsStore
    let callManager: CallManager
    let pushService: PushRegistryService

    @Published private(set) var registration: RegistrationState = .waitingForToken
    @Published private(set) var health: HealthState = .unknown
    @Published private(set) var lastKnownSpeech: Health.Speech?

    private var voipToken: Data?
    private var registrationTask: Task<Void, Never>?
    /// Server, device ID, and token of the registration in flight or done in this launch.
    private var registrationKey: String?
    private var isStarted = false
    private var askedForMicrophone = false

    private init() {
        settings = SettingsStore()
        callManager = CallManager(providerConfiguration: CallManager.makeProviderConfiguration())
        pushService = PushRegistryService(callManager: callManager)
        callManager.services = self
        pushService.delegate = self
    }

    /// Called from `application(_:didFinishLaunchingWithOptions:)`, also for background launches by a
    /// VoIP push. Safe to call again.
    func start() {
        guard !isStarted else { return }
        isStarted = true
        CallAudio.configureAtLaunch()
        pushService.start()
        if let token = pushService.currentToken {
            voipToken = token
        }
        registerIfNeeded(force: false)
    }

    /// The app came to the foreground.
    func appDidBecomeActive() {
        start()
        if case .failed = registration {
            registerIfNeeded(force: true)
        }
        Task { await checkHealth() }
        if !askedForMicrophone, SpeechPermissions.microphoneUndetermined {
            askedForMicrophone = true
            Task { _ = await SpeechPermissions.requestMicrophone() }
        }
    }

    /// The owner saved new settings.
    func settingsDidChange() {
        registerIfNeeded(force: true)
        Task { await checkHealth() }
    }

    /// A start-call activity from Recents or Siri. The only callee is DSH.
    func handleStartCallActivity(_ activity: NSUserActivity) {
        Log.app.info("Start call requested by \(activity.activityType, privacy: .public)")
        start()
        Task { await callManager.startOwnerCall() }
    }

    // MARK: - Device registration

    /// The Register button: allow registration again and register now.
    func registerButtonPressed() {
        settings.registrationEnabled = true
        registerIfNeeded(force: true)
    }

    /// Registers this device with the server unless an identical registration already ran in this launch.
    func registerIfNeeded(force: Bool) {
        guard settings.registrationEnabled else {
            registration = .unregistered
            return
        }
        guard let client = makeAPIClient() else {
            registration = .notConfigured
            return
        }
        guard let deviceId = currentDeviceId() else {
            registration = .failed(String(localized: "The device ID is not readable yet. Unlock the phone and try again."))
            return
        }
        guard let token = voipToken else {
            registration = .waitingForToken
            return
        }
        let tokenHex = token.lowercaseHexString
        let key = [client.configuration.baseURL.absoluteString, deviceId, tokenHex].joined(separator: "\n")
        if !force, key == registrationKey {
            return
        }
        registrationKey = key
        registrationTask?.cancel()
        registration = .registering

        let name = DeviceRegistrationBody.deviceName(UIDevice.current.name)
        let environment = PushEnvironment.current
        let activity = BackgroundActivity(name: "register")
        registrationTask = Task {
            defer { activity.end() }
            do {
                let device = try await client.registerDevice(deviceId: deviceId, voipToken: tokenHex, environment: environment, name: name)
                guard !Task.isCancelled else { return }
                registration = .registered(at: Date(timeIntervalSince1970: device.registeredAt / 1000))
                Log.app.info("Device registered (\(environment.rawValue, privacy: .public))")
            } catch is CancellationError {
                return
            } catch {
                guard !Task.isCancelled else { return }
                registrationKey = nil
                registration = .failed(error.localizedDescription)
            }
        }
    }

    /// The Unregister button: remove this device from the server and stop registering automatically.
    func unregisterButtonPressed() async {
        settings.registrationEnabled = false
        registrationTask?.cancel()
        registrationTask = nil
        registrationKey = nil
        guard let client = makeAPIClient(), let deviceId = currentDeviceId() else {
            registration = .unregistered
            return
        }
        registration = .unregistering
        do {
            try await client.unregisterDevice(deviceId: deviceId)
            registration = .unregistered
            Log.app.info("Device unregistered")
        } catch {
            registration = .failed(error.localizedDescription)
        }
    }

    // MARK: - Health

    func checkHealth() async {
        guard let client = makeAPIClient() else {
            health = .unknown
            return
        }
        health = .checking
        do {
            let result = try await client.health()
            health = .ok(result)
            lastKnownSpeech = result.speech
            if result.speech.stt == .device, SpeechPermissions.recognitionStatus == .notDetermined {
                _ = await SpeechPermissions.requestRecognition()
            }
        } catch {
            health = .failed(error.localizedDescription)
        }
    }
}

// MARK: - CallServices

extension AppModel: CallServices {
    func makeAPIClient() -> APIClient? {
        settings.apiConfiguration().map { APIClient(configuration: $0) }
    }

    func currentDeviceId() -> String? {
        settings.deviceId()
    }

    var recognitionLocale: String {
        settings.recognitionLocale
    }
}

// MARK: - PushRegistryServiceDelegate

extension AppModel: PushRegistryServiceDelegate {
    func pushRegistryService(_ service: PushRegistryService, didUpdateToken token: Data) {
        voipToken = token
        registerIfNeeded(force: false)
    }

    func pushRegistryServiceDidInvalidateToken(_ service: PushRegistryService) {
        voipToken = nil
        registrationTask?.cancel()
        registrationTask = nil
        registrationKey = nil
        registration = .waitingForToken
        guard let client = makeAPIClient(), let deviceId = currentDeviceId() else { return }
        let activity = BackgroundActivity(name: "unregister")
        Task {
            defer { activity.end() }
            do {
                try await client.unregisterDevice(deviceId: deviceId)
                Log.app.info("Device removed from the server after the token was invalidated")
            } catch {
                Log.app.error("Removing the device failed: \(error.localizedDescription, privacy: .public)")
            }
        }
    }
}
