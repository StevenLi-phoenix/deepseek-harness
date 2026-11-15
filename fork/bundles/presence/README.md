---
description: "Profile layer for the event service's do-not-disturb state: the Sleep Focus signal, the quiet-hours window, and Settings → 勿扰."
kind: "package-bundle"
---

# @deepseek-ai/presence

English | [中文](README.zh.md)

## Summary

This layer mounts the owner's presence: whether they sleep, from the Sleep Focus that a helper pushes to the ingest source, a daily quiet-hours window in the deployment's zone, and the buttons in Settings → 勿扰. While asleep, non-urgent messages wait and are sent as one digest on waking; urgent kinds pass. The zone is set here as `America/New_York`.

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
| `presence` | `@deepseek-ai/dsh-presence` | sleep state, the quiet-hours window, Settings → 勿扰 |

### What it needs

The `presence` source row inside the skeleton's `event-ingest`, and its token `EVENT_INGEST_TOKEN_PRESENCE` in `$DSH_HOME/.env`; the same value lives in the helper's token file.

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

- [Presence package](../../../packages/fork/presence/README.md)
- [WeChat channel](../wechat/README.md)

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- Without the helper's pushes the state falls back to the quiet-hours window and goes stale after two hours.
- The zone is a deployment value: another home restates `timeZone` in its profile patch.
