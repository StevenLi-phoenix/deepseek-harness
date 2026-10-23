---
description: "事件服务的微信（iLink bot）通道：在微信里通过一个长期存在的对话 Session 和 agent 聊天、收到它的回答，并经 ctx.lsyNotifier 接收事件通知；用持久 outbox 应对微信的回复窗口限制。"
kind: "package-reference"
---

# @deepseek-ai/dsh-lsy-wechat

[English](README.md) | 中文

## 概述

在手机微信上和你的 agent 聊天。扫一次二维码绑定 bot；之后你发给它的每条消息都会进入同一个长期存在的对话 Session，每个回答都以微信消息发回。事件通知和无人值守运行的结果也出现在同一个对话里。微信只允许 bot 在你自己的消息打开的窗口内发言，暂时发不出去的内容留在持久 outbox 里，等你下次发消息时合成一条摘要送达。只有扫码的那个微信用户能和 agent 对话。

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

在 Web profile 里把通道挂在 `@deepseek-ai/dsh-lsy-event-bus` 旁边。它提供 `ctx.lsyNotifier`，总线的通知就发到这里；它依赖 Host 的 Session Controller、permission preset、Session 标题和 storage domain facility。

### 何时选用

希望 agent 能在手机上找到你、你也能直接在手机上回复，又不想暴露 Web UI 时选它。群聊或多人使用不要选它：它只服务一个 owner，其他人的消息一律丢弃。

### 最小配置

先绑定 bot。以服务运行的用户身份、从已安装的构建里运行登录命令，用微信扫二维码；微信显示数字时把它输进终端：

```sh
sudo -u dsh-runtime env DSH_HOME=/Users/dsh-runtime/.dsh /opt/homebrew/bin/node /Users/Shared/lsy-dsh/current/lsy/deploy/wechat-login.mjs
```

命令以 600 权限写入 `<DSH_HOME>/lsy-wechat/account.json`，只打印 bot id 和 owner id。运行中的服务会在 `accountPollMs` 内读到这个文件；重新绑定会替换它，不需要重启。然后挂载通道：

```yaml
- insert:
    - id: lsy-wechat
      name: '@deepseek-ai/dsh-lsy-wechat'
      config:
        chat:
          workspacePath: /Users/dsh-runtime/work
          agentPreset: unattended
          permissionPreset: danger-full-access
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `accountFile` | `<DSH_HOME>/lsy-wechat/account.json` | 登录命令写入的账号文件 |
| `chat.workspacePath` | `/Users/dsh-runtime/work` | 对话 Session 的绝对路径目录；每次转发消息前确保存在。收到的附件存进其中的 `.wechat-inbox/`（目录 0700，文件 0600），它自带忽略规则，工作区是 git 仓库时附件也不会被提交 |
| `chat.agentPreset` | `unattended` | 新对话 Session 的 agent preset |
| `chat.permissionPreset` | `danger-full-access` | 新对话 Session 设置的 permission preset |
| `chat.title` | `微信` | 新对话 Session 的标题 |
| `chat.timeZone` | `America/New_York` | 随每条 prompt 发送、也用于摘要时间戳的时区 |
| `maxMessageChars` | `3000` | 每条微信消息的字符数；更长的文本会拆分，每条消息同时不超过 16384 个 UTF-8 字节 |
| `maxReplyParts` | `3` | 一段文本最多拆成的消息数；超出部分截断在最后一条 |
| `repliesPerToken` | `10` | 你每发一条消息，bot 可以发的消息数 |
| `contextTtlMs` | `84600000` | 你的一条消息让回复窗口保持打开的时长（23.5 小时） |
| `outboxLimit` | `50` | 保留的未送达文本数；最旧的先丢弃 |
| `accountPollMs` | `30000` | 没有可用账号时重新检查账号文件的间隔 |
| `longPollTimeoutMs` | `35000` | 服务器给出建议值之前的长轮询时限 |
| `requestTimeoutMs` | `15000` | 一次发送的时限 |
| `cdnBaseUrl` | `https://novac2c.cdn.weixin.qq.com/c2c` | 下载附件用的微信 CDN；服务器给出的 `full_url` 若不在这个 origin 上则拒绝 |
| `maxMediaBytes` | `26214400` | 下载附件的大小上限（25 MiB） |
| `mediaTimeoutMs` | `60000` | 一个附件下载的时限 |

