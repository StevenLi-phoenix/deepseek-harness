---
description: "Profile layer for the event service's course records: ctx.courses, the deadline poller with its fixed reminder rules, and Settings → 课程 DDL."
kind: "package-bundle"
---

# @deepseek-ai/courses

English | [中文](README.zh.md)

## Summary

This layer mounts the owner's course records and the deadline poller. Fixed rules decide every reminder, never a model: checkpoints before each deadline, a missed deadline told at once while its late window is open, submitted or completed tasks skipped, one message per task and checkpoint, quiet while the owner sleeps, urgent within three hours. A broken sync is told once, then at most daily, and its recovery once.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

### Install into the event profile

The layer ships with this repository: `fork/deploy/setup-profile.sh` links every directory under `fork/bundles/` into `$DSH_HOME/profiles/event/node_modules/@deepseek-ai/` and writes the profile manifest, so a deploy mounts it without a per-deployment edit. To add it by hand, link it and name it at the end of `dsh.profile.bundles`.

### What you get

| Row | Package | What it mounts |
|---|---|---|
| `courses` | `@deepseek-ai/dsh-courses` | the course records client and the deadline poller |
| `courses-settings` | `@deepseek-ai/dsh-courses-settings` | Settings → 课程 DDL: the checks and this row's config |

### What it needs

The courses service and its `COURSES_PAT` in `$DSH_HOME/.env`, `ctx.presence` for quiet hours, and the `tool-courses` row inside `preset-unattended`.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The rows are the ones this feature had inside `@deepseek-ai/dsh-event-bundle`, moved here verbatim and in the same relative order. The profile applies every layer as one flattened patch list in `dsh.profile.bundles` order, and an `insert` appends, so this layer mounts after the skeleton rows it uses and before the owner's profile patch. `fork/bundles/event/README.md` holds the mount order and the reasoning.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Courses package](../../../packages/fork/courses/README.md)
- [Courses tools](../../../packages/fork/tool-courses/README.md)

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- DSH only reads the records' sync health; the sync agents run elsewhere.
- A hand-edited deadline is not a fact: the record shows what the sync last read.
