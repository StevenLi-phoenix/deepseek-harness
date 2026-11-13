---
description: "右侧栏页面“子智能体”：列出一个会话派出的子智能体（在跑的排前面，写明各自正在做什么、做了多久；已结束的写明怎么结束），由替换上游悬停目录的顶栏按钮打开，数据来自 subagentActivity projection。"
kind: "package-reference"
---

# @deepseek-ai/dsh-subagent-activity

[English](README.md) | 中文

## 概要

不用悬停菜单，就能看到 agent 派出的子智能体在做什么。顶栏一个按钮（“1 个在跑”或“10 个已结束”）在右侧栏打开“子智能体”页面。在跑的排在前面：任务、第几步、此刻执行的工具和它参数里的一行（或者模型思考中，或者重试）、等了多久（太久变琥珀色）和最近的想法。已结束的随后列出，每行写着“完成”“出错”或“中断”和结束时间，以及用时、token、最后的回复或错误。下级子智能体也计入；有下级在跑的分支自己展开。点一行在侧栏打开它的对话，点箭头在主区打开。

## 目录

- [使用这个包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发笔记](#dev-note)

-----

<a id="use-this-package"></a>
## 使用这个包

把它挂在 profile 根上，与上游的 [`@deepseek-ai/dsh-client-ui-subagent`](../../client/ui-subagent/README.zh.md) 并存。上游包继续负责子会话的面包屑切换、行打开的侧栏对话标签、只读输入框和 `@` 来源。fork 事件 bundle 两个都挂。

```yaml
- id: subagent-activity
  name: '@deepseek-ai/dsh-subagent-activity'
```

它没有配置项。这个页面也在侧栏的引导页里（子智能体），所以任何会话都能打开，包括子会话，此时列出的是这个子会话自己的子智能体。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

Host 端注册 `subagentActivity` projection。它只对 header 里写着 `origin: 'subagent'`（或带有子智能体 descriptor）的会话折叠；其他会话保持 `null`，所以普通会话的摘要里没有这个值。它跟踪 `turn/start`、`step/start`、`tool/call`、`tool/result`、`assistant/message`、`llm/retry`、`llm/retry-started` 和 `turn/end`，遇到其他事件原样返回状态，所以 Host 的 control stream 只在页面会变时才发帧。工具预览取调用自带的 `description`，没有就取 `command`、路径、查询或 URL，最多 120 字；想法取回复文字，没有就取推理开头，最多 160 字。

浏览器端遮蔽上游的顶栏条目：用同一个 id `subagent-catalog`、优先级 -1 注册到 `conversation.session.header.actions`，slot 运行时渲染优先级最低的那个。页面注册成标签类型 `subagent-activity`，是一个带一条引导入口的页面类型。行数据来自父会话的 `subagentCatalog` projection、每个子会话的摘要（`subagentTiming`、`tokenUsage`、`subagentActivity`）和会话状态里的运行标记；打开页面时按上游菜单准备一层的方式读取目录和直接子会话，每个下级层展开时也这样读取自己，之后由 control stream 的实时帧保持更新。会话列表本来就带着每个会话的目录，所以整棵树不用额外读取就能计数：顶栏、摘要行和“正在运行”分区都按所有层级计数，一行会写出它下面有几个在跑，有下级在跑的分支自己展开（最多四层），即使分支顶上那一行已经结束，也排在“正在运行”分区。遍历最多走 12 层或 1000 个会话，同一个会话遇到两次只算一次，提前停下时在控制台打一条警告。一行打开的是 `dsh-resource://subagentchat/session/<child>?parent=<parent>&mode=<mode>`，也就是 `ui-subagent` 注册的地址。

| 文件 | 作用 |
|---|---|
| [`src/activity.ts`](src/activity.ts) | 线上类型和 projection 键声明，两端共用 |
| [`src/projection.ts`](src/projection.ts) | 折叠、预览和 schema |
| [`src/index.ts`](src/index.ts) | Host 端：注册 |
| [`src/client/index.ts`](src/client/index.ts) | 浏览器入口：词典、页面类型和内容、顶栏条目 |
| [`src/client/model.ts`](src/client/model.ts) | 行、状态、排序和每行文字 |
| [`src/client/SubagentPanel.tsx`](src/client/SubagentPanel.tsx) | 页面 |
| [`src/client/SubagentToggle.tsx`](src/client/SubagentToggle.tsx) | 顶栏按钮 |

全部文案在 `src/client/locales.ts`，共八种语言。这是 fork 本地的包，见 [`../UPSTREAM.md`](../UPSTREAM.md)。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [子智能体目录](../../client/ui-subagent/README.zh.md) — 这个包替换了它的顶栏条目
- [右侧栏](../../client/ui-sidebar-right/README.zh.md) — 页面类型、引导入口和 `ctx.sidebarRight`
- [会话 projection](../../session/session-projection/README.zh.md) — projection 怎么折叠、缓存、送到浏览器

-----

<a id="model-experience"></a>
## 模型体验

无，页面和 projection 只读取子智能体会话的事件，这里没有任何内容进入模型请求。

#### KV Cache 影响

无；这个包既不组装也不发送 provider 请求。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- **冷历史没有活动信息** — 在装这个包之前就结束的子智能体会显示用时和 token，但要等它的会话被打开一次才有最后回复。
- **页面上没有停止按钮** — 要停在跑的子智能体，从它的对话里停，点一行就能打开。
- **卡住的阈值是固定的** — 模型五分钟、单个工具十五分钟。

<a id="dev-note"></a>
### 开发笔记

<details>
<summary>给维护者的工作上下文 — 点击展开</summary>

本开发笔记是非权威的工作上下文：未决方向和给维护者的备注。已上线的行为和确定的理由以上面各节、包代码和链接的 Agent Notes 为准。

无。

</details>
