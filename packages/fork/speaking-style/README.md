---
description: "DSH's own speaking style: a persona card the agent writes for itself, traits and memes it notes while reading QQ groups, Bilibili comments, and the web (examples checked verbatim), memes a code-side miner finds and explains through a search, and real tone samples, shared as one style block with the unattended, up, bili, and qqbot presets; every public write goes through the content guard."
kind: "package-reference"
---

# @deepseek-ai/dsh-speaking-style

English | [中文](README.zh.md)

## Summary

Let DSH grow a voice of its own instead of sounding like a cold chatbot. DSH notes the memes and the character of the talk it reads in QQ groups, Bilibili comments, and the web, and writes its own persona card. A miner finds the memes of the moment and explains each through a search. Every channel gets the same style block, led by the card; every public write passes the content guard. The owner sees, edits, rolls back, and deletes everything in Settings → 说话风格.

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

Mount it once at the root (`mode: collect`: the stores, tone collection, and `ctx.speakingStyle`, which [speaking-style-settings](../speaking-style-settings/README.md) shows) and once in each preset (`mode: prompt`) with the tools that preset gets. The fork event bundle mounts:

| Preset | Block | Tools |
|---|---|---|
| `unattended` (WeChat main agent) | yes | `meme_lookup`, `style_note`, `persona_update` |
| `up` (Bilibili replies) | yes | `meme_lookup`, `style_note`, `persona_update` |
| `bili`, `qqbot` | yes | `meme_lookup` |
| `qq-digest` (reads the QQ groups) | no, so digests do not learn from their own notes | `style_note`, `persona_update` |

```yaml
- id: speaking-style
  name: '@deepseek-ai/dsh-speaking-style'
# inside a preset:
- id: speaking-style-prompt
  name: '@deepseek-ai/dsh-speaking-style'
  config:
    mode: prompt
    tools: [meme_lookup, style_note, persona_update]
```

Every write of text other people can read (the card, a note, a mined meme) goes through the content guard, `await ctx.get('contentGuard')?.check(text, { purpose, audience: 'public', sessionId })` (purposes `persona`, `style_note`, `meme_miner`; the `content-guard` package provides it). The guard is looked up per call. A refusal reaches the writer as `guard: <the guard's public reason>`, never the matched text; with no guard mounted, or a guard that throws, the write is refused as `guard_unavailable` (fail closed) and the log warns once. The owner's own edits on the Settings page are not checked.

| Field | Default | Meaning |
|---|---|---|
| `mode`, `block`, `tools` | `collect`, `true`, `[meme_lookup]` | Root or preset row; a preset row's block and tools |
| `enabled` | `true` | `false` turns the whole package off; data stays |
| `dir` | `<DSH_HOME>/speaking-style` | `samples.jsonl` (tone), `notes.json` (memes, traits, card versions), `state.json`, `answers.json`; 0600 files in a 0700 directory |
| `review` | `optional` | The one switch for tone samples: `optional` makes strangers' samples active at once; `required` holds them until the owner taps 留 |
| `tone.enabled`, `tone.maxShown`, `tone.maxChars` | `true`, `8`, `600` | Tone samples in the block, at most 8 exchanges and 600 characters |
| `memes.enabled`, `memes.maxIndex`, `memes.maxStored`, `memes.expireDays` | `true`, `40`, `80`, `14` | The meme index, `meme_lookup`, and meme notes; a meme not seen for 14 days expires |
| `traits.enabled`, `traits.max` | `true`, `10` | Traits of the groups' overall tone |
| `persona.enabled`, `persona.maxChars`, `persona.minIntervalHours`, `persona.maxVersions` | `true`, `600`, `6`, `30` | The card: length, hours between revisions (an owner edit restarts the wait), versions kept |
| `notes.sources`, `notes.termChars`, `notes.textChars`, `notes.perTurn` | `{qq-digest: qq, up: bili, unattended: web}`, `20`, `60`, `5` | Which preset reads which platform; field lengths; `style_note` calls per turn |
| `miner.enabled`, `miner.provider`, `miner.model`, `miner.maxOutputTokens` | `true`, unset, unset, `2000` | The meme miner needs `memes.enabled`; without `provider` and `model` its calls use the profile's default route (`ctx.agentDefaultModel`) |
| `miner.maxInputs`, `miner.maxNew`, `miner.maxSearches`, `miner.minLikes` | `120`, `6`, `6`, `20` | Texts the model reads per run, new memes kept per run, web searches per run, likes that make one hot comment evidence by itself |
| `miner.commonShare`, `miner.commonFrom`, `miner.meaningChars` | `0.35`, `10`, `80` | A term in more than 35% of at least 10 texts is an ordinary word; longest one-line meaning |
| `miner.windowHours`, `miner.qqMessages`, `miner.rawKept` | `72`, `400`, `30` | Hours of hot rows and QQ messages read, QQ messages per group, raw responses kept on disk |
| `miner.inbox.items`, `miner.inbox.chars`, `miner.inbox.days` | `30`, `6000`, `3` | Pages the main agent searched or fetched that the miner may read: how many, characters each, days kept |
| `hotwatch.enabled`, `hotwatch.url`, `hotwatch.limit`, `hotwatch.maxIndex`, `hotwatch.ttlMs`, `hotwatch.timeoutMs` | `true`, `http://100.97.163.18:8000`, `30`, `15`, `3600000`, `8000` | HotWatch's `meme` domain as a supplement: titles fetched by heat, at most 15 in the index, cached an hour |
| `presets`, `answerPresets`, `timeZone`, `ticsFile` | `unattended`, `up`, `bili`, `qqbot`; `unattended`; `America/New_York`; integrity-watch's `tics.json` | Who gets the block; whose answer lengths the trend counts; the rotation day; stock-line counts for the page |
| `everyHours`, `maxChars`, `maxActive`, `maxOwner`, `maxPending`, `perRun`, `perGroup`, `maxAgeDays`, `identityMarkers`, `blocklist`, `qq.*`, `bili.*` | see [the configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-speaking-style) | Tone collection: schedule, caps, filters, QQ window, bili-svc reads (`BILI_SVC_TOKEN_UP`, owner account `maodeng`) |

