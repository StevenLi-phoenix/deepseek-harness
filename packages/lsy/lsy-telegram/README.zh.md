---
description: "lsy 事件总线的 Telegram Bot API 通知器：以纯文本把事件批次和 agent Session 结果发到一个会话，bot token 通过 credential 引用读取。"
kind: "package-reference"
---

# @deepseek-ai/dsh-lsy-telegram

[English](README.md) | 中文

## 概述

通过 Telegram bot 在手机上收到事件总线的批次和无人值守 agent 的回答。消息是纯文本，不可信的事件正文无法注入看起来像你写的标记或链接。bot token 每次发送时按 credential 引用解析，轮换时无需重启。Telegram 的短时限流会重试一次；其余失败都明确报给总线，记录在对应批次上。

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

用 @BotFather 创建 bot，给它发一条消息，从 `getUpdates` 读出你的 chat id，把 token 以 `LSY_TELEGRAM_BOT_TOKEN` 存进实例的 credential 存储或 `$DSH_HOME/.env`，再把通知器挂在总线旁边。

### 何时选用

想在 Telegram 上被提醒时选它。其他渠道也可以提供 `ctx.lsyNotifier`；总线只需要 `send(note)`。

### 最小配置

```yaml
- insert:
    - id: lsy-telegram
      name: '@deepseek-ai/dsh-lsy-telegram'
      config:
        chatId: '123456789'
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `chatId` | 必填 | 用户 id、群组 id（负数）或 `@channelname` |
| `botTokenEnv` | `LSY_TELEGRAM_BOT_TOKEN` | 保存 bot token 的 credential 引用 |
| `apiBase` | `https://api.telegram.org` | Bot API 地址 |
| `timeoutMs` | `15000` | 单次请求的截止时间 |
| `maxRetryAfterSeconds` | `30` | 会重试一次的最长 `retry_after` |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidshlsy-telegram)是全部可用字段的权威来源。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

服务注册为 `ctx.lsyNotifier`。每次 `send()` 解析 token，把标题、正文和链接用空行隔开渲染，截断到 4096 字符，以关闭链接预览的方式调用 `sendMessage`。错误里带 HTTP 状态和 Telegram 的描述，从不带含有 token 的请求 URL。

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | 服务、配置、渲染与 Bot API 调用 |

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [lsy 事件总线](../lsy-event-bus/README.zh.md)——`ctx.lsyNotifier` 的使用方
- [Credentials](../../credentials/credentials/README.zh.md)——credential 引用与解析顺序

-----

<a id="model-experience"></a>
## 模型体验

无，通知器只给人发消息，不向任何模型请求添加内容。

#### KV Cache 影响

无关：不触及任何模型请求。

-----

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延后工作

- **只有一个会话**——所有消息都发到配置的会话；按订阅路由留待以后。
- **没有内联审批**——消息是单向的；审批仍在 Web UI 里完成。

-----

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

fork 本地的包；见 [`../UPSTREAM.md`](../UPSTREAM.md)。

</details>
