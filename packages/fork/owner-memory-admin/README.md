---
description: "Settings section for reviewing what the agent remembers about the owner: waiting writes to approve or discard, entries to search, undo, or erase, previewed rollbacks, and persona feedback, all from the Web UI."
kind: "package-reference"
---

# @deepseek-ai/dsh-owner-memory-admin

English | [中文](README.zh.md)

## Summary

Review and tidy what the agent remembers without a terminal. **Settings → Memory** lists pending writes first, with their source and Session, to approve or discard. A curation card proposes merges of near-duplicate entries and flags entries that look outdated; nothing changes until you click. The memories follow as compact rows, searchable by text and id, expandable to full text and history, and selectable to merge, erase, or recategorize. A rollback card undoes one Session's changes or everything since a time, previewing first. The page also holds your verdicts on persona replies and the content guard's settings and refusals.

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

This package is the page. Mount its row next to the Host route it talks to, `@deepseek-ai/dsh-owner-memory/settings` (see the [`owner-memory`](../owner-memory/README.md) README); the fork event bundle mounts both. It needs the settings shell (`@deepseek-ai/dsh-client-ui-settings-general`, which declares the `settings.section` list) and, on the Host, the `connection` service, both of which the Web bundles compose.

```yaml
- id: owner-memory-admin
  name: '@deepseek-ai/dsh-owner-memory-admin'
- id: owner-memory-settings
  name: '@deepseek-ai/dsh-owner-memory/settings'
```

The page has no fields of its own (the guard's fields are the `content-guard` entry's). The Host row's optional `file` names the memory file (default `<DSH_HOME>/owner-memory/memory.jsonl`, the file the agent's `owner-memory` rows use).

What each card does:

| Card | Shows | You can |
|---|---|---|
| Waiting for you | Protected writes (instructions, preferences, identity) the agent made in a turn you did not start alone, with their source, Session, and the day they lapse | Approve or discard one; approve or discard all (a second click confirms) |
| Curation | Proposed merges of near-duplicates (the differing clauses marked) and entries whose expiry or term has passed, from the Host's read | Accept (opens the merge or erase preview) or set one aside |
| Entries | Memories as compact rows, newest change first, with category counts: category, the opening, the date, and the protected mark | Search by text or id, filter by category, page; open one for its full text and history; undo its latest change; erase it completely after seeing what goes; select rows to merge, erase, or move to another category |
| Duplicates | Only the groups that say nearly the same thing, with the clauses that differ marked and the group's similarity | Merge a group into one (previewed, and the wording is yours) or keep both |
| Rollback | The Sessions that changed memory | Pick a Session or a time, preview the changes, confirm |
| Reply feedback | Your keep/delete verdicts on persona replies | Remove one, or add one by hand |
| Content guard | Texts checked and refused in the last 24 hours, refusals by rule name, the latest layer failure (from `GET /api/content-guard`, [`content-guard`](../content-guard/README.md); hidden where that route is not mounted) | Edit the `content-guard` entry in the All settings card below it ([`plugin-config`](../plugin-config/README.md)) |

The same operations exist as the `memory-admin` command-line tool; it stays as the fallback (RUNBOOK section 15).

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The page talks to `GET`/`POST /api/owner-memory`, registered by `@deepseek-ai/dsh-owner-memory/settings`. The route sits under `/api`, so the connection answers 403 to everyone but the owner's signed-in Web UI. It registers no agent tool, so the agent cannot call it and a write waiting for you cannot be approved by the Session that made it; the only writes it makes are the owner's explicit merge (previewed, applied with the preview's token) and category change. A `POST` must be `application/json` from the same origin. Actions are validated with schemastery; the log records the action, the ids, and the outcome with its duration, never entry text.

Rollback and erase are two steps. Without a `confirm` token the request is a preview: the Host computes what would change and answers it with a token over that answer and the memory it was computed from. With the token, the Host recomputes and applies only if the token still matches, and checks again under the memory file's lock before it writes; if memory changed in between, nothing is applied (`409`) and the page asks you to preview again.

The browser half registers one `settings.section` entry (`owner-memory`, order 55) through `ctx.slots.inject`. The shell mounts only the open section, so the page polls every 10 seconds while it is open and the page is visible. One `MemoryLoader` shares the read in flight, drops the answer of a query that has been replaced, hides a waiting write the moment you answer it and brings it back with the Host's reason if the Host refuses, and keeps the last view when a read fails. Entry text is rendered as text, never as markup.

| File | Role |
|---|---|
| [`src/view.ts`](src/view.ts) | The wire types and constants; the `./view` subpath, from which `owner-memory`'s route imports them |
| [`src/index.ts`](src/index.ts) | Host half: an empty plugin, so the browser half is delivered |
| [`src/client/index.ts`](src/client/index.ts) | Browser entry: dictionaries, the Host calls, the Settings section registration |
| [`src/client/memory.ts`](src/client/memory.ts) | Store and loader (optimistic hiding, previews with tokens); the poller is `@deepseek-ai/dsh-settings-kit`'s |
| [`src/client/MemorySettings.tsx`](src/client/MemorySettings.tsx) | The section; its cards are `PendingCard`, `EntriesCard`, `RollbackCard`, and `FeedbackCard` beside it |
| [`src/client/locales.ts`](src/client/locales.ts) | Copy in eight languages |

This is a fork-local package; see [`../UPSTREAM.md`](../UPSTREAM.md).

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [owner-memory](../owner-memory/README.md) — the memory store, the Host route behind this page, and the `memory-admin` CLI
- [turn-taint](../turn-taint/README.md) — how a turn is judged not to be the owner's alone, which is what holds a write for this page
- [sysmon](../sysmon/README.md) — the fork's other Settings section, whose store, poller, and layout this one follows

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

- The Host route lives in `owner-memory` and the page here because a package with a browser face may not import other workspace packages' values on the Host (the published dependency policy), and the agent-facing `owner-memory` plugin is mounted inside presets, where a route would register once per preset.
- Not built: a live view of a Session while it writes, and embedding search.

</details>
