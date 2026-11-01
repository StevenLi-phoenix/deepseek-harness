---
description: "事件驱动 agent 运行所用的持久事件总线：去重、回环抑制、来自配置或运行时创建的订阅、合批、每小时限流，分发给通知器、新的 webhook Session 或每个订阅一个的常驻 Session，并回报无人值守的轮次。"
kind: "package-reference"
---

# @deepseek-ai/dsh-lsy-event-bus

[English](README.md) | 中文

## 概述

把传感器产生的事件路由成手机通知或新的无人值守 agent Session，路由规则是你写在配置里的订阅，或 agent 自己用 `watch_create` 创建的订阅。总线丢掉重复事件和 agent 自己造成的事件，把突发事件合批并限制每小时批次数，嘈杂的仓库不会刷爆手机或模型预算。状态在重启后保留。订阅可以保留一个常驻 Session，每一批接着进行，每月用它的摘要换一个新的。Session 的结果和无人值守的提醒轮次都以一条带最终回答的消息送回，回答 `NO_REPLY` 时什么也不发。

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

在 Web profile 里挂载总线，同时挂一个传感器（如 `@deepseek-ai/dsh-lsy-github-sensor`）、一个通知器（如 `@deepseek-ai/dsh-lsy-wechat`），如果有 Session 订阅，还要挂 webhook runtime。把 `@deepseek-ai/dsh-lsy-tool-watch` 加进某个 agent preset，agent 就能自己管理订阅。

### 何时选用

外部事件需要唤醒 agent 或人、又没人盯着面板时选它。同一对话里的提醒不要用它；Host 的 schedule 服务已经负责投递这类提醒，这个总线只回报无人值守提醒轮次的结果。

### 最小配置

```yaml
- insert:
    - id: webhook-runtime
      name: '@deepseek-ai/dsh-webhook'
    - id: lsy-event-bus
      name: '@deepseek-ai/dsh-lsy-event-bus'
      config:
        webUrl: https://dsh.example.ts.net/
        suppress: { actors: ['my-agent-app[bot]'] }
        subscriptions:
          - id: releases
            kinds: [github.release, github.tag]
            action: notify
          - id: triage
            kinds: [github.notification.*]
            action: session
            coalesceMs: 300000
            maxPerHour: 4
            session:
              workspacePath: /Users/dsh-runtime/work
              agentPreset: unattended
              permissionPreset: danger-full-access
              instructions: Triage these notifications and tell me what needs my attention.
```

由 agent 在运行时创建订阅时，`subscriptions` 可以留空。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `subscriptions` | `[]` | 归配置所有的路由规则；agent 在运行时再添加 |
| `subscriptions[].sources` / `kinds` / `subjects` | `[]` | 不区分大小写的 `*` 通配；空列表匹配一切 |
| `subscriptions[].action` | 必填 | `notify` 或 `session` |
| `subscriptions[].coalesceMs` | `60000` | 第一条待处理事件之后、后续事件并入同一批的窗口 |
| `subscriptions[].maxPerHour` | `12` | 滚动一小时内的批次上限；超出的等待 |
| `subscriptions[].session` | `session` 时必填 | 绝对路径 `workspacePath`、`instructions`、preset 与 prompt 上限 |
| `subscriptions[].session.persistent.enabled` | `false` | 订阅的所有批次共用一个 Session，而不是每批一个（只限配置行） |
| `subscriptions[].session.persistent.rolloverDays` | `30` | 超过这么多天后，下一批开一个新 Session，带上旧 Session 最后一次的压缩摘要，旧 Session 被归档 |
| `subscriptions[].session.persistent.maxSeedChars` | `20000` | 带过去的摘要的字符上限 |
| `suppress.actors` / `suppress.markers` | `[]` | agent 的身份与输出标记，命中的事件被丢弃；优先用身份（由宿主设定），不要依赖标记（取决于模型写了什么） |
| `retainEvents` / `retainBatches` | `5000` / `1000` | 保留的历史；最旧的已结算记录先被清理 |
| `maxTextChars` | `4000` | 每个事件不可信正文的存储字符上限 |
| `notifySessionResult` | `true` | 把总线启动的 Session 第一轮的结果发给通知器 |
| `reportScheduledTurns` | `true` | 把每个无人值守的 Host schedule 提醒轮次、以及每个被 `lsy-tool-monitor` 通知唤醒的轮次（标题为 📡 加监控名）的最终回答发给通知器 |
| `maxNoteEvents` | `10` | 一条通知里列出的事件数；通知还带上这一批所有事件的类型（`LsyNote.kinds`），在主人睡觉时压消息的通道拿它去匹配自己的紧急类型 |
| `webUrl` | 未设置 | 附在 Session 结果里的 Web UI 链接 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-lsy-event-bus)是全部可用字段的权威来源。

### 运行时订阅

`ctx.lsyEventBus` 提供 `watch_create`、`watch_list`、`watch_delete` 使用的订阅存储：

