---
description: "打到 owner iPhone 的语音线路（默认禁用）：VoIP 推送经 CallKit 让 DSH Call app 响铃，经 Tailscale 的全双工 WebRTC 通话和一个通话 Session 对话、可以打断，owner 也能从 app 打给 agent。"
kind: "package-reference"
---

# @deepseek-ai/dsh-voice-call

[English](README.md) | 中文

## 概述

让 agent 给你打电话，你也能打回去。有事等不了的时候，agent 调用 `call_owner`；你的 iPhone 像普通来电一样响铃并显示原因，接起来就能和 agent 说话。你一开口，它就停下来听。你也可以从 DSH Call app 给 agent 打电话；挂断后，主 agent 拿到通话记录，接着办你交代的事。手机经你的 tailnet 连到 Host，不经过电话网或第三方语音服务；Apple 的推送服务只负责让电话响起来。

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

**这条线路默认禁用。**[`voice-call` bundle](../../../fork/bundles/voice-call/README.zh.md) 里它的那一行带着 `disabled: true`，并定义了通话 Session 用的 `voice-call` agent preset。在 Web profile 里把它挂在 [`@deepseek-ai/dsh-owner-relay`](../owner-relay/README.zh.md)（`ctx.ownerRelay`）旁边，本插件注册它的 `voice-call` 通道；没有 relay 时电话能接通，但听不到回答。它依赖 Host 的 Session Controller、permission preset、Session 标题、凭据存储、storage domain facility 和 Web server。挂载了 `ctx.presence`（睡眠）、`ctx.voice`（服务端语音）和 `ctx.ownerNotifier`（交给主 agent）时会用到它们。agent 一侧是 [`@deepseek-ai/dsh-tool-voice-call`](../tool-voice-call/README.zh.md) 的 `call_owner` 工具；手机一侧是 [DSH Call iOS app](../../../fork/apps/voice-call-ios/README.zh.md)。

### 何时选用

当 agent 偶尔有必须让你马上听到的事，或者有说两句比打字更快的决定，而你随身带着和 Host 在同一个 tailnet 上的 iPhone 时，选它。不要用它发日常通知：电话会打断你，所以工具说明和每小时限额让电话保持稀少，消息仍然是默认渠道。

### 最小配置

你需要 Apple Developer 账号、装在手机上的 app，以及一把 APNs 认证密钥（`.p8`）和它的 Key ID、你的 Team ID。把这四项凭据放进 `<DSH_HOME>/.env`（权限 600）或凭据存储，绝不要写进 profile：

| 凭据 | 内容 |
|---|---|
| `VOICE_CALL_TOKEN` | 一个很长的随机 bearer token；在 app 里填同一个值 |
| `VOICE_CALL_APNS_KEY_ID` | 认证密钥的十位 Key ID |
| `VOICE_CALL_APNS_TEAM_ID` | Apple Developer Team ID |
| `VOICE_CALL_APNS_KEY` | `.p8` 密钥的 PEM 文本，或这个文件的绝对路径 |

然后在 profile patch 里启用这一行，填上 app 的 bundle identifier，媒体 socket 也可以绑到 Host 的 Tailscale 地址：

```yaml
- id: voice-call
  disabled: false
  config:
    apns:
      bundleId: com.example.dshcall
    ice:
      bindAddress: 100.64.0.1
```

