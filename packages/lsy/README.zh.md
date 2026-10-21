---
description: "lsy 包组：fork 本地的传感器、事件总线、监控工具与微信通道，让外部事件和主人的消息在常开主机上唤醒 agent。"
kind: "package-group"
---

# lsy/ — 事件驱动的 agent 运行

[English](README.md) | 中文

## 概述

在微信里和一个常开的 agent 对话，让它替你盯 GitHub，不用改配置，也不用盯面板。你说什么重要，agent 就用工具自己建监控和提醒。传感器轮询并发布事件；总线去重、抑制 agent 自己造成的回声、合批并限流；actuator 发微信消息，或启动一个无人值守的 Session，它的答案会回到微信。这个组是 fork 本地的，通过账本跟踪上游。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

-----

<a id="packages"></a>
## 包

| 包 | 作用 |
|---|---|
| [`lsy-event-bus/`](lsy-event-bus/README.zh.md) | 去重、回环抑制、订阅、合批、限流、通知与 Session 分发 |
| [`lsy-github-sensor/`](lsy-github-sensor/README.zh.md) | 用条件请求轮询 GitHub 的 release、tag、提交与通知 |
| [`lsy-tool-watch/`](lsy-tool-watch/README.zh.md) | `watch_create`、`watch_list`、`watch_delete` 工具：agent 自己管理监控 |
| [`lsy-wechat/`](lsy-wechat/README.zh.md) | 微信（iLink bot）通道：主人对话 Session、回复转发，以及 `ctx.lsyNotifier` |

-----

<a id="related-documentation"></a>
## 相关文档

- [上游账本](UPSTREAM.md)——这个组从上游复制了什么，以及如何升级。
- [Webhook runtime](../experimental/webhook/README.zh.md)——总线复用的 Session 创建接口。

-----

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

部署用的 profile 与服务文件在仓库根目录的 `/lsy`。

</details>
