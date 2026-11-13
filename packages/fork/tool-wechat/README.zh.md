---
description: "面向模型的微信工具：wechat_send 在一轮中途给 owner 发消息，wechat_send_file 把宿主上的图片、视频或文件发给 owner，defer_deliver 把一段文字留到指定时间或 owner 醒来再发，所有规则由通道执行，不由模型决定。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-wechat

[English](README.md) | 中文

## 概述

在微信上让 agent 发一张截图、一份报告或一段视频，它会以真正的图片、文件或视频出现在对话里。`wechat_send_file` 把文件按对应的消息类型发出，`defer_deliver` 把一段文字留到 agent 指定的时间或你醒来时再送到，`wechat_send` 让它在长任务中途直接给你发消息。规则写在宿主代码里：收件人永远是你，只有在你最近一条消息打开的回复窗口内才会发出文件。

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

把下面这一行加进应当能发文件的 agent preset 的插件列表，同一进程里还要挂载 `@deepseek-ai/dsh-wechat`。fork event profile 把它挂在 `unattended` preset 里，微信对话 Session 用的就是这个 preset。

```yaml
- id: tool-wechat
  name: '@deepseek-ai/dsh-tool-wechat'
```

这个插件没有配置项；大小上限是通道的 `maxMediaBytes`（25 MiB）。`wechat_send` 只在通道的 `chat.delivery` 为 `hybrid`（默认）时注册；设成 `text` 时 agent 只有另外两个工具。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

挂载的作用域解析出 `ctx.ownerNotifier` 后，插件最多注册三个 `defineTool` 定义。`wechat_send`（仅当 `ctx.ownerNotifier.delivery()` 为 `hybrid` 时；每次通道被提供时读取，所以配置重载会注册或撤掉它）把文字、`urgent` 和调用方 Session 的 id 交给 `WechatChannel.sendText()`，返回已发出或在等的条数和窗口里剩余的回复数，或拒绝的原因（这一轮的上限、窗口的最后一个名额、空文字、`text` 投递）。`wechat_send_file` 把路径交给 `WechatChannel.sendFile()`，原样返回结果；`defer_deliver` 先检查 `until` 是带 UTC 偏移的 ISO 8601（不带偏移的时间会被按宿主所在时区解读，而模型看不到这个时区），再把文字和解析出的时间交给 `WechatChannel.holdDelivery()`，并把扣住的时间以 ISO 文本返回。通道把文字连同释放时间存进发件箱，并为最早的一条挂一个定时器；醒来会提前释放，owner 自己发消息不会。发文件时，通道检查路径是绝对路径、指向 `maxMediaBytes` 以内的非空普通文件，占用当前回复窗口（最后一个名额留给文字回复），用新生成的 AES-128 密钥加密文件、上传到微信 CDN，再经与文字回复相同的串行路径给 owner 发一个图片、视频或文件条目。不进任何队列；每次发送都记录类型、名称、大小和路径。

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：三个工具定义 |

这是 fork 本地包；见 [`../UPSTREAM.md`](../UPSTREAM.md)。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [微信通道](../wechat/README.zh.md)——回复窗口、双向媒体与 owner 的对话 Session

-----

<a id="model-experience"></a>
## 模型体验

### 消息工具

#### 模型看到什么

`chat.delivery` 为 `hybrid` 时，模型看到 schema `wechat_send`：必填字符串 `text`（"What to tell the owner, as you would write it in a message: plain text, no Markdown."）和可选布尔 `urgent`（穿透 owner 的睡眠）。描述说明：它在这一轮中途立刻给 owner 发微信（长任务的进度、慢步骤之前的第一个答案、等不得的发现）；最终回答仍会作为回复发出，所以这里发过的不要在最终回答里重复，如果该说的都在这里说完了，这一轮就只答 `NO_REPLY`；同一时刻的内容合成一条，因为 owner 每发一条消息只能被回复约十次，其中最后一次留给最终回答；`urgent` 只用于 owner 睡着也必须读到的事。

#### Token 影响

`hybrid` 投递开着、preset 挂载了这个包的 Agent，每次请求多一份约 250 token 的固定 schema 成本。

#### KV Cache 影响

工具定义和可见性不变时前缀稳定；切换 `chat.delivery` 会增减这个 schema，可能让从第一个变化的 schema token 起的复用失效。

### 消息结果

#### 模型看到什么