- `subscribe(subscription, { createdBy? })`——按配置行的同一套规则校验，连同 `createdAt` 和创建它的 Session 一起存储，返回它的视图。校验失败时以 `LsySubscriptionError` 拒绝，code 为 `invalid_subscription`；id 已被配置或另一条已存储的订阅使用时 code 为 `duplicate_id`。
- `unsubscribe(id)`——返回 `removed`、`not_found` 或 `config_owned`；删除时一并丢弃该订阅的待处理事件和 flush 计时器。
- `listSubscriptions()`——先列配置行，再按创建时间列已存储的订阅，每条带 `origin`（`config` 或 `agent`）和 `status`：待处理事件数、已启动的 flush 时间、最近一小时的批次数，以及最后一批的时间、状态、Session 结局和静默标记。

匹配、flush、重启恢复和 webhook Session rule 都使用合并后的集合。

### 常驻 Session

设置 `session.persistent.enabled` 后，第一批照常通过 webhook runtime 创建订阅的 Session，等这个 Session 的第一条消息到达时，总线把它的 id 记进 `persistent` 表。之后每一批都作为新的一轮进入这个 Session（经 `ctx.sessionController.resolveAgent()` 调用 `Agent.followup()`），prompt 文本和消息来源都与新 Session 的第一条消息相同（`webhook`、provider `lsy-event`、批次 id 作 delivery id），所以 lsy-taint 这类轮次来源检查对两者一视同仁。压缩归 preset 管（`dsh-compaction-basic` 的 `thresholdRatio`）；总线记下该 Session 最近一次 `compaction/summary` 的文本并计数。

- **已不存在**——存储的 Session 找不到或已归档时被遗忘，这一批开一个新的。
- **暂不可用**——Session 此刻接不了新一轮（写入者被占用、没有 controller）时，这一批得到一个一次性 Session（`detached`），存储的那个保留。
- **轮换**——存储的 Session 满 `rolloverDays` 天后，下一批开一个新 Session，它的第一条消息以 `previous_summary_json` 带上最后一次压缩摘要，并标为由不可信数据派生。这个 Session 的第一条消息到达后，它成为订阅的 Session，旧的用 `ctx.workspaceRegistry.archiveSession()` 归档：DSH 没有删除 Session 的功能，归档保留日志可读，并阻止它再跑模型步骤。

`persistentSessions()` 列出每个订阅的 Session（id、开始时间、批次数、压缩次数、它替换的 Session），`persistentSubscriptionOf(sessionId)` 说出这是哪个订阅当前的 Session；lsy-tool-up 在写频道笔记或查证据前会问它。每个批次记录带有 `delivery`：`fresh`、`persistent-new`、`persistent`、`rollover` 或 `detached`。

### 结果回报

总线启动的 Session 结束第一轮、或常驻 Session 结束某一批的那一轮时，总线把结局记到批次上，在日志里记下订阅、Session、投递方式、最后一次请求的输入 token、是否跑了压缩以及这一轮按名字统计的工具调用，并把最终的 assistant 文本发给 `ctx.lsyNotifier`。Host schedule 提醒（`source.kind: schedule`）在没有被 [`ctx.ownerRelay`](../owner-relay/README.zh.md) 的任何通道认领的 Session（`ownerOf(sessionId)` 为 `undefined`）里开启一轮时，总线把这一轮的最终回答发出去，标题为 `⏰ <提醒 prompt 的第一行>`。两种情况下，最终回答恰好是 `NO_REPLY`（`LSY_SILENT_REPLY`）时什么也不发；批次记录 `silent: true`。owner 停下的轮次（以 `aborted` 结束、原因为 `user`，来自 Web UI 或微信 `/stop`）只记录、不报告，因为停它的人已经知道。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

`publish()` 把每个新的 `source:key` 在 `lsy_event_bus` storage domain 里只存一次。actor 或正文命中 `suppress` 的事件记为 `suppressed`，没有订阅选中的记为 `unmatched`，其余事件为每个匹配的订阅加一行待处理记录，并启动该订阅的 flush 计时器。订阅等于配置行加上 `subscriptions` 表里的行；`subscribe()` 和 `unsubscribe()` 与发布、flush 走同一条串行的存储链。flush 先检查滚动一小时的上限，写入一行批次记录、删除待处理行，然后才调用 actuator，所以两步之间崩溃会丢掉这一批，而不是重复执行。`notify` 批次交给 `ctx.lsyNotifier`；`session` 批次以 kind `lsy-event` 交给 `ctx.webhookRuntime.dispatch()`，总线注册的 rule 再按订阅重建 Session 请求。总线跟踪这些 Session 的 `session/event`，在第一轮结束时回报结果。它还跟踪来源为 `schedule` 的 `user/message` 事件，在那一轮结束时回报，提醒名取自 Host 框架文本里的 `reminder_prompt_json` 或 `reminders_json` 一行。

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | 服务、配置、订阅存储、flush 计时器、actuator、Session 与提醒跟踪 |
| [`src/validate.ts`](src/validate.ts) | 配置与 `subscribe()` 共用的订阅校验 |
| [`src/match.ts`](src/match.ts) | 通配匹配与回环抑制 |
| [`src/prompt.ts`](src/prompt.ts) | Session 请求、批次、结果与提醒消息的渲染；静默回答 |
| [`src/storage.ts`](src/storage.ts) | 事件、待处理行、批次、运行时订阅与常驻 Session 的 storage-domain 表 |

