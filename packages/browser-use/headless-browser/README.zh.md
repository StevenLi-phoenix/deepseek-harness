---
description: "一个持久的无头 Chromium：给模型一组工具，给用户一个网页。用户在网页上看实时画面，需要时自己接管浏览器完成登录、付款之类必须人来的步骤。"
kind: "package-reference"
---

# @deepseek-ai/dsh-headless-browser

[English](README.md) | 中文

## 概述

给 agent 一个能跨轮次保留状态的浏览器，也给人一个进去的办法。一个无头 Chromium 用自己的 profile 目录运行，登录状态能扛过 Host 重启。模型可以打开页面、截图、点击、输入；某一步需要人时，它交出控制权并返回一个页面地址，用户在那一页看到和 agent 相同的画面、自己操作，再交还回去。用户控制期间 agent 的动作会被拒绝，不会和人抢同一个页面。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在同时有 Web 服务器和工具注册表的 Host 组合里挂载一次；浏览器在第一次工具调用或第一次打开接管页之前不会启动。

```yaml
- id: headless-browser
  name: '@deepseek-ai/dsh-headless-browser'
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `profileDir` | `$DSH_HOME/data/headless-browser/profile` | Chromium profile 目录；cookie、登录状态和本地存储都在这里 |
| `headless` | `true` | 不开窗口运行；`false` 需要已登录的桌面会话 |
| `viewportWidth` | `1280` | 页面视口宽度（CSS 像素） |
| `viewportHeight` | `800` | 页面视口高度（CSS 像素） |
| `jpegQuality` | `60` | 实时画面 JPEG 质量 |
| `snapshotDir` | `$DSH_HOME/cache/headless-browser/snapshots` | `headless_browser_snapshot` 写 PNG 的目录 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-headless-browser)列出了全部可用字段。

### 浏览器二进制

`playwright-core` 不下载浏览器，所以由部署为运行 Host 的账号准备一个 Chromium。装一次到该账号的 Playwright 缓存，或把 `PLAYWRIGHT_BROWSERS_PATH` 指向共享缓存：

```sh
pnpm exec playwright-core install chromium
PLAYWRIGHT_BROWSERS_PATH=/srv/dsh/ms-playwright pnpm exec playwright-core install chromium
```

不设变量时使用平台缓存（macOS 是 `~/Library/Caches/ms-playwright`，Linux 是 `~/.cache/ms-playwright`）。缺二进制时第一次工具调用会带着启动器的诊断失败，而不是在加载时报错。

### 接管页

`headless_browser_hand_over` 返回部署自己服务器上 `/headless-browser` 的地址。页面上是共享页面的实时画面、当前持有者，以及用户的控制按钮。

| 路由 | 用途 |
|---|---|
| `GET /headless-browser` | 页面：实时画面、持有者、取得控制与交还按钮，以及一个逐键输入不了的文本输入框 |
| `GET /headless-browser/status` | JSON：`holder`、用户填写的 `reason`、`launched`、`sessionId`、`url`，以及已连接的页面数 |
| `WS /headless-browser/live` | 画面帧、控制权变化，以及转发进去的输入 |

准入交给部署自己：页面和状态路由用 Web 服务器默认的必须认证策略，所以能打开 Web UI 的同一个 Cookie 或启动令牌也能打开它们。实时 socket 另外要求 owner 身份，因为持有它的人可以在一个已登录的 profile 里操作。

页面上的输入只在用户持有控制权时进入浏览器。从页面取得控制会把持有者设为 `human`，理由是「用户从接管页取得控制」；交还按钮把它还给 agent。两个按钮和两个控制工具是同一个状态转换。

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

一个 `HeadlessBrowserSession` 拥有上下文。启动是惰性的单飞：工具调用和页面连接同时到达也只会起一个 Chromium；`close()` 会等一个输掉竞争的启动结束。共享页面是第一个打开的页面，崩溃后换新的。每次启动都有新的 session id，状态路由会报告它。

实时画面是每个页面一个 CDP screencast，由所有已连接的查看者共享。第一个查看者到来时 `Page.startScreencast` 开始，最后一个离开时 `Page.stopScreencast` 停止；每一帧先确认再分发，因为 Chrome 只有收到确认才发下一帧。Chrome 在重绘时发帧，所以这个分发器保留最后一帧：页面静止时后连上来的查看者会立刻看到当前画面，而不是一块空白。帧里带着页面缩放指针输入所需的元数据，只在浏览器页面存在时才有帧。

页面发来的输入是每种事件一条 JSON。`decodeClientMessage` 校验它，`cdpCommand` 把它映射为 `Input.dispatchMouseEvent`（包括 `mouseWheel`）、`Input.dispatchKeyEvent` 或 `Input.insertText`，由 `TakeoverState` 决定是否接受输入。按键把 DOM 的 `keyCode` 同时当作两个 CDP 虚拟键码，所以快捷键和不产生字符的按键表现得和真实窗口一样；逐键打不出来的文本走 `Input.insertText`。

工具共用一个守卫。会操作页面的工具先调用 `TakeoverState.assertAgent`，并在错误结果里带上用户的理由；截图工具跳过守卫，因为它只读页面、不动页面。

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：会话、控制状态、实时画面、工具、路由 |
| [`src/session.ts`](src/session.ts) | 持久上下文、共享页面、CDP 会话、导航、截图、点击、填值 |
| [`src/takeover.ts`](src/takeover.ts) | 持有者状态，以及 agent 动作被拒绝时的错误 |
| [`src/input.ts`](src/input.ts) | 线路消息解码、CDP 命令映射、帧编码 |
| [`src/live-view.ts`](src/live-view.ts) | screencast 分发与查看者记录 |
| [`src/routes.ts`](src/routes.ts) | 页面、状态和实时 socket 的注册 |
| [`src/page.ts`](src/page.ts) | 服务出去的文档和其中的脚本 |
| [`src/tools.ts`](src/tools.ts) | 六个模型工具 |

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [浏览器操作](../browser-use/README.zh.md) —— 其他浏览器后端注册的提供方槽位。
- [Playwright MCP 提供方](../../experimental/browser-use-playwright-mcp/README.zh.md) —— 经上游 Playwright MCP 的每 Session 浏览器。
- [Web 服务器](../../host/webserver/README.zh.md) —— 这些路由继承的准入、升级与认证策略。
- [工具](../../core/tools/README.zh.md) —— 工具注册表和工具用的 schema DSL。

-----

<a id="model-experience"></a>
## 模型体验

### 页面工具

#### 模型看到什么

挂载作用域有工具注册表时，有四个工具定义：`headless_browser_open`（`url`）、`headless_browser_snapshot`（无参数）、`headless_browser_click`（`selector`）、`headless_browser_type`（`selector`、`text`）。每个描述只有一句话，说明操作和结果回答什么：打开返回落定后的 URL 与文档标题，截图返回 PNG 路径与页面 URL，点击返回 selector 与页面 URL，输入返回 selector。结果是一个 JSON 文本块。输入的结果不回显文本，所以模型敲进表单的密码不会进入会话日志。

#### Token 影响

作用域挂载本包的 agent 每次请求都有固定的 schema 开销，每个工具定义几十个 token。结果是一个很短的 JSON 对象；截图只增加路径，不增加图片。

#### KV Cache 影响

工具定义和描述不变时前缀稳定；结果追加在可复用前缀之后。

### 控制工具

#### 模型看到什么

`headless_browser_hand_over` 接收 `reason`，返回 `{ "url": "<origin>/headless-browser", "holder": "human", "reason": "…" }`；这个 URL 就是用户要打开的地址。`headless_browser_hand_back` 返回 `{ "holder": "agent" }`。用户持有控制期间，每个操作类工具都回答 `{ "error": "the user holds the browser (<reason>); call headless_browser_hand_back when they are done" }`，而不去碰页面；启动失败回答 `{ "error": "the headless browser could not start: <第一行>" }`。

#### Token 影响

两个很小的定义；一次拒绝只有一行，理由的长短由用户在页面上填的内容决定。

#### KV Cache 影响

只追加：结果和拒绝都进入历史中可复用前缀之后，不改写更早的内容。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **一个浏览器、一个挂载作用域** —— 路由是固定路径，所以一个 Host 只挂载一次；第二次挂载会在 `/headless-browser` 上冲突。浏览器是一个 Chromium、一个共享页面，不是每个 Session 一个，并行运行的 agent 共用它。
- **浏览器二进制由部署负责** —— `playwright-core` 不带浏览器，本包也不下载。没有 `PLAYWRIGHT_BROWSERS_PATH` 或账号缓存里的安装，每次工具调用都会带着启动器诊断失败。
- **支持的是无头模式** —— `headless: false` 需要已登录的桌面会话；服务账号开不了窗口。
- **没有标签页或窗口选择** —— 共享页面是第一个打开的页面，崩溃后换新的；站点自己打开的页面（弹窗、新标签页）不会被跟随。
- **画面只实时** —— 只有接管页连着时才有帧，不录制，Chrome 繁忙时会掉帧。静止页面不会产生新帧，后连上来的页面看到的是最后画出的那一帧。渲染进程崩溃会结束推流，重新加载页面并连接之后画面才会回来。
- **接管地址需要 Web 服务器** —— 在没有 Web 服务器的组合里，`headless_browser_hand_over` 只返回 `/headless-browser`，用户打不开。
- **生成的目录跟着挂载走** —— `docs/tool-catalog.md` 和 `docs/config-catalog.md` 只有在某个组合挂载本包并运行生成器之后，才会列出本包的工具和字段。
- **页面没有做本地化** —— 服务出去的页面文案固定为中文，和由 locale 拥有文案的 Client 插件不同；它不属于任何 Client bundle。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注不是权威上下文：它是未定方向和给维护者的记录。

- 页面刻意不加载 Client bundle：Host 只服务一个静态文档，所以在没有额外扩展 Web UI 的组合里也能用。
- 输入只在用户持有控制权时接受。空闲页面因此不会动 agent 的浏览器，agent 也不会在用户操作时挪动页面。
- 用户持有控制期间截图仍然可用；它只读页面，不抢输入。
- 需要浏览器的测试先解析 `chromium.executablePath()`，没有二进制就跳过，所以没装 Playwright 浏览器的 checkout 仍会跑其余全部用例。

</details>
