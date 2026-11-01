---
description: "事件服务的主人在线状态：由 Mac mini 上的 focus-watch 从 iCloud 读到的睡眠专注模式、每日兜底时段和设置里的按钮判断主人是否在睡觉；睡觉时微信把不紧急的消息压下，醒来后合成一条发出。"
kind: "package-reference"
---

# @deepseek-ai/dsh-fork-presence

[English](README.md) | 中文

## 概述

让 agent 在你睡觉时别再震你的手机。Mac mini 从 iCloud 读你的睡眠专注模式（`focus-watch`），每次变化都上报，另外每 30 分钟发一次心跳；它安静下来后由每日时段（纽约 03:30–10:30）接手，**设置 → 勿扰**里的按钮比两者都优先。你睡着时，微信把所有不紧急的消息压下，等你醒来合成一条发出；磁盘满、B站风险这类告警，以及对你刚发消息的回复，照常立刻送达。页面显示有多少消息在等，以及最近一次信号和心跳。

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

把这一行挂在 `@deepseek-ai/dsh-fork-wechat` 和 `@deepseek-ai/dsh-fork-event-ingest` 旁边；fork event bundle 已经挂载了它。它需要 storage domain facility；设置页的路由还需要 Host 的 `connection` 服务；页面本身需要 `@deepseek-ai/dsh-fork-wechat-settings` 和设置外壳。它提供 `ctx.forkPresence`。再加上承载 `focus-watch` 信号的 ingest 来源，这是一个 *sink* 来源：它的事件交给这个服务，不进事件总线，所以没有任何订阅会因它们启动 Session 或发通知：

```yaml
- id: fork-presence
  name: '@deepseek-ai/dsh-fork-presence'
  config:
    timeZone: America/New_York
- id: fork-event-ingest
  config:
    sources:
      - id: presence
        tokenEnv: FORK_INGEST_TOKEN_PRESENCE
        sink: forkPresence
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `timeZone` | `America/New_York` | 主人所在的 IANA 时区；时段和「勿扰到」的时间按它理解 |
| `window` | 启用，`03:30` 到 `10:30` | 每日兜底时段，没有新鲜的 Focus 信号时才用。`start` 晚于 `end` 时跨过午夜。设置页可以改，改过的值优先于这个默认值 |
| `focusFreshHours` | `2` | Focus 信号在没有更新的信号时保持多久，之后由时段接手；30 分钟一次的心跳会不断刷新它，所以 `focus-watch` 停掉大约两小时后才失效 |
| `sleepMaxHours` | `14` | Focus「开启」信号在没有更新的信号时最长保持多久；心跳会刷新它，所以夜里挂掉的 watcher 不会让一整天静音 |
| `manualMaxHours` | `12` | 设置里的按钮没有指定结束时间时最长保持多久 |
| `urgentKinds` | `host.disk.full`、`host.*.critical`、`bili.risk.*`、`bili.gate.readonly` | 即使你在睡觉也立刻发送的事件类型（glob） |

`focus-watch`（Mac mini 上以主人用户运行的已签名二进制，有完全磁盘访问权限，读取 iCloud 从手机同步来的 Focus 数据库）向 `POST http://127.0.0.1:3081/hooks/events` 发请求，带 `Authorization: Bearer <令牌>`。状态变化是 `{"kind":"presence.sleep.on","key":"sleep-on-<ts>","subject":"owner","title":…}`（关闭时用 `presence.sleep.off`，key 为 `sleep-off-<ts>`）；每 30 分钟它用以 `heartbeat` 开头的 key 重复当前状态。令牌和安装见 [RUNBOOK §18](../../../fork/deploy/RUNBOOK.md)。

**心跳是幂等的。** 重复已保持状态的信号（每个心跳都是）只会刷新状态的保持时间，以及最近一次信号和心跳的时间。它不会移动状态的起点、不会终结设置里的按钮、不会调用 `onChange` 监听器，也不会放出消息；已经醒着时的 `presence.sleep.off` 心跳什么也不改变。只有让状态翻转的信号（或第一条信号）才开始新状态并终结按钮。

**谁说了算。** 仍在生效的按钮，其次是新鲜的 Focus 信号，最后是每日时段。按钮之后到达的 Focus 变化会终结按钮，重复已保持状态的信号不会。信号的时间是 Host 的接收时间；watcher 的时钟不参与，key 只用来区分心跳和变化。

