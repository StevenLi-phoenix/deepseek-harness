---
description: "Profile layer for the event service's voice line: ctx.voiceCall, which rings the owner's iPhone, and the voice-call preset of its call Sessions."
kind: "package-bundle"
---

# @deepseek-ai/voice-call

English | [中文](README.zh.md)

## Summary

This layer mounts the voice line, disabled by default. When enabled the agent can phone the owner with `call_owner`, and the owner can call the agent from the DSH Call app; each picked-up call is a WebRTC leg over Tailscale and a call Session with the `voice-call` preset, whose answers the relay's `voice-call` channel speaks over the line.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

### Install into the event profile

The layer ships with this repository: `fork/deploy/setup-profile.sh` links every directory under `fork/bundles/` into `$DSH_HOME/profiles/event/node_modules/@deepseek-ai/` and writes the profile manifest, so a deploy mounts it without a per-deployment edit. To add it by hand, link it and name it at the end of `dsh.profile.bundles`.

### What you get

| Row | Package | What it mounts |
|---|---|---|
| `voice-call` | `@deepseek-ai/dsh-voice-call` | the voice line, disabled until the owner enables it |
| `preset-voice-call` | `@deepseek-ai/dsh-agent-preset` | the `voice-call` preset: a spoken persona, time, and compaction |

The `unattended` preset of the event bundle mounts `call_owner` (`@deepseek-ai/dsh-tool-voice-call`); the tool appears only while the voice line runs.

### What it needs

`owner-relay` for the `voice-call` channel; `VOICE_CALL_TOKEN` and the APNs key (`VOICE_CALL_APNS_KEY_ID`, `VOICE_CALL_APNS_TEAM_ID`, `VOICE_CALL_APNS_KEY`) in `$DSH_HOME/.env`; the app's bundle identifier in the profile patch; and the DSH Call app installed on the owner's iPhone.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The profile applies every layer as one flattened patch list in `dsh.profile.bundles` order, and an `insert` appends, so this layer mounts after the skeleton rows it uses (`owner-relay`, `voice`, `presence`) and before the owner's profile patch. `fork/bundles/event/README.md` holds the mount order and the reasoning.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Voice-call package](../../../packages/fork/voice-call/README.md)
- [call_owner tool](../../../packages/fork/tool-voice-call/README.md)
- [DSH Call iOS app](../../apps/voice-call-ios/README.md)

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- `disabled: true` here: a deployment enables it and sets the app's bundle identifier in the profile patch.
- The call Session has no tools; what the owner asks for during a call reaches the main agent after it ends.
