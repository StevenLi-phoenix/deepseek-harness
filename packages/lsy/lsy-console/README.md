---
description: "The event service in the browser: a message flow page that shows what is broken, how much came in and reached the owner, and where each event went; and Settings sections for a health overview of every integrated service, the event bus subscriptions and schedule reminders, and the service account's Claude Code sessions with a voice preview."
kind: "package-reference"
---

# @deepseek-ai/dsh-lsy-console

English | [中文](README.zh.md)

## Summary

Run the event service from the browser instead of an SSH session. **Message flow**, in the sidebar, shows whether anything is broken and what that touches, how much came in and how much reached you, and where each event went. **Settings → Service overview** shows a health card per service with a Manage link. **Settings → Subscriptions and monitors** lets you pause, resume, delete, or create event bus subscriptions and schedule reminders; configuration ones stay read-only. **Settings → Claude Code and voice** lists, starts, and stops the service account's Claude Code sessions and plays a voice test sentence.

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

Mount the row next to the Web bundles; the lsy event bundle mounts it. It needs the settings shell (`@deepseek-ai/dsh-client-ui-settings-general`, which declares the `settings.section` list) and, on the Host, the `connection` service, both of which the Web bundles compose. Every other service is optional: a card says "not installed" for one that is not mounted (the speaking-style page, `ctx.lsyStyle`, is one of them until it ships). Claude Code needs [`lsy-cc-admin`](../lsy-cc-admin/README.md), which the event bundle mounts next to this package.

```yaml
- id: lsy-console
  name: '@deepseek-ai/dsh-lsy-console'
```

