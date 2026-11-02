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
| [`bili/`](bili/README.zh.md) | agent 自己的 B站账号，作为 bili-svc 的客户端：读取和不发言的操作走 bili-svc 的门，owner 的私信经它的回复闸门回复，以及管理 bili-svc 的设置页（账号、扫码登录、闸门、急停、动作记录） |
| [`lsy-balance/`](lsy-balance/README.zh.md) | 账号设置页里列出各供应商 key 余额或配额的卡片 |
| [`lsy-config/`](lsy-config/README.zh.md) | 任何设置分区都能嵌入的“全部设置”卡片（`settings.plugin-config`）：插件条目的每个 Config 字段、所在层，以及一次复核后写入主人补丁的保存 |
| [`lsy-courses/`](lsy-courses/README.zh.md) | 主人的课程记录（`ctx.lsyCourses`）：courses 服务的客户端，以及按固定规则在微信上提醒 DDL、并在课程同步坏了时告诉主人的轮询器 |
| [`lsy-courses-settings/`](lsy-courses-settings/README.zh.md) | 设置页课程 DDL：提醒开关、检查记录、课程同步健康、接下来的截止、最近发出的提醒和配置 |
| [`lsy-event-bus/`](lsy-event-bus/README.zh.md) | 去重、回环抑制、订阅、合批、限流、通知与 Session 分发 |
| [`lsy-event-ingest/`](lsy-event-ingest/README.zh.md) | `POST /hooks/lsy` 路由：主人自己的服务用每个来源一个的 bearer token 推送事件 |
| [`lsy-github-sensor/`](lsy-github-sensor/README.zh.md) | 用条件请求轮询 GitHub 的 release、tag、提交与通知 |
| [`lsy-guard/`](lsy-guard/README.zh.md) | `ctx.lsyGuard.check`：给别人能读到的文字用的统一校验器；正则模式、金丝雀字符串、与 owner 记忆的重合、再加一个模型，任何一层跑不起来就拒绝 |
| [`lsy-integrity/`](lsy-integrity/README.zh.md) | 完整性监控：操控 agent 的文件的摘要、点名告诉 owner 哪里变了的微信通知、系统 prompt 哈希，以及人格禁用口头禅的计数 |
| [`lsy-memory/`](lsy-memory/README.zh.md) | 跨 Session 的主人记忆：记忆块、`memory_search`、`memory_save`、`memory_forget`，以及 claude.ai 导出导入器 |
| [`lsy-wechat-settings/`](lsy-wechat-settings/README.zh.md) | 设置 → 微信（扫码绑定、通道健康、解绑）和设置 → 勿扰的浏览器端 |
| [`lsy-presence/`](lsy-presence/README.zh.md) | 主人是否在睡觉（手机的睡眠专注、每日时段、设置 → 勿扰里的按钮）；这段时间微信压下不紧急的消息，醒来后合成一条发出 |
| [`lsy-qq/`](lsy-qq/README.zh.md) | 基于 OneBot v11 协议端（NapCat）的 QQ 群观察者：记录名单里的群、按计划做摘要、默认从不发言 |
| [`lsy-qqbot/`](lsy-qqbot/README.zh.md) | 官方 QQ 机器人通道，默认禁用：主人列入名单的私聊和 @ 消息各有一个对话 Session，回答经 `owner-relay` 送达 |
| [`lsy-qq-login/`](lsy-qq-login/README.zh.md) | QQ 的设置分区：观察者的连接状态、NapCat 的登录状态，以及 QQ 把账号踢下线后用手机扫码重新登录的二维码 |
| [`lsy-style/`](lsy-style/README.zh.md) | DSH 自己的说话风格：自己写的人设卡、从 QQ 群、B站和网页里学到的性格与热梗（挖掘器找出、搜索解释）和语气样本，给 unattended、up、bili、qqbot 看（`ctx.lsyStyle`；`persona_update`、`style_note`、`meme_lookup`） |
| [`lsy-style-settings/`](lsy-style-settings/README.zh.md) | 设置分区 说话风格：人设卡及其历史、带出处的热梗、可一键删除的语气样本、审核、挖掘器的上次运行、套话趋势和插件配置 |
| [`lsy-memory-admin/`](lsy-memory-admin/README.zh.md) | 审阅智能体记忆的设置分区：待批准的写入、条目、带预览的回滚与彻底删除、人格反馈（它的 Host 路由是 `lsy-memory` 的 `settings` 入口） |
| [`lsy-sysmon/`](lsy-sysmon/README.zh.md) | 设置里显示 Host 机器 CPU、内存、功耗、温度与各卷磁盘用量的分区 |
| [`lsy-cc-admin/`](lsy-cc-admin/README.zh.md) | 根服务 `ctx.lsyClaudeCode`：服务账号的 Claude Code 会话，供设置页列出、带第一条任务启动和停止 |
| [`lsy-console/`](lsy-console/README.zh.md) | 设置里的服务健康总览、事件服务数据流图、事件订阅与定时提醒、Claude Code 会话与语音试听分区 |
| [`lsy-taint/`](lsy-taint/README.zh.md) | 回合来源：当前回合由谁发起、陌生人的话有没有进来；只在 owner 自己的回合里联系 Claude Code，其他回合建的提醒和监控要上报 |
| [`lsy-time-gap/`](lsy-time-gap/README.zh.md) | 所有 Session 的时间说明：安静一段时间（5 分钟）之后到达的输入，带着当前时间、Session 安静了多久，以及“按它本身来读”的提示交给模型 |
| [`lsy-tool-courses/`](lsy-tool-courses/README.zh.md) | `courses_deadlines`、`courses_find`、`courses_get`、`courses_sync`、`courses_set_progress`、`courses_save_memo` 工具：agent 按主人的课程记录回答并更新它们 |
| [`lsy-tool-monitor/`](lsy-tool-monitor/README.zh.md) | `monitor_start`、`monitor_stop`、`monitor_list` 工具：命令输出的每一行都回到同一个 Session |
| [`lsy-tool-up/`](lsy-tool-up/README.zh.md) | `up_*` 工具：agent 读取创作者号的评论、私信和稿件，并向 bili-svc 回复闸门申请回复；答案只有 `sent`、`held`、`blocked` |
| [`lsy-tool-voice/`](lsy-tool-voice/README.zh.md) | `speak` 工具：agent 把文字合成语音，并把音频发给微信上的 owner |
| [`lsy-cc-bridge/`](lsy-cc-bridge/README.zh.md) | `cc_list_sessions`、`cc_send`、`cc_start`、`cc_stop` 工具：与 agent 自己账号下的 Claude Code 会话协作 |
| [`lsy-tool-qq/`](lsy-tool-qq/README.zh.md) | `qq_groups`、`qq_digest`、`qq_recent`、`qq_search` 工具：agent 读取 QQ 观察者记录和摘要的内容 |
| [`lsy-tool-watch/`](lsy-tool-watch/README.zh.md) | `watch_create`、`watch_list`、`watch_delete` 工具：agent 自己管理监控 |
| [`lsy-tool-wechat/`](lsy-tool-wechat/README.zh.md) | `wechat_send_file` 工具：agent 给 owner 发图片、视频和文件 |
| [`lsy-voice/`](lsy-voice/README.zh.md) | `ctx.lsyVoice`：文字转语音（feiyu，Mac mini TTS 兜底）与音频文件转文字（asr-service，默认关闭） |
| [`lsy-wechat/`](lsy-wechat/README.zh.md) | 微信（iLink bot）通道：主人对话 Session、经 `owner-relay` 送达的回答，以及 `ctx.lsyNotifier`；设置页可扫码绑定、查看通道健康和解绑 |
| [`owner-relay/`](owner-relay/README.zh.md) | `ctx.ownerRelay`：所有被认领 Session 的最终回答走同一套规则，交给认领它的通道（微信、B站私信），发不出时带标签降级到微信 |
| [`tool-bili/`](tool-bili/README.zh.md) | `bili` preset 的 B站工具：动态、借字幕看视频、评论、收件箱，经 bili-svc 点赞、投币、关注和收藏，以及日记；不发言 |

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
