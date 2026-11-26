import UIKit

/// A UIKit background task that keeps a short piece of work (a decline, a hangup, ring polling) running
/// when the app leaves the foreground. `end()` is idempotent and also runs on expiration.
@MainActor
final class BackgroundActivity {
    private var identifier: UIBackgroundTaskIdentifier = .invalid

    init(name: String) {
        identifier = UIApplication.shared.beginBackgroundTask(withName: name) { [weak self] in
            Log.app.info("Background time expired for \(name, privacy: .public)")
            self?.end()
        }
    }

    func end() {
        guard identifier != .invalid else { return }
        UIApplication.shared.endBackgroundTask(identifier)
        identifier = .invalid
    }
}