这是 fork 本地的包；`lsy` 组如何跟踪上游见 [`../UPSTREAM.md`](../UPSTREAM.md)。`@deepseek-ai/dsh-owner-relay` 引用了 `isSilentReply()` 和 `failureDetail()`，`@deepseek-ai/dsh-lsy-tool-watch` 调用 `LsyNotifier.ownsSession()`，所以它们保持稳定。因为中继依赖这个包，总线通过一个结构化的 `ownerOf()` 视图读取 `ctx.ownerRelay`，而不导入它。通知可选的 `origin` 为通道放进主人对话 Session 的副本指明发送方，从不显示给主人；递给主 agent 的消息另有一个可选的 `origin` 记号（`bili`、`cc`），它会进入通道所排 prompt 的请求 id，让 Host 能分清这一轮是它开启的，还是 owner 发起的。`LsyNotifier.tellMainAgent()` 是可选方法，总线从不调用它：有对话 Session 的通道（lsy-wechat）实现它，让另一个 Session（dsh-bili 的）能给 owner 的主 agent 递一条消息。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [Watch 工具](../lsy-tool-watch/README.zh.md)——agent 创建和删除订阅
- [Webhook runtime](../../experimental/webhook/README.zh.md)——负责创建 Session
- [基础压缩](../../compaction/compaction-basic/README.zh.md)——压缩常驻 Session；它的摘要接续到下一个
- [创作者工具](../lsy-tool-up/README.zh.md)——常驻 `bili-digest` Session 的工具
- [Storage domain](../../storage/storage-domain/README.zh.md)——持久表
- [Permission presets](../../interaction/permission-presets/README.zh.md)——无人值守的权限档位

-----

<a id="model-experience"></a>
## 模型体验

### Session prompt

#### 模型看到什么

`session` 订阅启动的每个 Session 收到一条用户消息：订阅里可信的 `instructions`，一句把事件数据标为不可信的说明（若订阅的 `session.trustedText` 已设置，即只有主人能向其来源发布事件，则改为一句把每个事件的正文当作主人请求的说明），订阅 id，事件数量，以及一行 JSON，其中最多 `maxPromptEvents` 个事件，正文截断到 `maxTextChars`。总线不往提醒轮次里加任何内容，只读取它的最终回答。配置行还可以设置 `session.model`（`{ provider, model }`，即已注册的 `llm-pi-ai` 线路），让它启动的 Session 走这条线路而不是 profile 的默认线路；此时 Session 不带默认值的 reasoning effort，用 `subscribe()` 创建的运行时订阅不能设置它。常驻订阅之后每一批的那一轮发送同样的消息；轮换后的第一条消息还在事件之前带上旧 Session 最后一次的压缩摘要，作为一行标为不可信派生数据的 JSON。

#### Token 影响

每批一条随数据变化的用户消息，受上面两个上限约束；轮换后另加最多 `maxSeedChars` 的摘要。常驻 Session 随每一批增长，直到它的 preset 压缩它。

#### KV Cache 影响

开启新 Session 的消息建立该 Session 可复用的前缀；常驻 Session 里每一批的那一轮追加在已有前缀之后，不会使它失效。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

- **至多一次分发**——记录批次与调用 actuator 之间崩溃会丢掉这一批。
- **轮次回报只在内存里**——总线启动的 Session 或提醒轮次运行期间重启，会丢失这一轮的回报。
- **没有删除 Session**——轮换掉的常驻 Session 只是归档、不删除；它的日志留在磁盘上，直到 owner 删除。
- **轮换的种子**——从没压缩过的 Session 只交出它的 id；总线没在运行时发生的压缩，摘要总线看不到。
- **提醒名取自 Host 框架文本**——schedule 消息格式变化后，回报退回 `⏰ Session <id>`。
- **没有指向单个 Session 的 Web 链接**——结果链接到 Web 根路径；客户端没有按 Session 的 URL。
- **整个 domain 重写**——JSON 存储后端每次写入都重写整个 domain；保留量要有上限。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是不具权威性的工作上下文：尚未决定的探索方向与维护者备注。已交付的行为与既定理由以上文、包代码和相关 Agent Note 为准。

- 只报告由总线启动的 Session 的第一轮、常驻 Session 每一批的那一轮、无人值守的提醒轮次和被监控唤醒的轮次；同一 Session 其他后续轮次只能在 Web UI 里看到。

</details>
