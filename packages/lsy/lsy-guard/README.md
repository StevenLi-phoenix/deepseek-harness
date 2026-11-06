---
description: "One content validator for text that others can read: patterns, canary strings, overlap with the owner's memory, and a model, each refusing on its own and any layer that cannot run refusing too. Other plugins call ctx.lsyGuard.check before they write shared or public text."
kind: "package-reference"
---

# @deepseek-ai/dsh-lsy-guard

English | [中文](README.zh.md)

## Summary

Keep the owner's private life out of anything the agent writes for other people. A plugin that stores or posts text strangers can read (a persona update, a style note, a group note) asks `ctx.lsyGuard.check(text, { purpose, audience })`. The answer is `{ ok: true }` or a refusal with a rule name and a generic reason that never repeats the text. Patterns, canary strings, overlap with the owner's memory, and a model run in order, and a layer that cannot run refuses as well.

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

Mount it once at the root; the lsy event bundle does, ahead of every writer of shared text. The service is Host-only and exposes no tool to any agent. A second row, `@deepseek-ai/dsh-lsy-guard/settings`, serves `GET /api/lsy.guard` (counts only) for the guard card in Settings → Memory, which also lists every field of the `lsy-guard` entry in the All settings card.

```yaml
- id: lsy-guard
  name: '@deepseek-ai/dsh-lsy-guard'
  config:
    extraCanaries: ['a honeypot token']   # in the profile patch, not in the public bundle
- id: lsy-guard-settings
  name: '@deepseek-ai/dsh-lsy-guard/settings'
```

A plugin that writes text others can read looks the service up when it writes, with `ctx.get`, and refuses the write when the guard is absent:

```js
const guard = ctx.get('lsyGuard')
if (guard === undefined) return 'refused: the content guard is not mounted'
const verdict = await guard.check(text, { purpose: 'persona_update', audience: 'public', sessionId })
if (!verdict.ok) return `refused (${verdict.rule}): ${verdict.publicReason}`
```

The check never rejects, so no `try` is needed; a plugin without the guard in its dependency graph declares a local structural type for it instead of importing this package. A text is checked as written, so a caller checks the exact string it stores, once per write. A refusal's `publicReason` never repeats the text and may go back to the model.

`purpose` is a short identifier (`persona_update`, `style_note`, `qq_group_note`, `bili_channel_note`, lowercase letters, digits, `_`, `.`, `-`, at most 40 characters). `audience` is `public` for text anyone can read and `channel` for the readers of one QQ group or Bilibili account. The two differ in one thing: the model layer can be switched off for `channel` and never for `public`.

| Rule | Layer | Meaning |
|---|---|---|
| `pattern.phone`, `pattern.email`, `pattern.id_number`, `pattern.bank_card`, `pattern.contact`, `pattern.url_token`, `pattern.long_number`, `pattern.mention`, `pattern.address`, `pattern.os_path`, `pattern.link` | patterns | A phone number (CN, US), an email, a Chinese ID number, a card number that passes the Luhn check, a labelled contact (`QQ: abc123`, `微信 xyz`), a link carrying a token or account id, five or more digits in a row, an `@`, an address, a file path with a user name, any link |
| `canary` | canary | The text contains a string from the canary file or `extraCanaries` |
| `memory_overlap` | memory | The text repeats a distinctive span of the owner's memory |
| `llm.<category>`, `llm.pii` | model | The model found private information (`real_name`, `school_employer`, `location`, `contact_account`, `health`, `finance`, `family`, `private_message`, `other`) |
| `llm.unsure`, `llm.unparseable`, `llm.unavailable` | model | The model could not tell, answered outside the protocol, or could not be reached in time |
| `canary.unavailable`, `memory.unavailable`, `pattern.error`, `guard.error` | any | A layer failed to run |
| `guard.bad_input`, `guard.too_long` | input | An empty or malformed purpose, an unknown audience, or a text above `maxChars` |

| Field | Default | Meaning |
|---|---|---|
| `layers.patterns`, `layers.canary`, `layers.memory`, `layers.llm` | `true` | Which layers run; `layers.llm: false` is ignored for audience `public` (one warning in the log) |
| `blockLinks` | `true` | Refuse any link; `false` refuses only a link that carries a token or an account id |
| `canaryFile` | `<DSH_HOME>/lsy-guard/canaries.txt` | One string per line, `#` starts a comment, reloaded when the file changes; a missing file is an empty list |
| `extraCanaries` | `[]` | Strings kept in the configuration, on top of the file |
| `memoryFile` | `<DSH_HOME>/lsy-memory/memory.jsonl` | The memory file compared against (entries and waiting writes); a missing file shares nothing, and the log says so once |
| `provider`, `model` | profile default | Route of the model layer, set together; unset uses `ctx.agentDefaultModel`, the cheap route the event profile selects |
| `timeoutMs`, `maxOutputTokens` | `20000`, `400` | Deadline and output cap of one model call |
| `maxChars` | `20000` | Longest text checked |
| `cacheHours` | `24` | Hours a model verdict is reused for the same text, purpose, and audience |
| `dir`, `rawRetentionDays` | `<DSH_HOME>/lsy-guard`, `14` | Where `canaries.txt` and `raw/` live, and how long raw model responses stay |

