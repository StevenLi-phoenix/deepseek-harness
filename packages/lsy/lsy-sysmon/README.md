---
description: "Settings section showing the Host machine's CPU, memory, power, temperature, and disk usage per volume, refreshed every five seconds while open; power and temperature come from macmon without sudo."
kind: "package-reference"
---

# @deepseek-ai/dsh-lsy-sysmon

English | [中文](README.zh.md)

## Summary

See how the machine running dsh is doing from any browser, without a terminal. **Settings → System status** shows CPU usage with core count and load averages, memory used against total with swap, whole-machine power with CPU, GPU, and Neural Engine watts and die temperatures, and one bar per volume with used, total, and free space, amber from 85% and red from 95%. It refreshes every five seconds while open and keeps the last reading if the Host stops answering. Power and temperature come from macmon without sudo; without it the card says how to install it.

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

Mount the row next to the Web bundles; the lsy event bundle mounts it. It needs the settings shell (`@deepseek-ai/dsh-client-ui-settings-general`, which declares the `settings.section` list) and, on the Host, the `connection` service, both of which the Web bundles compose.

```yaml
- id: lsy-sysmon
  name: '@deepseek-ai/dsh-lsy-sysmon'
```

| Field | Default | Meaning |
|---|---|---|
| `macmonPath` | unset: `<home>/bin/macmon` when it exists, else `/opt/homebrew/bin/macmon` | Absolute path of the [macmon](https://github.com/vladkens/macmon) binary that reads power, temperature, and memory |
| `mounts` | `/System/Volumes/Data` (`Internal`), `/Volumes/MiniSSD` (`MiniSSD`) | Volumes to show, in order: `mount` (the mount point) and `label`. A mount that cannot be read is shown as unavailable with the reason |
| `cacheMs` | `2000` | How long the Host serves a snapshot from cache; `?fresh=1` bypasses it at most every 2 s |

Install macmon for the user the service runs as: `brew install macmon`, or a release binary in that user's `~/bin`. Without it the section still shows CPU, disks, and an approximate memory figure (total minus free pages, which counts the macOS file cache as used).

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The Host half registers `GET /api/lsy.sysmon` on the connection, so the `/api` sign-in check guards it. A sample runs `macmon pipe -s 1 -i 500` through `execFile` with fixed arguments, a 5-second timeout, and a 1 MiB output cap (no shell; nothing from the request reaches the command), takes only finite numbers from its JSON line, and reads `os.cpus()` ticks, `os.loadavg()`, and `fs.statfsSync()` for each mount. CPU usage is the non-idle share of the ticks since the previous sample when that is under 30 s old, else across the macmon run itself; without either window it is `null`. Every reading the Host could not take is `null`, never `0`: zero watts in a virtual machine becomes `power: null`. A sample never throws; macmon's state is `sources.macmon` (`ok`, `missing`, `failed`) and a mount that fails `statfs` goes to `skippedMounts` with `not found`, `not permitted`, or `unreadable`. Each state change is logged once. Snapshots are cached for `cacheMs` and shared while in flight.

A volume's `used` is everything not available to the Host user (`total − bavail × bsize`), so `used + free = total`. On APFS this is the container's use, which is what fills up.

The browser half registers one `settings.section` entry (`lsy-sysmon`, after the built-in sections) through `ctx.slots.inject`, as the upstream pages do, so it follows the settings shell's lifetime. The shell mounts only the open section, so the section polls the document-relative `api/lsy.sysmon` every 5 seconds while it is open and the page is visible, and stops when it closes. One `SysmonLoader` shares a request in flight; a failed request keeps the last snapshot and the status line says when it was taken.

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Host half: configuration, the cached `/api/lsy.sysmon` route |
| [`src/sampler.ts`](src/sampler.ts) | One sample: CPU tick deltas, disks, memory fallback, cache, and change logging |
| [`src/macmon.ts`](src/macmon.ts) | Running macmon and parsing its JSON line |
| [`src/snapshot.ts`](src/snapshot.ts) | Snapshot types and the route path, shared by both halves |
| [`src/client/index.ts`](src/client/index.ts) | Browser entry: dictionaries, the loader, the Settings section registration |
| [`src/client/sysmon.ts`](src/client/sysmon.ts) | Store, loader, and the visibility-aware poller |
| [`src/client/cards.ts`](src/client/cards.ts) | Card contents, units, and threshold colours from a snapshot |
| [`src/client/SystemStatus.tsx`](src/client/SystemStatus.tsx) | The section |

This is a fork-local package; see [`../UPSTREAM.md`](../UPSTREAM.md).

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Settings domain](../../client/ui-settings/README.md) — the `settings.section` slot this section fills
- [lsy-balance](../lsy-balance/README.md) — the fork's other browser package, whose route and card this one follows

-----

<a id="model-experience"></a>
## Model Experience

None, as the section is browser chrome; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Power needs macmon on Apple Silicon** — other Hosts show CPU, disks, and approximate memory, and the Power card says why it is empty.
- **Container use, not volume use** — APFS volumes share their container's space, so a bar shows how full the container is; `df` reports each volume's own files.
- **A leftover mount point** — a directory left at an unmounted path reports the filesystem it sits on; macOS removes `/Volumes/<name>` on unmount, so this is rare.
- **Only while open** — nothing is sampled, kept, or alerted on while nobody has the section open.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is non-authoritative working context: undecided directions and notes for maintainers. Shipped behavior and accepted rationale live in the sections above, the package code, and the linked Agent Notes.

- A market search (`dsh-plugin-sourcing`) found 13+ system monitors; none fit: their routes had no sign-in check, and none read macOS disks per volume or power.
- References, read and not run: [MM998LI/dsh-dock-vitals](https://github.com/MM998LI/dsh-dock-vitals) (MIT) for fixed-argument `execFile` and sampling only when asked; [weihaobin0818-lgtm/dsh-system-monitor](https://github.com/weihaobin0818-lgtm/dsh-system-monitor) (MIT) for per-mount `statfs`; [vladkens/macmon](https://github.com/vladkens/macmon) (MIT) as the power source.
- On the Mac mini, macmon 0.10.0 is installed for `dsh-runtime` at `/Users/dsh-runtime/bin/macmon`.

</details>
