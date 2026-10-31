---
description: "面向 owner 的 agent 语音能力（ctx.lsyVoice）：文字转语音走笔记本上的 feiyu（Mac mini TTS 服务已停用，但仍可选）；语音转文字走 asr-service，处理 owner 发来的音频文件，默认关闭，只读文件。"
kind: "package-reference"
---

# @deepseek-ai/dsh-lsy-voice

[English](README.md) | 中文

## 概述

你的 agent 能开口说话，也能听懂一条语音文件。`ctx.lsyVoice.speak(text)` 用你自己的服务把文字合成音频文件：用笔记本上的 feiyu（可另行配置第二个服务，即已停用的 Mac mini TTS）。`ctx.lsyVoice.transcribe(path)` 经 mini 的 asr-service 把音频文件转成文字。语音转文字在你打开开关之前保持关闭，并且只读交给它的文件：这里没有任何打开麦克风或监听的代码。服务的每份回答都先存盘再解析，每次调用都有超时和重试，失败都会带着原因写入日志。

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

在 profile 根部挂载该服务。它只需要宿主的 `credentials` 服务来取 feiyu 的 key。lsy event bundle 会以关闭转写的状态挂载它。

```yaml
- id: lsy-voice
  name: '@deepseek-ai/dsh-lsy-voice'
```

feiyu 的 key 以 `LSY_FEIYU_API_KEY` 写入 `$DSH_HOME/.env`（改 `.env` 后需重启）；这个名字就是 `tts.feiyu.apiKeyEnv` 设置。每个字段都有默认值，所以 patch 条目只需写出要改的部分。

| 设置 | 默认值 | 含义 |
|---|---|---|
| `dataDir` | `<DSH_HOME>/lsy-voice` | 音频在 `audio/`，ASR 原始回答在 `asr/`（目录 0700，文件 0600） |
| `keepDays` | `14` | 超过该天数的文件在下一次调用时删除 |
| `tts.enabled` | `true` | 关闭 `speak` |
| `tts.provider` / `tts.fallback` | `feiyu` / `none` | 首选服务与失败后改用的服务（`none` 表示只试一个）。Mac mini TTS 服务（`mac-mini`）已于 2026-10-31 停用，所以不再兜底到它 |
| `tts.format` | `mp3` | `mp3` 用 ffmpeg 转换（`tts.ffmpegPath`，默认 `/opt/homebrew/bin/ffmpeg`），转换失败则交付 WAV |
| `tts.maxChars` | `200` | 文字上限；更长的会被拒绝，让 agent 分段（feiyu 加载后每句约 6-8 秒） |
| `tts.cache` | `true` | 说过的文字直接复用已有文件（直到 `keepDays` 清理），不再调用服务；改了音色设置后，要等旧文件被清理或把它设为 `false` 才生效 |
| `tts.retries` / `tts.retryDelayMs` | `2` / `1000` | 单次 HTTP 调用的额外重试次数；429、5xx、超时和网络错误会重试，其余 4xx 立即失败 |
| `tts.feiyu.*` | 笔记本 `http://100.117.175.117:19880`，音色 `feiyu`，风格 `cute` | `timeoutMs` 单次调用 30 秒，`jobTimeoutMs` 单个任务 180 秒（闲置后的第一次请求要加载模型，约 45 秒），`pollMs` 2 秒 |
| `tts.macMini.*` | `http://127.0.0.1:8098`，说话人 `vivian`，`Chinese` | 仅在选了 `mac-mini` 时使用；`timeoutMs` 240 秒。2026-10-31 停用 |
| `asr.enabled` | `false` | 语音转文字的开关 |
| `asr.baseUrl` / `asr.engine` / `asr.language` | `http://127.0.0.1:8099` / `funasr` / 未设置 | `funasr` 用于中文；`whisper` 用于英文和多语言（`language` 是它的语言提示） |
| `asr.timeoutMs` / `asr.retries` / `asr.maxBytes` | 120 秒 / `2` / 25 MiB | 单次调用超时、额外重试次数、文件大小上限 |

### 打开语音转文字

