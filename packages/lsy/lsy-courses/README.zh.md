---
description: "DSH 里的主人课程记录：ctx.lsyCourses，courses 服务的客户端，以及一个按固定规则（提醒时间点、迟交窗口、静默时段、每个任务每个时间点只发一次）在微信上提醒 DDL 的轮询器；课程同步坏了会告诉主人，恢复时也会说。"
kind: "package-reference"
---

# @deepseek-ai/dsh-lsy-courses

[English](README.md) | 中文

## 概述

不再错过课程 DDL：DSH 每 15 分钟读一次你的课程记录，在每个截止前 48、24、3 小时用微信提醒你；截止已过但还能迟交时，立刻提醒。做完的不提醒，每条提醒即使重启也只发一次，你睡觉时提醒先等着，除非离截止不到 3 小时。课程同步坏了，每天最多告诉你一次最近一次成功同步的时间和原因，恢复时再说一次。发什么由代码决定；agent 只回答你的回复。

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

把它挂在进程根上，该进程还要挂载 storage domain、凭据存储和一个通知通道，比如 [`@deepseek-ai/dsh-lsy-wechat`](../lsy-wechat/README.zh.md)；有 [`@deepseek-ai/dsh-lsy-presence`](../lsy-presence/README.zh.md) 时会多一个睡眠判断。把 audience 为 `courses` 的 PAT 以 `LSY_COURSES_PAT` 放进凭据存储或 `$DSH_HOME/.env`。lsy event bundle 按默认值挂载它；工具在 [`lsy-tool-courses`](../lsy-tool-courses/README.zh.md)，设置页是 [`lsy-courses-settings`](../lsy-courses-settings/README.zh.md)。

```yaml
- id: lsy-courses
  name: '@deepseek-ai/dsh-lsy-courses'
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `enabled` | `true` | 发送 DDL 和同步提醒；关掉后轮询器停止，工具照常可用 |
| `baseUrl` / `tokenEnv` / `agentName` | `https://api.lishuyu.app/courses` / `LSY_COURSES_PAT` / `DSH (lsy-courses)` | 服务地址、PAT 的名字，以及服务历史里记录的 `X-Courses-Agent` |
| `timeZone` | `America/New_York` | 消息里的时间和静默时段按这个时区 |
| `pollMinutes` / `firstPollSeconds` / `requestTimeoutMs` | `15` / `60` / `20000` | 轮询间隔、启动后第一次轮询的延迟、单次调用超时 |
| `lookaheadDays` | `7` | 轮询往后读多少天；有提醒时间点超出这个范围时加载失败 |
| `beforeHours` | `[48, 24, 3]` | 准时截止前多少小时提醒 |
| `lateBeforeHours` | `[12, 3]` | 迟交窗口结束前多少小时提醒；错过准时截止本身会立即提醒 |
| `urgentWithinHours` | `3` | 离截止这么近时，静默时段和睡眠中也发，并标为紧急；`0` 表示从不 |
| `quietHours.followPresence` | `true` | `ctx.lsyPresence` 说主人在睡觉时先等着（设置 → 勿扰） |
| `quietHours.enabled` / `start` / `end` | `false` / `01:00` / `09:00` | 另加一个自己的每日静默时段 |
| `sync.alert` / `statuses` | `true` / `['failing', 'missing']` | 同步健康状态是其中之一时告诉主人 |
| `sync.staleHours` / `repeatHours` | `24` / `24` | 距最近一次成功同步多少小时后发第一次提醒，以及两次提醒的间隔 |
| `outageAlertAfter` | `4` | 连续多少次轮询失败后告诉主人提醒暂停了（从未设置过的 token 只在设置页显示） |

### 规则