| Field | Default | Meaning |
|---|---|---|
| `bili.url` | `http://127.0.0.1:8097` | bili-svc, probed at `<url>/healthz` |
| `ams.url` | `http://127.0.0.1:18090` | The AMS intake receiver; any answer below 500 counts as reachable. Empty leaves its card out |
| `probeTimeoutMs` | `2000` | Deadline of every probe |
| `subscriptions.*` | those of `watch_create` | `workspacePath`, `agentPreset`, `permissionPreset`, `coalesceSeconds`, `notifyMaxPerHour`, `sessionMaxPerHour`: what a subscription made from the form runs with |
| `previewText` | a short Chinese sentence | The sentence the voice preview speaks (at most the voice service's `tts.maxChars`) |

**Overview.** The cards poll every 10 seconds while the section is open and the page is visible. A card links to `bili`, `lsy-qq`, `lsy-wechat`, `lsy-style`, `lsy-sysmon`, `lsy-subscriptions`, `lsy-agents`, or `account` only when that section is registered. A service can add detail to its card by exposing an optional `health()` that returns `{ state: 'ok' | 'warn' | 'down', detail? }`; `bili` and `lsyNotifier` are read that way when they have one. The speaking-style card reads `ctx.lsyStyle.health()` of [`lsy-style`](../lsy-style/README.md) (`StyleHealth`, checked again on arrival; kept and pending sample counts, review mode, last refresh, tic trend; counts only): green when it answers, yellow when review is required and samples wait, red when it throws or answers an unexpected shape.

**Message flow.** The page opens from its own entry in the sidebar, because it is a place to look at rather than a preference to set. It answers what the owner wants to know, in this order. *Is anything broken, and what does that touch?* The line at the top names the first service that is down and the boxes that get nothing without it (`needs`), with the way to fix it; a box that is down breathes red, and a box that lost what it needs is dashed. With nothing down, the line carries the first warning instead, in amber. *How much came in, and how much reached me?* The funnel beside it counts events, batches handed to an agent, messages sent to the owner, batches judged not worth a message, messages held until the owner wakes, and failures, for the last hour, day, or week; all three spans arrive together, so switching one needs no request. *Which ways are in use?* Each box says one thing about now (`factOf` in [`src/client/flow-view.ts`](src/client/flow-view.ts)): what is wrong when something is, otherwise what passed it; a healthy box never says it is healthy. An arrow gets heavier the more passed it, a dot runs along an arrow used in the last 15 minutes (at most ten at once), and a source that saw nothing fades back. *Where did this one go, and what became of it?* The side lists the latest 50 events a subscription took with their outcome, and counts the ones nothing took instead of listing them. Following a row draws its way through the picture one arrow after another (`stopsOf`, `route`), from its source through the Sessions that took it, and on to the owner's WeChat when it reached them. The outcome is the category the bus knows; the agent's reason for it stays in its Session. Choosing a box, by click or by Enter, lights every path through it, shows the tool and call arrows that belong to it, and turns the side into that box: how it stands, the way to its Settings section when one is registered, what passed it, what is around it, and how it is wired behind a disclosure. Escape or a click on the background goes back. All motion stops under `prefers-reduced-motion`.

Routes the agent has changed are drawn from what they really do ([`src/client/flow-live.ts`](src/client/flow-live.ts)): a changed route loses the arrows the drawing guessed and gets the ones it runs, a new route gets a box of its own under the drawing, and a paused or removed one says so on its box. Choosing a box shows its current rule, and the list on the side ends with the latest flow changes and why they were made.

The topology is written down in [`src/client/flow-graph.ts`](src/client/flow-graph.ts): it is the owner's picture of the flow, drawn in the flow editor and exported as JSON, so a box may name something the running service does not do that way yet. The file is client data and adds no Host route; changing a drawn path means editing it. Each box says through `wired`, `via` and `gap` whether it is live, partly wired, or planned, what carries it, and how the service differs from the drawing, and `tests/flow-graph.client.spec.ts` fails on a box that says nothing. Planned boxes stay out of the first view behind a switch. Each box has a `cell`, a fixed column and row: one row per source, from where things come on the left to where they go on the right. The picture shrinks to fit its width down to 80%, below which the words get too small and it scrolls sideways instead. A box names what the bus knows about it through `tracks` (event sources and subscriptions). A box with a `title` of its own needs no dictionary entry; the others read `flow.node.<id>` and `.desc`. The layout and the walks are arithmetic in [`src/client/flow-model.ts`](src/client/flow-model.ts), which knows no graph of its own. `problems()` there reports a cycle, a dangling or repeated arrow, a box with no arrow, and a question without both answers, and the same spec fails on any of them. Health comes from `api/lsy.overview`, in the overview's store; counts come from `api/lsy.flow` ([`src/activity.ts`](src/activity.ts)), which reads the event bus and the presence service and returns titles, never event text. Both are read together every 10 seconds while the page is open. The model route card is not part of it: model routing is shared infrastructure, not a step of the message flow.

**Subscriptions.** Subscriptions defined in the bus configuration show "From configuration" and have no buttons. A subscription made by `watch_create` or from the form can be paused (it matches no new events and holds the ones already waiting), resumed, or deleted after a second click; deleting a watch also stops its repository poll, as `watch_delete` does. The form takes a name, source, kind, and subject globs (at least one), notify or session mode, and, for a session, the instructions; a session subscription runs with the configured preset and workspace. Schedule reminders (`schedule_create`) can be paused, resumed, and deleted; their times are changed by asking the agent. The section ends with **Time check**, the All settings card of [`lsy-time-gap`](../lsy-time-gap/README.md) (threshold, zone, excluded presets), which marks inputs that arrive after a quiet spell.

**Session auto-archive.** Below the monitors, the same section shows whether the bus archives chat Sessions that nobody touched for a while (`autoArchive` of `lsy-event-bus`): the rule (idle days, per-sweep limit, interval), the next check, the plugins that protect their own Sessions, the last sweep (Sessions checked and archived, and what it skipped, by reason), and the 30 most recently archived Sessions. **Preview** lists what a sweep would archive without archiving; **Archive now** runs one. Both buttons turn into "Checking…" at once and stay disabled until the Host answers. The settings card at the foot lists only the `autoArchive` fields of `lsy-event-bus`, so a change (days, dry run, limits) is one explicit save, which reloads the bus.

**Claude Code and voice.** The sessions are those of `dsh-runtime`'s own Claude Code, never the owner's. The page can stop only sessions the bridge started in its tmux server, and starts at most `lsy-cc-admin`'s `maxSessions` (3). The first task becomes Claude Code's prompt argument, so a session started here sees it as the owner's own text. The voice card shows whether speech and transcription answer, and the preview button synthesizes the fixed sentence and plays it in the browser; nothing is sent to a channel. Transcription is configuration, so the card shows the patch that turns it on and leaves it read-only.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The Host half registers `GET /api/lsy.overview`, `GET /api/lsy.flow`, `GET`/`POST /api/lsy.subscriptions`, and `GET`/`POST /api/lsy.agents` on the connection, so the `/api` sign-in check guards them. A POST must be `application/json` (a cross-site form cannot send it), at most 64 KiB, and is validated with schemastery; a refusal is `{ error, detail? }` with a stable code and a field path, never the value. Every action logs its name, target, outcome, and duration (`subscription.delete octo-tags -> ok (3 ms)`), never a token, an event, a task, or the preview sentence.

The overview reads every card in parallel. Each HTTP probe has `probeTimeoutMs` and the whole card has twice that plus half a second, so a hung service costs one deadline and shows red; a card that throws shows red and logs only the error class. Cards carry a state and facts (counts, names, seconds), never a URL, key, or message text. The build identity is the `builds.noindex/<sha>` directory of the entry file and the version of the `@deepseek-ai/dsh` package above it. Claude Code's login state is `full` when `~/.claude/.credentials.json` is non-empty, `token` when the OAuth token file is, else `none`; the files are only `stat`ed.

Subscriptions use the bus's own API: `listSubscriptions()`, `batches()` (for the fire count), `subscribe()`, `unsubscribe()`, and `setPaused()`; reminders use `ctx.schedule.catalog()` and `edit()` (`active`, `delete`). The browser removes or flips a row at once and the Host's answer replaces it; a refusal puts the row back and says why. Monitors started with `monitor_start` live in the conversation that started them, in a preset-scoped registry the Host cannot reach, so the page explains where to manage them instead of listing them. The auto-archive card reads `archiveStatus()` with the same GET and runs `sweepArchive()` for the POST action `archive.sweep` (`dryRun` true or false); titles of archived Sessions are cut to 80 characters and no Session text is sent.

Claude Code sessions come from `ctx.lsyClaudeCode` ([`lsy-cc-admin`](../lsy-cc-admin/README.md)), read through a small structural type so this package, which ships a browser half, imports no runtime value from a peer package. The same goes for the voice and bus errors, which the Host half tells by name.

The browser half registers three `settings.section` entries (`lsy-overview` order 35, `lsy-subscriptions` 58, `lsy-agents` 60) through `ctx.slots.inject`, and the message flow as a `main` page with a `sidebar.panellist` entry (`lsy-flow`, order 20, after Plugins and Automations). The page's links into Settings call `ctx.get('settingsNavigation')?.openSection(id)`, which the settings shell provides. The Manage link calls the `select(id)` the settings shell hands every section (next to `close`), and shows only when the target section is registered. The model route card is built in the browser from `api/lsy.balance`.

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Host half: the four routes, status codes, and error answers |
| [`src/overview.ts`](src/overview.ts) | The cards and their bounded probes |
| [`src/activity.ts`](src/activity.ts) | What the message flow counts: the funnel, sources and subscriptions per span, and the latest events |
| [`src/subscriptions.ts`](src/subscriptions.ts) | Lists and actions over the bus and the schedule service, and the auto-archive view and sweep |
| [`src/agents.ts`](src/agents.ts) | Claude Code and voice cards, start, stop, and the preview |
| [`src/claude-code.ts`](src/claude-code.ts) | The shape of `ctx.lsyClaudeCode` this page uses |
| [`src/request.ts`](src/request.ts), [`src/log.ts`](src/log.ts), [`src/probe.ts`](src/probe.ts), [`src/build-info.ts`](src/build-info.ts) | Body parsing and refusals, action logging, deadlines, build identity |
| [`src/views.ts`](src/views.ts) | Types and route paths shared by both halves |
| [`src/client/index.ts`](src/client/index.ts) | Browser entry: dictionaries, loaders, the section and page registrations, the preview player |
| [`src/client/resource.ts`](src/client/resource.ts) | Store, loader with optimistic actions, and the visibility-aware poller |
| [`src/client/Overview.tsx`](src/client/Overview.tsx), [`Subscriptions.tsx`](src/client/Subscriptions.tsx), [`Agents.tsx`](src/client/Agents.tsx) | The sections |
| [`src/client/Flow.tsx`](src/client/Flow.tsx), [`FlowCanvas.tsx`](src/client/FlowCanvas.tsx), [`FlowBox.tsx`](src/client/FlowBox.tsx), [`FlowDetail.tsx`](src/client/FlowDetail.tsx), [`flow-view.ts`](src/client/flow-view.ts) | The message flow page: the page shell, the picture, one box, the side panel, and what a box says about itself |
| [`src/client/flow-graph.ts`](src/client/flow-graph.ts), [`flow-model.ts`](src/client/flow-model.ts) | The message flow topology (data only), and the layout, path walking, and checks that work on any graph |
| [`src/client/cards.ts`](src/client/cards.ts), [`balance.ts`](src/client/balance.ts), [`subs.ts`](src/client/subs.ts) | Card text, the model route card, form rules |

This is a fork-local package; see [`../UPSTREAM.md`](../UPSTREAM.md).

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Settings domain](../../client/ui-settings/README.md) — the `settings.section` slot these sections fill
- [lsy-event-bus](../lsy-event-bus/README.md) — the subscriptions and `setPaused()`
- [lsy-cc-admin](../lsy-cc-admin/README.md) — the Claude Code sessions service
- [lsy-cc-bridge](../lsy-cc-bridge/README.md) — the launcher and tools the sessions come from
- [lsy-voice](../lsy-voice/README.md) — `describe()` and the speech service
- [lsy-sysmon](../lsy-sysmon/README.md) — the page whose cards and polling these sections follow

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
- **WeChat and bili cards say little until they report health** — a service reports more by adding `health()`.
- **The QQ card never reaches QQ** — it calls only the observer's in-memory `connectionStatus()` (the recorder's last pushed status, which may be `recorder-down` or `protocol-mismatch`, shown red) and `recordedGroups()` (a test fails on any other member, and neither makes a request), because the account is under QQ risk control; no page of this package calls the protocol end or NapCat's login door.
- **Preview waits for the voice model** — the first sentence after idle takes about 45 seconds on feiyu; one preview runs at a time.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is non-authoritative working context: undecided directions and notes for maintainers. Shipped behavior and accepted rationale live in the sections above, the package code, and the linked Agent Notes.

- The `select` prop is a fork edit of `ui-settings-general` and the slot contract (`packages/lsy/UPSTREAM.md`); an id no section registered shows the shell's first section, which is why the link checks first.
- Reaching monitors would need a service the `unattended` preset publishes into an isolate realm, which the preset registry's mount audit allows only per mount.

</details>
