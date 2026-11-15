---
description: "Profile layer for the event service's Settings → Memory: the admin page for the owner's memory file and the route behind it."
kind: "package-bundle"
---

# @deepseek-ai/memory

English | [中文](README.zh.md)

## Summary

This layer adds Settings → Memory: waiting writes to approve or discard, entries to search, undo or erase, a Session's changes to roll back, and the keep/delete verdicts on persona replies. The page is the browser half; its `/api/owner-memory` route reads `<DSH_HOME>/owner-memory/memory.jsonl` and registers no tool, so no agent can reach it.

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
| `owner-memory-admin` | `@deepseek-ai/dsh-owner-memory-admin` | the Settings → Memory page |
| `owner-memory-settings` | `@deepseek-ai/dsh-owner-memory/settings` | the `/api/owner-memory` Host route |

### What it needs

The `owner-memory` row inside `preset-unattended`, which owns the memory file this page reads. That row stays in the skeleton with the preset.

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

- [Owner memory package](../../../packages/fork/owner-memory/README.md)
- [Owner memory admin package](../../../packages/fork/owner-memory-admin/README.md)

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- The page manages a file the Host mounts in front of root Sessions; it does not edit a Session's transcript.
- A protected write follows the `hold` setting of the `owner-memory` row, which this layer does not change.
