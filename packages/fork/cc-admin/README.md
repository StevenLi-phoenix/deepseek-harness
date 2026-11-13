---
description: "Root service ctx.claudeCodeSessions: the service account's Claude Code sessions, listed from Claude Code's own registry and tmux, started with a first task, and stopped, for the Settings page."
kind: "package-reference"
---

# @deepseek-ai/dsh-cc-admin

English | [中文](README.zh.md)

## Summary

Start, list, and stop the Claude Code sessions of the service account without an SSH session. `ctx.claudeCodeSessions` reports how `dsh-runtime` is signed in to Claude Code (a full claude.ai login, which Remote Control needs, only the inference token, or nothing), lists the live sessions with their status and directory, starts one in a detached tmux session with an optional first task, and stops one it started. The Settings page [`event-console`](../event-console/README.md) is its consumer.

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

Mount the row at the root of the composition, next to [`event-console`](../event-console/README.md); the fork event bundle mounts it. `cc-bridge`'s tools live in the `unattended` preset mount, which nothing outside it can reach, so the Settings page cannot use them; this service does the same work from the root.

```yaml
- id: cc-admin
  name: '@deepseek-ai/dsh-cc-admin'
```

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Turn the service off; the Settings page then shows Claude Code as off |
| `sessionsDir` | the bridge's (`~/.claude/sessions` of the Host's user) | Claude Code's session registry |
| `tmux`, `command`, `workDir`, `model`, `maxSessions` | the bridge's | How started sessions run and how many may run at once |

Every default is read from `cc-bridge`'s own configuration schema, so the two cannot drift; a test pins it. Set a field here only to give the page a different value than the tools use.

The methods are `view()` (login state, live sessions, and the tmux sessions started here), `start(name, task?)`, and `stop(name)`. `start` refuses a bad name or a duplicate (`invalid_request`), a first task over 8000 characters (`invalid_request`), and a fourth running session (`limit_reached`); `stop` answers `not_found` for a session the bridge did not start. The first task is Claude Code's prompt argument, single-quoted for the shell, so the session sees it as the owner's own text.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The service wraps the bridge's `Registry` (Claude Code's `<pid>.json` records, counted only when the process is alive with the recorded start time) and `Spawner` (tmux server `-L dsh-cc`, a cleaned environment, the name and model rules). It never opens the bridge's inbox or writes a peer record, so it cannot send a peer message; a first task therefore travels as the launcher's argument.

The login state is `full` when `~/.claude/.credentials.json` has content, `token` when `~/.config/claude-code/oauth_token` has, else `none`. The files are only `stat`ed; no credential is read, logged, or returned. A log line records a start, a stop, or a failure by name; a first task is not logged.

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Configuration, the types, and `ClaudeCodeAdmin` |

This is a fork-local package; see [`../UPSTREAM.md`](../UPSTREAM.md).

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [cc-bridge](../cc-bridge/README.md) — the tools, launcher, and registry this service reuses
- [event-console](../event-console/README.md) — the Settings page that consumes it
- [Event service runbook](../../../fork/deploy/RUNBOOK.md) — section 14, Claude Code for the service user

-----

<a id="model-experience"></a>
## Model Experience

None, as the service registers no tool and adds nothing to a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **No peer messages** — a first task is the prompt argument; sending later messages to a session stays with `cc_send`.
- **Only the bridge's sessions can be stopped** — a session started by hand in another tmux server is listed but not stopped from here.
- **Another copy of the defaults** — `Config` here repeats the bridge's fields so a deployment can override them; the defaults themselves are not repeated.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is non-authoritative working context: undecided directions and notes for maintainers. Shipped behavior and accepted rationale live in the sections above, the package code, and the linked Agent Notes.

- The page reads this service through a structural type in `event-console`, because a package that ships a browser half may not import runtime values from a peer package without a reviewed classification in `scripts/package-dependency-policy.ts`.

</details>
