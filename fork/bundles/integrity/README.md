---
description: "Profile layer for the event service's integrity watch: digests of what steers the agent, and a hash of each Session's system prompt."
kind: "package-bundle"
---

# @deepseek-ai/integrity

English | [中文](README.zh.md)

## Summary

This layer mounts the integrity watch: digests of what steers the agent (both profile patches, the instruction files and skill directories of its workspaces, the memory file against its history, the scheduled tasks) and a hash of each Session's system prompt, with a daily count of the persona's forbidden stock lines. A change goes to the log only; the WeChat notice is off here.

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
| `integrity-watch` | `@deepseek-ai/dsh-integrity-watch` | the digests, the prompt hashes and the stock-line counter |

### What it needs

Nothing from another feature; it reads files the Host already mounts.

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

- [Integrity watch package](../../../packages/fork/integrity-watch/README.md)

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- `notify: false` here: changes are logged, not messaged.
- It records that something changed, not who or what edited it.