改了 `.env` 要重启服务，因为它只在启动时读取。在 app 里填 Host 在 tailnet 上的 URL 和 token；app 用 `PUT /voice-call/v1/devices/<id>` 登记它的 VoIP token，token 对上之后 `GET /voice-call/v1/health` 才会回答。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `tokenEnv` | `VOICE_CALL_TOKEN` | 存 app bearer token 的凭据名；没设置时所有请求都返回 503 |
| `apns.keyIdEnv`、`apns.teamIdEnv`、`apns.keyEnv` | `VOICE_CALL_APNS_KEY_ID`、`VOICE_CALL_APNS_TEAM_ID`、`VOICE_CALL_APNS_KEY` | APNs 签名密钥的凭据名；缺一项时 agent 的来电会被拒绝 |
| `apns.bundleId` | `com.example.dshcall` | app 的 bundle identifier；推送发往 `<bundleId>.voip` |
| `apns.caller` | `DSH` | CallKit 给 agent 来电显示的名字 |
| `session.agentPreset` | `voice-call` | 通话 Session 的 agent preset；bundle 里的这个 preset 用简短的口语回答，不挂任何工具 |
| `session.workspacePath` | `/Users/dsh-runtime/voice-call` | 通话 Session 的绝对目录；每次通话前创建 |
| `speech.stt`、`speech.tts` | `device`、`device` | 识别和合成在哪里做：`device`（手机上的 Apple 语音）或 `server`（Host 上的 `speech.provider`） |
| `speech.provider` | `voice` | `server` 语音用的 Host 服务；`voice` 适配 `ctx.voice`，其他名字指一个带 `transcribe` 和 `synthesize` 的服务 |
| `limits.callsPerHour` | `4` | agent 在滚动的一小时里最多打几通 |
| `limits.respectSleep` | `true` | `ctx.presence` 说 owner 在睡觉时，拒绝不紧急的 agent 来电 |
| `limits.ringTimeoutMs`、`limits.maxCallMs` | `45000`、`900000` | 响多久算未接，以及一通电话最长多久 |
| `limits.bargeIn` | `true` | owner 一开口就停下 agent 的语音 |
| `handOff` | `true` | owner 自己打来的电话结束后，把通话记录交给主 agent |
| `ice.bindAddress`、`ice.minPort`、`ice.maxPort` | 空、`0`、`0` | 媒体 socket 的地址和 UDP 端口范围；为空时收集所有网卡 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-voice-call)列出所有可用字段，包括语音活动检测。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

`ctx.voiceCall.ring(request, signal)` 接收一个 `RingRequest`（`reason` 是这通电话要说的事，`urgent` 表示紧急），电话结束后以 `RingResult` 返回：没打出去时是 `{ status: 'refused', reason }`，否则是 `{ status: 'ended', call, detail, transcript }`，带着通话记录（结果和时间）和每一行通话文字。

同一时间只有一通电话。agent 的来电会建一条 `ringing` 记录，并给每台登记过的设备发 VoIP 推送；Apple 要求 app 对每个 VoIP 推送都向 CallKit 报一通来电，所以手机会响。失效的设备 token（HTTP 410）会让这台设备被删除。接起电话时，app 把完整的 SDP offer 发到 `POST /voice-call/v1/calls/<id>/connect`；服务在 SDP answer 里带上所有本地 host candidate，所以信令只要一次 HTTP 往返，不需要 STUN、TURN 或 WebSocket。拒接、挂断和响铃超时分别以 `declined`、`completed` 或 `missed` 结束通话。

媒体接通后，服务创建通话 Session，用 relay 的 `voice-call` 通道认领它，并用开场上下文 prompt 它：谁打的电话；agent 的来电还会把原因放在 `<reason>` 里，标明是另一个 Session 写的资料（请求 id 用 `turn-taint` 标成不可信）。之后由 [`Conversation`](src/conversation.ts) 跑语音循环：

- **听**：`speech.stt: device` 时由 app 识别语音，在 `control` 数据通道上发 `utterance` 帧；`server` 时，一个基于能量的语音活动检测器在 20 ms 的 PCMU 帧上切出一句句话，由 `speech.provider` 转写。每句话都以 `steer` 模式 prompt，所以一轮进行中说的话会在下一步并入。
- **说**：relay 交给通道的每个最终回答都先去掉 Markdown，然后要么以 `say` 帧发给 app（`speech.tts: device`），要么逐句合成、重采样到 8 kHz，每 20 ms 送出一帧。
- **打断**：检测器发现开口、app 发来 `speaking` 帧或 app 的打断按钮，都会停止合成、清空待播队列，并让 app 停止朗读。

