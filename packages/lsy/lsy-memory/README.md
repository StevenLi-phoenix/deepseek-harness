---
description: "Owner memory across Sessions for the lsy event agent: a JSONL file the Host puts in front of each root Session, memory_search/memory_save/memory_forget tools, and an importer for claude.ai memory exports."
kind: "package-reference"
---

# @deepseek-ai/dsh-lsy-memory

English | [中文](README.zh.md)

## Summary

The agent remembers the owner across Sessions. The Host keeps entries in `<DSH_HOME>/lsy-memory/memory.jsonl` and puts them in front of the model itself: the first request of every root Session, and the first after compaction, carries a memory block with instructions and preferences in full, career and project entries by their opening words, and only the number of identity entries, so details about people and accounts leave the Host only when a search asks for them. The agent reads entries with `memory_search` and writes with `memory_save` and `memory_forget`. claude.ai memory exports import as they are.

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

Add the row to the plugin list of the agent preset that should remember. The lsy event profile mounts it in its `unattended` preset, which the WeChat chat Session and watch-started Sessions use.

```yaml
- id: lsy-memory
  name: '@deepseek-ai/dsh-lsy-memory'
```

| Field | Default | Meaning |
|---|---|---|
| `file` | `<DSH_HOME>/lsy-memory/memory.jsonl` | The memory file |
| `maxBytes` | `65536` | Cap on the memory block; entries that do not fit are counted in a closing line and stay searchable |

Each entry is one line of text with an id, a category, and the date of its last write:

| Category | In the block | Holds |
|---|---|---|
| `instructions` | full text | How the owner wants the agent to work |
| `preferences` | full text | Tastes, opinions, style |
| `identity` | count only | Who the owner is: people, family, school, accounts |
| `career` | opening words | Jobs and applications |
| `projects` | opening words | What the owner builds or researches |

To import a claude.ai memory export (`## <n>. <Category>` headings over `[YYYY-MM-DD] - text` lines), run the import as the service user; it keeps the export's dates, skips entries already present, and prints counts only:

```sh
sudo -u dsh-runtime env DSH_HOME=/Users/dsh-runtime/.dsh /opt/homebrew/bin/node \
  /Users/Shared/lsy-dsh/current/lsy/deploy/memory-import.mjs < export.md
```

Add `--dry-run` to only count. The next Session sees the result; no restart is needed. The file is plain JSONL (mode 600) and may be edited by hand: a line that is not a valid entry stops injection and every write until it is fixed, rather than being dropped.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

An `agent/pre-step` listener adds the block when the step proposes messages, the Session is not a subagent's (`header.origin === 'subagent'`), and no `lsy-memory` message is among the Session's visible surface nodes. It reads the file, renders the block (`render.ts`), and places it right after the claimed prompt, as workspace instructions are placed. The block is an ordinary sourced `user/message` (`form: 'instructions'`), so it replays and resumes with the Session; once compaction replaces it, the next step adds a fresh one with whatever was saved since. A file that cannot be read is logged and the request goes on without memory.

The tools call `MemoryStore`, which validates everything the model sends: category from the fixed set, id as six hex digits, text collapsed to one line of at most 2000 characters, at most 1000 entries. Every mutation re-reads the file under a per-path lock and replaces it through a temporary file and `rename`, so concurrent Sessions and hand edits between writes are kept. Saving text that already exists in the category returns the existing entry. The Host stamps dates. Logs carry ids, categories, and lengths, never entry text.

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: the pre-step injection and the three tools |
| [`src/store.ts`](src/store.ts) | The JSONL store: list, save, forget, import, search |
| [`src/render.ts`](src/render.ts) | The memory block and its byte budget |
| [`src/entries.ts`](src/entries.ts) | Entry type, categories, validation |
| [`src/export.ts`](src/export.ts) | claude.ai export parser |
| [`src/cli.ts`](src/cli.ts) | `memory-import` (run through [`lsy/deploy/memory-import.mjs`](../../../lsy/deploy/memory-import.mjs)) |

This is a fork-local package; see [`../UPSTREAM.md`](../UPSTREAM.md).

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Workspace instructions](../../context/agent-instructions/README.md) — the same durable-context pattern for `AGENTS.md` files
- [Third-party memory MCP servers](../../../docs/user/guide/mcp-memory.md) — the upstream alternative, where the model decides when to recall

-----

<a id="model-experience"></a>
## Model Experience

### Memory block

#### What the model sees

One user-role message per root Session, inside `<system-reminder>`: three lines saying to follow the instructions and preferences, to call `memory_search` before relying on an entry that is shown by its opening words or only counted, or whenever the owner's background may matter (searching in Chinese and English), and to call `memory_save` or `memory_forget` in the same turn when the owner asks to remember, correct, or forget something. Then `## Instructions` and `## Preferences` as `- [date] (id) text` lines, `## Identity` as `N entries, not listed; memory_search finds them.`, and `## Career`, `## Projects` as `- id · <first 80 characters>…` lines, ending with `(N more entries did not fit; memory_search finds them.)` when the budget runs out.

#### Token effect

The block's size, at most `maxBytes`, once per root Session and again after each compaction; the owner's memory (170 entries) renders to about 24 KB. Subagents pay nothing.

#### KV Cache effect

Append-only: the block enters after the reusable prefix on the first request and is not rewritten when memory changes mid-Session, so later requests reuse it.

### Memory tools

#### What the model sees

Three tool schemas whenever the Agent's preset mounts the package: `memory_search` (`query`, optional `category` and `limit`), `memory_save` (`text`, `category`, optional `id` to replace), and `memory_forget` (`id`). Results are one JSON text block: `{ "entries": [{ id, category, date, text }], "more" }`, `{ "outcome": "added" | "replaced" | "unchanged", "entry" }`, `{ "forgot": entry }`, or `{ "error": "<code>", "message" }` with codes `invalid_text`, `invalid_category`, `invalid_id`, `not_found`, `full`, `corrupt`.

#### Token effect

A fixed schema cost on every request from an Agent whose preset mounts the package; a search result costs its entries, at most 50.

#### KV Cache effect

Prefix-stable while tool definitions are unchanged; results are appended after the reusable prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Substring search** — no embeddings or synonyms; a Chinese term does not find an English entry, so the block tells the model to search in both languages.
- **Recall of other entries is the model's choice** — instructions and preferences always arrive; details of career, project, and identity entries arrive only when the model searches.
- **One owner, one file** — every Session under the preset shares the same memory.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is non-authoritative working context: undecided directions and notes for maintainers. Shipped behavior and accepted rationale live in the sections above, the package code, and the linked Agent Notes.

- The layout follows claude.ai's memory (categorised, dated one-line facts) and Claude Code's auto memory (an always-loaded part plus details on demand); the Host, not the model, maintains the index.

</details>