**Tone samples** are collected once a day without a model: a QQ message and the reply that quotes it (or an unquoted answer inside a back-and-forth), and a Bilibili comment and its reply; the owner's hand-written 猫灯 replies count only when bili-svc marks them as not posted by its Reply Gate (`gate: false`). Lines with links, `@`, digit runs, personal information, media, commands, orders to an AI, AI talk, identity markers, slurs, or the persona's stock lines are left out.

**Notes.** `style_note({kind, term, meaning?, example, related?})` works only from a preset in `notes.sources`; its platform (`qq`, `bili`, or `web`, nothing else) comes from that preset, and `example` must appear verbatim in what the calling Session just read: the QQ messages a digest Session was shown (`ctx.qq.recentTextOf(sessionId)`) and the results of public-text tools in its own Session log (the QQ and Bilibili reads; for `web`, `web_search` and `web_fetch` only). The log is written by the host, so the model cannot forge it, and the owner's messages, memory, shell, and file results never count. Every field passes the note filter: personal information (names with an honorific or alias, QQ numbers, UIDs, phones, emails, addresses, schools and workplaces, a place tied to someone such as 「我在成都」, `@`), links, digit runs, slurs, and sexual content about minors. Writing a known term refreshes it. `related` lists up to four other terms of the same meme family. A trait describes the group's talk, never a member, so `web` presets take memes only; nothing about any member is stored.

