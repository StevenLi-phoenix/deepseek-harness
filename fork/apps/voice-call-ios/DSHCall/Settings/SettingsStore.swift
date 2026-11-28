import Foundation

/// The owner's settings. The server URL and recognition locale live in UserDefaults; the API token and
/// the device ID live in the Keychain. The token is never published or logged.
@MainActor
final class SettingsStore: ObservableObject {
    static let defaultRecognitionLocale = "zh-CN"

    enum SettingsError: Error, Equatable, LocalizedError {
        case invalidServerURL
        case missingToken

        var errorDescription: String? {
            switch self {
            case .invalidServerURL:
                return String(localized: "Enter an HTTPS address such as https://dsh.example.ts.net.")
            case .missingToken:
                return String(localized: "Enter the voice call token.")
            }
        }
    }

    private enum Keys {
        static let serverURL = "serverURL"
        static let recognitionLocale = "recognitionLocale"
        static let registrationEnabled = "registrationEnabled"
    }

    /// The server address as last saved (normalized), or empty.
    @Published private(set) var serverURL: String
    /// Whether a token is stored. The token itself is never published.
    @Published private(set) var hasToken: Bool
    /// The locale for on-device speech recognition, used when the server's stt mode is `device`.
    @Published var recognitionLocale: String {
        didSet { defaults.set(recognitionLocale, forKey: Keys.recognitionLocale) }
    }
    /// False after the owner pressed Unregister; the app then stops registering on its own until the
    /// owner presses Register.
    @Published var registrationEnabled: Bool {
        didSet { defaults.set(registrationEnabled, forKey: Keys.registrationEnabled) }
    }

    private let defaults: UserDefaults
    private let keychain: KeychainStore
    private var cachedToken: String?
    private var cachedDeviceId: String?

    init(defaults: UserDefaults = .standard, keychain: KeychainStore = KeychainStore()) {
        self.defaults = defaults
        self.keychain = keychain
        serverURL = defaults.string(forKey: Keys.serverURL) ?? ""
        recognitionLocale = defaults.string(forKey: Keys.recognitionLocale) ?? Self.defaultRecognitionLocale
        registrationEnabled = defaults.object(forKey: Keys.registrationEnabled) as? Bool ?? true
        let token: String? = (try? keychain.read(.apiToken)) ?? nil
        cachedToken = token
        hasToken = token != nil
    }

    /// Saves the server address and, when `newToken` is non-empty, replaces the token.
    /// An empty `newToken` keeps the stored one.
    func save(serverURL input: String, newToken: String) throws {
        guard let url = APIConfiguration.validatedBaseURL(input) else { throw SettingsError.invalidServerURL }
        let trimmedToken = newToken.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmedToken.isEmpty {
            guard token() != nil else { throw SettingsError.missingToken }
        } else {
            try keychain.write(trimmedToken, for: .apiToken)
            cachedToken = trimmedToken
            hasToken = true
        }
        serverURL = url.absoluteString
        defaults.set(serverURL, forKey: Keys.serverURL)
        Log.app.info("Settings saved for host \(url.host ?? "-", privacy: .private)")
    }

    func clearToken() throws {
        try keychain.delete(.apiToken)
        cachedToken = nil
        hasToken = false
    }

    /// The API configuration, or nil when the address or token is missing or unreadable.
    func apiConfiguration() -> APIConfiguration? {
        guard let url = APIConfiguration.validatedBaseURL(serverURL), let token = token() else { return nil }
        return APIConfiguration(baseURL: url, token: token)
    }

    /// The token, read from the Keychain when not cached (it can be unreadable before the first unlock).
    func token() -> String? {
        if let cachedToken { return cachedToken }
        do {
            cachedToken = try keychain.read(.apiToken)
            hasToken = cachedToken != nil
        } catch {
            Log.app.error("Token unavailable: \(error.localizedDescription, privacy: .public)")
        }
        return cachedToken
    }

    /// The device ID: a lowercase UUID generated once and kept in the Keychain. Nil only while the
    /// Keychain is unreadable; a new ID is created only when no item exists.
    func deviceId() -> String? {
        if let cachedDeviceId { return cachedDeviceId }
        do {
            if let stored = try keychain.read(.deviceId), UUID(uuidString: stored) != nil {
                cachedDeviceId = stored
            } else {
                let created = UUID().uuidString.lowercased()
                try keychain.write(created, for: .deviceId)
                cachedDeviceId = created
                Log.app.info("Created a new device ID")
            }
        } catch {
            Log.app.error("Device ID unavailable: \(error.localizedDescription, privacy: .public)")
        }
        return cachedDeviceId
    }
}
