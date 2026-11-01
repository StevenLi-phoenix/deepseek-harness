---
description: "Owner presence for the event service: asleep or awake from the phone's Sleep Focus (an iOS Shortcut), a daily fallback window, and buttons in Settings; WeChat holds non-urgent messages while the owner sleeps and sends them as one digest on waking."
kind: "package-reference"
---

# @deepseek-ai/dsh-fork-presence

English | [中文](README.zh.md)

## Summary

Stop the agent from buzzing your phone while you sleep. Your iPhone's Sleep Focus tells it when you fall asleep and wake, a daily window (03:30-10:30 New York) covers days without a signal, and **Settings → 勿扰** has buttons that win over both. While you sleep, WeChat holds every message that is not urgent and sends them as one digest when you wake; disk-full and Bilibili-risk alerts, and answers to something you just wrote, still arrive at once. The page also shows what is waiting, the latest Focus signal, and the iPhone Shortcut steps.

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

Mount the row next to `@deepseek-ai/dsh-fork-wechat` and `@deepseek-ai/dsh-fork-event-ingest`; the fork event bundle mounts it. It needs the storage domain facility and, for the Settings route, the Host's `connection` service; the page needs `@deepseek-ai/dsh-fork-wechat-settings` and the settings shell. It provides `ctx.forkPresence`. Add the ingest source that carries the phone's signals, a *sink* source whose events go to this service and never to the event bus, so no subscription can start a Session or send a note because of them:

```yaml
- id: fork-presence
  name: '@deepseek-ai/dsh-fork-presence'
  config:
    timeZone: America/New_York
    ingestUrl: https://dsh.tailc2559b.ts.net/hooks/events
- id: fork-event-ingest
  config:
    sources:
      - id: presence
        tokenEnv: FORK_INGEST_TOKEN_PRESENCE
        sink: forkPresence
```

| Field | Default | Meaning |
|---|---|---|
| `timeZone` | `America/New_York` | The owner's IANA zone; the window and the "quiet until" times are read in it |
| `window` | on, `03:30` to `10:30` | Daily fallback window, used when no Focus signal is fresh. It wraps past midnight when `start` is later than `end`. The Settings page can replace it, and what it saves wins over this default |
| `focusFreshHours` | `20` | How long a Focus-off signal outranks the window |
| `sleepMaxHours` | `14` | How long a Focus-on signal holds when its off signal never comes (a dead phone), so one lost signal cannot silence the day |
| `manualMaxHours` | `12` | How long a Settings button holds when it names no end |
| `urgentKinds` | `host.disk.full`, `host.*.critical`, `bili.risk.*`, `bili.gate.readonly` | Globs of the event kinds sent even while you sleep |
| `ingestUrl` | unset | Full URL of the ingest route, shown in the Shortcut instructions |
| `ingestPath` | `/hooks/events` | Path of that route |
| `tokenEnv` | `FORK_INGEST_TOKEN_PRESENCE` | Name of the variable that holds the ingest token, shown in the instructions (the page never reads or shows the value) |

The phone pushes `POST /hooks/events` with `Authorization: Bearer <token>` and the body `{"kind":"presence.sleep.on","key":"<date>","subject":"owner","title":"Sleep Focus on"}` (or `presence.sleep.off`). The Settings page shows the exact URL, header, and bodies, and the seven Shortcut steps; [RUNBOOK §18](../../../fork/deploy/RUNBOOK.md) covers creating the token on the Mac mini.

**Which answer wins.** A button that is still in force, then a fresh Focus signal, then the daily window. A Focus signal that arrives after a button ends the button. The Host's receipt time is the signal's time; the phone's clock and key are not used.

