import AppIntents

/// "Call DSH" for Siri, Spotlight, and the Shortcuts app. Opens the app and starts an outgoing call.
struct CallDSHIntent: AppIntent {
    static var title: LocalizedStringResource { "Call DSH" }

    static var description: IntentDescription? {
        IntentDescription("Starts a voice call to DSH.")
    }

    /// The call needs the app in the foreground the first time (microphone permission, CallKit start).
    static var openAppWhenRun: Bool { true }

    @MainActor
    func perform() async throws -> some IntentResult {
        let model = AppModel.shared
        model.start()
        await model.callManager.startOwnerCall()
        return .result()
    }
}

/// Registers the phrases without any setup by the owner. Every phrase must contain the app name; the
/// Info.plist key `INAlternativeAppNames` adds "DSH" as a name, so "Call DSH" and "打给 DSH" match.
struct DSHCallShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: CallDSHIntent(),
            phrases: [
                "Call \(.applicationName)",
                "Call DSH with \(.applicationName)",
                "Start a \(.applicationName) call",
            ],
            shortTitle: "Call DSH",
            systemImageName: "phone.fill"
        )
    }

    static var shortcutTileColor: ShortcutTileColor { .lime }
}