在对话里发 `/new` 会开始一个新的对话 Session。文字、语音转写和引用会交给 agent。图片、文件和视频会从微信 CDN 下载、解密并存进 inbox；模型的线路支持图片时，图片也会作为图片内容交给模型。

`sendFile(path)` 把本机文件发回去：内容是图片就发成图片，`.mp4`、`.mov`、`.m4v` 发成视频，其他发成文件。模型不该决定的事都由宿主决定：收件人永远是 owner，文件只经当前回复窗口发送（从不进 outbox），窗口的最后一个名额留给本轮的文字回复，路径必须指向 `maxMediaBytes` 以内的普通文件。工具包 [`@deepseek-ai/dsh-lsy-tool-wechat`](../lsy-tool-wechat/README.zh.md) 把它作为 `wechat_send_file` 提供给 agent。

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-lsy-wechat)是全部可用字段的权威来源。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

插件运行期间，通道持续长轮询 `ilink/bot/getupdates`，并在处理消息之前把返回的游标存进 `lsy_wechat` storage domain，所以崩溃只会丢消息，不会重复发 prompt。两次轮询之间它会重读账号文件；没有可用账号、或服务器报告 token 失效（`-14`）时，它只记一次日志，然后每隔 `accountPollMs` 检查一次文件。它只接受 owner 发来的用户消息。每条消息打开一个回复窗口（`context_token`、接收时间、已用条数），先把 outbox 作为摘要消息发出（摘要永远不占窗口的最后一个名额），再用 `sessionController.prompt()` 以 `steer` 模式转给 owner 的对话 Session：Session 空闲时开始新一轮，正在忙时在下一个步骤边界接收这条消息，所以紧跟一句话发来的图片会进入正在回答那句话的那一轮。转发之前，每个图片、文件和视频条目都会被下载（AES-128-ECB，密钥取 `image_item.aeskey` 或 `media.aes_key`），按内容或文件名判断类型，再写进 inbox；prompt 为每个附件附一行说明，图片作为图片内容附上；如果被拒绝为 `session/attachment-invalid`（模型只支持文本），就只带说明重发一次。`resolveAgent()` 成功时复用已存的 Session；Session 不存在或已损坏时，用 `sessionController.create()` 新建一个，并设置 permission preset 和标题。通道跟踪自己创建的每个对话 Session 的 `session/event`，记住这一轮最新的助手文本，在这一轮结束时发出，除非它是 `NO_REPLY`。`send()` 和回复转发共用一条串行的投递路径：文本只经由已打开、未过期且仍有名额的窗口发出，占用最后一个名额的那条带一句提示，其余的连同原因进入 outbox。`ret -2` 关闭窗口，`-14` 暂停通道，网络失败时文本留在 outbox 里。

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | 服务、配置、长轮询循环、对话 Session、回复转发、投递与 outbox |
| [`src/api.ts`](src/api.ts) | 最小的 iLink 客户端，每个请求有独立时限；错误信息从不包含 token |
| [`src/login.ts`](src/login.ts) | 二维码登录状态机、终端登录命令、账号文件 |
| [`src/text.ts`](src/text.ts) | 入站文本提取、消息拆分、转发文本、摘要 |
| [`src/media.ts`](src/media.ts) | CDN 下载与解密、图片类型识别、inbox、附件说明；外发的加密与上传（`getuploadurl`、CDN POST、`x-encrypted-param`） |
| [`src/storage.ts`](src/storage.ts) | 游标、回复窗口、对话 Session 与 outbox 的 storage-domain 表 |

