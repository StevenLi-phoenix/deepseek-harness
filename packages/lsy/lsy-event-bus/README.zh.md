---
description: "事件驱动 agent 运行所用的持久事件总线：去重、回环抑制、用户编写的订阅、合批窗口、每小时限流，并分发给通知器或新的 webhook Session。"
kind: "package-reference"
---

# @deepseek-ai/dsh-lsy-event-bus

[English](README.md) | 中文

## 概述

把传感器产生的事件路由成手机通知或新的无人值守 agent Session，而且只经过你自己写的订阅。总线丢掉重复事件和 agent 自己造成的事件，把突发事件合成一批，并限制每小时的批次数，嘈杂的仓库不会刷爆手机或模型预算。状态在重启后保留。Session 的结果以一条带最终回答的消息送回。

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

在 Web profile 里挂载总线，同时挂一个传感器（如 `@deepseek-ai/dsh-lsy-github-sensor`）、一个通知器（如 `@deepseek-ai/dsh-lsy-telegram`），如果有 Session 订阅，还要挂 webhook runtime。

### 何时选用

外部事件需要唤醒 agent 或人、又没人盯着面板时选它。同一对话里的提醒不要用它；Host 的 schedule 服务已经负责投递这类提醒。

### 最小配置

```yaml
- insert:
    - id: webhook-runtime
      name: '@deepseek-ai/dsh-webhook'
    - id: lsy-event-bus
      name: '@deepseek-ai/dsh-lsy-event-bus'
      config:
        webUrl: https://dsh.example.ts.net/
        suppress: { actors: [my-agent-bot], markers: ['Dsh-Agent:'] }
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

| 字段 | 默认值 | 含义 |
|---|---|---|
| `subscriptions` | `[]` | 路由规则；只有它们能启动 actuator |
| `subscriptions[].sources` / `kinds` / `subjects` | `[]` | 不区分大小写的 `*` 通配；空列表匹配一切 |
| `subscriptions[].action` | 必填 | `notify` 或 `session` |
| `subscriptions[].coalesceMs` | `60000` | 第一条待处理事件之后、后续事件并入同一批的窗口 |
| `subscriptions[].maxPerHour` | `12` | 滚动一小时内的批次上限；超出的等待 |
| `subscriptions[].session` | `session` 时必填 | 绝对路径 `workspacePath`、`instructions`、preset 与 prompt 上限 |
| `suppress.actors` / `suppress.markers` | `[]` | agent 的身份与输出标记，命中的事件被丢弃 |
| `retainEvents` / `retainBatches` | `5000` / `1000` | 保留的历史；最旧的已结算记录先被清理 |
| `maxTextChars` | `4000` | 每个事件不可信正文的存储字符上限 |
| `notifySessionResult` | `true` | 把总线启动的 Session 第一轮的结果发给通知器 |
| `maxNoteEvents` | `10` | 一条通知里列出的事件数 |
| `webUrl` | 未设置 | 附在 Session 结果里的 Web UI 链接 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidshlsy-event-bus)是全部可用字段的权威来源。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

`publish()` 把每个新的 `source:key` 在 `lsy_event_bus` storage domain 里只存一次。actor 或正文命中 `suppress` 的事件记为 `suppressed`，没有订阅选中的记为 `unmatched`，其余事件为每个匹配的订阅加一行待处理记录，并启动该订阅的 flush 计时器。flush 先检查滚动一小时的上限，写入一行批次记录、删除待处理行，然后才调用 actuator，所以两步之间崩溃会丢掉这一批，而不是重复执行。`notify` 批次交给 `ctx.lsyNotifier`；`session` 批次以 kind `lsy-event` 交给 `ctx.webhookRuntime.dispatch()`，总线注册的 rule 再按订阅重建 Session 请求。总线跟踪这些 Session 的 `session/event`，在第一轮结束时回报结果。

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | 服务、配置、flush 计时器、actuator、Session 跟踪 |
| [`src/match.ts`](src/match.ts) | 通配匹配与回环抑制 |
| [`src/prompt.ts`](src/prompt.ts) | Session 请求、批次消息与结果消息的渲染 |
| [`src/storage.ts`](src/storage.ts) | 事件、待处理行与批次的 storage-domain 表 |

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [Webhook runtime](../../experimental/webhook/README.zh.md)——负责创建 Session
- [Storage domain](../../storage/storage-domain/README.zh.md)——持久表
- [Permission presets](../../interaction/permission-presets/README.zh.md)——无人值守的权限档位

-----

<a id="model-experience"></a>
## 模型体验

### Session prompt

#### 模型看到什么

`session` 订阅启动的每个 Session 收到一条用户消息：订阅里可信的 `instructions`，一句把事件数据标为不可信的说明，订阅 id，事件数量，以及一行 JSON，其中最多 `maxPromptEvents` 个事件，正文截断到 `maxTextChars`。

#### Token 影响

每个启动的 Session 一条随数据变化的用户消息，受上面两个上限约束。

#### KV Cache 影响

这条消息开启一个新 Session，它建立该 Session 可复用的前缀，不会使已有前缀失效。

-----

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延后工作

- **至多一次分发**——记录批次与调用 actuator 之间崩溃会丢掉这一批。
- **没有指向单个 Session 的 Web 链接**——结果链接到 Web 根路径；客户端没有按 Session 的 URL。
- **整个 domain 重写**——JSON 存储后端每次写入都重写整个 domain；保留量要有上限。

-----

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

fork 本地的包；`lsy` 组如何跟踪上游见 [`../UPSTREAM.md`](../UPSTREAM.md)。

</details>
