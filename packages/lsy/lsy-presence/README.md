---
description: "Owner presence for the event service: asleep or awake from the Sleep Focus that focus-watch on the Mac mini reads from iCloud, a daily fallback window, and buttons in Settings; WeChat holds non-urgent messages while the owner sleeps and sends them as one digest on waking."
kind: "package-reference"
---

# @deepseek-ai/dsh-lsy-presence

English | [中文](README.zh.md)

## Summary

Stop the agent from buzzing your phone while you sleep. The Mac mini reads your Sleep Focus from iCloud (`focus-watch`) and reports every change plus a heartbeat every 30 minutes, a daily window (03:30-10:30 New York) takes over when it goes quiet, and **Settings → 勿扰** has buttons that win over both. While you sleep, WeChat holds every message that is not urgent and sends them as one digest when you wake; disk-full and Bilibili-risk alerts, and answers to something you just wrote, still arrive at once. The page shows what is waiting and the latest signal and heartbeat.

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

Mount the row next to `@deepseek-ai/dsh-lsy-wechat` and `@deepseek-ai/dsh-lsy-event-ingest`; the lsy event bundle mounts it. It needs the storage domain facility and, for the Settings route, the Host's `connection` service; the page needs `@deepseek-ai/dsh-lsy-wechat-settings` and the settings shell. It provides `ctx.lsyPresence`. Add the ingest source that carries `focus-watch`'s signals, a *sink* source whose events go to this service and never to the event bus, so no subscription can start a Session or send a note because of them:

```yaml
- id: lsy-presence
  name: '@deepseek-ai/dsh-lsy-presence'
  config:
    timeZone: America/New_York
- id: lsy-event-ingest
  config:
    sources:
      - id: presence
        tokenEnv: LSY_INGEST_TOKEN_PRESENCE
        sink: lsyPresence
```

| Field | Default | Meaning |
|---|---|---|
| `timeZone` | `America/New_York` | The owner's IANA zone; the window and the "quiet until" times are read in it |
| `window` | on, `03:30` to `10:30` | Daily fallback window, used when no Focus signal is fresh. It wraps past midnight when `start` is later than `end`. The Settings page can replace it, and what it saves wins over this default |
| `focusFreshHours` | `2` | How long a Focus signal holds without a newer one before the window decides again; the 30-minute heartbeat keeps refreshing it, so it lapses about two hours after `focus-watch` stops |
| `sleepMaxHours` | `14` | How long a Focus-on signal holds without a newer one; a heartbeat refreshes it, so a watcher that dies at night cannot silence the day |
| `manualMaxHours` | `12` | How long a Settings button holds when it names no end |
| `urgentKinds` | `host.disk.full`, `host.*.critical`, `bili.risk.*`, `bili.gate.readonly` | Globs of the event kinds sent even while you sleep |