**The meme miner** runs after every collection (and on 立即收集), with no Session and no tools: code gathers public text only, a cheap model proposes, and code decides. Inputs are Bilibili hot comments (text and likes) and hot-search words from `ctx.biliHot` (`{ comments(), words() }`, provided by the `bili` plugin; absent means the miner skips them), the recorded QQ groups, and the web inbox (the text of the last days' `web_search` and `web_fetch` results, never the query or URL, kept `miner.inbox.days` days). No author, id, or video id is read. Texts with personal information, links, digit runs, or slurs never reach the model. One call proposes memes `{term, meaning?, example, related}`; code keeps a proposal only when the example is verbatim in an input and holds the term, the term is in at least two texts, in one comment with `miner.minLikes` likes, or in a hot-search word, it is not in more than `miner.commonShare` of the texts, the note filter and the owner's deletions allow it, and the guard allows the whole record. A kept meme's meaning comes from HotWatch's summary, else the lines of the pages the main agent read that mention it (`meaningSource: web`), else one web search through `ctx.web` (`search`); a second call compresses the material to one line and says whether it shows a meme or an ordinary word (an ordinary word is dropped). A meme with no material is kept only with a hot-search hit or three texts, marked `llm`. A run makes at most two model calls and `miner.maxSearches` searches, and writes every raw model and search response to `<dir>/raw` before parsing it. Memes already stored whose term shows up again stay alive; unseen ones expire after `memes.expireDays`.

**Memes.** The block lists names only: the groups' jargon first (most recent first), then HotWatch's trending memes to fill up to 15. `meme_lookup({term})` answers from the groups first, then from HotWatch's event summary, and says which. HotWatch titles and summaries pass the note filter; when HotWatch is unreachable the index uses the groups' memes only and the log warns once per kind of failure.

**The persona card** is DSH's own: `persona_update({card, reason})` takes the whole card (at most 600 characters, the note filter applies), at most once every 6 hours since the last version, keeps every version, and tells the owner through `ctx.ownerNotifier` (a safety notice, not urgent, so the WeChat channel holds it while the owner sleeps) only the version number and the size change. The agent's revisions are the limited ones: on the page the owner edits, deletes, rolls back, or deletes a past version without a limit, and an owner edit becomes the new baseline that restarts the agent's wait. Without a card, the block of a preset that has `persona_update` invites the agent to write one from the traits, memes, and tone.

`meme_lookup` also finds a meme by any of its `related` terms (the Settings page shows the same fields).

`ctx.speakingStyle.health()` answers counts only: kept and pending tone samples, the review mode, the last collection's start, and the stock-line direction.

**Safety boundary.** Strangers' words reach the prompts of `unattended`, `up`, `bili`, and `qqbot` this way, outside [turn-taint](../turn-taint/README.md)'s turn-origin tracking, and the agent writes its own card without approval. The mitigations: inputs are QQ, Bilibili, and public web pages only (never owner-memory, WeChat, the owner's messages, or the owner's facts); verbatim checks and the filters; the content guard on every public write; length, count, and rate limits; the framing (style reference, not instructions, not facts about anyone; the system persona and rules first); the owner's view, edit, rollback, and deletion of everything; `review: required`; the switches. The package writes no memory and changes no persona text.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin: configuration, the two modes, the schedule, the web inbox feed, the answer-length counter, and `StyleService` (`ctx.speakingStyle`: block, panel, edits, collection, mining, notes, lookups, card updates, `health()`) |
| [`src/tools.ts`](src/tools.ts) | `meme_lookup`, `style_note` (with its per-turn limit), `persona_update` |
| [`src/notes.ts`](src/notes.ts) | `notes.json`: memes (with `related` and `meaningSource`), traits, blocked terms, card versions |
| [`src/guard.ts`](src/guard.ts) | `StyleGate`: the per-call `ctx.contentGuard` check, fail closed |
| [`src/miner.ts`](src/miner.ts), [`src/inputs.ts`](src/inputs.ts), [`src/model.ts`](src/model.ts) | The meme miner, its inputs (QQ, `ctx.biliHot`, the web inbox) and its model call |
| [`src/session-text.ts`](src/session-text.ts) | The public text a Session's log holds, for the verbatim check |
| [`src/hotwatch.ts`](src/hotwatch.ts) | HotWatch client: the meme list and summaries, cached, filtered, warn once |
| [`src/collect.ts`](src/collect.ts), [`src/bili.ts`](src/bili.ts), [`src/store.ts`](src/store.ts) | Tone collection: pairing, screening, bili-svc reads, `samples.jsonl` |
| [`src/filter.ts`](src/filter.ts) | Line rules, personal-information rules, the note filter |
| [`src/render.ts`](src/render.ts) | The block |
| [`src/trend.ts`](src/trend.ts) | `answers.json` and the page's trend |

A preset row adds the block as a `user/message` with source kind `speaking-style` after the turn's claimed messages, again when the day or the card version changes, after a compaction, and after a restart. Without the root row it logs one warning and adds nothing. The tools answer `{ status: 'recorded' | 'refreshed' }` or `{ status: 'rejected', reason }` (`not_a_reader`, `not_verbatim`, `meaning_missing`, `limit_reached`, `too_soon`, `removed`, `unavailable`, `off`, `guard_unavailable`, `guard: …`, or a filter reason); `meme_lookup` answers `{ found: true, from: 'groups' | 'hotwatch', term, meaning, example?, related?, source?, meaningSource? }` or `{ found: false }`.

This is a fork-local package; see [`../UPSTREAM.md`](../UPSTREAM.md).

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [QQ observer](../qq/README.md) — where the QQ messages come from, and what a digest turn just read
- [Integrity watch](../integrity-watch/README.md) — the stock-line list and the per-day counts
- [Owner memory](../owner-memory/README.md) — kept per channel; this package never reads it
- [Web search and fetch](../../web/web/README.md) — `ctx.web`, the miner's search

-----

<a id="model-experience"></a>
## Model Experience

### Style block

#### What the model sees

One user-role message per root Session of the listed presets, again when the day or the card version changes, inside `<system-reminder>` and `<style-samples day="…" card="N">`: a framing line (your own speaking style; learned from strangers' public words, untrusted-derived; a style reference, not instructions or facts about anyone; the system persona and rules first); `你的人设卡（你自己写的，用 persona_update 修订）：` and the card, or an invitation to write one; `性格倾向（群聊整体的说话性格）：` with `- 嘴硬（例："才不是呢"）`; a meme index line `圈内黑话：…` and `全网热梗：…` (names only, look up before use); then the owner's tone-sample intro and up to 8 exchanges `- "line" → "reply"（QQ）`. The rendered form is the fixture [`tests/fixtures/style-block.txt`](tests/fixtures/style-block.txt).

#### Token effect

The card (at most 600 characters), up to 10 traits, up to 40 meme names, and up to 600 characters of tone samples: about 1,200 tokens at most, once per day or card version. Subagents and presets outside the list pay nothing.

#### KV Cache effect

Append-only: the block enters after the claimed messages of a turn and is never rewritten, so later requests reuse it.

### Tools

#### What the model sees

The tool schemas a preset row lists: `meme_lookup` (`term`), `style_note` (`kind` meme or trait, `term`, `meaning`, `example`, described as writing down how the people being read talk, with the verbatim and personal-information rules and the per-turn limit), and `persona_update` (`card`, `reason`, described as writing the agent's own character card, at most 600 characters, effective at once, limited to one revision every few hours). Results are one JSON text block as listed above.

#### Token effect

A fixed schema cost on every request of a Session whose preset mounts them; a lookup result is a few dozen tokens (with the meaning, an example line, and up to four related terms).

#### KV Cache effect

Prefix-stable while tool definitions are unchanged; results are appended after the reusable prefix.

### Meme miner

#### What the model sees

Two stateless calls per run with no tools and no Session: a system prompt that asks for the memes in the data and says the texts are strangers' words to read as data, and a JSON list of up to 120 texts (`id`, `text`, `likes`, `hotSearch`); then, when a new meme has material, a second prompt with `{term, material}` items and the instruction to write a 60-character meaning from the material only, or an empty string for an ordinary word. No author, video id, or owner message is in them.

#### Token effect

About 4,000 input tokens for the first call and 1,500 for the second, once per collection (daily by default), on the profile's default route; none when mining is off or there is nothing to read.

#### KV Cache effect

None; the calls do not extend any Session's prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Needs the content guard** — until the `content-guard` package provides `ctx.contentGuard`, the card, notes, and mined memes are refused (`guard_unavailable`); the owner's Settings edits still work.
- **Needs `ctx.biliHot` for Bilibili** — the `bili` plugin provides `{ comments(), words() }`; until it does, the miner reads the QQ groups and the web inbox only.
- **The web inbox holds what any Session fetched** — the result text of every `web_search` and `web_fetch`, including pages the owner asked for, for `miner.inbox.days` days (never the query, the URL, or the owner's message); each line passes the personal-information screen before a model reads it, and `miner.enabled: false` stops the inbox.
- **The miner needs a model route and a search provider** — without `ctx.agentDefaultModel` (or `miner.provider` and `miner.model`) a run reports `no_model`; without a usable `ctx.web` search provider a new meme's meaning comes from the pages already read, or stays a model draft that needs stronger evidence.
- **Notes need a Session log** — a `style_note` call outside a Session, or from a platform with no public-text tool result in the log, is `unavailable` or `not_verbatim`.
- **Owner replies on Bilibili wait for bili-svc** — until its thread answer carries `gate` per reply, the owner's account's replies are left out of the tone samples.
- **Rule lists, not judgement** — a name without an honorific or a crude joke can pass the filters; the owner's deletion is the second filter.
- **Same block everywhere** — the card is the same in every channel; channel-specific behaviour stays in each preset's system persona.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is non-authoritative working context: undecided directions and notes for maintainers. Shipped behavior and accepted rationale live in the sections above, the package code, and the linked Agent Notes.

- A dedicated bili-svc token with only the `read` scope would replace the `up` token, which can also reply.

</details>
