---
description: "The owner's course records in DSH: ctx.forkCourses, a client of the courses service, and a deadline poller that reminds the owner on WeChat by fixed rules (checkpoints, late windows, quiet hours, once per task and checkpoint) and tells when the course sync is broken and when it recovers."
kind: "package-reference"
---

# @deepseek-ai/dsh-fork-courses

English | [中文](README.zh.md)

## Summary

Never miss a course deadline: DSH reads your course records every 15 minutes and messages you on WeChat 48, 24, and 3 hours before each deadline, and at once when a deadline passed while late submissions are still open. Finished work is left alone, each reminder goes out once even across restarts, and reminders wait while you sleep unless the deadline is under 3 hours away. A broken course sync is told once a day with the last good sync and the reason, and once when it recovers. Code decides when a reminder is due; the main agent tells you in its own words and answers your replies.

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

Mount it at the root of a process that also mounts the storage domain facility, the credential store, and a notifier such as [`@deepseek-ai/dsh-fork-wechat`](../fork-wechat/README.md); [`@deepseek-ai/dsh-fork-presence`](../fork-presence/README.md) adds the sleep check. Put a PAT with the audience `courses` in the credential store or `$DSH_HOME/.env` as `FORK_COURSES_PAT`. The fork event bundle mounts it with its defaults; the tools are [`fork-tool-courses`](../fork-tool-courses/README.md) and the Settings page is [`fork-courses-settings`](../fork-courses-settings/README.md).

```yaml
- id: fork-courses
  name: '@deepseek-ai/dsh-fork-courses'
```

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Send deadline and sync reminders; off stops the poller, and the tools keep working |
| `baseUrl` / `tokenEnv` / `agentName` | `https://api.lishuyu.app/courses` / `FORK_COURSES_PAT` / `DSH (fork-courses)` | The service, the PAT's name, and the `X-Courses-Agent` value its history records |
| `timeZone` | `America/New_York` | Zone of the times in messages and of the quiet window |
| `pollMinutes` / `firstPollSeconds` / `requestTimeoutMs` | `15` / `60` / `20000` | Poll period, first poll after start, timeout of one call |
| `lookaheadDays` | `7` | Days the poll reads ahead; a checkpoint larger than this fails the load |
| `beforeHours` | `[48, 24, 3]` | Hours before an on-time deadline at which the owner is reminded |
| `lateBeforeHours` | `[12, 3]` | Hours before a late window ends; the missed deadline itself is told at once |
| `urgentWithinHours` | `3` | A deadline this close goes out during quiet hours and sleep, marked urgent; `0` never |
| `quietHours.followPresence` | `true` | Wait while `ctx.forkPresence` says the owner sleeps (Settings → 勿扰) |
| `quietHours.enabled` / `start` / `end` | `false` / `01:00` / `09:00` | An extra daily quiet window of its own |
| `sync.alert` / `statuses` | `true` / `['failing', 'missing']` | Tell the owner when the sync health has one of these statuses |
| `sync.staleHours` / `repeatHours` | `24` / `24` | Hours since the last sync before the first alert and the stale line in reminders, and between alerts |
| `outageAlertAfter` | `4` | Failed polls in a row before the owner hears that reminders are paused (a token that was never set is only shown in Settings) |

### Rules

- **Checkpoints** — before an on-time deadline (`due_at`), a poll sends the smallest checkpoint already crossed, once. A first start or an outage that crossed several sends one message.
- **Late window** — once `due_at` passed and `late_at` or `closes_at` is still ahead, the task is told once as missed, then at the late checkpoints before the earlier of those two.
- **Done** — a task whose submission is `submitted` or whose progress is `completed` is never reminded; the service's `report` already leaves out work it counts as done.
- **Once** — a reminder's key is its phase, task, deadline, and checkpoint, stored after the channel accepted the message; a moved deadline starts its checkpoints again; a failed send is retried by the next poll.
- **One message per poll** — every reminder of a poll goes into one message, late windows first; a part (`parent_task_id`) reminded at its parent's deadline is folded into the parent's line.
- **Outlook** — after the reminders, every message lists "what else is due in the next 72 hours": the other unfinished tasks whose deadline (or, in a late window, whose late deadline) falls within 72 hours, soonest first, one line each with the time left, ⚠️ for a missed on-time deadline that can still be submitted late, at most 6 lines and then `另有 N 项`. It tells the owner which deadline is really the most urgent. The outlook only informs: its tasks are not marked as reminded and still get their own checkpoints.
- **Quiet** — while quiet, nothing is sent and nothing is marked; the first poll after it sends whatever checkpoint is current then.
- **Sync health** — a broken `report.coverage.health` (`sync.statuses`) whose last sync (`last_synced_run_at`: the newest run that checked something, a degraded one included) is `staleHours` old is told with that sync, the runs since that checked nothing, and the newest run's reason (the first failed, else not-checked, coverage detail, cut to 160 characters); then at most every `repeatHours`, and once when a newer sync follows. A status change alone ends no alert, and the last clean run never dates the records: a degraded run between two failing ones once sent "recovered" with the six-day-old clean date and, hours later, "six days without a sync". Reminders add the stale line on the same `staleHours` rule. DSH does not run or repair the sync.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

