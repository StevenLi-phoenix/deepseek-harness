# DSH Call iOS 版

[English](README.md) | 中文

DSH Call 是一个 iPhone app，给 DSH 一条电话线路。DSH 可以像普通来电一样让 iPhone 响铃，owner 也可以从 app、Siri 或"电话"app 的"最近通话"给 DSH 打电话。声音经 Tailscale 用 WebRTC 直接连到运行 DSH 的 Mac；Apple 的推送服务只负责让电话响起来。服务端是 [`@deepseek-ai/dsh-voice-call`](../../../packages/fork/voice-call/README.zh.md) 包。

本页先是一份配置教程，然后是关于通话如何进行、项目结构和已知限制的参考章节。

## 要求

- Xcode 16 或更高版本。项目使用 Swift 5 语言模式，并开启完整的并发检查。
- [XcodeGen](https://github.com/yonaskolb/XcodeGen) 2.45 或更高版本（`brew install xcodegen`）。Xcode 项目由它生成，不提交到仓库。
- 付费的 Apple Developer Program 会员资格。VoIP 推送、CallKit 和安装到自己的 iPhone 都需要它。
- 一个 APNs 认证密钥（`.p8` 文件）及其 Key ID，以及你的 Team ID。服务端用它为推送签名；app 从不接触它。
- 一台 iOS 17 或更高版本的真机 iPhone。模拟器收不到 VoIP 推送，也无法用真实音频进行 CallKit 通话。
- iPhone 和 Mac 上都装有 Tailscale 且在同一个 tailnet 中，Mac 上运行着 DSH 的 voice-call 服务。

## 配置

### 1. 选定 bundle identifier 并获取 APNs 密钥

选一个属于你团队的 bundle identifier，例如 `com.yourcompany.dshcall`。不需要手动注册：使用自动签名时，Xcode 会在你第一次为 iPhone 构建时注册 App ID，并根据 `DSHCall/Resources/DSHCall.entitlements` 打开 Push Notifications。

在开发者账号中打开 Certificates, Identifiers & Profiles，再进入 Keys，创建一个启用 Apple Push Notifications service (APNs) 的密钥。下载 `.p8` 文件（Apple 只允许下载一次），记下 10 个字符的 Key ID。Team ID 在 Membership details 页面上。一个密钥可用于团队的所有 app，也同时适用于 sandbox 和 production 两个推送环境。

### 2. 配置服务端

按服务端的[最小配置](../../../packages/fork/voice-call/README.zh.md#use-this-package)操作。app 依赖其中这几项：

- `VOICE_CALL_TOKEN` 保存一个足够长的随机令牌，在 app 里填入同一个值。
- `VOICE_CALL_APNS_KEY_ID`、`VOICE_CALL_APNS_TEAM_ID` 和 `VOICE_CALL_APNS_KEY` 保存第 1 步得到的密钥信息。
- `apns.bundleId` 是你的 bundle identifier。服务端把推送发往主题 `<bundle identifier>.voip`，两者不一致时手机永远不会响铃。
- `ice.bindAddress` 是 Mac 的 Tailscale 地址（`tailscale ip -4`），这样服务端只提供手机能连到的候选地址。
- 手机必须能经 HTTPS 访问 DSH 的 Web server。Tailscale Serve 会给它一个带有效证书的地址，例如 `https://mac-mini.your-tailnet.ts.net`。app 拒绝明文 HTTP。

### 3. 填写签名设置

```sh
cd fork/apps/voice-call-ios
cp Config/Local.example.xcconfig Config/Local.xcconfig
```

编辑 `Config/Local.xcconfig`，设置 `PRODUCT_BUNDLE_IDENTIFIER` 和 `DEVELOPMENT_TEAM`。Git 会忽略这个文件。`Config/Base.xcconfig` 里是占位值 `com.example.dshcall` 和空的 team，只能用于模拟器构建。

### 4. 生成项目并运行

```sh
xcodegen generate
open DSHCall.xcodeproj
```

Xcode 会解析 WebRTC 包（第一次需要下载 46 MB 的二进制文件）。把运行目标选为你的 iPhone，按 Run。Run 使用 Debug 配置，它的推送令牌属于 APNs sandbox；app 注册时会告诉服务端这一点。系统询问时允许使用麦克风。

### 5. 把 app 连到服务端

1. 点设置（齿轮按钮），填入第 2 步的服务端地址和令牌，再点保存。令牌保存在这台 iPhone 的钥匙串中。
2. 在"连接"下点"检查连接"。它会显示语音通话是否开启，以及语音识别和语音合成在哪里进行。
3. 在"来自 DSH 的来电"下，状态应显示"DSH 可以呼叫这台 iPhone"。地址、令牌或推送令牌变化时，app 会自动把 VoIP 推送令牌发给服务端；点"注册"可以再发一次。
4. 如果服务端让设备识别语音（`speech.stt: device`，默认值），在系统询问时允许语音识别，并在"设备端语音"下选择识别语言。

### 6. 给 DSH 打电话

点"打给 DSH"。系统通话界面打开，被叫方是 DSH；声音接通后计时开始，DSH 会先跟你打招呼。正常说话即可。app 的通话界面显示 DSH 正在做什么（正在听、正在思考、正在说话）以及通话的文字记录。点"打断"让 DSH 停止说话，或者直接开口。用"挂断"按钮或系统通话界面挂断。

同样的通话也可以这样发起：对 Siri 说 app 的某个短语，例如 "Call DSH with DSH Call"（中文为"用 DSH Call 打给 DSH"）；在"快捷指令"app 中运行"打给 DSH"操作；或点"电话"app"最近通话"中的 DSH Call 条目。app 还把 DSH 声明为备用 app 名称，所以更短的 "Call DSH"（"打给 DSH"）也可能匹配。

### 7. 让 DSH 打给你

让一个带有 [`call_owner`](../../../packages/fork/tool-voice-call/README.zh.md) 工具的 agent（智能体）给你打电话。iPhone 会显示 CallKit 来电界面并响铃，锁屏或 app 未运行时也一样，来电名称会说明 DSH 为什么打来。接听即可说话，也可以拒接。不接的话，服务端在响铃超时（默认 45 秒）后把通话记为未接，手机停止响铃。

## 通话如何进行

本节为参考内容。

### 来电

服务端发送 VoIP 推送 `{"aps":{},"dsh":{"v":1,"callId":…,"reason":…,"caller":…,"createdAt":…}}`。按照 iOS 对每个 VoIP 推送的要求，app 在推送处理返回之前向 CallKit 报告来电，并用通话 ID 作为 CallKit 通话 UUID；同一通话的重复推送不会造成问题。来电名称是 `caller: reason`，截断到 60 个字符。无法解析的推送也会被报告，然后立即结束。另一通通话进行中收到的推送会被报告、结束，并在服务端拒接。

响铃期间，app 每 2 秒向服务端查询一次这通电话，所以在其他设备上被接听或拒接、被 DSH 取消或已成未接的通话，在这台设备上也会停止响铃。app 在 60 秒后放弃。拒接会发送 `POST /calls/{id}/decline`。

### 去电

app 先用 `POST /calls` 创建通话，再请 CallKit 用同一个 UUID 发起它，并在开始连接和媒体接通时向 CallKit 报告进度。从 Siri 或"最近通话"发起的通话走同一条路径。挂断时会在控制通道上发送 `hangup` 帧，并发送 `POST /calls/{id}/hangup`。

### 媒体

接听或发起通话时会创建一个 peer connection：不用 ICE 服务器，Unified Plan，只收集一次候选地址，max-bundle，要求 RTCP 复用，一条既发送也接收的麦克风音轨，以及一个在 offer 之前创建、名为 `control` 的有序 data channel。ICE 不使用 trickle：app 等候选地址收集完成或 3 秒过去，然后把完整的 offer 发到 `POST /calls/{id}/connect`，并应用返回的 answer。SDP 从不被修改；服务端的 answer 选择 PCMU。

接听或发起后 15 秒内媒体仍未接通、ICE 失败，或 ICE 断开超过 5 秒时，通话以失败结束。connect 返回 `409` 表示通话已在其他设备上被接起（服务端报告它处于 connecting 或 active 时），或者无法接通；返回 `410` 表示通话已经结束。

音频由 CallKit 控制。WebRTC 的音频会话以手动模式运行，使用 `.playAndRecord` 和 `.voiceChat`；只有 CallKit 激活会话后音频才开始，会话停用时音频停止。静音经由 CallKit，所以系统通话界面和 app 保持一致。不支持保持通话、合并通话和 DTMF。

### 控制通道

每一帧都是带 `"v":1` 和 `type` 的 JSON 文本消息。

| 方向 | 类型 | app 的处理或含义 |
|---|---|---|
| 服务端 | `state` | 显示 `listening`、`thinking` 或 `speaking` |
| 服务端 | `transcript` | 在文字记录中添加一行 owner 或 agent 的话 |
| 服务端 | `say` | 在手机上朗读文字（`speech.tts: device`） |
| 服务端 | `stop-speaking` | 立即停止手机朗读 |
| 服务端 | `hangup` | 有原因时先读出原因，然后结束通话 |
| app | `speaking` | owner 开始说话（仅设备端识别） |
| app | `utterance` | owner 说的话，在 0.8 秒没有新词后发送（仅设备端识别） |
| app | `interrupt` | 点了"打断"按钮 |
| app | `hangup` | owner 挂断了通话 |

未知类型和其他版本的帧会被忽略，所以新版服务端可以增加帧类型。

### 设备端语音

服务端的健康检查结果说明语音在哪里识别（`stt`）、在哪里合成（`tts`）。`stt: device` 时，app 对麦克风运行 Apple 的语音识别器，语言支持时在设备上完成识别。`tts: device` 时，app 用系统语音朗读 `say` 帧，根据文字选择中文或英文。

手机自己的朗读不经过 WebRTC 的回声消除，因此用两种办法避免 DSH 听到自己的声音。手机朗读期间，麦克风音轨发送静音；识别出的文字如果大部分与手机刚读过的内容一致，就当作回声，不发送。开启设备端识别时，插话仍然可以打断 DSH，因为识别器一直在听麦克风，并会发送 `speaking`。

### 隐私与日志

令牌保存在钥匙串中（只在本设备，首次解锁后可读，以便锁屏时也能接听），从不写入日志，也不会再次显示。日志使用统一日志系统，subsystem 为 bundle identifier，分类为 `app`、`push`、`call`、`media`、`api` 和 `speech`；日志只记录状态、端点名、状态码和大小，从不记录令牌、SDP 内容或说话内容。查看日志时，把 iPhone 连到 Mac，在"控制台"中按 subsystem 过滤。app 没有任何统计分析，除 WebRTC 外没有其他依赖。

## 项目参考

| 路径 | 内容 |
|---|---|
| `project.yml` | XcodeGen 配置：`DSHCall` app target、`DSHCallTests` 单元测试和 WebRTC 包 |
| `Config/` | `Base.xcconfig`（占位值，包含 `Local.xcconfig`）和 `Local.example.xcconfig` |
| `DSHCall/App/` | app 入口、组合根（`AppModel`）、设备注册、日志 |
| `DSHCall/Push/` | PushKit 注册和 VoIP 推送处理 |
| `DSHCall/Call/` | CallKit（`CallManager`）、单通通话的状态机（`CallMachine`），以及一通通话的媒体与控制（`CallSession`） |
| `DSHCall/Media/` | WebRTC 客户端、音频会话、设备端语音 |
| `DSHCall/Network/` | API 客户端和协议版本 1 的线上数据类型 |
| `DSHCall/Settings/` | 设置和钥匙串 |
| `DSHCall/Intents/` | "打给 DSH" App Intent 及其 Siri 短语 |
| `DSHCall/UI/` | SwiftUI 界面 |
| `DSHCallTests/` | XCTest 单元测试；API 测试使用 `URLProtocol` 替身 |

WebRTC 来自 [stasel/WebRTC](https://github.com/stasel/WebRTC)，精确固定在 `158.0.0`（WebRTC M158）。

单元测试覆盖 API 客户端、线上数据类型、推送解析、通话状态机、语音辅助函数和设置。在模拟器上运行：

```sh
xcodebuild test -project DSHCall.xcodeproj -scheme DSHCall -destination 'platform=iOS Simulator,name=iPhone 16'
```

把 `iPhone 16` 换成你的 Xcode 已安装的任意 iPhone 模拟器。

## Release 构建与 TestFlight

`DSHCall.entitlements` 把 `aps-environment` 设为 `development`。归档并通过 App Store Connect 分发时，分发用的 provisioning profile 会把它设为 `production`，而 Release 构建注册令牌时报告 `production`，所以 TestFlight 构建无需改动就能收到 production APNs 主机的推送。直接从 Xcode 安装、使用开发 profile 的 Release 构建会把 sandbox 令牌报告为 `production`；从 Xcode 运行时请使用 Debug。

每次上传前提高 `project.yml` 中的 `MARKETING_VERSION` 和 `CURRENT_PROJECT_VERSION`。上传时 App Store Connect 会询问加密情况：WebRTC 用 DTLS-SRTP 加密通话媒体，请按你的出口合规情况回答，或在确定答案后把 `ITSAppUsesNonExemptEncryption` 加进 `Info.plist`。

## 已知限制

- 设备端识别通过 WebRTC 之外的第二个音频输入读取麦克风。如果 iOS 拒绝它，或音频路由的变化让识别器无法跟上，通话界面会提示语音识别不可用；通话本身继续，"打断"按钮仍然可用。
- 服务端识别语音（`stt: server`）而手机朗读（`tts: device`）时，手机朗读期间麦克风是静音的，所以插话打断不了 DSH；请用"打断"按钮。
- 服务端经音轨朗读、同时开启设备端识别时，在 DSH 说话且其内容尚不知道的期间，识别出的文字会被暂扣，所以打断可能稍有延迟。
- 没有设备端模型的识别语言会把音频发送到 Apple 的语音服务。
- iOS 16 起，没有特殊 entitlement 时系统只报告"iPhone"这样的通用设备名，所以每台设备都以这个名字注册。
- 同一时间只有一通通话；通话中收到的 VoIP 推送会被拒接。
- 手机必须经 Tailscale 直接连到 Mac；没有 STUN 或 TURN。
- 未在设备上验证：代码是在没有 Mac 的环境中编写和审查的，尚未编译过；在装有 Xcode 的 Mac 上第一次构建，就是它的第一次编译和真机测试。
