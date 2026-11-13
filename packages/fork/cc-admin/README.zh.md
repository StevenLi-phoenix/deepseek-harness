---
description: "根服务 ctx.claudeCodeSessions：服务账号的 Claude Code 会话，从 Claude Code 自己的登记目录和 tmux 列出，可带第一条任务启动、可停止，供设置页使用。"
kind: "package-reference"
---

# @deepseek-ai/dsh-cc-admin

[English](README.md) | 中文

## 概述

不用 SSH 就能启动、列出和停止服务账号的 Claude Code 会话。`ctx.claudeCodeSessions` 报告 `dsh-runtime` 怎样登录了 Claude Code（完整的 claude.ai 登录，Remote Control 需要它；只有推理 token；或没有），列出存活的会话及其状态和目录，在分离的 tmux 会话里启动一个（可带第一条任务），并停止自己启动的会话。设置页 [`event-console`](../event-console/README.zh.md) 是它的使用者。

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

把下面这一行挂在组合的根上，放在 [`event-console`](../event-console/README.zh.md) 旁边；fork event bundle 已经挂载了它。`cc-bridge` 的工具在 `unattended` 预设挂载里，外面谁也够不到，所以设置页用不了它们；这个服务从根上做同样的事。

```yaml
- id: cc-admin
  name: '@deepseek-ai/dsh-cc-admin'
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `enabled` | `true` | 关闭这个服务；设置页随之显示 Claude Code 已关闭 |
| `sessionsDir` | 与桥相同（Host 用户的 `~/.claude/sessions`） | Claude Code 的会话登记目录 |
| `tmux`、`command`、`workDir`、`model`、`maxSessions` | 与桥相同 | 启动的会话怎样运行、最多同时运行几个 |

每个默认值都读自 `cc-bridge` 自己的配置 schema，所以两边不会漂移，有测试固定这一点。只有想让页面用与工具不同的值时，才在这里设置字段。

方法有 `view()`（登录状态、存活的会话、本服务启动的 tmux 会话）、`start(name, task?)` 和 `stop(name)`。`start` 会拒绝不合法的名字或重名（`invalid_request`）、超过 8000 字的第一条任务（`invalid_request`）和第四个同时运行的会话（`limit_reached`）；对桥没有启动过的会话，`stop` 返回 `not_found`。第一条任务是 Claude Code 的 prompt 参数，为 shell 加了单引号，所以会话把它当作你本人的话。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

服务包装了桥的 `Registry`（Claude Code 的 `<pid>.json` 记录，只有进程存活且启动时间与记录一致才算数）和 `Spawner`（tmux 服务器 `-L dsh-cc`、清空的环境、名字与模型规则）。它从不打开桥的收件箱，也不写对等记录，所以发不了对等消息；第一条任务因此作为启动脚本的参数传入。

登录状态：`~/.claude/.credentials.json` 有内容为 `full`，`~/.config/claude-code/oauth_token` 有内容为 `token`，否则 `none`。这些文件只做 `stat`；任何凭据都不读取、不记录、不返回。启动、停止或失败各记一行日志（带名字）；第一条任务不记录。

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | 配置、类型和 `ClaudeCodeAdmin` |

这是 fork 本地包；见 [`../UPSTREAM.md`](../UPSTREAM.md)。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [cc-bridge](../cc-bridge/README.zh.md)——本服务复用的工具、启动脚本和登记目录
- [event-console](../event-console/README.zh.md)——使用它的设置页
- [事件服务运行手册](../../../fork/deploy/RUNBOOK.md)——第 14 节，服务用户的 Claude Code

-----

<a id="model-experience"></a>
## 模型体验

无，服务不注册工具，也不向模型请求添加任何内容。

#### KV Cache 影响

无；这个包既不组装也不发送 provider 请求。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

- **没有对等消息**——第一条任务就是 prompt 参数；之后给会话发消息仍归 `cc_send`。
- **只能停止桥启动的会话**——在别的 tmux 服务器里手工启动的会话只列出，不能从这里停止。
- **默认值的另一份拷贝**——这里的 `Config` 重复了桥的字段，部署才能覆盖它们；默认值本身没有重复。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是不具权威性的工作上下文：尚未决定的探索方向与维护者备注。已交付的行为与既定理由以上文、包代码和相关 Agent Note 为准。

- 页面通过 `event-console` 里的结构类型读取这个服务，因为带浏览器部分的包要运行时导入对等包的值，需要先在 `scripts/package-dependency-policy.ts` 里经审核分类。

</details>
