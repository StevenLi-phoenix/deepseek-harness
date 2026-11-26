import Speech
import SwiftUI
import UIKit

/// Server address and token, connection check, device registration, and on-device speech options.
struct SettingsView: View {
    @EnvironmentObject private var model: AppModel
    @EnvironmentObject private var settings: SettingsStore
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL

    @State private var serverURL = ""
    @State private var token = ""
    @State private var saveError: String?
    @State private var saved = false
    @State private var recognitionStatus = SpeechPermissions.recognitionStatus
    @State private var isUnregistering = false

    /// Recognition locales offered in the picker; the current setting is always included.
    private static let offeredLocales = ["zh-CN", "zh-TW", "zh-HK", "en-US", "en-GB", "ja-JP"]

    var body: some View {
        Form {
            serverSection
            connectionSection
            registrationSection
            speechSection
            aboutSection
        }
        .navigationTitle("Settings")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button("Done") { dismiss() }
            }
        }
        .onAppear {
            serverURL = settings.serverURL
            recognitionStatus = SpeechPermissions.recognitionStatus
        }
    }

    // MARK: - Sections

    private var serverSection: some View {
        Section {
            TextField("https://dsh.example.ts.net", text: $serverURL)
                .keyboardType(.URL)
                .textContentType(.URL)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
            SecureField(settings.hasToken ? String(localized: "Token (stored; leave empty to keep it)") : String(localized: "Token"), text: $token)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
            Button("Save") { save() }
            if let saveError {
                Text(saveError)
                    .foregroundStyle(.red)
            } else if saved {
                Label("Saved", systemImage: "checkmark")
                    .foregroundStyle(.green)
            }
        } header: {
            Text("Server")
        } footer: {
            Text("The Tailscale Serve HTTPS address of the Mac that runs DSH, and the voice call token configured there. The token is kept in the Keychain on this iPhone.")
        }
    }

    private var connectionSection: some View {
        Section("Connection") {
            switch model.health {
            case .unknown:
                Text("Not checked yet.")
                    .foregroundStyle(.secondary)
            case .checking:
                HStack {
                    ProgressView()
                    Text("Checking…")
                }
            case .ok(let health):
                LabeledContent("Voice calls", value: health.enabled ? String(localized: "On") : String(localized: "Off"))
                LabeledContent("Speech recognition", value: Self.modeName(health.speech.stt))
                LabeledContent("Speech output", value: Self.modeName(health.speech.tts))
            case .failed(let message):
                Text(message)
                    .foregroundStyle(.red)
            }
            Button("Check connection") {
                Task { await model.checkHealth() }
            }
        }
    }

    private var registrationSection: some View {
        Section {
            Text(RegistrationText.describe(model.registration))
            Button("Register") {
                model.registerButtonPressed()
            }
            Button("Unregister", role: .destructive) {
                isUnregistering = true
                Task {
                    await model.unregisterButtonPressed()
                    isUnregistering = false
                }
            }
            .disabled(isUnregistering)
        } header: {
            Text("Calls from DSH")
        } footer: {
            Text("Registering sends this iPhone's VoIP push token to the server so DSH can call it. Unregister removes it; the app then stops registering until you press Register.")
        }
    }

    private var speechSection: some View {
        Section {
            Picker("Recognition language", selection: $settings.recognitionLocale) {
                ForEach(localeChoices, id: \.self) { identifier in
                    Text(Self.localeName(identifier)).tag(identifier)
                }
            }
            switch recognitionStatus {
            case .authorized:
                Label("Speech recognition allowed", systemImage: "checkmark.circle")
            case .notDetermined:
                Button("Allow speech recognition") {
                    Task { recognitionStatus = await SpeechPermissions.requestRecognition() }
                }
            case .denied, .restricted:
                Button("Speech recognition is off. Open iOS Settings") {
                    if let url = URL(string: UIApplication.openSettingsURLString) { openURL(url) }
                }
            @unknown default:
                EmptyView()
            }
        } header: {
            Text("On-device speech")
        } footer: {
            Text("Used only when the server asks the phone to recognize speech. Recognition stays on the iPhone when the language supports it; otherwise iOS uses Apple's speech service.")
        }
    }

    private var aboutSection: some View {
        Section("About") {
            LabeledContent("Device ID", value: shortDeviceId)
            LabeledContent("Push environment", value: PushEnvironment.current.rawValue)
            LabeledContent("Version", value: Self.version)
        }
    }

    // MARK: - Helpers

    private func save() {
        saved = false
        do {
            try settings.save(serverURL: serverURL, newToken: token)
            token = ""
            serverURL = settings.serverURL
            saveError = nil
            saved = true
            model.settingsDidChange()
        } catch {
            saveError = error.localizedDescription
        }
    }

    private var localeChoices: [String] {
        var choices = Self.offeredLocales
        if !choices.contains(settings.recognitionLocale) {
            choices.insert(settings.recognitionLocale, at: 0)
        }
        return choices
    }

    private var shortDeviceId: String {
        guard let id = settings.deviceId() else { return String(localized: "Unavailable") }
        return String(id.prefix(8))
    }

    private static func localeName(_ identifier: String) -> String {
        let name = Locale.current.localizedString(forIdentifier: identifier) ?? identifier
        return "\(name) (\(identifier))"
    }

    private static func modeName(_ mode: Health.SpeechMode) -> String {
        switch mode {
        case .server: return String(localized: "On the server")
        case .device: return String(localized: "On this iPhone")
        default: return mode.rawValue
        }
    }

    private static var version: String {
        let info = Bundle.main.infoDictionary
        let short = info?["CFBundleShortVersionString"] as? String ?? "-"
        let build = info?["CFBundleVersion"] as? String ?? "-"
        return "\(short) (\(build))"
    }
}
