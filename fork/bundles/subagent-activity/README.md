---
description: "Profile layer for the event service's subagent panel: Right Sidebar → 子智能体, what each subagent is doing now, for how long, and how it ended."
kind: "package-bundle"
---

# @deepseek-ai/subagent-activity

English | [中文](README.zh.md)

## Summary

This layer adds Right Sidebar → 子智能体: a Session's subagents, what each is doing now, how long it has run and how it ended. Its header button shadows the `ui-subagent` hover catalog by slot id and priority; `ui-subagent` stays for the breadcrumb switcher and the Sidebar chat tab. The Host half registers the `subagentActivity` projection for subagent Sessions.

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
| `subagent-activity` | `@deepseek-ai/dsh-subagent-activity` | the 子智能体 panel and the `subagentActivity` projection |

### What it needs

The Web bundle's `ui-subagent`, which this panel shadows in one slot and leaves in place elsewhere.

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

- [Subagent activity package](../../../packages/fork/subagent-activity/README.md)

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- The panel lists subagent Sessions only; a root Session's own work is not shown.
