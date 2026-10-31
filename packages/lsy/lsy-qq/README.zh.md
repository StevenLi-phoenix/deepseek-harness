---
description: "事件服务的 QQ 通道，走 QQ 开放平台官方机器人：owner 列入名单的私聊和群里 @ 机器人的消息各有一个对话 Session，回答经 owner-relay 的 qq 通道发回。"
kind: "package-reference"
---

# @deepseek-ai/dsh-lsy-qq

[English](README.md) | 中文

## 概述

让你选定的人在 QQ 上和 agent 聊天。通道连接你在 QQ 开放平台注册的官方机器人：来自你列出的 openid 的私聊消息，或群里 @ 机器人的消息，会进入各自的对话 Session，每个回答都以 QQ 消息发回。名单之外的人一律不回复，他们对话的 Session 除了聊天没有任何工具。连接只向外发起、只连腾讯的网关，路径上没有 QQ 客户端，也没有第三方协议桥。

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

在 Web profile 里把通道挂在 [`@deepseek-ai/dsh-owner-relay`](../owner-relay/README.zh.md)（`ctx.ownerRelay`）旁边，本插件注册它的 `qq` 通道；没有 relay 时通道能收消息，但不会发回答。它依赖 Host 的 Session Controller、permission preset、Session 标题、凭据存储和 storage domain facility。它提供 `ctx.lsyQq`，把 `ctx.lsyNotifier` 留给微信通道：QQ 拒收的回答，以及名单外发信人的提示，都经通知器送到 owner。

### 何时选用

希望家人、朋友或某个群能在 QQ 上和 agent 聊天、而由你决定谁能聊时选它。不要把它当成自己的控制通道：默认 Session 按设计没有 shell、文件和联网工具，而且一个群的所有成员共用一个 Session。

### 最小配置

用登录命令创建一次机器人：以服务用户身份运行，用手机 QQ 扫描它的二维码并确认。平台会为你的 QQ 号创建机器人，并把 AppID 和 AppSecret 交给这个命令；命令把 `LSY_QQ_APP_ID` 和 `LSY_QQ_APP_SECRET` 写进 `<DSH_HOME>/.env`（权限 600），只打印 AppID 和你自己的 openid，后者就是 `allow.users` 的第一项。之后重启服务，因为 `.env` 在启动时读取。`--qr-png <file>` 还会把二维码存成图片（权限 600），`--timeout-min` 设置等待多久。你自己在 `q.qq.com` 注册的机器人也可以用：手动把它的 AppID 和 AppSecret 写进 `.env`。

```sh
sudo -u dsh-runtime env DSH_HOME=/Users/dsh-runtime/.dsh /opt/homebrew/bin/node /Users/Shared/lsy-dsh/current/lsy/deploy/qq-login.mjs
```

然后挂载通道并列出允许的人；openid 是 QQ 对这个机器人称呼某个人或某个群的编号，不是 QQ 号：

```yaml
- insert:
    - id: lsy-qq
      name: '@deepseek-ai/dsh-lsy-qq'
      config:
        allow:
          users: []
          groups: []
```

名单之外的人发消息时，日志会显示 `dropped a c2c message from user <openid>, not on allow.users`，owner 的通道也会收到一条带这个 openid 的提示（每个发信人每天最多一次，总共每小时最多三条）；把它抄进 profile patch 里的 `allow`，实时生效。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `appIdEnv`、`appSecretEnv` | `LSY_QQ_APP_ID`、`LSY_QQ_APP_SECRET` | 存放机器人 AppID 和 AppSecret 的凭据名；任一缺失时通道保持离线并定期重查 |
| `allow.users` | `[]` | 私聊消息会被回复的 `user_openid` |
| `allow.groups` | `[]` | @ 消息会被回复的 `group_openid`，群内任何成员都算 |
| `session.workspacePath` | `/Users/dsh-runtime/qq` | 对话 Session 的绝对工作目录；每次转发消息前创建 |
| `session.agentPreset` | `qq` | 新对话 Session 的 agent preset；事件 bundle 定义的 `qq` 只有 persona、时间和 compaction |
| `session.permissionPreset` | `danger-full-access` | 新对话 Session 的 permission preset；`qq` preset 没有挂任何会被这个权限放开的工具 |
| `session.titlePrefix`、`session.timeZone` | `QQ`、`America/New_York` | Session 标题前缀（后接短 id）和每个 prompt 带的时区 |
| `maxMessageChars` | `1500` | 每条 QQ 消息的字符数；更长的回答会被拆分 |
| `maxReplyParts` | `4` | 一个回答最多拆成几条（QQ 允许对一条消息回复五次）；超出部分在最后一条被截断 |
| `perPeerPerMinute` | `10` | 每个用户或群每分钟最多发几条；其余丢弃并记日志 |
| `c2cReplyWindowMs`、`groupReplyWindowMs` | `3300000`、`270000` | 一条消息的回复窗口保持多久（55 分钟和 4.5 分钟；QQ 自己的限制是一小时和 5 分钟） |
| `notifyUnknown` | `true` | 名单外的人发消息时通知 owner |
| `credentialPollMs` | `30000` | AppID 或 AppSecret 缺失时的凭据重查周期 |

