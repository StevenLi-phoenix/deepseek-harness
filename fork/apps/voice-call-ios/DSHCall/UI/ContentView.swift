import SwiftUI
import UIKit

/// The call screen while a call exists, the home screen otherwise.
struct ContentView: View {
    @EnvironmentObject private var callManager: CallManager
    @State private var showingSettings = false

    var body: some View {
        Group {
            if let call = callManager.activeCall {
                CallView(call: call)
            } else {
                HomeView(showingSettings: $showingSettings)
            }
        }
        .animation(.default, value: callManager.activeCall?.id)
        .onChange(of: callManager.activeCall?.id) { _, id in
            if id != nil { showingSettings = false }
        }
        .sheet(isPresented: $showingSettings) {
            NavigationStack {
                SettingsView()
            }
        }
        .alert("DSH Call", isPresented: alertPresented) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(callManager.alertMessage ?? "")
        }
    }

    private var alertPresented: Binding<Bool> {
        Binding(
            get: { callManager.alertMessage != nil },
            set: { presented in
                if !presented { callManager.alertMessage = nil }
            }
        )
    }
}

/// The idle screen: call button, connection and registration status, the last call.
struct HomeView: View {
    @EnvironmentObject private var model: AppModel
    @EnvironmentObject private var callManager: CallManager
    @Binding var showingSettings: Bool
    @Environment(\.openURL) private var openURL

    var body: some View {
        NavigationStack {
            VStack(spacing: 28) {
                Spacer()
                Image(systemName: "waveform.circle.fill")
                    .font(.system(size: 88))
                    .foregroundStyle(.tint)
                    .accessibilityHidden(true)
                Text(verbatim: "DSH")
                    .font(.largeTitle.bold())

                VStack(alignment: .leading, spacing: 10) {
                    StatusRow(systemImage: healthIcon, tint: healthTint, text: healthText)
                    StatusRow(systemImage: registrationIcon, tint: registrationTint, text: registrationText)
                    if !SpeechPermissions.microphoneGranted, !SpeechPermissions.microphoneUndetermined {
                        StatusRow(systemImage: "mic.slash", tint: .orange, text: String(localized: "Microphone access is off, so DSH cannot hear you."))
                        Button("Open iOS Settings") {
                            if let url = URL(string: UIApplication.openSettingsURLString) { openURL(url) }
                        }
                        .font(.footnote)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding()
                .background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 12))

                Button {
                    Task { await callManager.startOwnerCall() }
                } label: {
                    Label("Call DSH", systemImage: "phone.fill")
                        .font(.title3.weight(.semibold))
                        .frame(maxWidth: .infinity, minHeight: 34)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .tint(.green)
                .disabled(callManager.isStartingCall)
                .overlay {
                    if callManager.isStartingCall { ProgressView() }
                }

                if let summary = callManager.lastSummary {
                    LastCallView(summary: summary)
                }
                Spacer()
            }
            .padding()
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        showingSettings = true
                    } label: {
                        Label("Settings", systemImage: "gearshape")
                    }
                }
            }
        }
    }

    private var healthText: String {
        switch model.health {
        case .unknown:
            return String(localized: "Server not checked yet.")
        case .checking:
            return String(localized: "Checking the server…")
        case .ok(let health):
            return health.enabled
                ? String(localized: "DSH is reachable.")
                : String(localized: "DSH is reachable, but voice calls are turned off on the server.")
        case .failed(let message):
            return message
        }
    }

    private var healthIcon: String {
        switch model.health {
        case .ok(let health): return health.enabled ? "checkmark.circle.fill" : "pause.circle.fill"
        case .failed: return "exclamationmark.triangle.fill"
        case .unknown, .checking: return "circle.dotted"
        }
    }

    private var healthTint: Color {
        switch model.health {
        case .ok(let health): return health.enabled ? .green : .orange
        case .failed: return .red
        case .unknown, .checking: return .secondary
        }
    }

    private var registrationText: String {
        RegistrationText.describe(model.registration)
    }

    private var registrationIcon: String {
        switch model.registration {
        case .registered: return "bell.badge.fill"
        case .failed: return "bell.slash.fill"
        case .unregistered, .notConfigured: return "bell.slash"
        case .waitingForToken, .registering, .unregistering: return "bell"
        }
    }

    private var registrationTint: Color {
        switch model.registration {
        case .registered: return .green
        case .failed: return .red
        case .unregistered, .notConfigured: return .orange
        case .waitingForToken, .registering, .unregistering: return .secondary
        }
    }
}

/// Text for a registration state, shared by the home screen and Settings.
enum RegistrationText {
    static func describe(_ state: AppModel.RegistrationState) -> String {
        switch state {
        case .notConfigured:
            return String(localized: "Enter the server address and token in Settings.")
        case .waitingForToken:
            return String(localized: "Waiting for a push token from iOS.")
        case .registering:
            return String(localized: "Registering this iPhone…")
        case .registered(let date):
            return String(localized: "DSH can call this iPhone (registered \(date.formatted(date: .abbreviated, time: .shortened))).")
        case .unregistering:
            return String(localized: "Unregistering this iPhone…")
        case .unregistered:
            return String(localized: "Not registered: DSH cannot call this iPhone.")
        case .failed(let message):
            return String(localized: "Registration failed: \(message)")
        }
    }
}

struct StatusRow: View {
    let systemImage: String
    let tint: Color
    let text: String

    var body: some View {
        Label {
            Text(text)
                .font(.subheadline)
                .fixedSize(horizontal: false, vertical: true)
        } icon: {
            Image(systemName: systemImage)
                .foregroundStyle(tint)
        }
    }
}

struct LastCallView: View {
    let summary: CallSummary

    var body: some View {
        VStack(spacing: 4) {
            Text(summary.title)
                .font(.subheadline.weight(.semibold))
            HStack(spacing: 6) {
                Text(summary.endedAt, style: .time)
                if let duration = summary.duration {
                    Text(verbatim: "·")
                    Text(Duration.seconds(duration.rounded()).formatted(.time(pattern: .minuteSecond)))
                }
            }
            .font(.footnote)
            .foregroundStyle(.secondary)
            if let reason = summary.hangupReason, !reason.isEmpty {
                Text(reason)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            }
        }
        .frame(maxWidth: .infinity)
        .accessibilityElement(children: .combine)
    }
}
