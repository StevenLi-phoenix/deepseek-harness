---
description: "面向模型的 watch_create、watch_list、watch_delete、flow_read、flow_edit 工具，让 agent 自己决定 fork 事件服务监控什么、每条通知怎么走：GitHub 仓库与通知线程，结果经微信送达或交给无人值守的 agent。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-watch

[English](README.md) | 中文

## 概述

对 agent 说一句“deepseek-harness 发 release 时告诉我”，它就自己设置好：`watch_create` 先检查仓库，开始轮询，再把新内容变成一条微信消息，或交给一个无人值守的 agent。已有的内容记为基线，永远不会上报；突发事件合成一批，每小时有上限。`watch_list` 列出每个 watch 的健康状况和 token 状态；`watch_delete` 删除一个。没有人需要编辑 YAML，watch 也不会悄悄出现：微信聊天以外的 Session 创建或删除 watch 时，你会收到一条通知，说明改了什么、是哪个 Session 做的。

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

把下面这一行加进应当管理 watch 的 agent preset 的插件列表，同一进程里还要挂载 `@deepseek-ai/dsh-event-bus` 和 `@deepseek-ai/dsh-github-sensor`。fork event profile 把它挂在 `unattended` preset 里。

### 何时选用

需要 agent 自己决定监控什么时选它，无论来自聊天请求，还是它处理某个事件后的后续工作。基于时间的检查用 `@deepseek-ai/dsh-tool-schedule`；这个包只对 GitHub 上的新条目作出反应。

### 三个工具

- `watch_create(id, github_repo | github_notifications, ...)`——关注 `owner/name`（`streams` 取 `releases`、`tags`、`commits`，默认 `releases`；commits 可选 `branch`），或用 `github_notifications: true` 关注 owner 的通知线程。`action: notify`（默认）每批发一条微信消息；`action: session` 配合 `instructions` 启动一个无人值守的 agent，它的最终回答送到 owner，回答 `NO_REPLY` 则保持静默。可选 `workspace_path`、`coalesce_seconds`、`max_per_hour`。仓库会先被探测，读不到时以 `repo_unavailable` 拒绝。
- `watch_list()`——所有 watch（含配置里的），带目标、动作、来源、状态和 credential 状态。
- `watch_delete(id)`——删除 `watch_create` 创建的 watch；配置里的 watch 返回 `config_owned`。

创建或删除成功后，工具通过 `ctx.ownerNotifier` 发送 `🆕 watch created: <id>` 或 `🗑 watch deleted: <id>`，内容是目标、动作、session 指示（截断到 200 个字符）和调用方 Session 的 id；通知器自己就会转发该 Session（`ownsSession()`，例如 owner 的聊天 Session）时不发。通知器缺失或发送失败都不会让调用失败。

### 最小配置

