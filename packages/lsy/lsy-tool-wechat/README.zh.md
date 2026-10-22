---
description: "面向模型的 wechat_send_file 工具：agent 经 lsy 微信通道把宿主上的图片、视频或文件发给 owner，所有规则由通道执行，不由模型决定。"
kind: "package-reference"
---

# @deepseek-ai/dsh-lsy-tool-wechat

[English](README.md) | 中文

## 概述

在微信上让 agent 发一张截图、一份报告或一段视频，它会以真正的图片、文件或视频出现在对话里，而不是文字回复里的一个路径。agent 用宿主上的文件调用 `wechat_send_file`；图片内容发成图片，`.mp4`、`.mov`、`.m4v` 发成视频，其余发成文件附件。规则写在宿主代码里：收件人永远是你，只有在你最近一条消息打开的回复窗口内才会发出。结果会告诉 agent 发了什么，或为什么没发。

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

把下面这一行加进应当能发文件的 agent preset 的插件列表，同一进程里还要挂载 `@deepseek-ai/dsh-lsy-wechat`。lsy event profile 把它挂在 `unattended` preset 里，微信对话 Session 用的就是这个 preset。

```yaml
- id: lsy-tool-wechat
  name: '@deepseek-ai/dsh-lsy-tool-wechat'
```

这个插件没有配置项；大小上限是通道的 `maxMediaBytes`（25 MiB）。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

挂载的作用域解析出 `ctx.lsyNotifier` 后，插件注册一个 `defineTool` 定义，工具体把路径交给 `WechatChannel.sendFile()`，原样返回结果。通道检查路径是绝对路径、指向 `maxMediaBytes` 以内的非空普通文件，占用当前回复窗口（最后一个名额留给文字回复），用新生成的 AES-128 密钥加密文件、上传到微信 CDN，再经与文字回复相同的串行路径给 owner 发一个图片、视频或文件条目。不进任何队列；每次发送都记录类型、名称、大小和路径。

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：工具定义 |

这是 fork 本地包；见 [`../UPSTREAM.md`](../UPSTREAM.md)。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [微信通道](../lsy-wechat/README.zh.md)——回复窗口、双向媒体与 owner 的对话 Session

-----

<a id="model-experience"></a>
## 模型体验

### 发送工具

#### 模型看到什么

调用方 Agent 的 preset 挂载了这个包时，模型看到一个工具 schema：`wechat_send_file`，必填字符串参数 `path`（"Absolute path of a regular file on this computer, at most 25 MiB."）。描述说明图片发成图片、`.mp4`/`.mov`/`.m4v` 发成视频、其余发成文件；收件人永远是 owner，只有在 owner 最近的消息仍有效且回复额度未用完时才能发送；最终回答仍以文字回复发出。

#### Token 影响

preset 挂载了这个包的 Agent，每次请求都有固定的 schema 开销；其他 preset 下的 Agent 没有开销。

#### KV Cache 影响

工具定义与可见性不变时前缀稳定；挂载或卸载可能让第一个变化的 schema token 之后的缓存复用失效。

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

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是不具权威性的工作上下文：尚未决定的探索方向与维护者备注。已交付的行为与既定理由以上文、包代码和相关 Agent Note 为准。

- 上传流程参照 xiaoshihou514/dsh-weixin（MIT）与 @tencent-weixin/openclaw-weixin；视频条目不带缩略图。

</details>
