import Foundation
import Security

/// Generic-password Keychain items for this app.
///
/// Items use `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`: a VoIP push can wake the app while the
/// phone is locked, and answering or declining needs the token then. Items never sync or leave the device.
struct KeychainStore: Sendable {
    enum Item: String, Sendable {
        case apiToken = "api-token"
        case deviceId = "device-id"
    }

    enum KeychainError: Error, Equatable, LocalizedError {
        /// The item exists but cannot be read now, typically before the first unlock after a restart.
        case unavailable(OSStatus)
        case unexpectedStatus(OSStatus)
        case invalidData

        var errorDescription: String? {
            switch self {
            case .unavailable(let status), .unexpectedStatus(let status):
                return String(localized: "Keychain error \(Int(status)).")
            case .invalidData:
                return String(localized: "The Keychain item could not be read.")
            }
        }
    }

    let service: String

    init(service: String = (Bundle.main.bundleIdentifier ?? "com.example.dshcall") + ".keychain") {
        self.service = service
    }

    /// Returns the stored value, or nil when there is no such item.
    func read(_ item: Item) throws -> String? {
        var query = baseQuery(item)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        switch status {
        case errSecSuccess:
            guard let data = result as? Data, let value = String(data: data, encoding: .utf8) else {
                throw KeychainError.invalidData
            }
            return value
        case errSecItemNotFound:
            return nil
        case errSecInteractionNotAllowed:
            throw KeychainError.unavailable(status)
        default:
            throw KeychainError.unexpectedStatus(status)
        }
    }

    func write(_ value: String, for item: Item) throws {
        let data = Data(value.utf8)
        let attributes: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        let updateStatus = SecItemUpdate(baseQuery(item) as CFDictionary, attributes as CFDictionary)
        switch updateStatus {
        case errSecSuccess:
            return
        case errSecItemNotFound:
            var query = baseQuery(item)
            query.merge(attributes) { _, new in new }
            let addStatus = SecItemAdd(query as CFDictionary, nil)
            guard addStatus == errSecSuccess else { throw KeychainError.unexpectedStatus(addStatus) }
        case errSecInteractionNotAllowed:
            throw KeychainError.unavailable(updateStatus)
        default:
            throw KeychainError.unexpectedStatus(updateStatus)
        }
    }

    func delete(_ item: Item) throws {
        let status = SecItemDelete(baseQuery(item) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw KeychainError.unexpectedStatus(status)
        }
    }

    private func baseQuery(_ item: Item) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: item.rawValue,
        ]
    }
}
