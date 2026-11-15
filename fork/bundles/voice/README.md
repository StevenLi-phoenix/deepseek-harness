---
description: "Profile layer for the event service's voice: text to speech for the speak tool and speech to text for audio files, with transcription off by default."
kind: "package-bundle"
---

# @deepseek-ai/voice

English | [中文](README.zh.md)

## Summary

This layer mounts `ctx.voice`: text to speech for the `speak` tool, and speech to text for audio files the owner sends. Transcription is off here (`asr.enabled: false`) and turning it on means restating the whole config in the profile patch. It reads files only and never opens a microphone.

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
| `voice` | `@deepseek-ai/dsh-voice` | `ctx.voice`: TTS for `speak`, ASR for audio files (off) |

### What it needs

The Feiyu key `FEIYU_API_KEY` in `$DSH_HOME/.env`, and the `tool-voice` row inside `preset-unattended` for the `speak` tool.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The rows are the ones this feature had inside `@deepseek-ai/dsh-event-bundle`, moved here verbatim and in the same relative order. The profile applies every layer as one flattened patch list in `dsh.profile.bundles` order, and an `insert` appends, so this layer mounts after the skeleton rows it uses and before the owner's profile patch. `fork/bundles/event/README.md` holds the mount order and the reasoning.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Voice package](../../../packages/fork/voice/README.md)
- [Voice tool package](../../../packages/fork/tool-voice/README.md)

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- One provider, no fallback: without the key every synthesis fails.
- A patch replaces the whole config, so enabling ASR means restating the rest.
