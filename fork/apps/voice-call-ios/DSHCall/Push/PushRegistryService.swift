import Foundation
import PushKit

/// Receives PushKit token changes for `PushRegistryService`.
@MainActor
protocol PushRegistryServiceDelegate: AnyObject {
    func pushRegistryService(_ service: PushRegistryService, didUpdateToken token: Data)
    func pushRegistryServiceDidInvalidateToken(_ service: PushRegistryService)
}

/// Owns the VoIP `PKPushRegistry`.
///
/// The registry delivers on the main queue, so every delegate method runs on the main actor. Incoming
/// pushes go straight to `CallManager`, which reports them to CallKit before the delegate method returns:
/// since iOS 13 the system terminates an app that receives a VoIP push without reporting a call.
@MainActor
final class PushRegistryService: NSObject, PKPushRegistryDelegate {
    weak var delegate: PushRegistryServiceDelegate?

    private let callManager: CallManager
    private var registry: PKPushRegistry?

    init(callManager: CallManager) {
        self.callManager = callManager
        super.init()
    }

    /// Registers for VoIP pushes. Call once, from `application(_:didFinishLaunchingWithOptions:)`, so that a
    /// push which launched the app in the background is delivered.
    func start() {
        guard registry == nil else { return }
        let registry = PKPushRegistry(queue: .main)
        registry.delegate = self
        registry.desiredPushTypes = [.voIP]
        self.registry = registry
        Log.push.info("Registered for VoIP pushes")
    }

    /// The current VoIP token, when PushKit has one.
    var currentToken: Data? {
        registry?.pushToken(for: .voIP)
    }

    // MARK: - PKPushRegistryDelegate (main queue)

    nonisolated func pushRegistry(_ registry: PKPushRegistry, didUpdate pushCredentials: PKPushCredentials, for type: PKPushType) {
        guard type == .voIP else { return }
        let token = pushCredentials.token
        MainActor.assumeIsolated {
            Log.push.info("VoIP token updated (\(token.count, privacy: .public) bytes)")
            delegate?.pushRegistryService(self, didUpdateToken: token)
        }
    }

    nonisolated func pushRegistry(_ registry: PKPushRegistry, didInvalidatePushTokenFor type: PKPushType) {
        guard type == .voIP else { return }
        MainActor.assumeIsolated {
            Log.push.info("VoIP token invalidated")
            delegate?.pushRegistryServiceDidInvalidateToken(self)
        }
    }

    nonisolated func pushRegistry(
        _ registry: PKPushRegistry,
        didReceiveIncomingPushWith payload: PKPushPayload,
        for type: PKPushType,
        completion: @escaping @Sendable () -> Void
    ) {
        // Parse here so only a Sendable value crosses to the main actor. Every VoIP push is reported,
        // whatever its content; CallManager ends malformed ones at once.
        let parsed = type == .voIP ? IncomingPushParser.parse(payload.dictionaryPayload) : .malformed(reason: "unexpected push type")
        MainActor.assumeIsolated {
            Log.push.info("VoIP push received")
            callManager.reportIncomingPush(parsed, completion: completion)
        }
    }
}