Each poll calls `report` with `view: deadlines`, `overdue: include`, `include_undated: exclude`, `coverage_limit: 1`, and `to` at `lookaheadDays`, reading up to five pages; parses the task summaries and the sync health at the wire with zod; plans with pure functions; sends through `ctx.forkNotifier` with `kinds` (`courses.deadline.due`, `courses.deadline.late`, `courses.sync.*`, `courses.service.*`) and an `origin` for the copy in the owner's chat Session; and stores the keys. Polls run one at a time. Every poll logs its trigger, duration, open tasks, reminders and their outcome, and the sync status; sent keys and held keys are logged by key, never with the token.

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Service `ctx.forkCourses`: configuration, the poll timer, delivery, sync and outage alerts, the Settings status |
| [`src/api.ts`](src/api.ts) | REST client: PAT per call, timeout, `X-Courses-Agent`, typed failures |
| [`src/records.ts`](src/records.ts) | Wire parsing of task summaries, sync health, and a sync run's failure reason |
| [`src/plan.ts`](src/plan.ts) | Reminder and sync-alert rules and the message text |
| [`src/time.ts`](src/time.ts) | Times in the owner's zone, the quiet window, spans |
| [`src/storage.ts`](src/storage.ts) | Storage domain `fork_courses`: sent keys, the latest 20 messages, poll, sync alert, outage |

This is a fork-local package; see [`../UPSTREAM.md`](../UPSTREAM.md).

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Course tools](../fork-tool-courses/README.md) — what the main agent reads and writes
- [Settings → 课程 DDL](../fork-courses-settings/README.md) — the checks, sync health, and configuration
- [Presence](../fork-presence/README.md) — when the owner sleeps

-----

<a id="model-experience"></a>
## Model Experience

### Reminder copy in the chat Session

#### What the model sees

Nothing is registered for a model. The WeChat channel hands each message to the owner's main agent as a turn of the chat Session (`chat.notes: turn`), framed with its sender (`origin`: the course deadline check, fixed rules over the owner's course records), and the main agent tells the owner in its own words; an urgent reminder's turn answers past the owner's sleep. When the owner then answers "交了", the main agent knows which tasks the message named and updates them with the course tools. With `chat.notes: direct` the message goes as written and the chat Session keeps a copy as a notice.

#### Token effect

The message text once per reminder, typically 100 to 400 characters, in the owner's chat Session only.

#### KV Cache effect

Append-only; the notice follows the reusable request prefix and does not invalidate existing KV Cache entries.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Accepted is not delivered** — the WeChat channel queues a message when the reply window is closed (the owner wrote nothing for about 24 hours, or its replies are used up) and sends it after the owner's next message; the stored key then marks a message that is waiting, not one the owner saw.
- **At least once** — a crash after the channel accepted a message and before the keys are stored sends that message again on the next poll.
- **Records only as fresh as the sync** — reminders follow what the course records say; a deadline the sync has not seen yet is not reminded, which is why a broken sync is told.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is non-authoritative working context: undecided directions and notes for maintainers. Shipped behavior and accepted rationale live in the sections above, the package code, and the linked Agent Notes.

- The courses service's own reminders (`save_reminder`, destination `platform_push`) push to the platform message bus directly; moving their delivery to DSH is a change in the courses service.

</details>
