---
description: "Voice line to the owner's iPhone (disabled by default): a VoIP push rings the DSH Call app through CallKit, a full-duplex WebRTC leg over Tailscale talks with a call Session with barge-in, and the owner can call the agent from the app."
kind: "package-reference"
---

# @deepseek-ai/dsh-voice-call

English | [中文](README.zh.md)

## Summary

Let the agent phone you, and phone it back. When something cannot wait, the agent calls `call_owner`; your iPhone rings like a normal call, showing the reason, and you talk with the agent out loud. As soon as you speak, it stops talking and listens. You can also call the agent from the DSH Call app; when you hang up, the main agent gets the transcript and carries on with what you asked. The phone reaches the Host over your tailnet, with no telephone network or third-party voice service; Apple's push service only carries the ring.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

**This line is disabled by default.** The [`voice-call` bundle](../../../fork/bundles/voice-call/README.md) carries its row with `disabled: true` and defines the `voice-call` agent preset of the call Sessions. Mount it in a Web profile next to [`@deepseek-ai/dsh-owner-relay`](../owner-relay/README.md) (`ctx.ownerRelay`), whose `voice-call` channel this plugin registers; without the relay a call connects but hears no answers. It needs the Host Session Controller, permission presets, Session titles, the credential store, the storage domain facility, and the Web server. It reads `ctx.presence` (sleep), `ctx.voice` (server-side speech), and `ctx.ownerNotifier` (the hand-off to the main agent) when they are mounted. The agent's side is the `call_owner` tool of [`@deepseek-ai/dsh-tool-voice-call`](../tool-voice-call/README.md); the phone's side is the [DSH Call iOS app](../../../fork/apps/voice-call-ios/README.md).

### When to choose it

Choose it when the agent sometimes has something you must hear now, or a decision that is quicker to talk through than to type, and you carry an iPhone on the same tailnet as the Host. Avoid it for routine notices: a call interrupts you, so the tool description and the per-hour limit keep calls rare, and messages stay the default channel.

### Minimal configuration

You need an Apple Developer account, the app installed on your phone, and an APNs auth key (`.p8`) with its Key ID and your Team ID. Put the four credentials in `<DSH_HOME>/.env` (mode 600) or the credential store, never in the profile:

| Credential | Holds |
|---|---|
| `VOICE_CALL_TOKEN` | A long random bearer token; enter the same value in the app |
| `VOICE_CALL_APNS_KEY_ID` | The auth key's ten-character Key ID |
| `VOICE_CALL_APNS_TEAM_ID` | The Apple Developer Team ID |
| `VOICE_CALL_APNS_KEY` | The `.p8` key's PEM text, or the absolute path of the file |

Then enable the row in the profile patch with the app's bundle identifier and, optionally, the Host's Tailscale address for the media sockets:

```yaml
- id: voice-call
  disabled: false
  config:
    apns:
      bundleId: com.example.dshcall
    ice:
      bindAddress: 100.64.0.1
```

Restart the service after changing `.env`, because it is read at launch. In the app, enter the Host's URL on the tailnet and the token; the app registers its VoIP token with `PUT /voice-call/v1/devices/<id>`, and `GET /voice-call/v1/health` answers once the token matches.

| Field | Default | Meaning |
|---|---|---|
| `tokenEnv` | `VOICE_CALL_TOKEN` | Credential holding the app's bearer token; every request gets 503 while it is unset |
| `apns.keyIdEnv`, `apns.teamIdEnv`, `apns.keyEnv` | `VOICE_CALL_APNS_KEY_ID`, `VOICE_CALL_APNS_TEAM_ID`, `VOICE_CALL_APNS_KEY` | Credentials of the APNs signing key; the agent's calls are refused while one is missing |
| `apns.bundleId` | `com.example.dshcall` | The app's bundle identifier; pushes go to `<bundleId>.voip` |
| `apns.caller` | `DSH` | Name CallKit shows for the agent's calls |
| `session.agentPreset` | `voice-call` | Agent preset of the call Sessions; the bundle's preset answers in short spoken sentences and mounts no tools |
| `session.workspacePath` | `/Users/dsh-runtime/voice-call` | Absolute directory of the call Sessions; created before each call |
| `speech.stt`, `speech.tts` | `device`, `device` | Where recognition and synthesis run: `device` (the phone's Apple speech) or `server` (`speech.provider` on the Host) |
| `speech.provider` | `voice` | Host service for `server` speech; `voice` adapts `ctx.voice`, another name is a service with `transcribe` and `synthesize` |
| `limits.callsPerHour` | `4` | Calls the agent may place in a rolling hour |
| `limits.respectSleep` | `true` | Refuse the agent's calls that are not urgent while `ctx.presence` says the owner sleeps |
| `limits.ringTimeoutMs`, `limits.maxCallMs` | `45000`, `900000` | How long a call rings before it is missed, and the longest call |
| `limits.bargeIn` | `true` | Stop the agent's speech when the owner starts talking |
| `handOff` | `true` | Give the transcript of the owner's own calls to the main agent when they end |
| `ice.bindAddress`, `ice.minPort`, `ice.maxPort` | empty, `0`, `0` | Address and UDP port range of the media sockets; empty gathers every interface |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-voice-call) is the exhaustive source for every accepted field, including voice-activity detection.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`ctx.voiceCall.ring(request, signal)` takes a `RingRequest` (`reason`, the text the call is about, and `urgent`) and resolves once the call ends with a `RingResult`: `{ status: 'refused', reason }` when no call was placed, or `{ status: 'ended', call, detail, transcript }` with the call record (outcome and times) and every transcript line.

