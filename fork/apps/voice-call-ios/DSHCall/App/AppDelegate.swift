import UIKit

/// Starts PushKit and CallKit at launch. A VoIP push can launch the app in the background, and its
/// delivery requires the push registry to exist before `application(_:didFinishLaunchingWithOptions:)`
/// returns.
final class AppDelegate: NSObject, UIApplicationDelegate {
    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        Log.app.info("Launched")
        AppModel.shared.start()
        return true
    }
}
