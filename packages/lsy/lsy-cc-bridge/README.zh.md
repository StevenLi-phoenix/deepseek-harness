---
description: "面向模型的 cc_list_sessions、cc_send、cc_start、cc_stop 工具：agent 与自己账号下的 Claude Code 会话协作，会话发回的消息以不可信数据的形式交给主 agent。"
kind: "package-reference"
---

# @deepseek-ai/dsh-lsy-cc-bridge

[English](README.md) | 中文

## 概述

常驻的 agent 现在可以和 Claude Code 协作。它自己启动会话（`cc_start`）、列出会话（`cc_list_sessions`）、给其中一个派任务或问进度（`cc_send`）、用完停掉（`cc_stop`）；会话发给 agent 的消息会作为一个独立回合出现在微信对话 Session 里。两个方向的内容都是不可信数据，绝不是你的命令。这些会话与 agent 运行在同一个 macOS 用户下，配置为只读，所以 agent 经本地 unix socket 直接访问它们：不开端口，不用 relay，你自己的会话也碰不到。

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

先为服务用户装好 Claude Code（[RUNBOOK §14](../../../lsy/deploy/RUNBOOK.md)：`lsy/deploy/claude-dsh/install.sh`，再把 owner 用 `claude setup-token` 生成的 token 存进 0600 文件）。然后把下面这一行加进应当使用它的 agent preset 的插件列表，同一进程里还要挂载 `@deepseek-ai/dsh-lsy-wechat`。lsy event profile 以默认值把它挂在 `unattended` preset 里。

```yaml
- id: lsy-cc-bridge
  name: '@deepseek-ai/dsh-lsy-cc-bridge'
```

| 选项 | 默认值 | 含义 |
|---|---|---|
| `enabled` | `true` | `false` 时不注册工具，也不开收件 socket。 |
| `stateDir` | `/Users/dsh-runtime/.dsh/lsy-cc-bridge` | 收件 socket 所在目录（0700）。 |
| `sessionsDir` | `~/.claude/sessions` | 这个账号的 Claude Code 会话注册表。 |
| `peerName` | `dsh-agent` | Claude Code 的 `ListAgents` 里显示的 agent 名字。 |
| `mainAgentOnly` | `true` | 只有 owner 的微信对话 Session 能用这些工具；watch、提醒和事件 Session 会得到错误。 |
| `inboundPerHour` | `30` | 每个滚动小时内交给主 agent 的 Claude Code 消息条数；超出的丢弃并记录日志。 |
| `spawn` | `true` | 注册 `cc_start` 和 `cc_stop`。 |
| `tmux`、`command`、`workDir`、`model`、`maxSessions` | `/opt/homebrew/bin/tmux`、`/Users/dsh-runtime/bin/claude-dsh`、`/Users/dsh-runtime/work/cc`、`sonnet`、`3` | 启动的会话如何运行。 |

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

`src/hub.ts` 是 agent 一侧的 Claude Code peer 消息端，运行在 DSH 进程内。它监听一个 socket（`<stateDir>/cc.sock`，0600，所在目录 0700），并注册一条 peer 记录让 `ListAgents` 显示 agent；发送时，先在注册表（`src/registry.ts`：pid 存活且启动时间等于 `ps -o lstart=`）里确认会话在线，再往会话自己的 socket 写一帧。入站消息归属于注册记录里拥有 `from` socket 的会话，而不是消息自称的名字；Node 读不到连接的对端 pid，所以靠账号边界把关。速率（每个会话每分钟发 6 条、共 20 条；入站每个会话每分钟 6 条、共 30 条）和 8000 字符上限都在这里执行，被限制的会话每分钟收到一条通知，主 agent 暂时接不了的消息 30 秒后再给一次，最多 5 次。

`src/spawn.ts` 在分离的 tmux（独立服务器 `-L dsh-cc`）里、用清空的环境（`env -i`）启动会话，服务的密钥都到不了它们；启动器从文件读取 OAuth token。`src/wire.ts` 把内部消息格式集中在一处。

`src/index.ts` 注册四个工具，并把入站消息交给 `ctx.lsyNotifier.tellMainAgent`，与 Bilibili Session 用的是同一个入口：对话 Session 把消息按不可信数据的格式排进队列，它的回答经微信发给 owner（`NO_REPLY` 则什么都不发）。发送者的标签由注册表生成，引号、尖括号和控制字符会被去掉。

```text
Claude Code session --SendMessage--> cc.sock --> hub --> tellMainAgent --> chat Session
chat Session --cc_send--> hub --> the session's own socket in /tmp/cc-socks-502
chat Session --cc_start--> tmux -L dsh-cc --> claude-dsh --> a new session
```

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：选项、四个工具、入站交接及其每小时上限 |
| [`src/hub.ts`](src/hub.ts) | 收件 socket、发送、限制、未送达入站消息的重试、peer 记录 |
| [`src/registry.ts`](src/registry.ts) | 这个账号下在线的会话，以及名字如何解析 |
| [`src/spawn.ts`](src/spawn.ts) | 基于 tmux 的 `cc_start` 与 `cc_stop` |
| [`src/wire.ts`](src/wire.ts) | Claude Code 的内部消息格式 |

这是 fork 本地包；见 [`../UPSTREAM.md`](../UPSTREAM.md)。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [服务用户的 Claude Code](../../../lsy/deploy/RUNBOOK.md)——部署、token 文件，以及启动的会话能做什么
- [微信通道](../lsy-wechat/README.zh.md)——接收入站消息的对话 Session

-----

<a id="model-experience"></a>
## 模型体验

### 列表工具

#### 模型看到什么

调用方 Agent 的 preset 挂载了这个包时，模型看到一个工具 schema：`cc_list_sessions`，没有参数。描述说明它列出 agent 自己账号下的 Claude Code 会话，按最近活动排序，含名称、pid、工作目录、状态和距上次变化的秒数。

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

### 启动与停止工具

#### 模型看到什么

`cc_start`，必填字符串参数 `name`、可选字符串参数 `task`；以及 `cc_stop`，参数 `name`。描述说明会话运行在 agent 自己的账号下、配置保守（读、搜索、`ls`、`git status|log|diff`、收发消息；不能改文件、不能执行其他命令、不能上网），最多同时运行 3 个，`cc_start` 在会话就绪后返回（最长 45 秒），会话的回答稍后以发给主 agent 的消息到达。

#### Token 影响

preset 挂载了这个包的 Agent，每次请求这两个工具约 350 个 token 的固定 schema 开销；一次结果几十个 token。

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
- **送达只是交接**——`sent: true` 表示已把消息放进会话的收件箱；该会话是读取还是忽略，由它自己决定，Claude Code 的回执只出现在日志里。
- **仅限本账号**——owner 在另一个 macOS 账号下的会话按设计够不到；要够到需要跨两个账号的 relay（做过一次又撤掉了，见变更日志）。
- **内部消息格式**——Claude Code 的 peer 协议没有公开文档且带版本（`peerProtocol` 1，在 2.1.314 上核对），所以 Claude Code 更新可能让它失效；RUNBOOK 写了如何重新核对。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是不具权威性的工作上下文：尚未决定的探索方向与维护者备注。已交付的行为与既定理由以上文、包代码和相关 Agent Note 为准。

- 测试在临时目录里用假会话（unix socket 加注册记录）和假的 tmux 执行器；不启动 Claude Code。

</details>
