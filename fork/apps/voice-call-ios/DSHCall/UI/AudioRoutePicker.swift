import AVKit
import SwiftUI

/// The system audio route button (receiver, speaker, Bluetooth, AirPlay audio).
struct AudioRoutePicker: UIViewRepresentable {
    func makeUIView(context: Context) -> AVRoutePickerView {
        let view = AVRoutePickerView()
        view.prioritizesVideoDevices = false
        view.tintColor = .label
        view.activeTintColor = .systemGreen
        return view
    }

    func updateUIView(_ uiView: AVRoutePickerView, context: Context) {}
}
