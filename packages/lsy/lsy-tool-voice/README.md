---
description: "Model-facing speak tool: the agent turns a text into speech through ctx.lsyVoice and sends the audio to the owner on WeChat as an mp3 file, with the recipient and reply window enforced by the channel."
kind: "package-reference"
---

# @deepseek-ai/dsh-lsy-tool-voice

English | [中文](README.zh.md)

## Summary

Ask your agent on WeChat to read something aloud or tell you the news out loud, and an audio file arrives in the chat that you tap to play. The agent calls `speak` with the text; the voice service makes the audio and the WeChat channel sends it to you, only while your last message keeps the reply window open. WeChat bots cannot send voice bubbles, so the audio is an mp3 attachment. The result tells the agent where the file is and whether it went out.

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

Add the row to the plugin list of the agent preset that should speak, in a process that also mounts [`@deepseek-ai/dsh-lsy-voice`](../lsy-voice/README.md) (and, to deliver, `@deepseek-ai/dsh-lsy-wechat`). The lsy event profile mounts it in its `unattended` preset, which the WeChat chat Session uses. The tool registers once `ctx.lsyVoice` exists.

```yaml
- id: lsy-tool-voice
  name: '@deepseek-ai/dsh-lsy-tool-voice'
```

The plugin has no configuration; providers, voice, limits, and the on/off switch (`tts.enabled`) belong to `lsy-voice`.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The tool calls `ctx.lsyVoice.speak(text)`, then, unless `send` is false, hands the file path to `ctx.lsyNotifier.sendFile` (the WeChat channel's `sendFile`, which checks the path, the size, the open reply window, and keeps the last slot for the text reply). Failures of either step come back as data to the model and as a warning in the log; each call logs its length (never the text), provider, and outcome.

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: the tool definition |

This is a fork-local package; see [`../UPSTREAM.md`](../UPSTREAM.md).

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Voice service](../lsy-voice/README.md) — providers, fallback, files, and settings
- [`wechat_send_file`](../lsy-tool-wechat/README.md) — the same delivery path for any file

-----

<a id="model-experience"></a>
## Model Experience

### Speak tool

#### What the model sees

One tool schema whenever the calling Agent's preset mounts the package and `ctx.lsyVoice` exists: `speak` with the required string `text` and the optional boolean `send` (default true). The description says that the text becomes speech and, by default, goes to the owner on WeChat as an mp3 file because WeChat bots cannot send voice bubbles; to keep the text short and natural to say (a sentence or two, within the configured 200 characters by default, longer speech in several calls because synthesis takes tens of seconds), written the way it is spoken; and that sending works only while the owner's last message is recent.

#### Token effect

A fixed schema cost on every request from an Agent whose preset mounts the package; Agents under other presets pay nothing.

#### KV Cache effect

Prefix-stable while tool definitions and visibility are unchanged; mounting or disposal may invalidate reuse from the first changed schema token.

### Speak results

#### What the model sees

One JSON text block per call: `{ "path", "format": "mp3" | "wav", "bytes", "provider", "sent"? , "notSent"? }` with `sent` set to what went out or `notSent` holding the reason (`reply window expired`, `the owner has not written yet`, `the WeChat channel is not mounted`, and the other reasons `wechat_send_file` reports), or `{ "error": "<reason>" }` such as `speech is turned off (lsy-voice tts.enabled is false)`, `the text is 300 characters; speech takes at most 200, so say it in parts`, or `speech failed (feiyu: …; mac-mini: …)`.

#### Token effect

A few dozen tokens per call, kept in the Session's history until compaction.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV Cache entries.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Owner only, window only** — the audio cannot reach anyone else and cannot wait for the next window the way text does; a file that did not go out stays on disk and its path is in the result.
- **A file, not a bubble** — WeChat's iLink bot API has no voice-message send.
- **Not on Bilibili** — the `bili` preset does not mount it, and Bilibili messages carry text only.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is non-authoritative working context: undecided directions and notes for maintainers. Shipped behavior and accepted rationale live in the sections above, the package code, and the linked Agent Notes.

- A voice bubble would need the iLink `voice_item` with a SILK payload; revisit if the protocol gains a documented upload type for it.

</details>