每次调用一个 JSON 文本块：`{ "sent": <此刻发出的条数>, "queued": <在等的条数>, "held": true | false, "why"?: "<第一条在等的原因>", "repliesLeft"?: <窗口里剩余的回复数> }`，或 `{ "notSent": "<原因>" }`，原因如 `the text is empty`、`this turn already sent 10 messages (the cap is 10): put what is left into your final answer`、`reply quota nearly used up; the last message is kept for your final answer`、`wechat_send is off (chat.delivery is text): put the words in your answer`。

#### Token 影响

每次调用几十个 token，留在 Session 历史里直到压缩。

#### KV Cache 影响

只追加；新可见内容接在可复用的请求前缀之后，不会让已有 KV Cache 条目失效。

### 发送工具

#### 模型看到什么

调用方 Agent 的 preset 挂载了这个包时，模型看到一个工具 schema：`wechat_send_file`，必填字符串参数 `path`（"Absolute path of a regular file on this computer, at most 25 MiB."）。描述说明图片发成图片、`.mp4`/`.mov`/`.m4v` 发成视频、其余发成文件；收件人永远是 owner，只有在 owner 最近的消息仍有效且回复额度未用完时才能发送；最终回答仍以文字回复发出。

#### Token 影响

preset 挂载了这个包的 Agent，每次请求都有固定的 schema 开销；其他 preset 下的 Agent 没有开销。

#### KV Cache 影响

工具定义与可见性不变时前缀稳定；挂载或卸载可能让第一个变化的 schema token 之后的缓存复用失效。

### 延后工具

#### 模型看到什么

第二个 schema `defer_deliver`：必填字符串 `text`（“What to tell the owner, as you would write it in a message.”）和可选字符串 `until`（带 UTC 偏移的 ISO 8601，最多 7 天以内；不填就等 owner 醒来）。描述说明：文字会在 `until` 到达或 owner 醒来时发出，先到者为准；不填 `until` 时 owner 此刻必须在睡；不要在最终答复里重复这段文字（如果这就是全部要说的，就只答 `NO_REPLY`）；发送需要一个打开的微信回复窗口。

#### Token 影响

挂载该包的 preset 下的 Agent，每次请求多一份约 300 token 的固定 schema 成本。

#### KV Cache 影响

工具定义和可见性不变时前缀稳定；挂载或卸载可能让从第一个变化的 schema token 起的复用失效。

### 延后结果

#### 模型看到什么

每次调用一个 JSON 文本块：`{ "held": <条数>, "until": "<ISO 时间>"?, "wakes": true | false }`（owner 此刻在睡时 `wakes` 为 true，醒来可能先把它放出）；或 `{ "notHeld": "<原因>" }`，原因如 `the text is empty`、`until is not in the future`、`until is more than 7 days away`、`until is not an ISO 8601 time with a UTC offset, …`、`the owner is awake: put the text in your answer, or give a time with until`。

#### Token 影响

每次调用几十个 token，留在 Session 历史里直到压缩。

#### KV Cache 影响

只追加；新可见内容接在可复用的请求前缀之后，不会让已有 KV Cache 条目失效。

### 发送结果

#### 模型看到什么

每次调用一个 JSON 文本块：`{ "sent": "image" | "video" | "file", "name", "bytes" }`，或 `{ "notSent": "<原因>" }`，原因例如 `path must be absolute`、`not a regular file`、`the file exceeds 26214400 bytes`、`the owner has not written yet`、`reply window expired`、`reply quota nearly used up; the last message is kept for the text reply`、`upload failed: …`。

#### Token 影响

每次调用几十个 token，留在 Session 历史里直到压缩。

#### KV Cache 影响

只追加；新出现的内容位于可复用的请求前缀之后，不会使已有的 KV Cache 条目失效。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

- **只发给 owner，只在窗口内**——文件不能发给别人，也不能像文字那样等到下一个窗口。
- **不发语音**——音频文件以文件附件发出，不是语音消息。
- **扣住的文字在到点时需要一个窗口**——`until` 到达时回复窗口已关闭或额度用完，这段文字就像别的文字一样留在发件箱，随 owner 的下一条消息发出。
- **不能撤回**——agent 不能收回已扣住的文字；owner 可以在设置 → 勿扰里一次把扣住的全部发出。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是不具权威性的工作上下文：尚未决定的探索方向与维护者备注。已交付的行为与既定理由以上文、包代码和相关 Agent Note 为准。

- 上传流程参照 xiaoshihou514/dsh-weixin（MIT）与 @tencent-weixin/openclaw-weixin；视频条目不带缩略图。

</details>
