---
description: "Profile layer for the event service's Claude Code page: ctx.claudeCodeSessions, the service account's sessions listed, started and stopped from the console."
kind: "package-bundle"
---

# @deepseek-ai/cc-admin

English | [中文](README.zh.md)

## Summary

This layer mounts `ctx.claudeCodeSessions`, the root service the console page uses to list, start and stop the service account's Claude Code sessions. It goes through the root because `cc-bridge`'s tools live inside the `unattended` preset mount, which nothing outside it can reach; its defaults are the bridge's own.

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
| `cc-admin` | `@deepseek-ai/dsh-cc-admin` | `ctx.claudeCodeSessions` for Settings → Service overview |

### What it needs

The console page that reads it, and `cc-bridge` inside `preset-unattended` for the agent-facing tools.

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

- [Claude Code admin package](../../../packages/fork/cc-admin/README.md)
- [Claude Code bridge package](../../../packages/fork/cc-bridge/README.md)

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- The page shows the service account's own sessions; it does not attach to a session or read its transcript.
