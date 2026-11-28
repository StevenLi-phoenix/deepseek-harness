import SwiftUI

@main
struct DSHCallApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @Environment(\.scenePhase) private var scenePhase
    @StateObject private var model = AppModel.shared

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(model)
                .environmentObject(model.settings)
                .environmentObject(model.callManager)
                // Recents and Siri hand over a start-call activity; the only callee is DSH.
                .onContinueUserActivity("INStartCallIntent") { activity in
                    model.handleStartCallActivity(activity)
                }
                .onContinueUserActivity("INStartAudioCallIntent") { activity in
                    model.handleStartCallActivity(activity)
                }
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active {
                model.appDidBecomeActive()
            }
        }
    }
}
