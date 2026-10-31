---
description: "面向模型的 speak 工具：agent 经 ctx.lsyVoice 把文字合成语音，并把音频以 mp3 文件发给微信上的 owner，收件人与回复窗口由通道执行。"
kind: "package-reference"
---

# @deepseek-ai/dsh-lsy-tool-voice

[English](README.md) | 中文

## 概述

在微信上让 agent 把一段话念出来，或者把消息读给你听，对话里会出现一个点一下就能播放的音频文件。agent 用文字调用 `speak`；语音服务生成音频，微信通道把它发给你，且只在你最近一条消息打开的回复窗口内发出。微信机器人不能发语音气泡，所以音频是 mp3 附件。结果会告诉 agent 文件在哪、有没有发出去。

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

把这一行加到需要开口说话的 agent preset 的插件列表里，且该进程同时挂载 [`@deepseek-ai/dsh-lsy-voice`](../lsy-voice/README.zh.md)（要发出去还需要 `@deepseek-ai/dsh-lsy-wechat`）。lsy event profile 把它挂在 `unattended` preset 里，微信聊天 Session 用的就是这个 preset。`ctx.lsyVoice` 出现之后工具才会注册。

```yaml
- id: lsy-tool-voice
  name: '@deepseek-ai/dsh-lsy-tool-voice'
```

插件本身没有配置；服务、音色、限制和开关（`tts.enabled`）都属于 `lsy-voice`。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

工具调用 `ctx.lsyVoice.speak(text)`，然后（除非 `send` 为 false）把文件路径交给 `ctx.lsyNotifier.sendFile`（即微信通道的 `sendFile`，由它检查路径、大小和打开的回复窗口，并为文字回复保留最后一个名额）。两步中任何一步失败，都会作为数据返回给模型，并在日志里留一条警告；每次调用记录文字长度（不记文字本身）、服务和结果。

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：工具定义 |

这是 fork 本地的包，见 [`../UPSTREAM.md`](../UPSTREAM.md)。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [语音服务](../lsy-voice/README.zh.md)——服务、兜底、文件与设置
- [`wechat_send_file`](../lsy-tool-wechat/README.zh.md)——任何文件走的同一条发送路径

-----

<a id="model-experience"></a>
## 模型体验

### 说话工具

#### 模型看到什么

只要调用方 Agent 的 preset 挂载了该包且 `ctx.lsyVoice` 存在，就有一个工具 schema：`speak`，必填字符串 `text`，可选布尔 `send`（默认 true）。描述里写明：文字会变成语音，默认以 mp3 文件发给微信上的 owner（微信机器人不能发语音气泡）；文字要短而自然、适合说出口（一两句话，默认不超过配置的 200 字，更长的分几次调用，因为合成要几十秒），按口语写法书写；发送只在 owner 最近一条消息还新鲜时有效。

#### Token 影响

挂载该包的 preset 下，每次请求都有固定的 schema 开销；其他 preset 下的 Agent 不付这笔开销。

#### KV Cache 影响

工具定义与可见性不变时前缀稳定；挂载或卸载可能让缓存复用从第一个变化的 schema token 起失效。

### 说话结果

#### 模型看到什么

每次调用返回一个 JSON 文本块：`{ "path", "format": "mp3" | "wav", "bytes", "provider", "sent"? , "notSent"? }`，其中 `sent` 是发出的类型，`notSent` 是没发出的原因（`reply window expired`、`the owner has not written yet`、`the WeChat channel is not mounted`，以及 `wechat_send_file` 报告的其他原因）；或者 `{ "error": "<原因>" }`，例如 `speech is turned off (lsy-voice tts.enabled is false)`、`the text is 300 characters; speech takes at most 200, so say it in parts`、`speech failed (feiyu: …; mac-mini: …)`。

#### Token 影响

每次调用几十个 token，保留在 Session 历史中直到压缩。

#### KV Cache 影响

只追加；新出现的内容跟在可复用的请求前缀之后，不会让已有的 KV Cache 条目失效。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

- **只发给 owner，只在窗口内**——音频不能发给别人，也不能像文字那样等到下一个窗口；没发出去的文件留在磁盘上，路径在结果里。
- **是文件，不是气泡**——微信 iLink 机器人 API 没有发送语音消息的接口。
- **B 站没有**——`bili` preset 没挂载它，B 站消息只能发文字。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是不具权威性的工作上下文：尚未决定的探索方向与维护者备注。已交付的行为与既定理由以上文、包代码和相关 Agent Note 为准。

- 语音气泡需要带 SILK 负载的 iLink `voice_item`；协议若有文档化的上传类型再考虑。

</details>
