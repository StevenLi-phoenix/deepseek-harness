---
description: "Settings section for reviewing what the agent remembers about the owner: waiting writes to approve or discard, entries to search, undo, or erase, previewed rollbacks, and persona feedback, all from the Web UI."
kind: "package-reference"
---

# @deepseek-ai/dsh-lsy-memory-admin

English | [中文](README.zh.md)

## Summary

Review and undo what the agent remembers without a terminal. **Settings → Memory** lists the writes waiting for you first, with where each came from and the Session behind it, to approve or discard. Below are the memories, searchable by text and category, with full text and history on demand, to undo or erase. A rollback card undoes one Session's changes or everything since a time: it previews first, and confirming applies exactly that preview. A last card holds your keep/delete verdicts on persona replies.

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

This package is the page. Mount its row next to the Host route it talks to, `@deepseek-ai/dsh-lsy-memory/settings` (see the [`lsy-memory`](../lsy-memory/README.md) README); the lsy event bundle mounts both. It needs the settings shell (`@deepseek-ai/dsh-client-ui-settings-general`, which declares the `settings.section` list) and, on the Host, the `connection` service, both of which the Web bundles compose.

```yaml
- id: lsy-memory-admin
  name: '@deepseek-ai/dsh-lsy-memory-admin'
- id: lsy-memory-settings
  name: '@deepseek-ai/dsh-lsy-memory/settings'
```

The page has no fields of its own. The Host row's optional `file` names the memory file (default `<DSH_HOME>/lsy-memory/memory.jsonl`, the file the agent's `lsy-memory` rows use).

What each card does:

| Card | Shows | You can |
|---|---|---|
| Waiting for you | Protected writes (instructions, preferences, identity) the agent made in a turn you did not start alone, with their source, Session, and the day they lapse | Approve or discard one; approve or discard all (a second click confirms) |
| Entries | Memories, newest change first, with category counts; the opening of each text | Search, filter by category, page; open one for its full text and history; undo its latest change; erase it completely after seeing what goes |
| Rollback | The Sessions that changed memory | Pick a Session or a time, preview the changes, confirm |
| Reply feedback | Your keep/delete verdicts on persona replies | Remove one, or add one by hand |

The same operations exist as the `memory-admin` command-line tool; it stays as the fallback (RUNBOOK section 15).

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The page talks to `GET`/`POST /api/lsy.memory`, registered by `@deepseek-ai/dsh-lsy-memory/settings`. The route sits under `/api`, so the connection answers 403 to everyone but the owner's signed-in Web UI. It registers no agent tool and has no action that writes an entry, so the agent cannot call it and a write waiting for you cannot be approved by the Session that made it. A `POST` must be `application/json` from the same origin. Actions are validated with schemastery; the log records the action, the ids, and the outcome with its duration, never entry text.

Rollback and erase are two steps. Without a `confirm` token the request is a preview: the Host computes what would change and answers it with a token over that answer and the memory it was computed from. With the token, the Host recomputes and applies only if the token still matches, and checks again under the memory file's lock before it writes; if memory changed in between, nothing is applied (`409`) and the page asks you to preview again.

The browser half registers one `settings.section` entry (`lsy-memory`, order 55) through `ctx.slots.inject`. The shell mounts only the open section, so the page polls every 10 seconds while it is open and the page is visible. One `MemoryLoader` shares the read in flight, drops the answer of a query that has been replaced, hides a waiting write the moment you answer it and brings it back with the Host's reason if the Host refuses, and keeps the last view when a read fails. Entry text is rendered as text, never as markup.

| File | Role |
|---|---|
| [`src/view.ts`](src/view.ts) | The wire types and constants; `lsy-memory/src/settings/view.ts` is a byte-identical copy (a test keeps them equal) |
| [`src/index.ts`](src/index.ts) | Host half: an empty plugin, so the browser half is delivered |
| [`src/client/index.ts`](src/client/index.ts) | Browser entry: dictionaries, the Host calls, the Settings section registration |
| [`src/client/memory.ts`](src/client/memory.ts) | Store, loader (optimistic hiding, previews with tokens), and the visibility-aware poller |
| [`src/client/MemorySettings.tsx`](src/client/MemorySettings.tsx) | The section; its cards are `PendingCard`, `EntriesCard`, `RollbackCard`, and `FeedbackCard` beside it |
| [`src/client/locales.ts`](src/client/locales.ts) | Copy in eight languages |

This is a fork-local package; see [`../UPSTREAM.md`](../UPSTREAM.md).

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [lsy-memory](../lsy-memory/README.md) — the memory store, the Host route behind this page, and the `memory-admin` CLI
- [lsy-taint](../lsy-taint/README.md) — how a turn is judged not to be the owner's alone, which is what holds a write for this page
- [lsy-sysmon](../lsy-sysmon/README.md) — the fork's other Settings section, whose store, poller, and layout this one follows

-----

<a id="model-experience"></a>
## Model Experience

None, as the section is browser chrome; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **One owner, one file** — the page shows the memory of the file the Host row names; per-preset memory files are not separate pages.
- **Erase is final** — an erased entry is removed from the history and the daily snapshots too, so it cannot be rolled back; the page shows what goes before it goes.
- **Rollback is by Session or time** — there is no per-entry history browser beyond an entry's own history.
- **A hand edit is not shown live** — the page reads the file on each refresh (every 10 seconds); a line that is not a valid entry makes the page report that the memory is unavailable until it is fixed, as the agent's injection does.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is non-authoritative working context: undecided directions and notes for maintainers. Shipped behavior and accepted rationale live in the sections above, the package code, and the linked Agent Notes.

- The Host route lives in `lsy-memory` and the page here because a package with a browser face may not import other workspace packages' values on the Host (the published dependency policy), and the agent-facing `lsy-memory` plugin is mounted inside presets, where a route would register once per preset.
- Not built: a live view of a Session while it writes, and embedding search.

</details>