**压下什么。** 目前只有微信通道会压消息（[`fork-wechat`](../fork-wechat/README.zh.md#quiet-hours)）。它调用 `ctx.forkPresence.isAsleep()` 和 `isUrgent(note)`，注册一个 holder（`registerHolder`）让页面能数出并发出等待中的消息，并用 `onChange` 在你醒来时发出汇总。消息在发送方标了紧急（`ForkNote.urgent`），或它报告的某个事件类型（`ForkNote.kinds`，由事件总线为 notify 订阅的批次填入）匹配 `urgentKinds` 时算紧急。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

`src/state.ts` 是纯状态机：`evaluate(now, inputs, rules)` 返回 `{ asleep, source, since, until }`，`nextChange()` 返回在没有新输入时答案下一次可能变化的时刻（按钮到期、Focus 信号过期、时段开始或结束）。时钟时间用 `Intl.DateTimeFormat` 按主人的时区计算；一年里该时区切换偏移的那两天，时段边界可能差一小时。服务把输入存在 `fork_presence` storage domain 里（表 `inputs`、行 `owner`：最近一次 Focus 信号和按钮；表 `window`、行 `window`：在设置里设的时段），每次输入之后以及下一个变化时刻的定时器触发时重新计算（定时器最多一天后触发，已 `unref`），答案或来源每变一次只记一次日志，并且只在答案在睡着和醒着之间翻转时调用 `onChange` 监听器；抛错的监听器会被记录，不会拦住别的监听器。存储输入失败时，状态保留在内存里并记录失败。

服务实现了 `ForkIngestSink`。`fork-event-ingest` 对声明了 `sink: forkPresence` 的来源，把校验过的事件交给它而不发布到总线，并回答 `202 {"outcome":"asleep"|"awake"}`；`presence.sleep.on` 和 `presence.sleep.off` 以外的类型是 `400`，服务没挂载是 `503`。路由 `GET`/`POST /api/fork.presence` 位于 `/api` 下，受 connection 的登录校验保护；每个动作（`sleep.now`、`wake.now`、`quiet.until`、`manual.clear`、`window.set`、`flush`）都按 schemastery schema 校验，并记录结果和耗时。任何回答里都没有令牌。

设置页是只含浏览器端的包 [`@deepseek-ai/dsh-fork-wechat-settings`](../fork-wechat-settings/README.zh.md) 里的分区 `fork-presence`（顺序 53）：八种语言，打开且页面可见时每 5 秒轮询 `api/fork.presence`。本包没有浏览器面；它的 `src/view.ts` 与那个包里的副本逐字节相同，由测试检查。

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | `forkPresence` 服务：输入、存储、定时器、监听器、holder、ingest sink、紧急匹配 |
| [`src/state.ts`](src/state.ts) | 纯状态机和时钟辅助函数 |
| [`src/settings.ts`](src/settings.ts) | 路由 `/api/fork.presence` 及其动作 |
| [`src/storage.ts`](src/storage.ts) | storage domain |
| [`src/view.ts`](src/view.ts) | 两端共用的类型和常量 |

这是 fork 本地的包；见 [`../UPSTREAM.md`](../UPSTREAM.md)。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [fork-wechat](../fork-wechat/README.zh.md)——你睡觉时压下不紧急的消息，醒来后发出汇总
- [fork-event-ingest](../fork-event-ingest/README.zh.md)——推送路由及其 sink 来源
- [fork-event-bus](../fork-event-bus/README.zh.md)——`ForkNote.kinds` 和 `ForkNote.urgent`
- [fork-sysmon](../fork-sysmon/README.zh.md)——这个分区沿用的设置分区写法

-----

<a id="model-experience"></a>
## 模型体验

无，因为在线状态只决定消息何时送到主人；这里没有任何内容进入模型请求。

#### KV Cache 影响

无；这个包既不组装也不发送提供商请求。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

- **只有微信会压消息**——QQ bot 通道和B站私信不看在线状态。
- **文件不压**——`wechat_send_file` 经由已打开的回复窗口立刻发出，因为文件没法在文本 outbox 里等。
- **压下的通知已经在对话里**——通道留在主人对话 Session 里的那份通知副本写着它在原始时间发出，而主人其实是在早晨的汇总里读到它。
- **信号只来自一台 Mac**——`focus-watch` 需要 Mac mini 登录了 iCloud 并有完全磁盘访问权限；它停掉后，状态保持 `focusFreshHours`（睡着时最长 `sleepMaxHours`），之后由每日时段决定。一小时没有信号时页面会提示。
- **时区变化**——时段按 `timeZone` 而不是手机在哪；出差要改配置。
- **三十分钟写在微信里**——「刚发过消息」的长度是 `fork-wechat` 的 `awakeAfterMessageMs`（30 分钟）；页面上的文字写的是这个默认值。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是不具权威性的工作上下文：尚未决定的探索方向与维护者备注。已交付的行为与既定理由以上文、包代码和相关 Agent Note 为准。

- 笔记本也会收到 Focus 状态（`~/Library/DoNotDisturb/DB/Assertions.json`，模式 `com.apple.sleep.sleep-mode`），但它不总开着；Mac mini 登录了 iCloud 又常开，所以 watcher 放在它上面。曾考虑从手机用 iOS 快捷指令发信号，因为快捷指令自动化会同步并造成干扰而放弃。
- 让页面能改紧急类型，需要在配置的列表旁再存一份覆盖；现在它们只能改配置。

</details>
