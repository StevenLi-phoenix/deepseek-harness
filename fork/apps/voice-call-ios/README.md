# DSH Call for iOS

English | [中文](README.zh.md)

DSH Call is an iPhone app that gives DSH a phone line. DSH can ring the iPhone like a normal call, and the owner can call DSH from the app, from Siri, or from the Phone app's Recents. The audio runs over WebRTC straight to the Mac that runs DSH, across Tailscale; Apple's push service only carries the ring. The server side is the [`@deepseek-ai/dsh-voice-call`](../../../packages/fork/voice-call/README.md) package.

This page has a setup tutorial first, then reference sections on how a call works, the project, and its limits.

## Requirements

- Xcode 16 or later. The project uses the Swift 5 language mode with complete concurrency checking.
- [XcodeGen](https://github.com/yonaskolb/XcodeGen) 2.45 or later (`brew install xcodegen`). The Xcode project is generated and is not checked in.
- A paid Apple Developer Program membership. VoIP pushes, CallKit, and installing on your own iPhone need it.
- An APNs authentication key (`.p8` file) with its Key ID, and your Team ID. The server signs pushes with it; the app never sees it.
- A physical iPhone with iOS 17 or later. The simulator cannot receive VoIP pushes or run a CallKit call with real audio.
- Tailscale on the iPhone and on the Mac, both in the same tailnet, and the DSH voice-call service running on the Mac.

## Set up

### 1. Pick a bundle identifier and get an APNs key

Choose a bundle identifier that belongs to your team, for example `com.yourcompany.dshcall`. You do not need to register it by hand: with automatic signing, Xcode registers the App ID and turns on Push Notifications (from `DSHCall/Resources/DSHCall.entitlements`) the first time you build for your iPhone.

In your developer account, open Certificates, Identifiers & Profiles, then Keys, and create a key with Apple Push Notifications service (APNs) enabled. Download the `.p8` file (Apple lets you download it only once) and note the 10-character Key ID. Your Team ID is on the Membership details page. One key serves every app of the team and both the sandbox and production push environments.

### 2. Configure the server

Follow the server's [minimal configuration](../../../packages/fork/voice-call/README.md#use-this-package). The app depends on these parts of it:

- `VOICE_CALL_TOKEN` holds a long random token. You enter the same value in the app.
- `VOICE_CALL_APNS_KEY_ID`, `VOICE_CALL_APNS_TEAM_ID`, and `VOICE_CALL_APNS_KEY` hold the key from step 1.
- `apns.bundleId` is your bundle identifier. The server sends pushes to the topic `<bundle identifier>.voip`, so a mismatch means the phone never rings.
- `ice.bindAddress` is the Mac's Tailscale address (`tailscale ip -4`), so the server offers only candidates the phone can reach.
- The DSH Web server must be reachable from the phone over HTTPS. Tailscale Serve gives it an address such as `https://mac-mini.your-tailnet.ts.net` with a valid certificate. The app refuses plain HTTP.

### 3. Set your signing values

```sh
cd fork/apps/voice-call-ios
cp Config/Local.example.xcconfig Config/Local.xcconfig
```

Edit `Config/Local.xcconfig` and set `PRODUCT_BUNDLE_IDENTIFIER` and `DEVELOPMENT_TEAM`. Git ignores this file. `Config/Base.xcconfig` holds the placeholders `com.example.dshcall` and an empty team, which build only for the simulator.

### 4. Generate the project and run it

```sh
xcodegen generate
open DSHCall.xcodeproj
```

Xcode resolves the WebRTC package (a 46 MB binary download the first time). Select your iPhone as the run destination and press Run. Run uses the Debug configuration, whose push tokens belong to the APNs sandbox; the app tells the server so when it registers. Allow microphone access when asked.

### 5. Connect the app to the server

1. Tap Settings (the gear button) and enter the server address from step 2 and the token, then tap Save. The token is stored in the Keychain on the iPhone.
2. Under Connection, tap Check connection. It shows whether voice calls are on and where speech is recognized and synthesized.
3. Under Calls from DSH, the status should read "DSH can call this iPhone". The app sends its VoIP push token to the server on its own whenever the address, token, or push token changes; tap Register to send it again.
4. If the server recognizes speech on the device (`speech.stt: device`, the default), allow speech recognition when asked, and pick the recognition language under On-device speech.

### 6. Call DSH

Tap Call DSH. The system call screen opens with the callee DSH; once the audio connects, the timer starts and DSH greets you. Talk normally. The app's call screen shows what DSH is doing (listening, thinking, speaking) and the transcript. Tap Interrupt to make DSH stop talking, or just start talking. End the call with End or from the system call screen.

The same call starts from Siri with one of the app's phrases, such as "Call DSH with DSH Call" ("用 DSH Call 打给 DSH" in Chinese), from the Call DSH action in the Shortcuts app, and from a DSH Call entry in the Phone app's Recents. The app also declares DSH as an alternative app name, so the shorter "Call DSH" ("打给 DSH") can match too.

### 7. Let DSH call you

Ask an agent that has the [`call_owner`](../../../packages/fork/tool-voice-call/README.md) tool to call you. The iPhone rings with the CallKit incoming-call screen, also when it is locked or the app is not running, and the caller name shows why DSH is calling. Answer to talk, or decline. If you do not answer, the server marks the call missed after its ring timeout (45 seconds by default) and the phone stops ringing.

## How a call works

This section is reference.

### Incoming calls

The server sends a VoIP push `{"aps":{},"dsh":{"v":1,"callId":…,"reason":…,"caller":…,"createdAt":…}}`. The app reports a CallKit incoming call before the push handler returns, as iOS requires for every VoIP push, using the call ID as the CallKit call UUID; a repeated push for the same call is harmless. The caller name is `caller: reason`, cut to 60 characters. A push that cannot be read is still reported and ended at once. A push that arrives during another call is reported, ended, and declined on the server.

While it rings, the app asks the server for the call every 2 seconds, so a call that was answered or declined on another device, cancelled by DSH, or missed stops ringing here too. The app gives up after 60 seconds. Declining sends `POST /calls/{id}/decline`.

### Outgoing calls

The app creates the call with `POST /calls`, then asks CallKit to start it with the same UUID, and reports to CallKit when it starts connecting and when media connects. A start from Siri or Recents goes through the same path. Ending the call sends a `hangup` frame on the control channel and `POST /calls/{id}/hangup`.

### Media

Answering or starting creates one peer connection: no ICE servers, Unified Plan, gather once, max-bundle, RTCP mux required, one send-and-receive microphone track, and an ordered data channel named `control`, created before the offer. ICE is not trickled: the app waits until candidate gathering completes or 3 seconds pass, then posts the complete offer to `POST /calls/{id}/connect` and applies the answer it returns. The SDP is never modified; the server's answer selects PCMU.

A call ends as failed when media has not connected 15 seconds after the answer or start, when ICE fails, or when ICE stays disconnected for more than 5 seconds. A `409` from connect means the call was picked up on another device (when the server reports it connecting or active) or cannot be connected; a `410` means it has ended.

Audio is under CallKit's control. WebRTC's audio session runs in manual mode with `.playAndRecord` and `.voiceChat`; audio starts only when CallKit activates the session and stops when it deactivates it. Mute goes through CallKit, so the system call screen and the app agree. Hold, grouping, and DTMF are not supported.

### The control channel

Every frame is a JSON text message with `"v":1` and a `type`.

| From | Type | What the app does or means |
|---|---|---|
| Server | `state` | Shows `listening`, `thinking`, or `speaking` |
| Server | `transcript` | Adds an owner or agent line to the transcript |
| Server | `say` | Speaks the text on the phone (`speech.tts: device`) |
| Server | `stop-speaking` | Stops the phone's speech at once |
| Server | `hangup` | Speaks the reason, if any, then ends the call |
| App | `speaking` | The owner started talking (on-device recognition only) |
| App | `utterance` | What the owner said, sent after 0.8 seconds without new words (on-device recognition only) |
| App | `interrupt` | The Interrupt button was tapped |
| App | `hangup` | The owner ended the call |

Unknown types and frames with another version are ignored, so a newer server can add frames.

### Speech on the device

The server's health answer says where speech is recognized (`stt`) and synthesized (`tts`). With `stt: device`, the app runs Apple's speech recognizer on the microphone, on the device when the language supports it. With `tts: device`, it speaks `say` frames with the system voice, Chinese or English depending on the text.

The phone's own speech does not pass through WebRTC's echo canceller, so two things keep DSH from hearing itself. While the phone speaks, the microphone track sends silence; and recognized words that mostly match what the phone just said are treated as echo and not sent. With on-device recognition, speaking over DSH still interrupts it, because the recognizer keeps listening to the microphone and sends `speaking`.

### Privacy and logs

The token is kept in the Keychain (this device only, readable after the first unlock so a locked phone can answer) and is never logged or shown again. Logs use the unified logging system with the bundle identifier as subsystem and the categories `app`, `push`, `call`, `media`, `api`, and `speech`; they hold states, endpoint names, status codes, and sizes, never the token, SDP bodies, or what was said. To read them, connect the iPhone to a Mac and filter Console by the subsystem. The app has no analytics and no dependency besides WebRTC.

## Project reference

| Path | Contents |
|---|---|
| `project.yml` | XcodeGen spec: the `DSHCall` app target, the `DSHCallTests` unit tests, and the WebRTC package |
| `Config/` | `Base.xcconfig` (placeholders, includes `Local.xcconfig`) and `Local.example.xcconfig` |
| `DSHCall/App/` | App entry, composition (`AppModel`), device registration, logging |
| `DSHCall/Push/` | PushKit registration and VoIP push handling |
| `DSHCall/Call/` | CallKit (`CallManager`), the per-call state machine (`CallMachine`), and media and control for one call (`CallSession`) |
| `DSHCall/Media/` | WebRTC client, audio session, on-device speech |
| `DSHCall/Network/` | API client and the protocol version 1 wire types |
| `DSHCall/Settings/` | Settings and the Keychain |
| `DSHCall/Intents/` | The Call DSH App Intent and its Siri phrases |
| `DSHCall/UI/` | SwiftUI screens |
| `DSHCallTests/` | XCTest unit tests; the API tests use a `URLProtocol` stub |

WebRTC comes from [stasel/WebRTC](https://github.com/stasel/WebRTC), pinned to exactly `158.0.0` (WebRTC M158).

The unit tests cover the API client, wire types, push parsing, the call state machine, the speech helpers, and settings. Run them on a simulator:

```sh
xcodebuild test -project DSHCall.xcodeproj -scheme DSHCall -destination 'platform=iOS Simulator,name=iPhone 16'
```

Replace `iPhone 16` with any iPhone simulator installed with your Xcode.

## Release builds and TestFlight

`DSHCall.entitlements` sets `aps-environment` to `development`. When you archive and distribute through App Store Connect, the distribution provisioning profile sets it to `production`, and Release builds register their tokens as `production`, so TestFlight builds receive pushes from the production APNs host without changes. A Release build installed straight from Xcode with a development profile would register a sandbox token as `production`; use Debug for builds you run from Xcode.

Raise `MARKETING_VERSION` and `CURRENT_PROJECT_VERSION` in `project.yml` before each upload. App Store Connect asks about encryption on upload: WebRTC encrypts call media with DTLS-SRTP, so answer according to your export compliance situation, or add `ITSAppUsesNonExemptEncryption` to `Info.plist` once you know the answer.

## Known limitations

- On-device recognition reads the microphone through a second audio input next to WebRTC's. If iOS refuses it, or the audio route changes in a way the recognizer cannot follow, the call screen says that speech recognition is unavailable; the call itself continues, and the Interrupt button still works.
- When the server recognizes speech (`stt: server`) and the phone speaks (`tts: device`), the microphone is silent while the phone speaks, so talking over DSH does not interrupt it; use the Interrupt button.
- When the server speaks over the audio track but on-device recognition is on, recognized words are withheld while DSH speaks and its words are not known yet, so an interruption can take a moment to register.
- A recognition language without an on-device model sends audio to Apple's speech service.
- iOS 16 and later report a generic device name such as "iPhone" without a special entitlement, so every device registers under that name.
- One call at a time; a VoIP push during a call is declined.
- The phone must reach the Mac directly over Tailscale; there is no STUN or TURN.
- Not verified on a device: the code was written and reviewed without a Mac, so it has not been compiled, and the first build on a Mac with Xcode is its first compile and device test.