`focus-watch` (a signed binary on the Mac mini under the owner's user, with Full Disk Access to read the Focus database iCloud syncs from the phone) pushes `POST http://127.0.0.1:3081/hooks/lsy` with `Authorization: Bearer <token>`. A change is `{"kind":"presence.sleep.on","key":"sleep-on-<ts>","subject":"owner","title":…}` (or `presence.sleep.off`, key `sleep-off-<ts>`); every 30 minutes it repeats the current state with the key `sleep-on-hb-<bucket>` or `sleep-off-hb-<bucket>` (the bucket number of the 30-minute interval, so a retry repeats the key). [RUNBOOK §18](../../../lsy/deploy/RUNBOOK.md) covers the token and the install.

**Heartbeats are idempotent.** A signal that repeats the state already held, which every heartbeat does, only refreshes how long the state holds and when the latest signal and heartbeat arrived. It does not move the state's start, end a Settings button, call the `onChange` listeners, or flush; a heartbeat `presence.sleep.off` while awake changes nothing. Only a signal that flips the state, or the first one, begins a new state and ends a button.

**Which answer wins.** A button that is still in force, then a fresh Focus signal, then the daily window. A Focus change that arrives after a button ends the button; a repeat of the held state does not. The Host's receipt time is the signal's time; the watcher's clock is not used, and the key only tells a heartbeat from a change.

**What is held.** Only the WeChat channel holds anything today ([`lsy-wechat`](../lsy-wechat/README.md#quiet-hours)). It calls `ctx.lsyPresence.isAsleep()` and `isUrgent(note)`, registers a holder (`registerHolder`) so the page can count and flush what is waiting, and listens with `onChange` to send the digest when you wake. A message is urgent when its sender marked it (`LsyNote.urgent`) or one of the event kinds it reports (`LsyNote.kinds`, set by the event bus for a notify subscription's batch) matches `urgentKinds`.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`src/state.ts` is the pure state machine: `evaluate(now, inputs, rules)` returns `{ asleep, source, since, until }`, and `nextChange()` returns the next instant the answer can change without a new input (a button lapsing, a Focus signal going stale, the window opening or closing). Clock times use `Intl.DateTimeFormat` in the owner's zone; on the two days a year that zone changes its offset, a window edge can land an hour off. The service keeps the inputs in the `lsy_presence` storage domain (table `inputs`, row `owner`: the latest Focus signal and the button; table `window`, row `window`: the window set in Settings), re-evaluates after every input and when a timer fires for the next change (at most one day out, `unref`ed), logs each change of answer or source once, and calls the `onChange` listeners only when the answer flips between asleep and awake; a throwing listener is logged and does not stop the others. If storing an input fails, the state stays in memory and the failure is logged.

The service implements `LsyIngestSink`. `lsy-event-ingest` gives a source that names `sink: lsyPresence` the validated event instead of publishing it, and answers `202 {"outcome":"asleep"|"awake"}`; any kind other than `presence.sleep.on` and `presence.sleep.off` is a `400`, and an unmounted service a `503`. The route `GET`/`POST /api/lsy.presence` sits under `/api`, so the connection's sign-in check guards it; each action (`sleep.now`, `wake.now`, `quiet.until`, `manual.clear`, `window.set`, `flush`) is checked against a schemastery schema and logged with its outcome and duration. No answer carries a token.

The Settings page is the section `lsy-presence` (order 53) of the browser-only package [`@deepseek-ai/dsh-lsy-wechat-settings`](../lsy-wechat-settings/README.md): eight languages, polling `api/lsy.presence` every 5 seconds while it is open and the page is visible. This package has no browser face; its `src/view.ts` and the copy in that package are byte-identical, and a test checks it.

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | The `lsyPresence` service: inputs, storage, timer, listeners, holders, ingest sink, urgent matching |
| [`src/state.ts`](src/state.ts) | The pure state machine and clock helpers |
| [`src/settings.ts`](src/settings.ts) | Route `/api/lsy.presence` and its actions |
| [`src/storage.ts`](src/storage.ts) | The storage domain |
| [`src/view.ts`](src/view.ts) | Types and constants shared by both halves |

This is a fork-local package; see [`../UPSTREAM.md`](../UPSTREAM.md).

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [lsy-wechat](../lsy-wechat/README.md) — holds non-urgent messages while you sleep and sends the digest on waking
- [lsy-event-ingest](../lsy-event-ingest/README.md) — the push route and its sink sources
- [lsy-event-bus](../lsy-event-bus/README.md) — `LsyNote.kinds` and `LsyNote.urgent`
- [lsy-sysmon](../lsy-sysmon/README.md) — the Settings section this one follows

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
- **The signal comes from one Mac** — `focus-watch` needs the Mac mini signed into iCloud and its Full Disk Access; when it stops, the state holds for `focusFreshHours` (asleep: up to `sleepMaxHours`) and then the daily window decides. The page says so after an hour without a signal.
- **Time-zone changes** — the window follows `timeZone`, not where the phone is; travelling means changing the setting.
- **Thirty minutes, fixed in WeChat** — what counts as "just wrote" is `awakeAfterMessageMs` of `lsy-wechat` (30 minutes); the text on the page names that default.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is non-authoritative working context: undecided directions and notes for maintainers. Shipped behavior and accepted rationale live in the sections above, the package code, and the linked Agent Notes.

- The laptop also receives the Focus state (`~/Library/DoNotDisturb/DB/Assertions.json`, mode `com.apple.sleep.sleep-mode`) but is not always on; the Mac mini is signed into iCloud and always on, so it hosts the watcher. An iOS Shortcut that posted from the phone was dropped because its automations sync and interfere.
- Making the urgent kinds editable from the page would need a stored override beside the configured list; today they are configuration only.

</details>