```yaml
- id: tool-watch
  name: '@deepseek-ai/dsh-tool-watch'
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `defaultWorkspacePath` | `/Users/dsh-runtime/work` | `session` watch 启动的 Session 所用的 Workspace，调用里另行指定时除外 |
| `defaultAgentPreset` | `unattended` | 这些 Session 的 agent preset |
| `defaultPermissionPreset` | `danger-full-access` | 这些 Session 的 permission preset |
| `defaultCoalesceSeconds` | `60` | 第一条新事件之后的合批窗口 |
| `defaultNotifyMaxPerHour` | `12` | `notify` watch 滚动一小时的批次上限 |
| `defaultSessionMaxPerHour` | `4` | `session` watch 滚动一小时的批次上限 |
| `defaultMaxPromptEvents` | `50` | watch 或路由启动的 Session，其提示内嵌入的事件数 |
| `defaultMaxTextChars` | `2000` | 该提示内每个事件文本的字符数 |
| `defaultRolloverDays` | `30` | 路由的长期 Session 存续天数，到期后下一批次替换它 |
| `defaultMaxSeedChars` | `20000` | 带入替换 Session 的摘要字符数 |
| `flowHistoryShown` | `20` | `flow_read` 返回的通知流程改动条数 |
| `flowUnroutedShown` | `20` | `flow_read` 返回的无路由事件种类数 |

### 通知流程

- `flow_read()`——从事件到主人的每条路由：接收什么、它的 Session 要做什么、回答去哪、最近情况如何；还有最近一天没有路由接收的事件类型，以及最新改动。
- `flow_edit(op, id, note, ...)`——改一条路由，包括部署写好的路由。`set` 改给出的字段或新建路由；`remove`、`reset`、`pause`、`resume` 分别是移除、恢复默认、暂停、恢复。`result` 取 `notify`、`urgent`、`main`、`quiet` 或 `event`，`event` 路由的回答由写明 `flow.<id>.result` 的路由接收。改动立即生效，部署不会盖回；通知器不转发的 Session 做的改动还会给主人发一条消息。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

挂载范围解析到 `ctx.eventBus` 和 `ctx.githubSensor` 后，插件注册三个 `defineTool` 定义。`watch_create` 校验参数，拒绝任何订阅已占用的 id；对仓库先调用 `probe()`，再关注 GitHub 规范的 `full_name`：`githubSensor.watch(id, …)` 存储轮询侧并开始基线轮询，`eventBus.subscribe()` 存储路由侧，`sources: [github]`、每个流一个 kind（`github.release`、`github.tag`、`github.commit`），subject 为该仓库；订阅被拒绝时回滚传感器的 watch。通知 watch 订阅 `github.notification.*`，不需要改动传感器。创建与删除调用逐个执行；审计通知在调用成功后发送，不等待通道，失败只记日志。视图由总线的订阅列表和传感器的流状态重建；存储细节不会到达模型，意外失败统一为 `internal_error`。

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：watch 工具注册、参数校验与视图投影 |
| [`src/flow.ts`](src/flow.ts) | `flow_read` 和 `flow_edit`：路由视图，以及调用字段到路由改动的映射 |
| [`src/limits.ts`](src/limits.ts) | 工具调用可请求值的上下限 |

这是 fork 本地的包；见 [`../UPSTREAM.md`](../UPSTREAM.md)。测试在内存存储上挂载真实的总线、传感器与工具注册表，并复用传感器的 `tests/fake-github.ts`。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [fork 事件总线](../event-bus/README.zh.md)——订阅、合批与结果回报
- [GitHub 传感器](../github-sensor/README.zh.md)——轮询、基线与 token
- [Schedule 工具](../../schedule/tool-schedule/README.zh.md)——基于时间的检查

-----

<a id="model-experience"></a>
## 模型体验

### Watch 工具

#### 模型看到什么

调用方 Agent 的 preset 挂载这个包时，看到三个工具 schema。`watch_create` 接受 `id`（必填；1-63 个小写字母、数字或连字符）、`github_repo`、`streams`（枚举 `releases`、`tags`、`commits`）、`branch`、`github_notifications`、`action`（枚举 `notify`、`session`）、`instructions`、`workspace_path`、`coalesce_seconds` 和 `max_per_hour`；它的描述说明基线、去重与合批、notify 批次和 session 回答经微信送达、`NO_REPLY`，以及基于时间的检查属于 `schedule_create`。`watch_list` 不接受参数；`watch_delete` 接受 `id`。

#### Token 影响

preset 挂载这个包的 Agent，每次请求都有一份固定的 schema 开销。preset 没有这一行的 Agent 不付出任何开销。

#### KV Cache 影响

工具定义与可见性不变时前缀稳定。挂载、dispose，或改变了描述里提到的默认值的配置变更，可能从第一个变化的 schema token 起使复用失效。

### Flow 工具

#### 模型看到什么

同一 preset 行下多出两个工具 schema。`flow_read` 没有参数。`flow_edit` 必填 `op`（枚举 `set`、`remove`、`reset`、`pause`、`resume`）、`id` 和 `note`；`set` 还接受 `sources`、`kinds`、`subjects`、`action`、`result`（枚举 `notify`、`urgent`、`main`、`quiet`、`event`）、`instructions`、`agent_preset`、`workspace_path`、`model`、`session_per`（枚举 `batch`、`route`、`subject`）、`coalesce_seconds` 和 `max_per_hour`。默认 preset 和工作区写在对应参数的描述里。

#### Token 影响

preset 挂载这个包的 Agent，每次请求在 watch 工具之外多一份固定的 schema 开销。

#### KV Cache 影响

工具定义与可见性不变时前缀稳定。修改 `defaultAgentPreset` 或 `defaultWorkspacePath` 会改变参数描述，可能从第一个变化的 schema token 起使复用失效。

### Flow 结果

#### 模型看到什么

每次调用一个无损 JSON 文本块。`flow_read` 返回 `routes`、`unrouted_kinds`（最近一天的种类、来源、次数）和 `history`（时间、操作、路由、Session、说明）。路由包含 `id`、`origin`、`action`、`sources`、`kinds`、`subjects`、`coalesce_seconds`、`max_per_hour`、`downstream`、`pending`、`batches_last_hour`，以及设置时才有的 `paused`、`removed`、`changed_at`、`result`、`result_kind`、`instructions`、`agent_preset`、`workspace_path`、`model`、`session_per` 和 `last_batch`。`flow_edit` 返回 `route`（移除后为 `null`）和 `warnings`，或带 `code`（`invalid_arguments`、`invalid_route`、`not_found`、`not_config`、`cycle`、`internal_error`）和 `message` 的拒绝。

#### Token 影响

结果在压缩前一直留在调用方 Session 的历史里；`flow_read` 的结果随路由数量增长，其列表受 `flowHistoryShown` 和 `flowUnroutedShown` 限制。

#### KV Cache 影响

只追加；新出现的内容位于可复用的请求前缀之后，不会使已有的 KV Cache 条目失效。

### Watch 结果

#### 模型看到什么

每次调用一个无损 JSON 文本块。watch 视图包含 `id`、`origin`（`config` 或 `agent`）、`target`（`{ kind: github_repo, repo, streams, branch? }`、`{ kind: github_notifications }`，或对其他形状的配置规则用 `{ kind: event_filter, sources, kinds, subjects }`）、`action`、session watch 的 `instructions` 与 `workspace_path`、`coalesce_seconds`、`max_per_hour`、`created_at`，以及 `status`（`pending_events`、`batches_last_hour`、`next_batch_at`、带时间/事件数/状态/Session 结局/`silent`/错误的 `last_batch`，以及每个流带 `polled`、`baseline`、`last_poll` 的 `polling`）。`watch_create` 返回视图加 `warnings`（例如 token 未配置，或 GitHub 的规范名称）；`watch_list` 返回 `{ watches, credentials }`，其中列出每个 token 的名称以及是否已配置；`watch_delete` 返回 `{ id, deleted: true }`。被拒绝的调用返回 `{ code, message }`，code 为 `invalid_arguments`、`invalid_id`、`invalid_target`、`invalid_streams`、`invalid_action`、`invalid_workspace`、`invalid_limits`、`duplicate_id`、`repo_unavailable`、`watch_not_found`、`config_owned` 或 `internal_error` 之一。

#### Token 影响

结果在压缩前一直留在调用方 Session 的历史里；`watch_list` 的结果随 watch 和流的数量增长。

#### KV Cache 影响

只追加；新出现的内容位于可复用的请求前缀之后，不会使已有的 KV Cache 条目失效。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

- **只支持 GitHub**——目标只有 GitHub 仓库与通知线程；其他来源需要各自的传感器与目标类型。
- **同一仓库的 watch 共享事件**——订阅按仓库和 kind 匹配，所以同一仓库的两个 watch（例如两个分支的 commits）都会看到任一分支的提交。
- **不能原地修改**——修改 watch 要先 `watch_delete` 再 `watch_create`，会重新记录基线。
- **watch 作用于整个实例**——preset 挂载了这些工具的任何 Agent，都能看到并删除所有 agent 创建的 watch。
- **preset 下的任何 Agent 都能改流程**——事件启动的 Session 也能改路由。通知器不转发的 Session 做的每次改动都会给主人发一条通知，消息流页面列出改动，`reset` 恢复部署写好的路由。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是不具权威性的工作上下文：尚未决定的探索方向与维护者备注。已交付的行为与既定理由以上文、包代码和相关 Agent Note 为准。

- 监控目前只覆盖 GitHub 来源（`github_repo`、`github_notifications`）；新增传感器后，要先给 `watch_create` 加上对应的种类，agent 才能不改配置就订阅它。

</details>
