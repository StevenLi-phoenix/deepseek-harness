---
description: "Right-Sidebar page 子智能体 listing a Session's subagents (running ones first, with what each is doing now and for how long; finished ones with how they ended), opened from a header button that replaces the upstream hover catalog, over the subagentActivity projection."
kind: "package-reference"
---

# @deepseek-ai/dsh-subagent-activity

English | [中文](README.zh.md)

## Summary

See what your agent's subagents are doing. One header button, “1 个在跑” or “10 个已结束”, opens the 子智能体 page of the right Sidebar. Running subagents come first: the task, the step, the tool running now and its arguments (or the model thinking, or a retry), how long it has waited (amber when too long), and the latest thought. Finished ones follow, each saying 完成, 出错, or 中断 and when, with time, tokens, and last reply or error. Nested subagents count; a branch running one opens itself. A row opens its conversation in the Sidebar; its arrow, the main view.

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

Mount it at the profile root beside the upstream [`@deepseek-ai/dsh-client-ui-subagent`](../../client/ui-subagent/README.md), which stays: it still owns the breadcrumb switcher of a child Session, the Sidebar chat tab the rows open, the read-only composer, and the `@` source. The fork event bundle mounts both.

```yaml
- id: subagent-activity
  name: '@deepseek-ai/dsh-subagent-activity'
```

It has no configuration. The page is also on the Sidebar guide (子智能体), so it can be opened in any Session, a child one included, where it lists that child's own subagents.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The Host half registers the `subagentActivity` projection. Its fold runs only for a Session whose header says `origin: 'subagent'` (or that has a subagent descriptor); every other Session keeps the `null` view, so ordinary Session summaries carry nothing. It follows `turn/start`, `step/start`, `tool/call`, `tool/result`, `assistant/message`, `llm/retry`, `llm/retry-started`, and `turn/end`, and returns the same state for any other event, so the Host-wide control stream sends a frame only when the page would change. A tool preview is the call's own `description`, else its `command`, path, query, or URL, at most 120 characters; a note is the reply text, else the start of the reasoning, at most 160.

The browser half shadows the upstream header entry: it registers `conversation.session.header.actions` with the same id, `subagent-catalog`, at priority -1, and the slot runtime renders the lowest priority. It registers the page as tab kind `subagent-activity`, a page type with one guide entry. Rows come from the parent's `subagentCatalog` projection, each child's summary (`subagentTiming`, `tokenUsage`, `subagentActivity`), and the Session status for running; opening the page reads the catalog and its direct children the same way the upstream menu prepared a level, each nested level reads itself the same way when it opens, and live control frames keep them current. The Session list already carries every Session's catalog, so the whole tree is counted without a read: the header, the summary line, and the running section count every depth, a row says how many below it run, and a branch with one running opens by itself to four levels and sits in the running section even when its top row has finished. The walk stops at 12 levels or 1000 Sessions, counts a Session met twice once, and logs a warning when it stops early. A row opens `dsh-resource://subagentchat/session/<child>?parent=<parent>&mode=<mode>`, the address `ui-subagent` registers.

| File | Role |
|---|---|
| [`src/activity.ts`](src/activity.ts) | Wire type and the projection key declaration, shared by both halves |
| [`src/projection.ts`](src/projection.ts) | The fold, previews, and schemas |
| [`src/index.ts`](src/index.ts) | Host half: registration |
| [`src/client/index.ts`](src/client/index.ts) | Browser entry: dictionaries, the page type and body, the header entry |
| [`src/client/model.ts`](src/client/model.ts) | Rows, states, ordering, and the text of each line |
| [`src/client/SubagentPanel.tsx`](src/client/SubagentPanel.tsx) | The page |
| [`src/client/SubagentToggle.tsx`](src/client/SubagentToggle.tsx) | The header button |

All copy is in `src/client/locales.ts` in eight languages. This is a fork-local package; see [`../UPSTREAM.md`](../UPSTREAM.md).

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Subagent catalog](../../client/ui-subagent/README.md) — the upstream presentation whose header entry this package replaces
- [Right Sidebar](../../client/ui-sidebar-right/README.md) — page types, guide entries, and `ctx.sidebarRight`
- [Session projections](../../session/session-projection/README.md) — how a projection folds, caches, and reaches the browser

-----

<a id="model-experience"></a>
## Model Experience

None, as the page and the projection only read subagent Session events; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Cold history has no activity** — a subagent that finished before this package was installed shows its time and tokens but no last reply until its Session is opened once.
- **No Stop on the page** — stop a running subagent from its conversation, which the row opens.
- **Stall thresholds are fixed** — five minutes on the model and fifteen on one tool call.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is non-authoritative working context: undecided directions and notes for maintainers. Shipped behavior and accepted rationale live in the sections above, the package code, and the linked Agent Notes.

None.

</details>