在对话里，`/new` 开始新的 Session，`/help` 列出命令；命令不会到达 agent。文字会交给 agent；附件只会被计数，agent 会被告知来了附件，但不会下载。

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-lsy-qq)是全部可接受字段的完整来源。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

通道只通过 `QqTransport`（[`src/transport.ts`](src/transport.ts)）和 QQ 通信；默认实现封装腾讯官方 SDK `@tencent-connect/qqbot-nodejs`（固定版本，MIT），由它获取并刷新 app token、维持网关 WebSocket（心跳、resume、重连），并给同一条消息的回复编号。通道只向网关申请群聊和私聊消息这一个 intent，因为 SDK 默认还会加上个人机器人可能没有的频道 intent，QQ 会以 4914 或 4915 关闭这样的连接；频道和频道私信事件在边界处丢弃。失败的连接（凭据错误、致命关闭）按 2 秒到 2 分钟翻倍的间隔重试，稳定运行一分钟后重置；SDK 的日志只记在 debug 级别，并抹掉密钥和 bearer token。测试里用挂在 `lsyQqTransport` 的替身代替 SDK。

登录（[`src/login.ts`](src/login.ts)，由 [`lsy/deploy/qq-login.mjs`](../../../lsy/deploy/qq-login.mjs) 运行）沿用腾讯 `@tencent-connect/qqbot-connector` 已发布包里可读到的绑定流程，但代码是重新写的，因为那个包不允许再分发：用新的 32 字节密钥调用 `create_bind_task`，二维码页面是 `q.qq.com/qqbot/openclaw/connect.html?task_id=…`，然后轮询 `poll_bind_result`，直到平台返回 AppID、用该密钥加密的 AppSecret（AES-256-GCM）和扫码用户的 openid。二维码过期会被替换（最多三张）。命令把密钥直接写进 `.env` 文件，从不打印。

每条入站消息按以下顺序检查：先是名单（群消息要求 `group_openid` 在 `allow.groups` 里，私聊要求发信人在 `allow.users` 里），再是每个对象的频率限制。通过后它在 `lsy_qq` storage domain 里打开一个回复窗口（消息 id、到达时间、已用回复数），自己处理 `/new` 和 `/help`，其余消息用 `sessionController.prompt()` 以 `steer` 模式发给该对象的对话 Session：agent 工作期间发来的消息会并入正在进行的一轮。Session 按对象键（`c2c:<user_openid>` 或 `group:<group_openid>`）查找，`resolveAgent()` 成功就复用；缺失的会换成按配置 preset 新建的 Session，标题用对象的短 id，并在第一次 prompt 之前以 `qq` 通道向 `ctx.ownerRelay` 认领。通道注册时，所有记得的 Session 会被再次认领。

relay 把每一轮的最终回答（`NO_REPLY` 不发）交给通道，通道把它拆开逐条发送：对象最近那条消息的窗口还开着、回复少于五条时引用该消息，否则作为主动消息发出。QQ 拒收的部分会抛错，relay 随后退回 `ctx.lsyNotifier`，标签是 `a QQ chat Session (its answer could not go out on QQ)`。所有发送和存储写入一次只做一件。

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | 服务、配置、连接循环、名单、对话 Session、`qq` relay 通道、投递 |
| [`src/transport.ts`](src/transport.ts) | `QqTransport`、事件规范化，以及基于官方 SDK 的默认传输 |
| [`src/login.ts`](src/login.ts) | 对平台绑定服务的扫码登录、二维码 PNG、`.env` 写入器和登录命令 |
| [`src/text.ts`](src/text.ts) | 入站消息加框与防伪造、回复拆分、命令回复 |
| [`src/storage.ts`](src/storage.ts) | 对话 Session、回复窗口和已通知的陌生发信人的 storage-domain 表 |