Canaries match without regard to case, width, spacing, or punctuation (`BSV-Honeypot-7F3A91` finds `bsv_honeypot_7f3a91`). A canary shorter than three characters, or two when it holds a Chinese, Japanese, or Korean character, is left out because it would match unrelated text.

Settings → Memory shows the last 24 hours of refusals by rule on the guard card (counts and rule names, never a text), and its All settings card edits the layers, the model route, and the honeypot list; a save reloads the plugin.

`ctx.lsyGuard.health()` answers counts for the last 24 hours (checks, refusals, refusals by rule), the most recent layer failure with a message cut to 200 characters, and the time of the latest check, never any text. Each check logs one line: purpose, audience, verdict, rule, the first 12 hex digits of the text's SHA-256, milliseconds, and cache hit or miss. Neither the text nor a canary is logged.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`check` never rejects. It validates the input, then runs the enabled layers in order and returns the first refusal. Patterns are pure functions over the NFKC-folded text; digits split by spaces or dashes are read as one number. The canary layer compares the squashed text (letters and digits only) with each squashed canary. The memory layer calls `MemoryStore.containsSpanOf` in [lsy-memory](../lsy-memory/README.md), which reads the memory file and the waiting writes and answers a boolean: a shared span is six consecutive CJK characters, or three consecutive words of a Latin-script text once a short list of filler words is dropped. A text too short to hold a span skips the read.

The model layer sends one request through `ctx.llm.stream` with the versioned system prompt (`GUARD_PROMPT_VERSION`), the purpose and audience, and the text between `<text_under_review>` tags in which `<` and `>` are replaced by their full-width forms, so the text cannot close the fence. It has no tools, no Session, and no memory. The route is the explicit `provider` and `model` (with the lightest reasoning effort the model offers) or `ctx.agentDefaultModel`'s selection. The answer must be one JSON object `{"label": "clear" | "pii" | "unsure", "categories": [...]}`; anything else is `llm.unparseable`. The raw response is written to `<dir>/raw/<YYYY-MM-DD>/<id>.json` (mode 0600, with the text's hash and never the text) before it is parsed, and a response from a failed call is kept too. Day directories older than `rawRetentionDays` are removed at start and at most once an hour after a save.

Only the model layer is cached, by SHA-256 of the text, purpose, audience, and prompt version, in memory for `cacheHours`; a cheap-layer refusal costs nothing to repeat, and a new canary or memory entry takes effect at once. Simultaneous checks of the same text share one call. A model error or timeout is not cached.

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin, configuration, `ctx.lsyGuard` |
| [`src/service.ts`](src/service.ts) | `GuardService`: layer order, cache, health, logging |
| [`src/patterns.ts`](src/patterns.ts) | The deterministic layer; `LINK`, `MENTION`, and `LONG_NUMBER` are the expressions `lsy-style`'s line filter uses |
| [`src/canary.ts`](src/canary.ts) | The canary file and configured strings |
| [`src/classifier.ts`](src/classifier.ts) | Prompt, answer parser, raw response store |
| [`src/model.ts`](src/model.ts) | The model call over the LLM service |
| [`src/settings.ts`](src/settings.ts) | `GET /api/lsy.guard`: the counts of `health()` for the Settings card |

This is a fork-local package; see [`../UPSTREAM.md`](../UPSTREAM.md).

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Owner memory](../lsy-memory/README.md) — the facts the memory layer compares against
- [Speaking style](../lsy-style/README.md) — the line filter whose patterns this package shares
- [QQ observer](../lsy-qq/README.md) — its group-note filter is the other source of the patterns

-----

<a id="model-experience"></a>
## Model Experience

None, as the guard registers no tool and adds nothing to the requests of the agents that write the text; a writer sees only a refusal's rule and generic reason when its plugin passes them on.

#### KV Cache effect

None for the main agent. The review is a separate one-shot request with a fixed system prompt, so the provider can reuse it across checks, and the model layer's cache avoids repeat requests for the same text.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Callers decide whether to ask** — the guard validates what it is given; a plugin that writes text without calling it is not covered.
- **A word list and a model, not a proof** — patterns miss spelled-out numbers and paraphrased facts; the model layer is the safety net, and it can be wrong in both directions. A refused text costs one rewrite.
- **Short canaries are skipped** — a one-character name cannot be matched without refusing unrelated text.
- **Common Chinese phrases can overlap** — a six-character span shared with a memory entry refuses even when the phrase is innocent.
- **The memory layer reads the file, not the service** — it compares against `memoryFile` directly, so it works in a profile that mounts `lsy-memory` only in one preset; a profile whose memory lives elsewhere must set `memoryFile`, or the layer compares against nothing.
- **The cache lives in memory** — a restart repeats the model call once per text.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is non-authoritative working context: undecided directions and notes for maintainers. Shipped behavior and accepted rationale live in the sections above, the package code, and the linked Agent Notes.

- `lsy-style` and `lsy-qq` still carry their own filters; they switch to `ctx.lsyGuard.check` in their own changes.
- The classifier design follows bili-svc's PII gate: two fail-closed layers, a versioned prompt, enum labels, and raw responses saved before parsing.

</details>
