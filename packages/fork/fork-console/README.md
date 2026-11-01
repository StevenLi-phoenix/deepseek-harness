---
description: "Settings sections that manage what the event service runs: a health overview of every integrated service, the event bus subscriptions and schedule reminders with pause, resume, delete, and create, and the service account's Claude Code sessions with a voice preview."
kind: "package-reference"
---

# @deepseek-ai/dsh-fork-console

English | [中文](README.zh.md)

## Summary

Run the event service from the browser instead of an SSH session. **Settings → Service overview** shows a health card for each integrated service, with a Manage link to its own section. **Settings → Subscriptions and monitors** lists the event bus subscriptions and the schedule reminders and lets you pause, resume, delete, or create them; configuration ones stay read-only. **Settings → Claude Code and voice** lists, starts, and stops the service account's Claude Code sessions and plays a voice test sentence in your browser.

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

Mount the row next to the Web bundles; the fork event bundle mounts it. It needs the settings shell (`@deepseek-ai/dsh-client-ui-settings-general`, which declares the `settings.section` list) and, on the Host, the `connection` service, both of which the Web bundles compose. Every other service is optional: a card says "not installed" for one that is not mounted (the speaking-style page, `ctx.forkStyle`, is one of them until it ships). Claude Code needs [`fork-cc-admin`](../fork-cc-admin/README.md), which the event bundle mounts next to this package.

```yaml
- id: fork-console
  name: '@deepseek-ai/dsh-fork-console'
```

| Field | Default | Meaning |
|---|---|---|
| `bili.url` | `http://127.0.0.1:8097` | bili-svc, probed at `<url>/healthz` |
| `ams.url` | `http://127.0.0.1:18090` | The AMS intake receiver; any answer below 500 counts as reachable. Empty leaves its card out |
| `probeTimeoutMs` | `2000` | Deadline of every probe |
| `subscriptions.*` | those of `watch_create` | `workspacePath`, `agentPreset`, `permissionPreset`, `coalesceSeconds`, `notifyMaxPerHour`, `sessionMaxPerHour`: what a subscription made from the form runs with |
| `previewText` | a short Chinese sentence | The sentence the voice preview speaks (at most the voice service's `tts.maxChars`) |

**Overview.** The cards poll every 10 seconds while the section is open and the page is visible. A card links to `bili`, `fork-qq`, `fork-wechat`, `fork-style`, `fork-sysmon`, `fork-subscriptions`, `fork-agents`, or `account` only when that section is registered. A service can add detail to its card by exposing an optional `health()` that returns `{ state: 'ok' | 'warn' | 'down', detail? }`; `bili`, `forkQq`, and `forkNotifier` are read that way when they have one.

**Subscriptions.** Subscriptions defined in the bus configuration show "From configuration" and have no buttons. A subscription made by `watch_create` or from the form can be paused (it matches no new events and holds the ones already waiting), resumed, or deleted after a second click; deleting a watch also stops its repository poll, as `watch_delete` does. The form takes a name, source, kind, and subject globs (at least one), notify or session mode, and, for a session, the instructions; a session subscription runs with the configured preset and workspace. Schedule reminders (`schedule_create`) can be paused, resumed, and deleted; their times are changed by asking the agent.

**Claude Code and voice.** The sessions are those of `dsh-runtime`'s own Claude Code, never the owner's. The page can stop only sessions the bridge started in its tmux server, and starts at most `fork-cc-admin`'s `maxSessions` (3). The first task becomes Claude Code's prompt argument, so a session started here sees it as the owner's own text. The voice card shows whether speech and transcription answer, and the preview button synthesizes the fixed sentence and plays it in the browser; nothing is sent to a channel. Transcription is configuration, so the card shows the patch that turns it on and leaves it read-only.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The Host half registers `GET /api/fork.overview`, `GET`/`POST /api/fork.subscriptions`, and `GET`/`POST /api/fork.agents` on the connection, so the `/api` sign-in check guards them. A POST must be `application/json` (a cross-site form cannot send it), at most 64 KiB, and is validated with schemastery; a refusal is `{ error, detail? }` with a stable code and a field path, never the value. Every action logs its name, target, outcome, and duration (`subscription.delete octo-tags -> ok (3 ms)`), never a token, an event, a task, or the preview sentence.

The overview reads every card in parallel. Each HTTP probe has `probeTimeoutMs` and the whole card has twice that plus half a second, so a hung service costs one deadline and shows red; a card that throws shows red and logs only the error class. Cards carry a state and facts (counts, names, seconds), never a URL, key, or message text. The build identity is the `builds.noindex/<sha>` directory of the entry file and the version of the `@deepseek-ai/dsh` package above it. Claude Code's login state is `full` when `~/.claude/.credentials.json` is non-empty, `token` when the OAuth token file is, else `none`; the files are only `stat`ed.

Subscriptions use the bus's own API: `listSubscriptions()`, `batches()` (for the fire count), `subscribe()`, `unsubscribe()`, and `setPaused()`; reminders use `ctx.schedule.catalog()` and `edit()` (`active`, `delete`). The browser removes or flips a row at once and the Host's answer replaces it; a refusal puts the row back and says why. Monitors started with `monitor_start` live in the conversation that started them, in a preset-scoped registry the Host cannot reach, so the page explains where to manage them instead of listing them.

Claude Code sessions come from `ctx.forkClaudeCode` ([`fork-cc-admin`](../fork-cc-admin/README.md)), read through a small structural type so this package, which ships a browser half, imports no runtime value from a peer package. The same goes for the voice and bus errors, which the Host half tells by name.

The browser half registers three `settings.section` entries (`fork-overview` order 35, `fork-subscriptions` 58, `fork-agents` 60) through `ctx.slots.inject`. The settings shell hands a section only `close`, so the Manage link clicks the shell's own navigation button for the target section, found by its position in the `order`-sorted list. The model route card is built in the browser from `api/fork.balance`.

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Host half: the three routes, status codes, and error answers |
| [`src/overview.ts`](src/overview.ts) | The cards and their bounded probes |
| [`src/subscriptions.ts`](src/subscriptions.ts) | Lists and actions over the bus and the schedule service |
| [`src/agents.ts`](src/agents.ts) | Claude Code and voice cards, start, stop, and the preview |
| [`src/claude-code.ts`](src/claude-code.ts) | The shape of `ctx.forkClaudeCode` this page uses |
| [`src/request.ts`](src/request.ts), [`src/log.ts`](src/log.ts), [`src/probe.ts`](src/probe.ts), [`src/build-info.ts`](src/build-info.ts) | Body parsing and refusals, action logging, deadlines, build identity |
| [`src/views.ts`](src/views.ts) | Types and route paths shared by both halves |
| [`src/client/index.ts`](src/client/index.ts) | Browser entry: dictionaries, loaders, the three section registrations, the preview player |
| [`src/client/resource.ts`](src/client/resource.ts) | Store, loader with optimistic actions, and the visibility-aware poller |
| [`src/client/Overview.tsx`](src/client/Overview.tsx), [`Subscriptions.tsx`](src/client/Subscriptions.tsx), [`Agents.tsx`](src/client/Agents.tsx) | The sections |
| [`src/client/cards.ts`](src/client/cards.ts), [`balance.ts`](src/client/balance.ts), [`sections.ts`](src/client/sections.ts), [`subs.ts`](src/client/subs.ts) | Card text, the model route card, section links, form rules |

This is a fork-local package; see [`../UPSTREAM.md`](../UPSTREAM.md).

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Settings domain](../../client/ui-settings/README.md) — the `settings.section` slot these sections fill
- [fork-event-bus](../fork-event-bus/README.md) — the subscriptions and `setPaused()`
- [fork-cc-admin](../fork-cc-admin/README.md) — the Claude Code sessions service
- [fork-cc-bridge](../fork-cc-bridge/README.md) — the launcher and tools the sessions come from
- [fork-voice](../fork-voice/README.md) — `describe()` and the speech service
- [fork-sysmon](../fork-sysmon/README.md) — the page whose cards and polling these sections follow

