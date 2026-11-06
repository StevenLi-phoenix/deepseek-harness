---
description: "Model-facing watch_create, watch_list, watch_delete, flow_read, and flow_edit tools that let the agent decide what the lsy event service monitors and how each notification travels: GitHub repositories and notification threads, reported over WeChat or handed to an unattended agent."
kind: "package-reference"
---

# @deepseek-ai/dsh-lsy-tool-watch

English | [中文](README.zh.md)

## Summary

Tell the agent "let me know when deepseek-harness ships a release" and it sets that up: `watch_create` checks the repository, starts polling it, and routes what is new to a WeChat message or an unattended agent. Items that already exist become a baseline and are never reported; bursts are batched and capped per hour. `watch_list` shows each watch's health and token status; `watch_delete` removes one. Nobody edits YAML, and no watch appears silently: when a Session other than your WeChat chat creates or deletes one, you get a note saying what changed and which Session did it.

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

Add the row below to the plugin list of the agent preset that should manage watches, in a process that also mounts `@deepseek-ai/dsh-lsy-event-bus` and `@deepseek-ai/dsh-lsy-github-sensor`. The lsy event profile mounts it in its `unattended` preset.

### When to choose it

Choose it when the agent itself should decide what to monitor, from a chat request or as follow-up work of an event it handled. Use `@deepseek-ai/dsh-tool-schedule` for time-based checks; this package only reacts to new items on GitHub.

### The three tools

- `watch_create(id, github_repo | github_notifications, ...)` — Watch `owner/name` (`streams` of `releases`, `tags`, `commits`; default `releases`; optional `branch` for commits) or, with `github_notifications: true`, the owner's notification threads. `action: notify` (default) sends a WeChat message per batch; `action: session` with `instructions` starts an unattended agent whose final answer reaches the owner, and `NO_REPLY` keeps it silent. Optional `workspace_path`, `coalesce_seconds`, `max_per_hour`. A repository is probed first and refused with `repo_unavailable` when it cannot be read.
- `watch_list()` — Every watch, including configured ones, with target, action, origin, status, and credential status.
- `watch_delete(id)` — Remove a watch created by `watch_create`; configured watches return `config_owned`.

After a successful create or delete, the tool sends `🆕 watch created: <id>` or `🗑 watch deleted: <id>` through `ctx.lsyNotifier` with the target, action, session instructions (cut to 200 characters), and the calling Session id, unless the notifier relays that Session itself (`ownsSession()`), as it does for the owner's chat Session. A missing or failing notifier never fails the call.

### Minimal configuration

```yaml
- id: lsy-tool-watch
  name: '@deepseek-ai/dsh-lsy-tool-watch'
```

| Field | Default | Meaning |
|---|---|---|
| `defaultWorkspacePath` | `/Users/dsh-runtime/work` | Workspace of Sessions that `session` watches start, unless the call names one |
| `defaultAgentPreset` | `unattended` | Agent preset of those Sessions |
| `defaultPermissionPreset` | `danger-full-access` | Permission preset of those Sessions |
| `defaultCoalesceSeconds` | `60` | Batch window after the first new event |
| `defaultNotifyMaxPerHour` | `12` | Batches per rolling hour of a `notify` watch |
| `defaultSessionMaxPerHour` | `4` | Batches per rolling hour of a `session` watch |
| `defaultMaxPromptEvents` | `50` | Events embedded in the prompt of a Session a watch or route starts |
| `defaultMaxTextChars` | `2000` | Characters of each event's text in that prompt |
| `defaultRolloverDays` | `30` | Days a route's long-running Session lives before the next batch replaces it |
| `defaultMaxSeedChars` | `20000` | Characters of the summary carried into the replacement |
| `flowHistoryShown` | `20` | Changes of the notification flow that `flow_read` returns |
| `flowUnroutedShown` | `20` | Event kinds without a route that `flow_read` returns |

### The notification flow

- `flow_read()` — Every route from an event to the owner: what it takes, what its Session is told, where its answer goes, how it has been doing; event kinds no route took in the last day; and the latest changes.
- `flow_edit(op, id, note, ...)` — Change a route, including one the deployment wrote. `set` changes the fields given or creates the route; `remove`, `reset`, `pause`, and `resume` do what they say. `result` is `notify`, `urgent`, `main`, `quiet`, or `event`, and an `event` route's answer is taken by a route naming `flow.<id>.result`. A change works at once and outlives deploys, and a change from a Session the notifier does not relay also sends the owner a message.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The plugin registers three `defineTool` definitions once the mounting scope resolves `ctx.lsyEventBus` and `ctx.lsyGithubSensor`. `watch_create` validates its arguments, refuses an id any subscription already uses, and for a repository calls `probe()` and then watches GitHub's canonical `full_name`: `lsyGithubSensor.watch(id, …)` stores the polling side and starts the baseline poll, and `lsyEventBus.subscribe()` stores the routing side with `sources: [github]`, one kind per stream (`github.release`, `github.tag`, `github.commit`), and the repository as subject; a refused subscription rolls the sensor watch back. A notifications watch subscribes to `github.notification.*` and needs no sensor change. Create and delete calls run one at a time; the audit note is sent after the call succeeded, without waiting for the channel, and a failure is only logged. Views are rebuilt from the bus subscription list and the sensor's stream state; storage details never reach the model, and unexpected failures collapse to `internal_error`.

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: the watch tool registrations, argument validation, and the view projection |
| [`src/flow.ts`](src/flow.ts) | `flow_read` and `flow_edit`: the route views and the mapping from call fields to a route change |
| [`src/limits.ts`](src/limits.ts) | Bounds on what a tool call may ask for |

