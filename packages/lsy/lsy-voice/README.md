---
description: "Voice for the owner's agents (ctx.lsyVoice): text to speech through feiyu on the laptop with the Mac mini TTS service as fallback, and speech to text through the asr-service for audio files the owner sends, off by default and file-only."
kind: "package-reference"
---

# @deepseek-ai/dsh-lsy-voice

English | [中文](README.zh.md)

## Summary

Your agent can talk, and can understand a voice note. `ctx.lsyVoice.speak(text)` turns text into an audio file with your own services: feiyu on the laptop first, the Mac mini's TTS service when feiyu is down. `ctx.lsyVoice.transcribe(path)` turns an audio file into text through the mini's asr-service. Transcription is off until you switch it on, and it only reads files that were handed to it: nothing here opens a microphone or listens. Every service answer is saved to disk before it is parsed, every call has a deadline and retries, and every failure is logged with its reason.

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

Mount the service at the root of the profile. It needs the Host's `credentials` service for the feiyu key and nothing else. The lsy event bundle mounts it with transcription off.

```yaml
- id: lsy-voice
  name: '@deepseek-ai/dsh-lsy-voice'
```

The feiyu key goes into `$DSH_HOME/.env` as `LSY_FEIYU_API_KEY` (restart after changing `.env`); the name is the `tts.feiyu.apiKeyEnv` setting. Every field has a default, so a patch entry restates only what it changes.

| Setting | Default | Meaning |
|---|---|---|
| `dataDir` | `<DSH_HOME>/lsy-voice` | Audio under `audio/`, raw ASR answers under `asr/` (directories 0700, files 0600) |
| `keepDays` | `14` | Files older than this are removed on the next call |
| `tts.enabled` | `true` | Turns `speak` off |
| `tts.provider` / `tts.fallback` | `feiyu` / `mac-mini` | First provider and the one tried after it fails (`none` stops after one) |
| `tts.format` | `mp3` | `mp3` converts with ffmpeg (`tts.ffmpegPath`, default `/opt/homebrew/bin/ffmpeg`) and delivers the WAV when that fails |
| `tts.maxChars` | `600` | Longest text; longer text is refused so the agent splits it |
| `tts.retries` / `tts.retryDelayMs` | `2` / `1000` | Extra attempts of one HTTP call; 429, 5xx, timeouts, and network errors retry, other 4xx fail at once |
| `tts.feiyu.*` | laptop `http://100.117.175.117:19880`, voice `feiyu`, style `cute` | `timeoutMs` 30 s per call, `jobTimeoutMs` 180 s per job (the first request after idle loads the model, about 45 s), `pollMs` 2 s |
| `tts.macMini.*` | `http://stevens-mac-mini.tailc2559b.ts.net:8098`, speaker `vivian`, `Chinese` | `timeoutMs` 120 s (a cold model load is slow) |
| `asr.enabled` | `false` | The switch for speech to text |
| `asr.baseUrl` / `asr.engine` / `asr.language` | `http://127.0.0.1:8099` / `funasr` / unset | `funasr` is Chinese; `whisper` is English and multilingual (`language` is its hint) |
| `asr.timeoutMs` / `asr.retries` / `asr.maxBytes` | 120 s / `2` / 25 MiB | Per call, extra attempts, largest file |

### Turn speech to text on

Add this to the profile patch (`$DSH_HOME/profiles/event/cordis.patch.yml`); it reloads live:

```yaml
- id: lsy-voice
  config:
    asr:
      enabled: true
```

From then on, an audio file (`.m4a`, `.mp3`, `.wav`, `.flac`, `.ogg`, `.wma`, `.aac`, `.webm`) the owner sends on WeChat is transcribed and the text joins that message's attachment note. Set `asr.engine: whisper` for English.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`speak` runs one call at a time: the feiyu GPU takes one job, and a burst should not pile up retries. A call tries `tts.provider`, then `tts.fallback`; each provider writes its raw answer before anything else happens: `<name>.job.json` (feiyu's final job record) and `<name>.wav` in `audio/`, named by time, a hash of the text, and the provider. The deliverable is that WAV or its MP3 conversion (written as `.mp3.part` and renamed). `transcribe` reads the file, posts it to `/transcribe`, and writes the raw JSON to `asr/<time>-<hash of the audio>.json` before reading `full_text`. Logs carry lengths, providers, timings, and paths, never the spoken text or the key.

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | `ctx.lsyVoice`, configuration, raw-answer files, mp3 conversion, fallback order, pruning |
| [`src/tts.ts`](src/tts.ts) | The feiyu provider (submit a job, poll, fetch the audio) and the Mac mini provider (one multipart POST) |
| [`src/asr.ts`](src/asr.ts) | The asr-service client and its format list |
| [`src/http.ts`](src/http.ts) | Deadline and retry wrapper shared by the clients |

This is a fork-local package; see [`../UPSTREAM.md`](../UPSTREAM.md).

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [`speak` tool](../lsy-tool-voice/README.md) — how the agent asks for speech
- [WeChat channel](../lsy-wechat/README.md) — where audio files arrive and speech goes out

-----

<a id="model-experience"></a>
## Model Experience

### Transcript of an audio file

#### What the model sees

Nothing changes while `asr.enabled` is false. When it is true, an audio file the owner sends on WeChat reaches the chat Session with the usual attachment note and one more clause on the file's line: `speech-to-text (<engine>) of what the owner said in it: 「<text>」`, or `speech-to-text failed (<reason>)` when the service could not read it. The text is what the owner said, so the agent treats it like the owner's own message.

#### Token effect

One short clause per audio file: the transcript itself, kept in the Session's history until compaction.

#### KV Cache effect

Append-only: the clause is part of the owner's message and follows the reusable request prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Files only** — WeChat's own voice messages arrive with WeChat's transcript and no audio, so only audio files sent as attachments reach the asr-service. There is no microphone path.
- **No voice bubbles** — iLink bots cannot send voice messages, so speech goes out as an mp3 file attachment.
- **Feiyu is a laptop GPU** — the first request after idle takes about 45 s, each later one 6–8 s, and the laptop must be awake; the fallback then answers, with its own cold start.
- **Bilibili** — the Bilibili account's messages carry text only and its preset has no `speak` tool.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is non-authoritative working context: undecided directions and notes for maintainers. Shipped behavior and accepted rationale live in the sections above, the package code, and the linked Agent Notes.

- 2026-10-30: on the first day the Mac mini TTS service sat in `loading` for over six minutes under memory pressure, which is why feiyu is the default.
- WeChat's `voice_item` carries a transcript and, per the iLink protocol, a SILK media reference; decoding SILK needs a decoder that is not installed on the host.

</details>
