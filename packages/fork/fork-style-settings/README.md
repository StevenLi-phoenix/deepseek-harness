---
description: "Speaking style settings section: the real QQ and Bilibili exchanges that tune the main agent's voice, grouped by source with one-tap deletion, review of pending samples, lines of the owner's own, the last collection run, and the stock-line trend."
kind: "package-reference"
---

# @deepseek-ai/dsh-fork-style-settings

English | [中文](README.zh.md)

## Summary

See and correct what the main agent learns its voice from, on the phone. Settings → 说话风格 lists every speaking-style sample [fork-style](../fork-style/README.md) keeps: your own lines first, then QQ groups and Bilibili comments, each with a delete button that takes effect at once and keeps the sample from coming back. It also shows pending samples to keep or delete when review is required, a field to add a line of your own, what the last collection read and left out by reason, and per day how many answers still held a forbidden stock line.

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

Mount it at the root next to fork-style; it has nothing to configure.

```yaml
- id: fork-style-settings
  name: '@deepseek-ai/dsh-fork-style-settings'
```

The Host half registers three routes under `/api`, so the connection's sign-in check guards them: `GET /api/fork.style` (the panel), `POST /api/fork.style.edit` with `{ "op": "remove" | "keep", "id" }` or `{ "op": "add", "reply", "prompt"? }`, and `POST /api/fork.style.collect` (starts a run and answers at once). They read `ctx.forkStyle` per request and answer 503 while fork-style is not mounted. The browser half is the `fork-style` Settings section (label 说话风格): a verdict card with the sample count, the review mode, and 立即收集; pending samples with 留 and 删; the owner's own, QQ, and Bilibili samples with 删; the add field; the last run with its counts per filter reason; and the trend. A delete or keep shows on the page before the Host answers and is undone if the Host refuses it.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Host routes over `ctx.forkStyle`, and a compile-time check that the service's answers fit `src/view.ts` |
| [`src/view.ts`](src/view.ts) | Route paths and the panel's fields, shared by both halves |
| [`src/client/index.ts`](src/client/index.ts) | Registers the dictionaries and the section |
| [`src/client/style.ts`](src/client/style.ts) | Store, loader (reads, edits applied before the answer, runs), and the poller (5 s while the page is visible) |
| [`src/client/StyleSection.tsx`](src/client/StyleSection.tsx) | The section |

This is a fork-local package; see [`../UPSTREAM.md`](../UPSTREAM.md).

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Speaking style](../fork-style/README.md) — collection, filters, the store, and the block the main agent reads
- [QQ section](../fork-qq-login/README.md) — the sibling Settings section this one follows

-----

<a id="model-experience"></a>
## Model Experience

None, as the section is browser chrome; the samples reach the main agent through fork-style, not through this package.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Owner only** — the routes answer the signed-in owner Peer, like the rest of the DSH page.
- **On and off live in the profile patch** — the page shows whether the block is on and the review mode; changing them is `enabled` and `review` on the root `fork-style` row.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is non-authoritative working context: undecided directions and notes for maintainers. Shipped behavior and accepted rationale live in the sections above, the package code, and the linked Agent Notes.

- The section is its own package because a package with a browser half may not take runtime exports from Host packages without a reviewed exception in the dependency policy, and fork-style needs several.

</details>