This is a fork-local package; see [`../UPSTREAM.md`](../UPSTREAM.md). Tests mount the real bus, sensor, and tool registry over memory storage and reuse the sensor's `tests/fake-github.ts`.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [lsy event bus](../lsy-event-bus/README.md) — subscriptions, batching, and result reports
- [GitHub sensor](../lsy-github-sensor/README.md) — polling, baselines, and tokens
- [Schedule tools](../../schedule/tool-schedule/README.md) — time-based checks

-----

<a id="model-experience"></a>
## Model Experience

### Watch tools

#### What the model sees

Three tool schemas whenever the calling Agent's preset mounts the package. `watch_create` takes `id` (required; 1-63 lowercase letters, digits, or hyphens), `github_repo`, `streams` (enum `releases`, `tags`, `commits`), `branch`, `github_notifications`, `action` (enum `notify`, `session`), `instructions`, `workspace_path`, `coalesce_seconds`, and `max_per_hour`; its description explains baselines, deduplication and batching, the WeChat delivery of notify batches and session answers, `NO_REPLY`, and that time-based checks belong to `schedule_create`. `watch_list` takes no arguments; `watch_delete` takes `id`.

#### Token effect

A fixed schema cost on every request from an Agent whose preset mounts the package. Agents under a preset that omits the row pay nothing.

#### KV Cache effect

Prefix-stable while tool definitions and visibility are unchanged. Mounting, disposal, or a configuration change that alters a default named in a description may invalidate reuse from the first changed schema token.

### Flow tools

#### What the model sees

Two more tool schemas under the same preset row. `flow_read` takes no parameters. `flow_edit` requires `op` (enum `set`, `remove`, `reset`, `pause`, `resume`), `id`, and `note`; `set` also takes `sources`, `kinds`, `subjects`, `action`, `result` (enum `notify`, `urgent`, `main`, `quiet`, `event`), `instructions`, `agent_preset`, `workspace_path`, `model`, `session_per` (enum `batch`, `route`, `subject`), `coalesce_seconds`, and `max_per_hour`. The default preset and workspace appear in their parameter descriptions.

#### Token effect

A fixed schema cost on every request from an Agent whose preset mounts the package, added to the watch tools.

#### KV Cache effect

Prefix-stable while tool definitions and visibility are unchanged. A configuration change to `defaultAgentPreset` or `defaultWorkspacePath` alters a parameter description and may invalidate reuse from the first changed schema token.

### Flow results

#### What the model sees

One lossless JSON text block per call. `flow_read` returns `routes`, `unrouted_kinds` (kind, source, count over the last day), and `history` (time, op, route, Session, note). A route carries `id`, `origin`, `action`, `sources`, `kinds`, `subjects`, `coalesce_seconds`, `max_per_hour`, `downstream`, `pending`, `batches_last_hour`, and when set `paused`, `removed`, `changed_at`, `result`, `result_kind`, `instructions`, `agent_preset`, `workspace_path`, `model`, `session_per`, and `last_batch`. `flow_edit` returns `route` (`null` after a removal) and `warnings`, or a refusal with `code` (`invalid_arguments`, `invalid_route`, `not_found`, `not_config`, `cycle`, `internal_error`) and `message`.

#### Token effect

Results stay in the calling Session's history until compaction; a `flow_read` result grows with the number of routes and is bounded by `flowHistoryShown` and `flowUnroutedShown` for its lists.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV Cache entries.

### Watch results

#### What the model sees

One lossless JSON text block per call. A watch view carries `id`, `origin` (`config` or `agent`), `target` (`{ kind: github_repo, repo, streams, branch? }`, `{ kind: github_notifications }`, or `{ kind: event_filter, sources, kinds, subjects }` for configured rules of another shape), `action`, `instructions` and `workspace_path` for session watches, `coalesce_seconds`, `max_per_hour`, `created_at`, and `status` (`pending_events`, `batches_last_hour`, `next_batch_at`, `last_batch` with time, event count, status, Session outcome, `silent`, and error, and `polling` with each stream's `polled`, `baseline`, and `last_poll`). `watch_create` returns the view plus `warnings` (for example an unconfigured token or GitHub's canonical name); `watch_list` returns `{ watches, credentials }` with each token's name and whether it is configured; `watch_delete` returns `{ id, deleted: true }`. A refused call returns `{ code, message }` with one of `invalid_arguments`, `invalid_id`, `invalid_target`, `invalid_streams`, `invalid_action`, `invalid_workspace`, `invalid_limits`, `duplicate_id`, `repo_unavailable`, `watch_not_found`, `config_owned`, or `internal_error`.

#### Token effect

Results stay in the calling Session's history until compaction; a `watch_list` result grows with the number of watches and streams.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV Cache entries.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **GitHub only** — the targets are GitHub repositories and notification threads; other sources need their own sensor and target.
- **Same-repository watches share events** — subscriptions match by repository and kind, so two watches of one repository, such as commits on two branches, both see commits from either branch.
- **No in-place update** — changing a watch means `watch_delete` and `watch_create`, which records a new baseline.
- **Watches are instance-wide** — any Agent whose preset mounts the tools sees and can delete every agent-created watch.
- **Any Agent under the preset can change the flow** — a Session an event started can edit routes too. The owner gets a note for each change from a Session the notifier does not relay, the message flow page lists the changes, and `reset` restores a deployment route.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is non-authoritative working context: undecided directions and notes for maintainers. Shipped behavior and accepted rationale live in the sections above, the package code, and the linked Agent Notes.

- Watches cover GitHub sources only (`github_repo`, `github_notifications`); a new sensor needs its own `watch_create` kind before the agent can subscribe to it without editing configuration.

</details>
