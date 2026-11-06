---
description: "所有 Session 的时间说明：安静一段时间之后开启回合的输入，带着当前时间、Session 安静了多久、上一次交流在何时，以及“按它本身来读、重新确认外部状态”的提示交给模型。"
kind: "package-reference"
---

# @deepseek-ai/dsh-lsy-time-gap

[English](README.md) | 中文

## 概述

隔了很久才到的消息不是紧接着的追问，但模型从历史里看不出这一点。一条 prompt、一个事件或一个提醒在 Session 上次活动之后至少 `thresholdMs`（5 分钟）才开启回合时，这个包在它前面放一段简短说明：当前时间和时区、Session 安静了多久、上一次交流在何时，以及这条输入是新的开始。它覆盖 Web UI 对话、渠道 Session、总线和 webhook 的投递，以及提醒；owner 的微信消息仍由 [lsy-wechat](../lsy-wechat/README.zh.md) 自己的说明负责。

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

在 profile 根部挂一行，它的监听器就能看到每个 agent preset 的步骤。lsy 事件 bundle 按下面的默认值挂载它；设置 → 订阅与监控页面底部的“全部设置”卡片编辑这一行，保存到 owner 的 patch 并重新加载插件。

```yaml
- id: lsy-time-gap
  name: '@deepseek-ai/dsh-lsy-time-gap'
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `enabled` | `true` | 是否添加说明；`false` 时什么也不注册 |
| `thresholdMs` | `300000`（5 分钟） | 算作“安静了一段时间”的最短时长 |
| `timeZone` | `America/New_York` | 说明里时间所用的 IANA 时区；未知时区会让插件在加载时失败 |
| `excludePresets` | `qq-digest` | 其 Session 永远不加说明的 agent preset（汇总任务的 prompt 自带时间范围） |
| `senderPresets` | `qqbot` | prompt 承载别人的话的 agent preset，说明里称“the sender” |
| `deferChannels` | `wechat` | 会在所认领 Session 里 owner 的消息前自己写时间说明的 owner-relay 通道 |

### 哪些 Session 和输入会收到

监听器只处理这样的回合第一步：认领的消息里有一条进入的输入，Session 不属于 subagent，且 preset 没有被排除。安静时长从 Session 最后一条 assistant 消息和上一条进入的输入中较晚的那个算起，两者都读自 Session 日志；Session 的第一条输入没有起点可算，不加说明。插进正在运行的回合的消息是加入进行中的工作，所以后面的步骤都不加。决定措辞的是认领消息中第一条进入的输入，按它持久化的 `source` 和 Session header 分类，从不读它的文字：

| 来源 | Session | 措辞 |
|---|---|---|
| `user`（Web UI、渠道的 prompt） | 不在 `senderPresets` 里的任何 preset（Web UI 对话、`unattended`、`bili` 账号收到的 owner 大号私信） | the owner |
| `user` | 在 `senderPresets` 里的 preset（`qqbot`） | the sender |
| 带 `principal` 的 `user`（访客），或 request id 带 lsy-taint 的 `lsy-untrusted:` 前缀（另一个 Session 转来的消息） | 任何 | the sender |
| `webhook`（总线批次、webhook 规则）、`lsy-tool-monitor` | 任何 | this event |
| `schedule` | 任何 | this reminder |

其他来源（指令、快照、其他插件的提示、本插件自己的说明）是上下文，不是输入：既不开始计时，也不加说明。被 `deferChannels` 里的 owner-relay 通道认领的 Session 中，owner 的输入交给那个通道处理。`lsy-wechat` 以 `wechat` 认领它的对话 Session，并在 owner 的消息前写自己的说明，依据的是它自己记录的上一次发给 owner 的内容（包括别的 Session 发来、要到对话 Session 下一轮才进入的通知）；微信对话 Session 里的提醒、事件和其他 Session 转来的消息仍然由本插件加说明。微信的阈值是 `lsy-wechat.timeGapMs`，默认同样是 5 分钟。

每条说明记一行 info 日志 `lsy-time-gap: Session <id>, <owner|sender|event|reminder> input after <gap> of silence`，不含任何消息文字；交给通道处理的 Session 记 debug 日志。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

插件注册一个 Session projection `lsyTimeGap`（版本 1），保存两个时间：`lastIncomingAt`（来源是进入类输入的最新一条 `user/message`）和 `lastReplyAt`（最新一条 `assistant/message`），所以间隔在重启和重放之后依然成立，也不用读历史。它的 `agent/pre-step` 监听器先等 projection，再用 `next()` 委派，然后在进入的决定的第 1 步，按 `Date.now()` 计算间隔；这一步的消息还没进日志，所以状态就是这些消息之前的 Session 历史。说明插在决定的消息列表里、紧挨在进入的输入之前，来源是 `{ kind: 'lsy-time-gap', form: 'notice', summary: 'Time check: <gap> since the last exchange' }`。已经带有 `lsy-time-gap` 消息的决定不会再加第二条。交给通道的判断读 `ctx.get('ownerRelay')?.ownerOf(sessionId)`；没有 `owner-relay` 时什么也不交出去。

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件：配置、projection、pre-step 监听器 |
| [`src/notice.ts`](src/notice.ts) | 输入分类、间隔计算、说明文字 |
| [`src/format.ts`](src/format.ts) | `formatStamp` 和 `formatGap`，与 `lsy-wechat` 共用 |

这是 fork 本地的包；见 [`../UPSTREAM.md`](../UPSTREAM.md)。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [微信通道](../lsy-wechat/README.zh.md) — 微信对话 Session 自己的时间说明
- [回合来源](../lsy-taint/README.zh.md) — 同样的来源规则决定回合属于谁
- [时间上下文](../../context/time-context/README.zh.md) — 一些 preset 也挂载的上游时钟读数

-----

<a id="model-experience"></a>
## 模型体验

### 安静一段时间后的输入前的时间说明

#### 模型看到的内容

Session 安静了至少 `thresholdMs` 时，在回合第一步进入的输入之前出现一条 user 角色的说明。开头点明输入是什么（`the owner sent the message below at`、`the sender sent the message below at`、`this event arrived at` 或 `this reminder arrived at`）；`<now>` 和 `<last>` 是 `<zone>` 时区下 `Sun 2026-11-01 11:05` 这样的时间戳，`<gap>` 写成 `12 min`、`3 h 5 min` 或 `2 d 3 h`，`<previous>` 是 `your own reply` 或 `an earlier input that got no reply`。

##### owner 或 sender 的消息的原文

```markdown
Time check: the owner sent the message below at <now> (<zone>), after <gap> of silence in this Session. Before it, the last exchange here was <previous>, at <last>. Read the message on its own terms: it starts a new exchange unless it clearly refers back to something earlier. Things outside this conversation (files, processes, services, accounts, other people's messages) may have changed since then; check again before relying on what you saw earlier.
```

##### 事件或提醒的原文

```markdown
Time check: this event arrived at <now> (<zone>), after <gap> of silence in this Session. Before it, the last exchange here was <previous>, at <last>. Treat it as arriving now, not as part of the last exchange: what it concerns may have changed since then, so check the current state before acting on it.
```

#### Token 影响

消息的说明约 120 个 token，事件或提醒的约 90 个（约 500 和 350 个字符），每个回合最多一条，且只在安静一段时间之后出现；每条说明都留在历史里，直到压缩把它去掉。

#### KV Cache 影响

只追加：说明加在缓存的历史之后、新回合之中，系统提示词和工具列表从不改变，所以可复用的前缀仍可复用。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

- **微信有两个阈值** — owner 的微信消息用 `lsy-wechat.timeGapMs`（设置 → 微信），不用 `thresholdMs`；两者默认都是 5 分钟，改一个不会改另一个。要合成一个设置，需要 `lsy-wechat` 通过一个服务把它的记录交给本插件。
- **排队的输入** — 排在正在运行的回合后面的输入（`mode: 'queue'`）在它自己的回合开始时才计算，从它前面刚结束的回复算起，所以在队列里等得再久也显示不出间隔。
- **owner 还是 sender 由 preset 决定** — owner 在 Web UI 里往 `senderPresets` preset 的 Session 里打字，也会被称为“the sender”；只读来源和 preset，从不读文字。
- **后台任务的通知** — `tool-jobs` 的完成通知和其他插件的提示是上下文，它们开启的回合不加说明。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是不具权威性的工作上下文：尚未决定的探索方向与维护者备注。已交付的行为与既定理由以上文、包代码和相关 Agent Note 为准。

- 如果 owner 从不把微信的两个阈值设成不同的值，它们可以合并成一个设置。

</details>
