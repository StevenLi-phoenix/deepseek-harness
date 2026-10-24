---
description: "把 Session 的最终回答转给主人的唯一中继（ctx.ownerRelay）：微信对话、B站账号私信这类通道认领自己的 Session，每轮结束时由同一套规则决定，通道送不出的回答带着来源标签退回 ctx.lsyNotifier，事件总线跳过已被认领的 Session。"
kind: "package-reference"
---

# @deepseek-ai/dsh-owner-relay

[English](README.md) | 中文

## 概述

agent 的某个 Session 结束一轮时你会收到什么，由一个地方决定。微信对话、B站账号私信这类通道认领它们负责的 Session；每轮结束时中继套用同一套规则（你停下的一轮或恰好是 `NO_REPLY` 的回答什么也不发，没完成的一轮加上警告和原因），再把回答交给认领它的通道。通道送不出的回答改发到微信，并标明来自哪里；事件总线也不会把已被认领的 Session 再报告一遍。

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

把中继挂在 profile 根部，放在使用它的插件之前。它不依赖其他服务，也没有配置；只有需要退回时才读取 `ctx.lsyNotifier`（来自 [`@deepseek-ai/dsh-lsy-wechat`](../lsy-wechat/README.zh.md)）。lsy 事件 bundle 把它挂在事件总线之前。

```yaml
- id: owner-relay
  name: '@deepseek-ai/dsh-owner-relay'
```

### 何时选用

当一个插件拥有若干 Session，而它们的最终回答应该经由该插件自己的通道送到主人手里时，选用它。不要用它处理没有通道认领的 Session 的报告（事件总线的结果和提醒通知），也不要用它发送不属于某一轮回答的通知（登录或风控通知）：这些直接发给 `ctx.lsyNotifier`。

### 规则

中继为每个被认领的 Session 记下最新的 assistant 文本（只取文本部分），在这一轮结束时决定：

| 这一轮怎样结束 | 认领它的通道收到什么 |
|---|---|
| `aborted` 且原因是 `user`（微信 `/stop`、Web UI 的停止） | 什么也不发：主人已经知道 |
| 最终文本恰好是 `NO_REPLY` | 什么也不发 |
| `completed` 且有文本 | 这段文本 |
| `completed` 但没有文本 | 什么也不发 |
| 其他任何结束方式（`error`、因其他原因的 `aborted`、`max-tokens`、`interrupted`） | 有文本就先放文本，然后是 `⚠️ 本轮未完成（<kind>）`；`error` 还在下面加 `原因：<code>: <message>` |

### 服务

| `ctx.ownerRelay` 的成员 | 含义 |
|---|---|
| `registerChannel(channel)` | 加入一个通道；返回一个注销函数，注销时移除通道并释放它认领的所有 Session。同名的第二个通道会抛错。 |
| `claim(sessionId, channelName)` | 从此由该通道转发这个 Session 的每一轮；已被其他通道认领时转到这个通道。 |
| `release(sessionId)` | 不再转发这个 Session；返回它原先是否被认领。 |
| `ownerOf(sessionId)` | 认领它的通道名，没有则为 `undefined`。 |

一个通道（`RelayChannel`）有 `name`、`deliver(answer)`、可选的钩子 `onTurnStart`、`onTurnEnd`、`onTurnSettled`，以及可选的 `fallbackLabel`。回答带有 `sessionId`、`text`（主人收到的内容）、`outcome` 和 `detail`（失败原因）。`deliver` 以 `sent`（已发出或已持久排队）或 `kept`（通道选择不发，比如不是唤醒开启的 B站那一轮）完成，送不出时 reject。中继在 `turn/start` 时调用 `onTurnStart`；在 `turn/end` 时先调用 `onTurnEnd(sessionId, ended)`，再在同一个 tick 里调用 `deliver`，等 `deliver` 和可能的退回都结束后调用 `onTurnSettled`。没有要发的内容时，`onTurnSettled` 紧跟在 `onTurnEnd` 之后。`ended` 是中继对这一轮的决定：`answer`（随后会调用 `deliver`）、`silent`（最终文本是 `NO_REPLY`）、`stopped`（主人停掉了这一轮）或 `empty`（完成了但没有文本），所以按轮记录状态的通道，即使什么都没有投递，也知道这一轮是怎么结束的。

`deliver` reject 时，中继给 `ctx.lsyNotifier` 发一条 `↪️ 这条回答没能从原渠道发出，改发这里` 通知：回答本身、下面一行 `原因：<error>`，并把通道的 `fallbackLabel` 作为通知的 `origin`，微信对话 Session 里的副本会以它作为发送者。没有标签的通道就是通知器自己，它送不出时只记日志。

认领只保存在内存里。每个通道注册时重新认领自己存储的 Session，在新 Session 的第一次 prompt 之前认领它，注销时失去它的认领。lsy 事件 profile 有两个通道：

