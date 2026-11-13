---
description: "Settings section 课程 DDL for course deadline reminders: on or off and quiet now, the last and next check with a check-now button, the course sync's health and newest failure reason, the next deadlines with their next reminder, the latest reminders, the rules, and the All settings card of courses."
kind: "package-reference"
---

# @deepseek-ai/dsh-courses-settings

English | [中文](README.zh.md)

## Summary

See and change your course deadline reminders in one place. Settings → 课程 DDL says whether reminders are on and whether it is quiet now, when DSH last checked your course records and what it sent, whether the course sync works (with its last good run and the newest reason it failed), which deadlines come next and when each is reminded, and the reminders it sent, each one expandable. A button checks now. The reminder switch, checkpoints, quiet hours, and alert settings are edited in the card at the foot of the page.

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

Mount it at the root of a Web profile beside [`@deepseek-ai/dsh-courses`](../courses/README.md) and [`@deepseek-ai/dsh-plugin-config`](../plugin-config/README.md) (the All settings card). The fork event bundle does; the section appears in Settings after QQ.

```yaml
- id: courses-settings
  name: '@deepseek-ai/dsh-courses-settings'
```

It has no configuration. Check now runs the same poll as the timer, so it sends what is due.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The Host half registers `GET /api/courses` (the status from `ctx.courses.status()`, mapped to the wire types in `src/view.ts`) and `POST /api/courses.poll` (JSON only, so a cross-site form cannot start one; it awaits one poll and answers the new status) under `/api`, behind the Web UI sign-in. The browser half refreshes every 15 s while the section is open and the page visible, keeps the last answer through a failed read, and renders the All settings card for the entry `courses`. All copy is in `src/client/locales.ts` in eight languages.

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Host half: the two routes and the wire mapping |
| [`src/view.ts`](src/view.ts) | Wire types and paths shared by both halves |
| [`src/client/index.ts`](src/client/index.ts) | Browser entry: dictionaries, the loader, the section registration |
| [`src/client/courses.ts`](src/client/courses.ts) | Store, loader, and the text of each card |
| [`src/client/polling.ts`](src/client/polling.ts) | Refresh while open and visible |
| [`src/client/CoursesSection.tsx`](src/client/CoursesSection.tsx) | The section |

This is a fork-local package; see [`../UPSTREAM.md`](../UPSTREAM.md).

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Course service](../courses/README.md) — the rules behind every line on this page
- [All settings card](../plugin-config/README.md) — how the configuration is saved to the owner's patch

-----

<a id="model-experience"></a>
## Model Experience

None, as the section is browser chrome; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Last poll only** — the page shows the latest poll and the latest 20 messages; older polls are in the service log.
- **The upcoming list needs a poll** — after a restart it is empty until the first poll (60 s), or until Check now.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is non-authoritative working context: undecided directions and notes for maintainers. Shipped behavior and accepted rationale live in the sections above, the package code, and the linked Agent Notes.

None.

</details>
