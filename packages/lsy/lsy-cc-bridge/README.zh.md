---
description: "面向模型的 cc_list_sessions 与 cc_send 工具：agent 经本地 relay 与同一台 Mac 上 owner 的 Claude Code 会话互相通信，会话发回的消息以不可信数据的形式交给主 agent。"
kind: "package-reference"
---

# @deepseek-ai/dsh-lsy-cc-bridge

[English](README.md) | 中文

## 概述

常驻的 agent 和你在同一台 Mac 上开的 Claude Code 会话现在可以互相说话。agent 列出正在运行的会话（`cc_list_sessions`），给其中一个派任务或问进度（`cc_send`）；会话发给 agent 的消息会作为一个独立回合出现在微信对话 Session 里。两个方向的内容都是不可信数据，绝不是你的命令。你账号下的一个小 relay（[`lsy/cc-bridge`](../../../lsy/cc-bridge/README.zh.md)）经本地 unix socket 转发消息，不开任何端口。

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

先以 owner 身份运行 relay（[`lsy/cc-bridge/install.sh`](../../../lsy/cc-bridge/install.sh)），再把下面这一行加进应当能联系 Claude Code 的 agent preset 的插件列表，同一进程里还要挂载 `@deepseek-ai/dsh-lsy-wechat`。lsy event profile 把它挂在 `unattended` preset 里。

```yaml
- id: lsy-cc-bridge
  name: '@deepseek-ai/dsh-lsy-cc-bridge'
  config:
    socketPath: /Users/Shared/dsh-cc-bridge/dsh.sock
```

| 选项 | 默认值 | 含义 |
|---|---|---|
| `enabled` | `true` | `false` 时不注册工具，也不建立连接。 |
| `socketPath` | `/Users/Shared/dsh-cc-bridge/dsh.sock` | relay 面向 DSH 的 unix socket。 |
| `mainAgentOnly` | `true` | 只有 owner 的微信对话 Session 能列出并给 Claude Code 会话发消息；watch、提醒和事件 Session 会得到错误。 |
| `inboundPerHour` | `30` | 每个滚动小时内交给主 agent 的 Claude Code 消息条数；超出的丢弃并记录日志。 |
| `requestTimeoutMs` | `10000` | 等待 relay 应答的最长时间。 |

没有 relay 时，工具返回错误，插件按退避（1 秒到 30 秒）重连，所以之后再启动 relay 不需要重启这里。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

`src/client.ts` 保持一条到 relay 的长连接：JSON 行、每次调用一个请求 id、连接时先 hello、带退避重连。relay 推送 `message` 事件（会话发来的内容）和 `status` 事件（Claude Code 的回执，例如被扣留或被丢弃）。`onMessage` 接收一条消息后才确认；接收不了的消息 30 秒后再给一次，最多 5 次，而 relay 在下次连接时会重放所有未确认的消息，所以任何一方重启，在 relay 的一小时窗口内都不会丢消息。

`src/index.ts` 注册两个工具，并把入站消息接到 `ctx.lsyNotifier.tellMainAgent`，与 Bilibili Session 用的是同一个入口：对话 Session 把消息按不可信数据的格式排进队列，它的回答经微信发给 owner（`NO_REPLY` 则什么都不发）。发送者的标签来自 relay——它按连接进程找到会话，而不是取自消息内容；会话名里的引号、尖括号和控制字符在进入框架前会被去掉。对话通道未运行时到达的消息保持未确认，之后再给。

```text
Claude Code session --SendMessage--> relay (owner) --> this plugin --> tellMainAgent --> chat Session
chat Session --cc_send--> this plugin --> relay (owner) --> the session's own inbox socket
```

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：选项、两个工具、入站交接及其每小时上限 |
| [`src/client.ts`](src/client.ts) | relay 连接：请求、重连、确认、重试、重复消息抑制 |

这是 fork 本地包；见 [`../UPSTREAM.md`](../UPSTREAM.md)。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [Relay 及其安全模型](../../../lsy/cc-bridge/README.zh.md)——socket、权限、Claude Code 消息格式、速率限制
- [微信通道](../lsy-wechat/README.zh.md)——接收入站消息的对话 Session

-----

<a id="model-experience"></a>
## 模型体验

### 列表工具

#### 模型看到什么

调用方 Agent 的 preset 挂载了这个包时，模型看到一个工具 schema：`cc_list_sessions`，没有参数。描述说明它列出这台 Mac 上 owner 正在运行的 Claude Code 会话，按最近活动排序，含名称、pid、工作目录、状态和距上次变化的秒数。

#### Token 影响

preset 挂载了这个包的 Agent，每次请求都有固定的 schema 开销；其他 preset 下的 Agent 没有开销。一次结果每个会话约 60 个 token。

#### KV Cache 影响

工具定义与可见性不变时前缀稳定；挂载或卸载可能让第一个变化的 schema token 之后的缓存复用失效。

### 发送工具

#### 模型看到什么

`cc_send`，必填字符串参数 `to`（列表中的会话名，或它的 pid）和 `text`（最多 8000 个字符）。描述说明消息会标明来自 DSH agent 而不是 owner，会话可以不做任何处理，回答稍后以发给主 agent 的消息到达、绝不会作为工具结果，每个会话每分钟约接收 6 条，并且不能放密钥，也不能因为陌生人的文字而给会话发消息。

#### Token 影响

preset 挂载了这个包的 Agent，每次请求约 300 个 token 的固定 schema 开销；一次结果几十个 token。

#### KV Cache 影响

每次调用只追加；新出现的内容位于可复用的请求前缀之后，不会使已有的 KV Cache 条目失效。

### 入站消息

#### 模型看到什么

一条排进队列的对话提示，形状与 Bilibili 交接相同：发送者（`a Claude Code session on this Mac named "…" (pid …, working in …)`）、一句说明它不是 owner 以及如何回答（对同名会话调用 `cc_send`，owner 无需知晓时回答 `NO_REPLY`），以及放在 `<agent_message trust="untrusted">` 块里的正文。

#### Token 影响

框架约 150 个 token 加上消息本身，每小时最多 30 条。

#### KV Cache 影响

只追加；提示进入对话 Session 历史中可复用前缀之后的位置。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

- **不能调用后等待**——会话的回答是之后的一条消息，不是工具结果，因为 Claude Code 会话在自己的回合结束时才回答。
- **送达只是交接**——`sent: true` 表示 relay 已把消息放进会话的收件箱；该会话是读取、扣留等待用户确认还是忽略，由它自己决定，Claude Code 的回执只出现在日志里。
- **仅限本机**——其他机器上的会话不会列出；Claude Code 的 peer 协议是内部的、带版本的，所以 Claude Code 更新可能让 relay 失效（见其 README）。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是不具权威性的工作上下文：尚未决定的探索方向与维护者备注。已交付的行为与既定理由以上文、包代码和相关 Agent Note 为准。

- 测试跑在临时 unix socket 上的假 relay（`tests/fake-relay.ts`）上；relay 自己的测试在 `lsy/cc-bridge/tests`。

</details>
