import AVFoundation
import WebRTC

/// Audio session handling for calls, in the order CallKit requires.
///
/// WebRTC runs with manual audio: its voice-processing audio unit may start only after CallKit has
/// activated the audio session (`provider(_:didActivate:)`) and must stop when CallKit deactivates it.
/// The app never activates or deactivates the session itself. `RTCAudioSession` is thread safe; these
/// functions are called on the main thread by the CallKit delegate.
enum CallAudio {
    /// Call once at launch, before any peer connection exists.
    static func configureAtLaunch() {
        let session = RTCAudioSession.sharedInstance()
        session.useManualAudio = true
        session.isAudioEnabled = false
    }

    /// Sets the category and mode WebRTC needs (`.playAndRecord`, `.voiceChat`) without activating the
    /// session. Call from the CallKit start or answer action, before fulfilling it.
    static func prepareForCall() {
        let configuration = RTCAudioSessionConfiguration.webRTC()
        configuration.category = AVAudioSession.Category.playAndRecord.rawValue
        configuration.mode = AVAudioSession.Mode.voiceChat.rawValue
        configuration.categoryOptions = bluetoothOptions
        let session = RTCAudioSession.sharedInstance()
        session.lockForConfiguration()
        defer { session.unlockForConfiguration() }
        do {
            try session.setConfiguration(configuration)
        } catch {
            Log.media.error("Audio session configuration failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    /// CallKit activated the session: hand it to WebRTC, then allow its audio unit to start.
    static func didActivate(_ audioSession: AVAudioSession) {
        let session = RTCAudioSession.sharedInstance()
        session.audioSessionDidActivate(audioSession)
        session.isAudioEnabled = true
        Log.media.info("Audio session activated")
    }

    /// CallKit deactivated the session: stop WebRTC's audio unit, then tell WebRTC.
    static func didDeactivate(_ audioSession: AVAudioSession) {
        let session = RTCAudioSession.sharedInstance()
        session.isAudioEnabled = false
        session.audioSessionDidDeactivate(audioSession)
        Log.media.info("Audio session deactivated")
    }

    /// Bluetooth hands-free headsets. The option was renamed in the iOS 26 SDK (Swift 6.2 compilers).
    private static var bluetoothOptions: AVAudioSession.CategoryOptions {
        #if compiler(>=6.2)
        return [.allowBluetoothHFP]
        #else
        return [.allowBluetooth]
        #endif
    }
}
