---
description: "设置里的一个分区，用来审阅智能体记住的关于主人的内容：待批准的写入、可搜索/撤销/彻底删除的条目、带预览的回滚和人格反馈，全部在 Web UI 里完成。"
kind: "package-reference"
---

# @deepseek-ai/dsh-owner-memory-admin

[English](README.md) | 中文

## 概述

不开终端，也能审阅和撤销智能体记住的内容。**设置 → 记忆**最上面是等你决定的写入，标明来源和背后的 Session，可批准或丢弃。下面是记忆本身，可按文字和分类搜索，按需展开全文和历史，可撤销或彻底删除。回滚卡片撤销某个 Session 或某个时间之后的全部改动，先预览。一张卡片是你对人格回复的「保留 / 删除」判断，页面末尾是内容守卫过去 24 小时的拒绝统计和它的设置。

## 目录

- [使用这个包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用这个包

这个包是页面本身。把它的行和它所连的 Host 路由 `@deepseek-ai/dsh-owner-memory/settings` 挂在一起（见 [`owner-memory`](../owner-memory/README.zh.md) 的 README）；fork event bundle 两行都挂。它需要设置外壳（`@deepseek-ai/dsh-client-ui-settings-general`，声明了 `settings.section` 列表），Host 上需要 `connection` 服务，两者都由 Web bundle 组合提供。

```yaml
- id: owner-memory-admin
  name: '@deepseek-ai/dsh-owner-memory-admin'
- id: owner-memory-settings
  name: '@deepseek-ai/dsh-owner-memory/settings'
```

页面本身没有字段（守卫的字段属于 `content-guard` 条目）。Host 那一行的可选字段 `file` 指定记忆文件（默认 `<DSH_HOME>/owner-memory/memory.jsonl`，也就是智能体的 `owner-memory` 行使用的文件）。

各张卡片的作用：

| 卡片 | 显示 | 你可以 |
|---|---|---|
| 待审批 | 智能体在不是你一个人发起的回合里做的保护类写入（指令、偏好、身份），附来源、Session 和失效日期 | 逐条批准或丢弃；全部批准或丢弃（要点第二次确认） |
| 记忆条目 | 记忆，最近改动在前，带分类计数；每条文字的开头 | 搜索、按分类过滤、翻页；展开看全文和历史；撤销最近一次改动；看过会删掉什么之后彻底删除 |
| 回滚 | 改过记忆的 Session | 选一个 Session 或一个时间，预览改动，确认 |
| 回复反馈 | 你对人格回复的「保留 / 删除」判断 | 移除一条，或手动添加一条 |
| 内容守卫 | 过去 24 小时检查和拒绝的文字数、按规则名统计的拒绝次数、最近一次检查层故障（来自 `GET /api/content-guard`，[`content-guard`](../content-guard/README.zh.md)；没有挂这条路由时隐藏） | 在它下面的「全部设置」卡片里编辑 `content-guard` 条目（[`plugin-config`](../plugin-config/README.zh.md)） |

同样的操作也有命令行工具 `memory-admin`，作为备用（RUNBOOK 第 15 节）。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

页面访问 `GET`/`POST /api/owner-memory`，由 `@deepseek-ai/dsh-owner-memory/settings` 注册。路由在 `/api` 之下，所以 connection 对除了已登录的 owner Web UI 之外的所有人回 403。它不注册任何 agent 工具，也没有写入条目的动作，所以 agent 调不到它，等你决定的写入也不能被写下它的 Session 自己批准。`POST` 必须是同源的 `application/json`。动作用 schemastery 校验；日志记录动作、id 和结果及耗时，从不记录条目文字。

回滚和彻底删除分两步。没带 `confirm` 令牌的请求只是预览：Host 算出会改什么，连同一个令牌一起回答，令牌覆盖这个答案和它所依据的记忆内容。带着令牌再来时，Host 重新计算，令牌仍然吻合才应用，并且在写入前在记忆文件的锁内再核对一次；期间记忆变了，就什么都不应用（`409`），页面请你重新预览。

浏览器部分通过 `ctx.slots.inject` 注册一个 `settings.section` 条目（`owner-memory`，order 55）。外壳只挂载当前打开的分区，所以页面在打开且可见时每 10 秒轮询一次。一个 `MemoryLoader` 共享进行中的读取，丢弃已被替换的查询的应答，在你回答的瞬间隐藏待批准的写入、Host 拒绝时带着原因把它放回来，读取失败时保留上一次的视图。条目文字按文本渲染，从不当作标记。

| 文件 | 作用 |
|---|---|
| [`src/view.ts`](src/view.ts) | 线上数据类型和常量；`owner-memory/src/settings/view.ts` 是逐字节相同的副本（由测试保持一致） |
| [`src/index.ts`](src/index.ts) | Host 部分：一个空插件，让浏览器部分得以下发 |
| [`src/client/index.ts`](src/client/index.ts) | 浏览器入口：词典、对 Host 的调用、设置分区注册 |
| [`src/client/memory.ts`](src/client/memory.ts) | Store、loader（乐观隐藏、带令牌的预览）和感知页面可见性的轮询 |
| [`src/client/MemorySettings.tsx`](src/client/MemorySettings.tsx) | 分区本身；它的卡片是旁边的 `PendingCard`、`EntriesCard`、`RollbackCard` 和 `FeedbackCard` |
| [`src/client/locales.ts`](src/client/locales.ts) | 八种语言的文案 |

这是 fork 本地的包；见 [`../UPSTREAM.md`](../UPSTREAM.md)。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [owner-memory](../owner-memory/README.zh.md) — 记忆存储、这个页面背后的 Host 路由，以及 `memory-admin` CLI
- [turn-taint](../turn-taint/README.zh.md) — 怎样判定一个回合不是 owner 独自发起的，也就是什么会让写入留待这个页面处理
- [sysmon](../sysmon/README.zh.md) — fork 的另一个设置分区，这个分区沿用它的 store、轮询和版式

-----

<a id="model-experience"></a>
## 模型体验

无。这个分区是浏览器界面，这里的任何内容都不会进入模型请求。

#### KV Cache 影响

无；这个包既不组装也不发送提供方请求。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

- **一位 owner，一个文件** — 页面显示 Host 那一行指定的文件里的记忆；按预设分开的记忆文件不会各有一页。
- **彻底删除不可逆** — 被删的条目也会从历史和每日快照里抹掉，所以无法回滚；页面在删之前会显示将要删掉什么。
- **按 Session 或时间回滚** — 除了条目自己的历史之外，没有按条目浏览历史的界面。
- **手工编辑不会实时显示** — 页面每次刷新（每 10 秒）才读文件；不是合法条目的行会让页面报告记忆暂不可用，直到修好，与智能体的注入行为一致。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是不具权威性的工作上下文：尚未决定的探索方向与维护者备注。已交付的行为与既定理由以上文、包代码和相关 Agent Note 为准。

- Host 路由放在 `owner-memory`、页面放在这里，是因为带浏览器部分的包不能在 Host 上导入其他工作区包的值（已发布的依赖策略），而面向智能体的 `owner-memory` 插件挂在预设内部，路由会按预设各注册一次。
- 没做：Session 写入时的实时视图，以及语义搜索。

</details>