-----

<a id="model-experience"></a>
## Model Experience

None, as the sections are browser chrome; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Sessions started here are not the agent's** — a subscription made from the form starts the same unattended Session as one from `watch_create`; a Claude Code session started here belongs to the service account, and the agent hears from it only if it messages the agent.
- **Monitors are not listed** — `monitor_start` registries belong to each preset mount; ask the conversation that started one to `monitor_list` or `monitor_stop`.
- **Fire counts are bounded by retention** — the count is the batches the bus still holds (`retainBatches`, 1000 by default), and "last fired" is the newest of them.
- **Transcription is read-only** — it is configuration, and a patch entry's `config` replaces the whole entry, so the card shows the patch instead of saving one.
- **WeChat and speaking-style cards say little until they report health** — a service reports more by adding `health()`; the QQ card reads `connectionStatus()` and `recordedGroups()` of the observer when it has them.
- **The Manage link follows the shell's markup** — it clicks the navigation button by position; a shell that drops `data-shortcut-modal="settings"` or reorders its rows needs `sections.ts` updated.
- **Preview waits for the voice model** — the first sentence after idle takes about 45 seconds on feiyu; one preview runs at a time.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is non-authoritative working context: undecided directions and notes for maintainers. Shipped behavior and accepted rationale live in the sections above, the package code, and the linked Agent Notes.

- Passing a section a `select(id)` through `SettingsSectionOwnerProps` would replace the navigation click; it needs a two-line edit in `ui-settings-general` and the slot contract.
- Reaching monitors would need a service the `unattended` preset publishes into an isolate realm, which the preset registry's mount audit allows only per mount.

</details>