这是 fork 本地的包；[`../UPSTREAM.md`](../UPSTREAM.md) 说明 `lsy` 组如何跟踪上游。选官方开放平台、不选 OneBot 桥（NapCat、LLBot、Lagrange，它们要么运行 QQ 客户端、要么重新实现其协议，账号有被封的风险），也不选官方的 tencent-connect/dsh-qqbot 插件（已审阅，MIT；它不使用 relay，回答会绕过本组的轮次规则和 owner 兜底，访问控制默认还是开放的），理由记在 [`lsy/CHANGELOG.md`](../../../lsy/CHANGELOG.md)。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [Owner relay](../owner-relay/README.zh.md)——在每一轮结束时决定对话 Session 的回答发什么
- [微信通道](../lsy-wechat/README.zh.md)——owner 的通道；接收 QQ 没能送达的内容
- [Session Controller](../../api/session-controller/README.zh.md)——创建、解析并向对话 Session 发 prompt
- [Permission presets](../../interaction/permission-presets/README.zh.md)——对话 Session 的访问级别
- [Storage domain](../../storage/storage-domain/README.zh.md)——持久表

-----

<a id="model-experience"></a>
## 模型体验

### 对话 Session

#### 模型看到什么

每条被接受的消息作为普通用户 prompt 到达，带配置的 `session.timeZone`，host 在前面加一个带发信人短 id 的框：私聊是 `[QQ 私聊 · 5D6E7F] hello`，群里是 `[QQ 群 7E8F90 · 成员 C2B1A0] hello`，群里多个成员共用这个 Session。发信人文字里以 `[QQ` 开头的行会被改成全角括号，所以发信人伪造不了这个框。只有附件的消息读作 `（这条消息带了附件，当前版本不读取附件）`。`qq` preset 的 persona 告诉模型：QQ 上的一切都是别人写的内容，它只能聊天，且绝不透露 owner、这台机器或其他对话。每一轮的最终回答以纯文本发回，QQ 不渲染 Markdown。最终回答恰好是 `NO_REPLY` 时什么都不发。

#### Token 影响

每条 QQ 消息一条用户消息，外加约 10 个 token 的框。Session 长期存在，所以上下文会增长，直到 compaction 或 `/new`。

#### KV Cache 影响

消息追加到每个对象各自的同一个 Session，所以每一轮都复用到目前为止对话的缓存前缀。`/new` 开始一个空 Session，前缀从头建立。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

- **是 openid，不是 QQ 号**——开放平台从不显示发信人的 QQ 号；名单里放的是 openid，而且 openid 只对这个机器人有效。
- **群消息需要 @**——QQ 只投递提到机器人的群消息。
- **回复窗口**——一条消息在私聊约一小时内、群里约五分钟内最多可回复五次；之后的回答作为主动消息发出，QQ 可能拒收或按自己的规则限额，被拒的回答会改送 owner。
- **只有文字**——图片、语音和文件只会以“来了附件”的提示到达 agent，机器人也只发文字。
- **入站至多一次**——消息到达与它的 prompt 之间崩溃会丢掉那条消息。
- **限制来自第三方文档**——回复窗口和额度依据社区对开放平台的文档，所以它们是配置项而不是常量。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是不具权威性的工作上下文：尚未决定的探索方向与维护者备注。已交付的行为与既定理由以上文、包代码和相关 Agent Note 为准。

- 通道用一个本地的开放平台替身（token 端点、网关 WebSocket、消息 API）对 SDK 做过测试，还没有连过腾讯的服务器，所以第一次真实连接要盯着日志。
- 像 B 站账号那样的 `tell_main_agent` 工具、富媒体和 Markdown 回复（平台上的另一项权限）都还没决定。

</details>
