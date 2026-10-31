---
description: "Integrity watch for the owner's main agent: digests of the files that steer it, a WeChat notice naming what changed (never its content), a hash of every Session's system prompt in the log, and a daily count of the persona's forbidden stock lines."
kind: "package-reference"
---

# @deepseek-ai/dsh-lsy-integrity

English | [中文](README.zh.md)

## Summary

If someone slips a line into `AGENTS.md`, a skill, a profile patch, or a scheduled task, the agent changes without anyone deciding it should. This package keeps a digest of those files and tells the owner on WeChat which one changed, by name and never by content, merged and at most a few times a day. It also logs a hash of each Session's system prompt and counts, per day, the stock lines the persona forbids in the answers the owner receives, so a model's tics coming back show as a trend.

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

Mount it at the root, in a process that also has a notifier (`ctx.lsyNotifier`, from [`lsy-wechat`](../lsy-wechat/README.md)). The lsy event profile lists the workspaces of its Sessions.

```yaml
- id: lsy-integrity
  name: '@deepseek-ai/dsh-lsy-integrity'
  config:
    workspaces:
      - /Users/dsh-runtime/me
```

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `true` | `false` turns the whole watch off |
| `workspaces` | `[]` | Directories whose `AGENTS.md`, `CLAUDE.md`, `CLAUDE.local.md`, `.dsh/skills`, and `.agents/skills` are watched |
| `intervalSec` | `300` | Seconds between scans |
| `notify` | `true` | Tell the owner on WeChat; `false` only logs |
| `minGapSec` | `1800` | Fewest seconds between two notices; changes that arrive sooner wait and merge into the next one |
| `noticesPerDay` | `6` | Notices a day |
| `ticPresets` | `unattended`, `bili` | Presets whose answers are checked for the persona's forbidden stock lines |
| `stateDir` | `<DSH_HOME>/lsy-integrity` | Where the baseline, persona hashes, and counts live |
| `memoryFile` | `<DSH_HOME>/lsy-memory/memory.jsonl` | The memory file whose digest is checked against the memory history |

Watched, always: the home patch `<DSH_HOME>/cordis.patch.yml`, the owner's layer `<DSH_HOME>/profiles/event/cordis.patch.yml`, `<DSH_HOME>/AGENTS.md` and its siblings, `<DSH_HOME>/skills`, `~/.agents/skills`, the definitions of the scheduled tasks in `storages/schedule.json` (not their delivery history), and the memory file. The first scan writes `baseline.json` silently. After that, a changed, new, or removed target produces one notice, `🔐 完整性：N 处被改动（不显示内容）`, and becomes the new baseline. The memory file changes all day through the memory tool, so it is compared with the SHA-256 the memory history last recorded; only a change the tool did not make is reported.

`<stateDir>/tics.json` holds, per day, how many answers the owner received, how many held a forbidden line, and a count per line (by index into the persona's list). `persona.json` holds the last system prompt hash per preset.

Making the home patch immutable (`chown root:wheel` and `chflags uchg`) is a deployment step for the operator, not done here: the agent runs as the account that owns the file today.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`scan.ts` digests each target: a file by the SHA-256 of its bytes (a file over 4 MiB by size and mtime), a directory by the sorted list of relative paths and file digests (skipping `node_modules` and `.git`, at most 2,000 files), the schedule by the task ids and the digest of each task's definition. Absent and unreadable targets have their own values, so appearing, disappearing, and a permissions problem all count as changes. `index.ts` compares them with the baseline every `intervalSec` seconds; a change that is held back by the gap or the daily limit stays out of the baseline so that the next scan finds it again, which is how held changes merge. A failed send is retried.

The Session hooks listen to `session/event`. A `system/message` is hashed (first 12 hex digits of SHA-256) and logged with the Session's preset; a different hash for the same preset logs a warning that is expected after an upgrade or a model switch (the persona names the model) and nothing else. At a `turn/end` of a checked preset, the last assistant message of the turn is matched against `src/tics.ts`; `NO_REPLY` turns are skipped. `tics.ts` is the persona's blacklist copied out; a test reads the bundle and fails when the two differ, in either persona preset.

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin: the scan loop, the notice, the system prompt hashes, the stock-line counter |
| [`src/scan.ts`](src/scan.ts) | The targets and their digests |
| [`src/tics.ts`](src/tics.ts) | The forbidden stock lines and their matcher |

This is a fork-local package; see [`../UPSTREAM.md`](../UPSTREAM.md).

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Owner memory](../lsy-memory/README.md) — the history whose hashes the memory check reads
- [Turn origin](../lsy-taint/README.md) — the rules for turns the owner did not start alone

-----

<a id="model-experience"></a>
## Model Experience

None, as the package reads files and Session events, writes counts and digests under its own directory, and notifies the owner; nothing here is added to a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request. The WeChat channel copies a sent notice into the chat Session as a notice for its next turn, which follows the reusable prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **A digest says that, not what** — the notice cannot tell a legitimate edit (the owner saving a setting in the Web UI) from a planted one; the owner decides from the name.
- **Polling** — a change is found within `intervalSec`, not at once, and a file changed and restored between two scans is not seen.
- **The persona hash is the whole system prompt** — it changes with the model name, the tools, and the guidance as well as the persona.
- **Only the listed places** — a skill or instruction file in a directory not listed under `workspaces` is not watched.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is non-authoritative working context: undecided directions and notes for maintainers. Shipped behavior and accepted rationale live in the sections above, the package code, and the linked Agent Notes.

- A hand edit of the memory file between two writes is only caught if a scan falls between them; recording an `external edit` marker in the memory history at the next write would make it durable.

</details>
