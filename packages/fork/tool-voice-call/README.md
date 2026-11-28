---
description: "Model-facing call_owner tool: the agent phones the owner through ctx.voiceCall, a separate call Session talks with them, and the tool returns the outcome, duration, and transcript once the call ends."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-voice-call

English | [中文](README.zh.md)

## Summary

Let the agent phone you when a message is not enough. The agent calls `call_owner` with everything the call has to cover; your iPhone rings through the DSH Call app, and a separate call agent talks with you out loud. When you hang up, the tool returns how the call went and what was said, so the agent that called can act on your answer. A declined, missed, or refused call (too many this hour, or you are asleep and it is not urgent) comes back as such, and the agent decides whether to send a message instead.

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

Add the row to the plugin list of the agent preset that may call, in a process that also mounts [`@deepseek-ai/dsh-voice-call`](../voice-call/README.md). The fork event profile mounts it in its `unattended` preset; the tool registers once `ctx.voiceCall` exists, so it stays absent while the voice-call row is disabled.

```yaml
- id: tool-voice-call
  name: '@deepseek-ai/dsh-tool-voice-call'
```

| Field | Default | Meaning |
|---|---|---|
| `maxTranscriptLines` | `60` | Transcript lines returned to the agent, newest kept; the rest are counted in `omittedLines` |

Limits, sleep, and the line itself belong to `voice-call`.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The tool calls `ctx.voiceCall.ring({ reason, urgent }, signal)` and waits; the tool call's abort signal cancels a ringing call or hangs up a live one. `callOutput` turns the result into the tool output: a refusal, or the outcome, the detail, the talk time in seconds (0 when the call was never answered), and the newest transcript lines. Each call logs its outcome, duration, and line count, never what was said.

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: the tool definition and `callOutput` |

This is a fork-local package; see [`../UPSTREAM.md`](../UPSTREAM.md).

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Voice call line](../voice-call/README.md) — the push, the call Session, speech, and limits
- [`speak`](../tool-voice/README.md) — an audio file on WeChat instead of a call

-----

<a id="model-experience"></a>
## Model Experience

### Call tool

#### What the model sees

One tool schema whenever the calling Agent's preset mounts the package and `ctx.voiceCall` exists: `call_owner` with the required string `reason` and the optional boolean `urgent` (default false). The description says that the owner's iPhone rings like a normal call and a separate call agent talks with them; to call only when a voice conversation is clearly better than a message, because a call interrupts the owner; that the call agent knows nothing but `reason`, so it must carry the facts, what is needed, and the options, in the language of the call; and that calls are limited per hour, only `urgent` calls ring while the owner sleeps, and a refused, missed, or declined call is not an answer.

#### Token effect

A fixed schema cost on every request from an Agent whose preset mounts the package; Agents under other presets pay nothing.

#### KV Cache effect

Prefix-stable while tool definitions and visibility are unchanged; mounting or disposal may invalidate reuse from the first changed schema token.

### Call results

#### What the model sees

One JSON text block per call once it ends: `{ "outcome": "completed" | "declined" | "missed" | "failed" | "cancelled", "detail"?, "durationS", "transcript": [{ "role": "owner" | "agent", "text" }], "omittedLines"? }`, or `{ "refused": "<reason>" }` such as `another call is in progress`, `no phone is registered; …`, `already 4 calls in the last hour (limit 4)`, or `the owner is asleep; call again with urgent only if it cannot wait`. The transcript is the owner's words and the call agent's answers.

#### Token effect

A few dozen tokens for a refusal or a missed call, up to the size of `maxTranscriptLines` lines for a long call, kept in the Session's history until compaction.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV Cache entries.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Blocking** — the tool waits for the whole call (15 minutes at most by default), and the calling turn waits with it.
- **No live steering** — the calling agent cannot speak into the call; the call agent works from `reason` alone.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is non-authoritative working context: undecided directions and notes for maintainers. Shipped behavior and accepted rationale live in the sections above, the package code, and the linked Agent Notes.

- Returning as soon as the call is answered, with the transcript delivered later as a Session input, is undecided.

</details>
