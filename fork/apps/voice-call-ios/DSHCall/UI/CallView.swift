import SwiftUI

/// The in-app call screen: status, what DSH is doing, the live transcript, and the call controls.
struct CallView: View {
    @ObservedObject var call: ActiveCall
    @EnvironmentObject private var callManager: CallManager

    var body: some View {
        VStack(spacing: 16) {
            header
            TranscriptView(lines: call.transcript)
            if let note = speechNote {
                Label(note, systemImage: "waveform.badge.exclamationmark")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            }
            controls
        }
        .padding()
    }

    // MARK: - Header

    private var header: some View {
        VStack(spacing: 6) {
            Text(call.callerName)
                .font(.largeTitle.bold())
            statusLine
                .font(.headline)
                .foregroundStyle(.secondary)
            if let activity = shownActivity {
                ActivityBadge(activity: activity)
            }
            if let reason = call.reason, call.phase == .ringing || call.phase == .connecting {
                Text(reason)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            }
        }
        .padding(.top, 24)
    }

    @ViewBuilder
    private var statusLine: some View {
        switch call.phase {
        case .ringing:
            Text("Incoming call")
        case .dialing:
            Text("Calling…")
        case .connecting:
            Text("Connecting…")
        case .active:
            if let connectedAt = call.connectedAt {
                Text(connectedAt, style: .timer)
                    .monospacedDigit()
            } else {
                Text("Connected")
            }
        case .ended(let cause):
            Text(cause.localizedDescription)
                .multilineTextAlignment(.center)
        }
    }

    /// With on-device speech output the server reports `listening` while the phone speaks its answer.
    private var shownActivity: AgentActivity? {
        guard call.phase == .active else { return nil }
        return call.isDeviceSpeaking ? .speaking : call.activity
    }

    private var speechNote: String? {
        guard call.phase == .active else { return nil }
        switch call.speechStatus {
        case .server, .listening:
            return nil
        case .unavailable(let message):
            return message
        }
    }

    // MARK: - Controls

    @ViewBuilder
    private var controls: some View {
        switch call.phase {
        case .ringing:
            HStack(spacing: 48) {
                RoundButton(title: String(localized: "Decline"), systemImage: "phone.down.fill", tint: .red) {
                    callManager.endCall()
                }
                RoundButton(title: String(localized: "Answer"), systemImage: "phone.fill", tint: .green) {
                    callManager.answerCall()
                }
            }
        case .ended:
            Button("Close") {
                callManager.dismissEndedCall()
            }
            .buttonStyle(.bordered)
            .controlSize(.large)
        case .dialing, .connecting, .active:
            VStack(spacing: 24) {
                HStack(spacing: 28) {
                    RoundButton(
                        title: call.isMuted ? String(localized: "Unmute") : String(localized: "Mute"),
                        systemImage: call.isMuted ? "mic.slash.fill" : "mic.fill",
                        tint: call.isMuted ? .orange : .gray
                    ) {
                        callManager.setMuted(!call.isMuted)
                    }
                    RoundButton(title: String(localized: "Interrupt"), systemImage: "hand.raised.fill", tint: .blue) {
                        callManager.interrupt()
                    }
                    .disabled(call.phase != .active)
                    VStack(spacing: 6) {
                        AudioRoutePicker()
                            .frame(width: 64, height: 64)
                            .background(Circle().fill(Color.gray.opacity(0.2)))
                        Text("Audio")
                            .font(.caption)
                    }
                    .accessibilityElement(children: .combine)
                    .accessibilityLabel(Text("Audio output"))
                }
                RoundButton(title: String(localized: "End"), systemImage: "phone.down.fill", tint: .red) {
                    callManager.endCall()
                }
            }
        }
    }
}

extension CallMachine.EndCause {
    /// A short sentence for the call screen and the last-call summary.
    var localizedDescription: String {
        switch self {
        case .declined:
            return String(localized: "Declined")
        case .hungUp:
            return String(localized: "Call ended")
        case .remoteHangup:
            return String(localized: "DSH ended the call")
        case .answeredElsewhere:
            return String(localized: "Answered on another device")
        case .declinedElsewhere:
            return String(localized: "Declined on another device")
        case .remoteCancelled:
            return String(localized: "The call ended before it was answered")
        case .unanswered:
            return String(localized: "Missed call")
        case .failed(let message):
            return String(localized: "Call failed: \(message)")
        }
    }
}

/// What DSH is doing, from the control channel's `state` frames.
struct ActivityBadge: View {
    let activity: AgentActivity

    var body: some View {
        Label(title, systemImage: icon)
            .font(.subheadline.weight(.medium))
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .background(.thinMaterial, in: Capsule())
            .accessibilityLabel(Text(title))
    }

    private var title: String {
        switch activity {
        case .listening: return String(localized: "Listening")
        case .thinking: return String(localized: "Thinking")
        case .speaking: return String(localized: "Speaking")
        default: return activity.rawValue
        }
    }

    private var icon: String {
        switch activity {
        case .listening: return "ear"
        case .thinking: return "ellipsis.bubble"
        case .speaking: return "speaker.wave.2.fill"
        default: return "questionmark.circle"
        }
    }
}

/// The live transcript, newest at the bottom.
struct TranscriptView: View {
    let lines: [ActiveCall.TranscriptLine]

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 10) {
                    if lines.isEmpty {
                        Text("The transcript appears here.")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                            .frame(maxWidth: .infinity)
                            .padding(.top, 24)
                    }
                    ForEach(lines) { line in
                        TranscriptBubble(line: line)
                            .id(line.id)
                    }
                }
                .padding(.vertical, 8)
            }
            .onChange(of: lines.last?.id) { _, id in
                guard let id else { return }
                withAnimation { proxy.scrollTo(id, anchor: .bottom) }
            }
        }
        .frame(maxHeight: .infinity)
    }
}

struct TranscriptBubble: View {
    let line: ActiveCall.TranscriptLine

    private var isOwner: Bool { line.role == .owner }

    var body: some View {
        HStack {
            if isOwner { Spacer(minLength: 40) }
            Text(line.text)
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(
                    isOwner ? Color.accentColor.opacity(0.18) : Color.gray.opacity(0.15),
                    in: RoundedRectangle(cornerRadius: 14)
                )
                .textSelection(.enabled)
            if !isOwner { Spacer(minLength: 40) }
        }
        .accessibilityLabel(Text(isOwner ? String(localized: "You: \(line.text)") : String(localized: "DSH: \(line.text)")))
    }
}

/// A round call-control button with a caption.
struct RoundButton: View {
    let title: String
    let systemImage: String
    let tint: Color
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(spacing: 6) {
                Image(systemName: systemImage)
                    .font(.title2)
                    .frame(width: 64, height: 64)
                    .background(Circle().fill(tint.opacity(0.85)))
                    .foregroundStyle(.white)
                Text(title)
                    .font(.caption)
                    .foregroundStyle(.primary)
            }
        }
        .buttonStyle(.plain)
        .accessibilityLabel(Text(title))
    }
}