- **时间点**：准时截止（`due_at`）之前，每次轮询发已经越过的最小那个时间点，只发一次。首次启动或一次中断越过了好几个时间点时，只发一条。
- **迟交窗口**：`due_at` 已过而 `late_at` 或 `closes_at` 还没到时，先提醒一次“已错过”，再在两者中较早那个之前的迟交时间点提醒。
- **已完成**：提交状态为 `submitted` 或进度为 `completed` 的任务从不提醒；服务的 `report` 本来就不列它算作完成的工作。
- **只发一次**：提醒的键由阶段、任务、截止时间和时间点组成，通道接收消息之后才存；截止时间改了就重新开始；发送失败由下一次轮询重试。
- **每次轮询一条消息**：一次轮询的所有提醒合成一条消息，迟交窗口在前；和父任务同一截止时间提醒的子任务（`parent_task_id`）并进父任务那一行。
- **接下来**：每条消息在提醒之后附一份“接下来 72 小时内还有什么”：其余未完成、截止时间（迟交窗口内则是迟交截止）在 72 小时内的任务，按截止时间排序，每项一行并带剩余时间；准时截止已过但还能迟交的标 ⚠️；最多 6 行，超出写 `另有 N 项`。主人由此随时看得出真正最紧急的是哪一项。这份清单只是参考：里面的任务不算“已提醒”，仍按各自的时间点发自己的提醒。
- **静默**：静默期间什么都不发，也不记为已发；静默结束后的第一次轮询发当时所处的时间点。
- **同步健康**：`report.coverage.health` 坏了 `staleHours` 之后，发一条消息，写明最近一次成功同步、失败次数和最新一次运行的原因（coverage 里第一条 failed，否则第一条 not_checked 的 detail，截到 160 字符）；之后最多每 `repeatHours` 一次，下一次成功同步后发一次恢复。DSH 不运行也不修复同步。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

每次轮询用 `view: deadlines`、`overdue: include`、`include_undated: exclude`、`coverage_limit: 1` 和 `lookaheadDays` 处的 `to` 调用 `report`，最多读五页；在线路边界用 zod 解析任务摘要和同步健康；用纯函数做决定；经 `ctx.lsyNotifier` 发送，带 `kinds`（`courses.deadline.due`、`courses.deadline.late`、`courses.sync.*`、`courses.service.*`）和给主人聊天 Session 副本用的 `origin`；最后存下键。轮询一次只跑一个。每次轮询都记录触发方式、耗时、未完成任务数、提醒数及其结果和同步状态；发出和暂缓的提醒按键记录，从不记录 token。

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | 服务 `ctx.lsyCourses`：配置、轮询定时器、投递、同步与中断提醒、设置页状态 |
| [`src/api.ts`](src/api.ts) | REST 客户端：每次调用取 PAT、超时、`X-Courses-Agent`、带类型的失败 |
| [`src/records.ts`](src/records.ts) | 线路解析：任务摘要、同步健康、同步运行的失败原因 |
| [`src/plan.ts`](src/plan.ts) | 提醒和同步提醒的规则，以及消息文字 |
| [`src/time.ts`](src/time.ts) | 主人时区的时间、静默时段、时长 |
| [`src/storage.ts`](src/storage.ts) | storage domain `lsy_courses`：已发的键、最近 20 条消息、轮询、同步提醒、中断 |

这是 fork 本地包；见 [`../UPSTREAM.md`](../UPSTREAM.md)。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [课程工具](../lsy-tool-courses/README.zh.md)：主 agent 读写什么
- [设置 → 课程 DDL](../lsy-courses-settings/README.zh.md)：检查记录、同步健康和配置
- [Presence](../lsy-presence/README.zh.md)：主人什么时候在睡觉

-----

<a id="model-experience"></a>
## 模型体验

### 聊天 Session 里的提醒副本

#### 模型看到什么

没有为模型注册任何东西。微信通道会把每条消息的副本作为来自另一个 Session 的通知留在主人的聊天 Session 里（`origin`：课程 DDL 检查，按固定规则读主人的课程记录），所以主人回“交了”时，主 agent 知道这条消息说的是哪些任务，并用课程工具更新它们。

#### Token 影响

每条提醒一次消息文字，通常 100 到 400 字符，只在主人的聊天 Session 里。

#### KV Cache 影响

只追加；通知跟在可复用的请求前缀之后，不会使已有的 KV Cache 失效。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

- **接收不等于送达**：回复窗口关着时（主人约 24 小时没发消息，或回复额度用完），微信通道会把消息排队，等主人下一次发消息后再发；这时存下的键表示的是一条在排队的消息，不是主人已经看到的消息。
- **至少一次**：通道接收消息之后、存下键之前崩溃，下一次轮询会再发一次这条消息。
- **记录只和同步一样新**：提醒跟着课程记录走；同步还没看到的截止不会提醒，所以同步坏了要告诉主人。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>给维护者的工作上下文——点击展开</summary>

本开发备注是非权威的工作上下文：尚未定下的方向和给维护者的备注。已发布的行为和已接受的理由以上面各节、包代码和链接的 Agent Notes 为准。

- courses 服务自己的提醒（`save_reminder`，目的地 `platform_push`）直接推到平台消息总线；把它们的投递改到 DSH 需要改 courses 服务。

</details>
