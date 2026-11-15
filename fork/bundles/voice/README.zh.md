---
description: "event 服务的语音层：speak 工具的语音合成，以及音频文件的语音识别，默认关闭识别。"
kind: "package-bundle"
---

# @deepseek-ai/voice

[English](README.md) | 中文

## 概述

这一层挂载 `ctx.voice`：给 `speak` 工具的语音合成，以及 owner 发来的音频文件的语音识别。这里关着识别（`asr.enabled: false`），要开就得在 profile patch 里整份重写 config。它只读文件，从不打开麦克风。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [已知限制与后续工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

### 装进 event profile

这一层随仓库发布：`fork/deploy/setup-profile.sh` 会把 `fork/bundles/` 下的每个目录链接进 `$DSH_HOME/profiles/event/node_modules/@deepseek-ai/`，并写好 profile 清单，所以部署时不用逐台改动。手动加入就自己建链接，把名字加到 `dsh.profile.bundles` 末尾。

### 这一层挂载什么

| 行 | 包 | 挂载什么 |
|---|---|---|
| `voice` | `@deepseek-ai/dsh-voice` | `ctx.voice`：speak 的合成，音频文件的识别（关） |

### 它依赖什么

`$DSH_HOME/.env` 里的飞语密钥 `FEIYU_API_KEY`，以及 `preset-unattended` 里给 `speak` 用的 `tool-voice` 行。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

这里的行就是该功能原先写在 `@deepseek-ai/dsh-event-bundle` 里的那些，逐字搬过来，相对顺序不变。profile 按 `dsh.profile.bundles` 的顺序把各层合成一个扁平的 patch 列表来应用，`insert` 是追加，所以这一层挂载在它用到的骨架行之后、owner 的 profile patch 之前。挂载顺序和理由写在 `fork/bundles/event/README.md`。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [语音包](../../../packages/fork/voice/README.zh.md)
- [语音工具包](../../../packages/fork/tool-voice/README.zh.md)

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与后续工作

- 只有一个提供方，没有兜底：没有密钥时每次合成都失败。
- patch 会整份替换 config，所以开识别要把其余字段一起重写。