到了 `limits.maxCallMs`、某一路断开超过 `ice.disconnectGraceMs`、或 app 发来 `hangup` 时，服务挂断。每通电话存一条记录（方向、原因、时间、结果、通话记录），超出 `keepCalls` 的最旧记录会被忘掉；Host 停止时还在进行的通话，下次启动时以 `failed` 关闭。日志只记 id、数量和时长，从不记 token、密钥或说了什么。

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | `ctx.voiceCall`：配置、通话、设备、relay 通道和交接 |
| [`src/routes.ts`](src/routes.ts) | `/voice-call/v1/` 下带 bearer token 的 HTTP 路由 |
| [`src/protocol.ts`](src/protocol.ts) | 协议第 1 版：HTTP 请求体、推送内容和控制帧 |
| [`src/apns.ts`](src/apns.ts) | 基于 HTTP/2 和 ES256 token 的 APNs 客户端 |
| [`src/webrtc.ts`](src/webrtc.ts)、[`src/media.ts`](src/media.ts) | 基于 werift 的 WebRTC 通话腿和媒体接口 |
| [`src/conversation.ts`](src/conversation.ts) | 一通已接通电话的听、说和打断 |
| [`src/vad.ts`](src/vad.ts)、[`src/audio.ts`](src/audio.ts)、[`src/playout.ts`](src/playout.ts) | 语音活动检测、PCMU 与重采样、定速播放 |
| [`src/speech.ts`](src/speech.ts) | 语音 provider 接口、`ctx.voice` 适配器和断句 |
| [`src/storage.ts`](src/storage.ts) | 设备和通话记录的 storage-domain 表 |

这是 fork 本地的包；[`../UPSTREAM.md`](../UPSTREAM.md) 说明 `fork` 组如何跟踪上游。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [DSH Call iOS app](../../../fork/apps/voice-call-ios/README.zh.md)——PushKit、CallKit 和 WebRTC 客户端
- [`call_owner`](../tool-voice-call/README.zh.md)——agent 的工具
- [Owner relay](../owner-relay/README.zh.md)——把通话 Session 的回答交给这个通道
- [语音服务](../voice/README.zh.md)——服务端识别与合成
- [Presence](../presence/README.zh.md)——owner 是否在睡觉

-----

<a id="model-experience"></a>
## 模型体验

### 通话 Session

#### 模型看到什么

每通电话一个新的 Session，用 `voice-call` preset，它的人设说写出来的每个字都会被念出来：简短的中文句子，不要 Markdown、列表、链接或代码，agent 来电的原因是资料而不是指令。第一条 prompt 是 Host 写的开场上下文：agent 的来电是 `[通话] 你给主人打了电话，主人已经接听。…`，后面跟着放在 `<reason>` 里的原因；owner 的来电是 `[通话] 主人用 DSH Call 给你打来了电话，已经接通。…`。之后 owner 的每句话都作为普通用户 prompt 到达，带着配置的 `session.timeZone`。每个最终回答都会被念出来；`NO_REPLY` 什么也不说。

#### Token 影响

每句话一条用户消息。通话很短（默认最长 15 分钟），所以它的 Session 很小；这个 Session 不会复用。

#### KV Cache 影响

每句话都追加到这通电话自己的 Session 里，所以每一轮复用这通电话已缓存的前缀；每通电话从新的前缀开始。

### 交给主 agent

#### 模型看到什么

owner 自己打来的电话结束、而且 owner 说过话时，主 agent 经 `ctx.ownerNotifier.tellMainAgent` 收到一条消息：`主人刚和通话 agent 打了 N 分钟电话。通话记录如下；主人交代的事如果通话里没办完，由你接着办：`，后面每行通话记录一行 `主人：…` 或 `通话 agent：…`。

#### Token 影响

一条和通话记录一样大的用户消息，最多 `limits.transcriptLines` 行。

#### KV Cache 影响

只追加；新可见的内容跟在可复用的请求前缀之后，不会让已有的 KV Cache 条目失效。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

- **只有 iPhone，同时只有一通**——唯一的客户端是 iOS app，有一通在进行时第二通会被拒绝。
- **只走 tailnet**——媒体只用 host candidate，没有 STUN 或 TURN，所以手机必须能直接连到 Host，这由 Tailscale 提供。
- **PCMU 音频**——通话腿用 8 kHz 的 G.711，所有 WebRTC 实现都支持；听起来像电话，不是宽带音质。
- **这里没在真机上验证**——服务用本地 HTTP/2 服务器和脚本化的媒体替身测过，WebRTC 通话腿用 werift 对端测过；真实的 APNs 推送和 iOS app 需要 Apple Developer 账号和手机。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是不具权威性的工作上下文：尚未决定的探索方向与维护者备注。已交付的行为与既定理由以上文、包代码和相关 Agent Note 为准。

- 等 werift 的 Opus 路径和 iOS WebRTC 对过之后，Opus 能带来宽带音质。
- 给通话 Session 只读工具、以及在一轮结束前就把部分回答流式送去合成，都还没决定。

</details>