这是 fork 本地的包；`lsy` 组如何跟踪上游见 [`../UPSTREAM.md`](../UPSTREAM.md)。协议参照腾讯 OpenClaw 微信插件（`@tencent-weixin/openclaw-weixin` 2.4.10）；这个客户端实现二维码登录、`getupdates`、媒体下载和文本 `sendmessage`。媒体格式与 origin 校验参照 [xiaoshihou514/dsh-weixin](https://github.com/xiaoshihou514/dsh-weixin)（MIT）。[`lsy/deploy/wechat-login.mjs`](../../../lsy/deploy/wechat-login.mjs) 只是 `runLoginCli()` 外面的一层薄壳，逻辑由测试覆盖。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [事件总线](../lsy-event-bus/README.zh.md)——把通知和 Session 结果发给这个通道
- [Session Controller](../../api/session-controller/README.zh.md)——创建、解析对话 Session 并向它发 prompt
- [Permission presets](../../interaction/permission-presets/README.zh.md)——对话 Session 的权限档位
- [Storage domain](../../storage/storage-domain/README.zh.md)——持久表

-----

<a id="model-experience"></a>
## 模型体验

### 对话 Session

#### 模型看到什么

owner 的每条微信消息都以普通用户 prompt 的形式进入对话 Session，带上配置的 `chat.timeZone`，和在 Web UI 里输入的文字一样。文本不带任何微信包装；引用会多一行 `[引用] …`，语音消息是 `[语音] <转写>`，媒体是占位符，后面每个附件跟一行说明，例如 `- image (image/jpeg, 84.2 KB) saved at /Users/dsh-runtime/work/.wechat-inbox/…-image.jpg; it is attached to this message.`；没能取到的附件会注明取不到、内容不可用。不超过 20 MiB、格式为 Host 接受的 PNG、JPEG、GIF、WebP 的图片，同时作为同一条消息的图片内容。每一轮模型的最终回答以纯文本发回，所以 Markdown 在手机上会原样显示。最终回答恰好是 `NO_REPLY` 时什么也不发。

#### Token 影响

每条微信消息一条用户消息，长度就是 owner 写的长度，外加每个附件约一行说明，以及每张附上的图片的图片 token。对话 Session 长期存在，上下文会跨天增长，直到压缩或 `/new`。

#### KV Cache 影响

消息追加到同一个 Session，每一轮都复用到目前为止对话的缓存前缀。`/new` 开始一个空 Session，前缀从头建立。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

- **24 小时窗口**——owner 最后一条消息之后大约一天内，微信才接受 bot 的消息；之后的文本在 outbox 里等待。如果在等提醒，每天给 bot 发一个字。
- **每条 owner 消息约 10 条回复**——窗口内 bot 能发的消息数有限；最后一条会说明这一点，其余的等 owner 下一条消息。
- **不能主动发起联系**——owner 给 bot 发消息之前，bot 无法发言。
- **语音只有文字**——语音只以转写交给 agent，bot 也从不发语音；图片、文件和视频两个方向都支持。
- **inbox 不会自动清理**——收到的附件一直留在 `.wechat-inbox/`，需要手动删除。
- **没有"正在输入"提示**——agent 工作时 owner 看不到任何动静。
- **入站至多一次**——存储游标与转发消息之间崩溃会丢掉那条消息。
- **限制来自第三方文档**——窗口时长、额度和长度上限没有官方公布，所以它们是配置项而不是常量。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是不具权威性的工作上下文：尚未决定的探索方向与维护者备注。已交付的行为与既定理由以上文、包代码和相关 Agent Note 为准。

- `/new` 是唯一的聊天命令；其他命令（例如在微信里切换聊天 Session 的模型）尚未决定。

</details>