在 profile patch（`$DSH_HOME/profiles/event/cordis.patch.yml`）里加上下面这段，保存即热加载。patch 条目的 `config` 会整体替换该行的配置，所以 patch 里已有 `lsy-voice` 行（例如设置了 `tts`）时，把 `asr` 写进那一行的 `config`，不要再加第二行：

```yaml
- id: lsy-voice
  config:
    asr:
      enabled: true
```

此后，owner 在微信里发来的音频文件（`.m4a`、`.mp3`、`.wav`、`.flac`、`.ogg`、`.wma`、`.aac`、`.webm`）会被转写，文字并入该条消息的附件说明。英文内容设 `asr.engine: whisper`。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

`speak` 一次只跑一个调用：feiyu 的 GPU 同时只接一个任务，突发请求不应堆积重试。一次调用先试 `tts.provider`，再试 `tts.fallback`；每个服务先把原始回答写盘再做别的事：`audio/` 下的 `<name>.job.json`（feiyu 最终的任务记录）和 `<name>.wav`，文件名由时间、文字哈希和服务名组成。交付物是这份 WAV 或它的 MP3 转换结果（先写成 `.mp3.part` 再改名）。`transcribe` 读取文件，POST 到 `/transcribe`，先把原始 JSON 写到 `asr/<时间>-<音频哈希>.json`，再读取 `full_text`。日志只记长度、服务、耗时和路径，不记说出的文字，也不记 key。

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | `ctx.lsyVoice`、配置、原始回答文件、mp3 转换、兜底顺序、清理 |
| [`src/tts.ts`](src/tts.ts) | feiyu 服务（提交任务、轮询、取音频）与 Mac mini 服务（一次 multipart POST） |
| [`src/asr.ts`](src/asr.ts) | asr-service 客户端与格式列表 |
| [`src/http.ts`](src/http.ts) | 各客户端共用的超时与重试封装 |

这是 fork 本地的包，见 [`../UPSTREAM.md`](../UPSTREAM.md)。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [`speak` 工具](../lsy-tool-voice/README.zh.md)——agent 如何请求语音
- [微信通道](../lsy-wechat/README.zh.md)——音频文件从这里进来，语音从这里发出

-----

<a id="model-experience"></a>
## 模型体验

### 音频文件的转写

#### 模型看到什么

`asr.enabled` 为 false 时没有任何变化。为 true 时，owner 在微信里发来的音频文件到达聊天 Session 时，会带上常规的附件说明，并在该文件那一行多一句：`speech-to-text (<engine>) of what the owner said in it: 「<text>」`，服务读不出来时则是 `speech-to-text failed (<reason>)`。这段文字就是 owner 说的话，agent 把它当作 owner 自己的消息。

#### Token 影响

每个音频文件多一小句：转写文本本身，保留在 Session 历史中直到压缩。

#### KV Cache 影响

只追加：这一句属于 owner 的消息，跟在可复用的请求前缀之后。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

- **只处理文件**——微信自己的语音消息只带微信的转写文字、不带音频，所以只有作为附件发来的音频文件才会到 asr-service。没有麦克风通路。
- **没有语音气泡**——iLink 机器人不能发语音消息，语音以 mp3 文件附件发出。
- **只有一个服务**——feiyu 闲置后第一次请求约 45 秒，之后 6–8 秒，要求笔记本醒着；没有兜底，笔记本不在时 `speak` 会带着 feiyu 的原因失败。缓存让重复的句子不再占用它的 GPU。
- **B 站**——B 站账号的消息只能发文字，它的 preset 也没有 `speak` 工具。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是不具权威性的工作上下文：尚未决定的探索方向与维护者备注。已交付的行为与既定理由以上文、包代码和相关 Agent Note 为准。

- 2026-10-31：Mac mini TTS 服务被停掉（它占约 13 GB GPU 内存、冷启动要几分钟），mini 到笔记本 19880 端口的通路也已放行，所以默认值改成 feiyu、无兜底；在此之前默认是先 `mac-mini` 后 `feiyu`。
- 微信的 `voice_item` 带转写文字，按 iLink 协议还带一个 SILK 媒体引用；解 SILK 需要宿主上没有安装的解码器。

</details>
