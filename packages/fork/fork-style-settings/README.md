---
description: "Speaking style settings section: the persona card with its history (edit, roll back, delete), traits, memes with their meaning and origin, tone samples with one-tap deletion, the meme miner's last run, the stock-line trend, and the plugin's configuration."
kind: "package-reference"
---

# @deepseek-ai/dsh-fork-style-settings

English | [中文](README.zh.md)

## Summary

See and correct DSH's voice on the phone. Settings → 说话风格 shows the persona card with its history, and the traits, memes, and tone samples [fork-style](../fork-style/README.md) keeps, each with a delete button that takes effect at once. Memes show where they were read and where their meaning came from. It also shows pending samples, the last collection and meme-mining runs, the stock-line trend, and the plugin's configuration.

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

The Host half registers three routes under `/api`, so the connection's owner check guards them (any other Peer gets 403; a test runs them through the real connection): `GET /api/fork.style` (the panel), `POST /api/fork.style.edit` with `{ "op": "remove" | "keep", "id" }`, `{ "op": "block", "term" }`, `{ "op": "card", "card" }`, `{ "op": "rollback", "version" }`, or `{ "op": "deleteVersion", "version" }`, and `POST /api/fork.style.collect` (starts a collection and a mining run and answers at once). They read `ctx.forkStyle` per request and answer 503 while fork-style is not mounted. The browser half is the `fork-style` Settings section (label 说话风格): a verdict card with the item count, the review mode, and 立即收集; pending samples with 留 and 删; the persona card with 编辑, 删除, and its history (each version against the one before, 回滚到这版 and 删 per past version); the columns 性格, 热梗 (the groups' jargon with each meme's source, meaning origin, and family, then HotWatch's titles), and 语气样本 (猫灯's hand-written replies first), each item with a 删 button; the last collection with its counts per filter reason; the meme miner's last run (texts read by kind, new, refreshed, proposed, model calls, searches, and refusals by rule); the trend; and, at the foot, the All settings card of the `fork-style` entry ([fork-config](../fork-config/README.md); the preset-row fields `mode`, `block`, `tools`, `dir`, and `ticsFile` are left out). A delete, keep, card edit, rollback, or version delete shows on the page before the Host answers and is undone if the Host refuses it. Both review modes work: under `required` new tone samples wait in the pending card.

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
- [All settings card](../fork-config/README.md) — the configuration editor at the foot of the page

-----

<a id="model-experience"></a>
## Model Experience

None, as the section is browser chrome; the samples reach the main agent through fork-style, not through this package.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Owner only** — the routes answer the signed-in owner Peer, like the rest of the DSH page.
- **On and off live in the configuration card** — the page shows whether the block is on and the review mode; changing them is `enabled` and `review` on the root `fork-style` row, which the card at the foot saves into the owner's patch (a plugin reload follows).
- **Nothing typed by hand but the card** — every other item's source is QQ, Bilibili, or a web page the agent read, so the page has no field to add a meme or a sample; the card is the one text the owner writes.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is non-authoritative working context: undecided directions and notes for maintainers. Shipped behavior and accepted rationale live in the sections above, the package code, and the linked Agent Notes.

- The section is its own package because a package with a browser half may not take runtime exports from Host packages without a reviewed exception in the dependency policy, and fork-style needs several.

</details>