| 通道 | 插件 | 认领 | 投递 | `fallbackLabel` |
|---|---|---|---|---|
| `wechat` | `@deepseek-ai/dsh-lsy-wechat` | 它记得的每个对话 Session（当前的和更早的） | 一条微信回复；更早的对话 Session 的回答还会复制一份到当前对话里 | 无：它就是通知器 |
| `bili-dm` | `@deepseek-ai/dsh-bili` | 账号的 Session | 唤醒开启的一轮发 B站私信（否则 `kept`；回答被观看下限压住、这次唤醒还在继续浏览时也是 `kept`）；发不出去的部分带着原因和标签改发微信 | `the Bilibili account's Session (its answer could not go out as a Bilibili message)` |

`@deepseek-ai/dsh-lsy-event-bus` 在跟踪提醒或监控那一轮之前先问 `ownerOf()`，所以被认领的 Session 的一轮只经由它的通道送达主人一次。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

`OwnerRelay` 是一个 Cordis 服务（`ctx.ownerRelay`），监听 `session/event`，忽略没有被认领的 Session。对被认领的 Session，它保存最新的 `assistant/message` 文本（`contentText`：拼接文本部分，没有文本的消息保留上一条），在 `turn/end` 时取出并套用 `decideRelay`。钩子在事件里同步调用，每个都包在自己的 `try` 里，出错的钩子只记日志，不会让中继停下；`deliver` 在第一个 `await` 之前就被调用，所以通道可以读取 `onTurnEnd` 刚设好的每轮状态；`onTurnEnd` 的第二个参数是 `decision.kind`。投递在后台进行，销毁时等它们结束。被一个尚未注册的通道认领的 Session 只记日志并跳过。

每个决定都以 info 级别记日志，带 Session id 和原因，从不记录正文：`owner-relay: Session <id> ended a turn (<outcome>); relaying <n> chars through <channel>`、什么也不转发的原因（`the owner stopped`、`that answered NO_REPLY`、`without text`），以及 `<channel> sent` 或 `kept the answer`。被 reject 的投递和每次退回的结果以 warn 或 info 记录。

中继依赖 `@deepseek-ai/dsh-lsy-event-bus` 的 `failureDetail`、`isSilentReply` 和 `LsyNotifier` 契约，所以事件总线通过一个结构化的 `ownerOf()` 视图读取 `ctx.ownerRelay`，而不导入这个包。`@deepseek-ai/dsh-lsy-wechat` 和 `@deepseek-ai/dsh-bili` 只导入它的类型，通过一个 `inject: ['ownerRelay']` 的子插件注册；有浏览器部分的 `bili` 把它保留为开发依赖。

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | 服务：通道、认领、事件跟踪、投递、退回和日志 |
| [`src/rules.ts`](src/rules.ts) | 纯规则：`contentText`、`decideRelay` 和退回通知 |

这是 fork 本地的包；见 [`../UPSTREAM.md`](../UPSTREAM.md)。单元测试用通道替身驱动服务；lsy-wechat、lsy-event-bus 和 bili 的测试把它和真实插件一起挂载。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [微信通道](../lsy-wechat/README.zh.md)——`wechat` 通道和 `ctx.lsyNotifier`
- [B站账号](../bili/README.zh.md)——`bili-dm` 通道
- [事件总线](../lsy-event-bus/README.zh.md)——没有通道认领的 Session 的报告

-----

<a id="model-experience"></a>
## 模型体验

### 退回通知

#### 模型看到的内容

中继不往它转发回答的 Session 里加任何内容，只读取它们的事件。退回的回答作为一条共享通知（来自 `@deepseek-ai/dsh-lsy-wechat`）进入主人的微信对话 Session，带有发出时间，开头用通道的 `fallbackLabel` 代替笼统的“另一个 session”说法，让对话 agent 知道主人回复的那条消息来自哪里。

##### 共享的退回通知

```markdown
At Fri 2026-10-23 19:42 (America/New_York), the Bilibili account's Session (its answer could not go out as a Bilibili message) sent the owner this message on WeChat. It is context, not the owner speaking: the owner may reply to it in this chat.
↪️ 这条回答没能从原渠道发出，改发这里

魔女，这只猫自己学会开门了 https://www.bilibili.com/video/BV1aa4y1X7aa

原因：the write guard failed
```

#### Token 影响

每次退回一条共享通知：回答本身加一行开头。正常转发的回答不会进入任何模型上下文。

#### KV Cache 影响

只追加：通知在对话 Session 的下一步之前注入，位于可复用前缀之后，之前的内容不会被改写。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

- **认领只在内存里**——只有通道已注册并认领了某个 Session，才会转发它；通道的插件重启期间结束的一轮不会被转发。
- **一个 Session 只属于一个通道**——第二次认领会把 Session 转给新的通道。
- **回答不持久**——中继什么也不存储；host 停止时还在投递中的回答会丢失，除非通道已经把它排进了队列（lsy-wechat 的 outbox 会这样做）。
- **退回需要通知器**——没有 `ctx.lsyNotifier`，或者通道就是通知器自己时，送不出的回答只记日志。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是不具权威性的工作上下文：尚未决定的探索方向与维护者备注。已交付的行为与既定理由以上文、包代码和相关 Agent Note 为准。

- 事件总线保留它自己的结果和提醒通知：它们报告的是没有通道认领的 Session，有各自的格式和批次记录。是否把它们也作为一个通道并入，尚未决定。

</details>
