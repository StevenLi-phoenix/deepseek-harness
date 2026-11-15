---
description: "Profile layer for the event service's Settings → System status: this Mac's CPU, memory, power, temperature and disks per volume."
kind: "package-bundle"
---

# @deepseek-ai/sysmon

English | [中文](README.zh.md)

## Summary

This layer adds Settings → System status: CPU, memory, power, temperature and disks per volume for the Mac the service runs on. Power and temperature come from a sudoless helper; the defaults name the volumes this deployment uses.

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
| `sysmon` | `@deepseek-ai/dsh-sysmon` | the System status card and its readings |

### What it needs

The `macmon` helper at `/Users/dsh-runtime/bin/macmon` for power and temperature; without it those two fields stay empty.

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

- [System monitor package](../../../packages/fork/sysmon/README.md)

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- Readings are the host's: no remote machine and no history, only the current values.