**What is held.** Only the WeChat channel holds anything today ([`fork-wechat`](../fork-wechat/README.md#quiet-hours)). It calls `ctx.forkPresence.isAsleep()` and `isUrgent(note)`, registers a holder (`registerHolder`) so the page can count and flush what is waiting, and listens with `onChange` to send the digest when you wake. A message is urgent when its sender marked it (`ForkNote.urgent`) or one of the event kinds it reports (`ForkNote.kinds`, set by the event bus for a notify subscription's batch) matches `urgentKinds`.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`src/state.ts` is the pure state machine: `evaluate(now, inputs, rules)` returns `{ asleep, source, since, until }`, and `nextChange()` returns the next instant the answer can change without a new input (a button lapsing, a Focus signal going stale, the window opening or closing). Clock times use `Intl.DateTimeFormat` in the owner's zone; on the two days a year that zone changes its offset, a window edge can land an hour off. The service keeps the inputs in the `fork_presence` storage domain (table `inputs`, row `owner`: the latest Focus signal and the button; table `window`, row `window`: the window set in Settings), re-evaluates after every input and when a timer fires for the next change (at most one day out, `unref`ed), logs each change of answer or source once, and calls the `onChange` listeners only when the answer flips between asleep and awake; a throwing listener is logged and does not stop the others. If storing an input fails, the state stays in memory and the failure is logged.

The service implements `ForkIngestSink`. `fork-event-ingest` gives a source that names `sink: forkPresence` the validated event instead of publishing it, and answers `202 {"outcome":"asleep"|"awake"}`; any kind other than `presence.sleep.on` and `presence.sleep.off` is a `400`, and an unmounted service a `503`. The route `GET`/`POST /api/fork.presence` sits under `/api`, so the connection's sign-in check guards it; each action (`sleep.now`, `wake.now`, `quiet.until`, `manual.clear`, `window.set`, `flush`) is checked against a schemastery schema and logged with its outcome and duration. No answer carries a token.

The Settings page is the section `fork-presence` (order 53) of the browser-only package [`@deepseek-ai/dsh-fork-wechat-settings`](../fork-wechat-settings/README.md): eight languages, polling `api/fork.presence` every 5 seconds while it is open and the page is visible. This package has no browser face; its `src/view.ts` and the copy in that package are byte-identical, and a test checks it.

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | The `forkPresence` service: inputs, storage, timer, listeners, holders, ingest sink, urgent matching |
| [`src/state.ts`](src/state.ts) | The pure state machine and clock helpers |
| [`src/settings.ts`](src/settings.ts) | Route `/api/fork.presence` and its actions |
| [`src/storage.ts`](src/storage.ts) | The storage domain |
| [`src/view.ts`](src/view.ts) | Types and constants shared by both halves |

This is a fork-local package; see [`../UPSTREAM.md`](../UPSTREAM.md).

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [fork-wechat](../fork-wechat/README.md) — holds non-urgent messages while you sleep and sends the digest on waking
- [fork-event-ingest](../fork-event-ingest/README.md) — the push route and its sink sources
- [fork-event-bus](../fork-event-bus/README.md) — `ForkNote.kinds` and `ForkNote.urgent`
- [fork-sysmon](../fork-sysmon/README.md) — the Settings section this one follows

-----

<a id="model-experience"></a>
## Model Experience

None, as presence only decides when a message reaches the owner; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Only WeChat holds messages** — the QQ bot channel and the Bilibili direct messages ignore presence.
- **Files are not held** — `wechat_send_file` goes out through the open reply window at once, since a file cannot wait in the text outbox.
- **A held note is already in the chat** — the copy of a note that the channel leaves in the owner's chat Session says it was sent at its original time, though the owner reads it in the morning's digest.
- **The phone must reach the Host** — the Shortcut needs the iPhone connected to Tailscale; a signal the phone cannot send is lost, and the daily window then decides after `focusFreshHours`.
- **Time-zone changes** — the window follows `timeZone`, not the phone's location; travelling means changing the setting.
- **Thirty minutes, fixed in WeChat** — what counts as "just wrote" is `awakeAfterMessageMs` of `fork-wechat` (30 minutes); the text on the page names that default.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is non-authoritative working context: undecided directions and notes for maintainers. Shipped behavior and accepted rationale live in the sections above, the package code, and the linked Agent Notes.

- The laptop also receives the Focus state (`~/Library/DoNotDisturb/DB/Assertions.json`, mode `com.apple.sleep.sleep-mode`), but it is not always on and the Mac mini has no iCloud account, so the phone's own Shortcut is the source.
- Making the urgent kinds editable from the page would need a stored override beside the configured list; today they are configuration only.

</details>
