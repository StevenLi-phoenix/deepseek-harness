---
description: "面向模型的 owner_push 工具：agent 通过 API 平台的消息总线，把紧急消息推到主人的手机，或把一行放进每日邮件摘要；每件事按 key 只发一条。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-push

[English](README.md) | 中文

## 概述

有些事几小时内不处理就会错过：今天要确认的面试时间、今天截止的事、离开你就跑不下去的任务。这时 agent 会把它推到你的手机上，而不是只写进微信汇报。agent 调用 `owner_push`，传入正文和一个标明这件事的 key；API 平台的消息总线经通知服务推送它，设了 `digest` 时则留到每日邮件摘要里。总线对每个 key 只收一条，所以之后的运行不会把同一件事再推一次。

## 目录

- [使用这个包](#use-this-package)
- [了解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型视角](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用这个包

把这一行加进需要推送的 agent 预置的插件列表。fork 的 event profile 把它挂在 `unattended` 预置里，微信聊天 Session 和定时运行都用这个预置。

```yaml
- id: tool-push
  name: '@deepseek-ai/dsh-tool-push'
```

工具用一个能往消息总线发消息的 PAT 发帖（需要 `messageservice` 的写 ACL，或者是管理员）。把它放进 `$DSH_HOME/.env` 或凭据库，名字是 `MESSAGE_PAT`；每次调用都会重新读取，所以换了 token 不用重启。没有 token 时，工具回答 token 未设置，什么也不发。

| 选项 | 默认值 | 含义 |
|---|---|---|
| `apiBase` | `https://api.lishuyu.app` | 平台地址，末尾不带斜杠 |
| `tokenEnv` | `MESSAGE_PAT` | PAT 在凭据库或 `$DSH_HOME/.env` 里的名字 |
| `source` | `dsh` | 每条消息的 `source` |
| `channel` | `dsh` | 消息存放的总线频道；拒绝 `display`，因为总线从不推送这个频道 |
| `pushPriority` | `6` | 推送的优先级：达到总线的通知阈值（5）就推送，7 及以上还会占用墨水屏并发邮件 |
| `requestTimeoutMs` | `15000` | 单次发帖的超时 |

-----

<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>实现细节——点击展开</summary>

`owner_push` 先检查参数（正文去掉首尾空白后 1-500 个字符，key 是不超过 100 个字符的小写 slug），再往 `POST <apiBase>/v2/call/messageservice/post` 发一条消息。推送是 `{ source, text, channel, priority: pushPriority, idempotency_key: "owner-push:<key>" }`；摘要行内容相同，只是优先级为 0，并带上 `digest: true` 和 `digest_key: <key>`。总线把达到通知阈值的消息转给通知服务，由它经 Bark 推送；摘要消息进入通知服务的每日邮件摘要，同一个 key 的几行合并成一行。

用 typed RPC 而不用总线的 REST 接口（`/message/messages`），是因为 REST 接口会丢掉 `idempotency_key`。总线按调用方区分 key：完全相同的重复请求返回第一条消息的 id，不再推送；同一个 key 换了内容会得到 409 `idempotency_conflict`，工具把它报告为"已经发过"。DSH 这边不存任何状态。

每次发帖都记录消息 id、推送还是摘要、key 和正文长度，从不记录正文或 token；失败时按类别（`not-configured`、`auth`、`duplicate`、`invalid`、`http`、`network`、`timeout`）记一条 warn。

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：配置、参数检查和工具定义 |
| [`src/bus.ts`](src/bus.ts) | 消息总线客户端和它的失败类别 |

这是 fork 本地的包，见 [`../UPSTREAM.md`](../UPSTREAM.md)。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [微信工具](../tool-wechat/README.zh.md)——在微信上给主人发汇报、文件和延时消息

-----

<a id="model-experience"></a>
## 模型视角

### 推送工具

#### 模型看到什么

只要调用方 Agent 的预置挂载了这个包，就多一个工具 schema：`owner_push`，必填字符串 `text` 和 `key`，可选布尔值 `digest`。描述写明：只推送几小时内不处理就会错过的事，例如今天要确认的面试时间、今天截止的事、离开主人就跑不下去的任务；能等的事写进微信汇报，或者设 `digest` 放进下一封每日邮件摘要，一天或更久以后的截止不算紧急；总线对每个 key 只收一条，所以之后的运行再碰到同一件事，什么新的也不会发。`unattended` 的 persona 用一句话重申这条规则。

#### Token 影响

预置挂载了这个包的 Agent，每次请求都有固定的 schema 开销；其他预置下的 Agent 没有这笔开销。

#### KV Cache 影响

工具定义和可见性不变时前缀稳定；挂载或卸载可能让第一个变化的 schema token 之后的缓存失效。

### 推送结果

#### 模型看到什么

每次调用返回一个 JSON 文本块：`{ "posted": true, "id", "as": "push" | "digest" }`，或者 `{ "notPosted": "<原因>" }`，例如 `the bus already took a message for key <key>; nothing new was sent, so do not send it again`、`the message bus token is not set; tell the owner in your WeChat report instead`、`the message bus refused the token (HTTP 403 forbidden); …`、`text is longer than 500 characters; say it shorter`，或 key 不是 slug。

#### Token 影响

每次调用几十个 token，留在 Session 历史里直到被压缩。

#### KV Cache 影响

只追加；新出现的内容排在可复用的请求前缀之后，不会让已有的 KV Cache 失效。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- **收下不等于送达**——总线把消息和通知任务存下就回答；手机关机或 Bark 失败只在通知服务的日志里看得到。
- **每个 key 一条**——需要第二次推送的事（比如面试前一小时的提醒）要用自己的 key。
- **紧不紧急由模型判断**——门槛由描述和 persona 给出，没有代码去检查截止时间还有多远。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>给维护者的工作背景——点击展开</summary>

这份开发备注不具权威性，只记录尚未决定的方向和给维护者的笔记。已上线的行为和定下来的理由，以上面各节、包代码和链接的 Agent Notes 为准。

- 主机告警（AMS intake、平台自身的故障）也可以走同一条总线推到手机，前提是先定下哪些告警值得推送。

</details>
