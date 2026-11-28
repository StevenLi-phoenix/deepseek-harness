import XCTest
@testable import DSHCall

/// Uses a throwaway UserDefaults suite and Keychain service, removed after each test.
final class SettingsStoreTests: XCTestCase {
    private var suiteName = ""
    private var keychain = KeychainStore(service: "unused")

    override func setUp() {
        super.setUp()
        let id = UUID().uuidString
        suiteName = "dshcall.tests.\(id)"
        keychain = KeychainStore(service: "dshcall.tests.\(id)")
    }

    override func tearDown() {
        UserDefaults().removePersistentDomain(forName: suiteName)
        try? keychain.delete(.apiToken)
        try? keychain.delete(.deviceId)
        super.tearDown()
    }

    @MainActor
    private func makeStore() throws -> SettingsStore {
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        return SettingsStore(defaults: defaults, keychain: keychain)
    }

    @MainActor
    func testStartsUnconfigured() throws {
        let store = try makeStore()
        XCTAssertEqual(store.serverURL, "")
        XCTAssertFalse(store.hasToken)
        XCTAssertNil(store.apiConfiguration())
        XCTAssertTrue(store.registrationEnabled)
        XCTAssertEqual(store.recognitionLocale, SettingsStore.defaultRecognitionLocale)
    }

    @MainActor
    func testSaveStoresTokenInKeychainAndURLInDefaults() throws {
        let store = try makeStore()
        try store.save(serverURL: "https://dsh.example.ts.net/", newToken: "  token-1  ")
        XCTAssertEqual(store.serverURL, "https://dsh.example.ts.net")
        XCTAssertTrue(store.hasToken)
        XCTAssertEqual(try keychain.read(.apiToken), "token-1")
        XCTAssertEqual(store.apiConfiguration()?.token, "token-1")

        let reloaded = try makeStore()
        XCTAssertEqual(reloaded.serverURL, "https://dsh.example.ts.net")
        XCTAssertEqual(reloaded.apiConfiguration()?.baseURL.absoluteString, "https://dsh.example.ts.net")
    }

    @MainActor
    func testEmptyTokenKeepsTheStoredOne() throws {
        let store = try makeStore()
        try store.save(serverURL: "https://dsh.example.ts.net", newToken: "token-1")
        try store.save(serverURL: "https://other.example.ts.net", newToken: "")
        XCTAssertEqual(store.apiConfiguration()?.token, "token-1")
        XCTAssertEqual(store.serverURL, "https://other.example.ts.net")
    }

    @MainActor
    func testSaveRejectsBadInput() throws {
        let store = try makeStore()
        XCTAssertThrowsError(try store.save(serverURL: "http://dsh.example.ts.net", newToken: "t")) { error in
            XCTAssertEqual(error as? SettingsStore.SettingsError, .invalidServerURL)
        }
        XCTAssertThrowsError(try store.save(serverURL: "https://dsh.example.ts.net", newToken: " ")) { error in
            XCTAssertEqual(error as? SettingsStore.SettingsError, .missingToken)
        }
        XCTAssertFalse(store.hasToken)
        XCTAssertEqual(store.serverURL, "")
    }

    @MainActor
    func testClearToken() throws {
        let store = try makeStore()
        try store.save(serverURL: "https://dsh.example.ts.net", newToken: "token-1")
        try store.clearToken()
        XCTAssertFalse(store.hasToken)
        XCTAssertNil(store.apiConfiguration())
        XCTAssertNil(try keychain.read(.apiToken))
    }

    @MainActor
    func testDeviceIdIsALowercaseUUIDThatStays() throws {
        let first = try XCTUnwrap(try makeStore().deviceId())
        XCTAssertNotNil(UUID(uuidString: first))
        XCTAssertEqual(first, first.lowercased())
        XCTAssertEqual(try makeStore().deviceId(), first)
    }

    @MainActor
    func testRegistrationEnabledPersists() throws {
        let store = try makeStore()
        store.registrationEnabled = false
        XCTAssertFalse(try makeStore().registrationEnabled)
    }
}