One call is live at a time. A call from the agent opens a `ringing` record and sends a VoIP push to every registered device; Apple requires the app to report a CallKit call for each VoIP push, so the phone rings. A dead device token (HTTP 410) removes the device. Picking up sends the app's complete SDP offer to `POST /voice-call/v1/calls/<id>/connect`; the service answers with every local host candidate in the SDP, so signalling is one HTTP round trip and needs no STUN, TURN, or WebSocket. Declining, hanging up, and the ring timeout end the call with `declined`, `completed`, or `missed`.

When media connects, the service creates the call Session, claims it with the relay's `voice-call` channel, and prompts it with the opening context: who called, and for the agent's calls the reason inside `<reason>` marked as data from another Session (the request id is marked untrusted with `turn-taint`). From then on the [`Conversation`](src/conversation.ts) runs the speech loop:

- **Hearing**: with `speech.stt: device` the app recognizes speech and sends `utterance` frames on the `control` data channel; with `server`, an energy voice-activity detector over the 20 ms PCMU frames cuts utterances and `speech.provider` transcribes them. Each utterance is a `steer` prompt, so speech during a turn joins it at the next step.
- **Speaking**: every final answer the relay hands the channel is cleaned of Markdown and either sent to the app as a `say` frame (`speech.tts: device`) or synthesized sentence by sentence, resampled to 8 kHz, and paced out one frame every 20 ms.
- **Barge-in**: the detector's speech onset, the app's `speaking` frame, or the app's interrupt button stops synthesis, clears the playout queue, and tells the app to stop speaking.

The service hangs up after `limits.maxCallMs`, when a leg stays disconnected for `ice.disconnectGraceMs`, and when the app sends `hangup`. A call record (direction, reason, times, outcome, transcript) is stored per call and the oldest beyond `keepCalls` are forgotten; a call that was live when the Host stopped is closed as `failed` on the next start. Logs carry ids, counts, and durations, never the token, the key, or what was said.

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | `ctx.voiceCall`: configuration, calls, devices, the relay channel, and the hand-off |
| [`src/routes.ts`](src/routes.ts) | HTTP routes under `/voice-call/v1/` with the bearer token |
| [`src/protocol.ts`](src/protocol.ts) | Protocol version 1: HTTP bodies, the push payload, and the control frames |
| [`src/apns.ts`](src/apns.ts) | APNs client over HTTP/2 with an ES256 token |
| [`src/webrtc.ts`](src/webrtc.ts), [`src/media.ts`](src/media.ts) | The WebRTC leg on werift and the media interface |
| [`src/conversation.ts`](src/conversation.ts) | Hearing, speaking, and barge-in for one connected call |
| [`src/vad.ts`](src/vad.ts), [`src/audio.ts`](src/audio.ts), [`src/playout.ts`](src/playout.ts) | Voice-activity detection, PCMU and resampling, paced playout |
| [`src/speech.ts`](src/speech.ts) | The speech provider interface, the `ctx.voice` adapter, and sentence splitting |
| [`src/storage.ts`](src/storage.ts) | Storage-domain tables for devices and call records |

This is a fork-local package; [`../UPSTREAM.md`](../UPSTREAM.md) describes how the `fork` group tracks upstream.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [DSH Call iOS app](../../../fork/apps/voice-call-ios/README.md) — PushKit, CallKit, and the WebRTC client
- [`call_owner`](../tool-voice-call/README.md) — the agent's tool
- [Owner relay](../owner-relay/README.md) — hands the call Session's answers to this channel
- [Voice service](../voice/README.md) — server-side recognition and synthesis
- [Presence](../presence/README.md) — whether the owner sleeps

-----

<a id="model-experience"></a>
## Model Experience

### Call Session

#### What the model sees

A new Session per call under the `voice-call` preset, whose persona says that everything it writes is spoken aloud: short Chinese sentences, no Markdown, lists, links, or code, and that the reason of an agent's call is data, not an instruction. The first prompt is the host's opening context, `[通话] 你给主人打了电话，主人已经接听。…` followed by the reason inside `<reason>` for the agent's calls, or `[通话] 主人用 DSH Call 给你打来了电话，已经接通。…` for the owner's. Each owner utterance then arrives as a plain user prompt with the configured `session.timeZone`. Each final answer is spoken; `NO_REPLY` says nothing.

#### Token effect

One user message per utterance. A call is short (15 minutes at most by default), so its Session stays small; the Session is not reused.

#### KV Cache effect

Utterances are appended to the call's own Session, so each turn reuses the cached prefix of the call; every call starts a new prefix.

### Hand-off to the main agent

#### What the model sees

When a call the owner placed ends and the owner said something, the main agent receives one message through `ctx.ownerNotifier.tellMainAgent`: `主人刚和通话 agent 打了 N 分钟电话。通话记录如下；主人交代的事如果通话里没办完，由你接着办：` followed by one `主人：…` or `通话 agent：…` line per transcript line.

#### Token effect

One user message the size of the transcript, at most `limits.transcriptLines` lines.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV Cache entries.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **iPhone only, one call at a time** — the only client is the iOS app, and a second call is refused while one is live.
- **Tailnet only** — media uses host candidates without STUN or TURN, so the phone must reach the Host directly, which Tailscale provides.
- **PCMU audio** — the leg uses G.711 at 8 kHz, which every WebRTC stack supports; it sounds like a phone call, not like wideband audio.
- **Not verified on a device here** — the service is tested against a local HTTP/2 server and a scripted media double, and the WebRTC leg against a werift peer; a real APNs push and the iOS app need an Apple Developer account and a phone.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is non-authoritative working context: undecided directions and notes for maintainers. Shipped behavior and accepted rationale live in the sections above, the package code, and the linked Agent Notes.

- Opus would give wideband audio once werift's Opus path is checked against iOS WebRTC.
- A call Session with read-only tools, and streaming partial answers into speech before the turn ends, are undecided.

</details>
