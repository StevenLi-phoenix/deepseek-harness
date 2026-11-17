---
description: "一个持久的无头 Chromium：给模型一组工具，给用户一个网页。用户在网页上看实时画面，需要时自己接管浏览器完成登录、付款之类必须人来的步骤。"
kind: "package-reference"
---

# @deepseek-ai/dsh-headless-browser

[English](README.md) | 中文

## 概述

给 agent 一个能跨轮次保留状态的浏览器，也给人一个进去的办法。一个无头 Chromium 用自己的 profile 目录运行，登录状态能扛过 Host 重启。模型可以打开页面、看页面、读页面、点击、输入、滚动、关闭标签；某一步需要人时，它交出控制权并返回一个页面地址，用户在那一页看到和 agent 相同的画面、自己操作，再交还回去。用户控制期间 agent 的动作会被拒绝，不会和人抢同一个页面。

一个页面有三种读法、两种看法。`headless_browser_look` 一次调用同时交回画面和一份有上限的无障碍摘要，想看又想知道页面讲什么的模型因此只花一个来回，不再先截图再读一遍。`headless_browser_ax` 打印无障碍树，每个可操作的节点前面带一个短 id；`headless_browser_click`、`headless_browser_type`、`headless_browser_scroll` 直接用这个 id 操作，模型读一次表单就能动手，不必猜 selector。`headless_browser_read` 给超出视口的长正文；`headless_browser_eval` 算一个值；`headless_browser_snapshot` 只给画面。

## 目录

- [使用本包](#use-this-package)
  - [怎么看一个页面](#choosing-how-to-look-at-a-page)
  - [按无障碍 id 操作](#acting-by-accessibility-id)
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
| `stealth` | `true` | 每个页面都报告一个 macOS Chrome 身份，让把「无头浏览器」认出来的站点正常返回页面 |
| `viewportWidth` | `1280` | 页面视口宽度（CSS 像素） |
| `viewportHeight` | `800` | 页面视口高度（CSS 像素） |
| `jpegQuality` | `60` | 实时画面 JPEG 质量 |
| `snapshotDir` | `$DSH_HOME/cache/headless-browser/snapshots` | `headless_browser_snapshot` 写 PNG 的目录 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-headless-browser)列出了全部可用字段。

<a id="choosing-how-to-look-at-a-page"></a>
### 怎么看一个页面

每个工具回答不同的问题。选能回答眼前问题的最便宜那个；既要画面又要知道页面讲了什么时，直接用 `look`。

| 工具 | 回答什么 | 代价 |
|---|---|---|
| `headless_browser_look` | 页面长什么样，又说了什么？一次结果里既有画面，也有同一页面有上限的无障碍摘要 | 一个来回；一张图，加重叠不超过 60 个节点、2000 个字符 |
| `headless_browser_ax` | 哪些元素能操作、状态是什么？无障碍树按缩进打印，每个可交互节点带 id | 纯文本；默认上限 300 个节点 |
| `headless_browser_read` | 正文说了什么？body 或某个 selector 渲染出来的文本，按字符窗口翻 | 纯文本；每窗口最多 20000 个字符 |
| `headless_browser_snapshot` | 页面当时长什么样，不需要读？只有画面，视口或整页 | 一张图，不带页面文本 |
| `headless_browser_eval` | 这个表达式的值是什么？JSON 文本，加上页面自己的异常和 console 错误原文 | 纯文本；表达式上限 16 KiB，结果上限 8000 个字符 |

agent 还没看过的页面默认用 `look`：它在同一个结果里交回模型能看的画面和无障碍摘要，不必先截图再读。`read` 用于不需要画面的长正文。`ax` 用于表单、菜单、列表这类「该点哪里」的问题，也是唯一会把 id 交给操作工具的读法。`snapshot` 是文本说不清页面时的像素兜底，也是坐标点击的来源。`eval` 是取计算值的最后手段，不是读页面的办法。

#### 模型看到的画面

`headless_browser_snapshot` 和 `headless_browser_look` 把 PNG 作为 image 内容块交给模型看，同一结果里带路径、页面 URL、宽、高、它们遵守的 `fullPage` 标志，以及 `scale`。画面是有上限的：一边超过 1568 像素、或总面积超过 120 万像素的页面会被裁剪后缩放拍下，结果显示 `downscaled: true`，并注明缩小到了多大，所以很长的页面到手上是一张看得清的概览，而不是一张巨大的图。同样的字节也落在 `snapshotDir` 下的文件里，接管页和主人读的是这个文件。组合里没有挂载 attachment store 时，结果保留路径并在 note 里说明，而不是让整次调用失败。

#### 读取页面文本

截图只拍视口，比视口长的列表到了模型手上就少了下面几行，而且没有把画面滚动下去再拍一次的办法。`headless_browser_read` 交回页面渲染出来的文本而不是像素：整个文档 body，或者 CSS `selector` 命中的第一个元素，按字符切成窗口。`offset` 与 `limit` 逐页翻——默认 8000 个字符，最多 20000——结果里的 `header` 写明标签页、页面 URL、第几页和字符区间，另有 `total`，以及剩余文本的起始偏移 `nextOffset`。过长的一行 URL 在 `header` 里会截断，窗口按字符计数，不会切在代理对（例如 emoji）中间：每个窗口本身就是模型能独立读的文本。

<a id="acting-by-accessibility-id"></a>
### 按无障碍 id 操作

`headless_browser_ax` 和 `headless_browser_look` 的摘要会给每个 agent 能操作的节点打印一个 `e12` 这样的 id：button、link、textbox、searchbox、combobox、checkbox、radio、menuitem（含它的 checkbox 与 radio 变体）、tab、slider、switch、spinbutton；文件选择框本身报 button 角色，也被覆盖。id 命名的是元素，不是 selector：宿主按页面保存一张 id 到 DOM 节点的映射，所以同一页面连续读两次，同一个元素拿到同一个 id，中间夹一次截图也不影响。模型读一次页面，然后把 `axId` 交给 `headless_browser_click`、`headless_browser_type` 或 `headless_browser_scroll`，它们只解析那一个元素，达不到 Playwright 的可操作性阈值就拒绝，而不是去点别的元素。

id 随导航失效，因为文档和里面的节点都没了；它也只属于一个标签页，因为发号器是全浏览器共用的。别的标签页或上一份文档的 id 会得到 `{ "error": "axId e12 no longer names an element on this page (…); ids die on navigation, so read the page again with headless_browser_ax" }`；从没打印过的 id 会得到 `{ "error": "no element has axId e77; read the page with headless_browser_ax and use an id it printed" }`。

解析 id 时会把 `data-dsh-axid="e12"` 写到元素上，让一次 locator 调用正好找到那个节点，shadow root 里也一样；这个属性只是那次查找的标记，不是页面内容。

### 无障碍输出的样子

一行是 `id role "name" value="…" [states]`，每层缩进两个空格：

```
RootWebArea "Checkout"
  heading "Delivery"
  e3 textbox "Street" [required]
  e4 combobox "Country" value="United States" [expanded=false]
  e5 checkbox "Gift wrap" [checked]
  e6 button "Pay" [disabled]
  … 42 more nodes
```

只打印打开着的状态——`checked`、`checked=mixed`、`disabled`、`required`——只有 `expanded` 例外，它打印 `expanded=true` 或 `expanded=false`，因为 combobox 收起来本身就是信息。隐藏节点被丢掉，它的子节点顶上来；文本只是重复父节点名字的节点被丢掉；走到 `maxNodes`（默认 300，最多 1000）就停，用一行 `… N more nodes` 说明上限挡掉了多少。`selector` 把读取限定在一个元素的子树里，模型因此可以只读一个表单，而不是整页。

### 求值

`headless_browser_eval` 在页面里执行一个 JavaScript 表达式，把 `result` 作为 JSON 文本交回：JSON 能承载的值就是它本身，JSON 不能承载的值用 Chrome 自己的写法（`undefined`、`Infinity`、`5n`）。只有 `awaitPromise` 为 true 时才等返回的 promise。执行期间页面说的每一句都照抄，不改写：每个抛出的异常保留页面自己的描述和栈，每条 console 错误保留页面自己的文本。表达式上限 16384 个字符，结果上限 8000 个字符并带走一个说明截掉多少的标记，超限的调用直接报错并说明上限，不会到页面里跑。

这是唯一一个在已登录 profile 里运行模型自己写的代码的工具。它的结果是页面数据：eval 返回的字符串、一行 console、一个异常，都是页面在说它自己，绝不是什么要照做的指令。知道这个工具在跑的页面可以观察或干扰它求值的任何东西，所以只用它取 agent 已经决定要问的值——不要让页面决定下一步做什么，也不要把页面文本当成代码或命令粘进表达式。

### 浏览器二进制

`playwright-core` 不下载浏览器，所以由部署为运行 Host 的账号准备一个 Chromium。装一次到该账号的 Playwright 缓存，或把 `PLAYWRIGHT_BROWSERS_PATH` 指向共享缓存：

```sh
pnpm exec playwright-core install chromium
PLAYWRIGHT_BROWSERS_PATH=/srv/dsh/ms-playwright pnpm exec playwright-core install chromium
```

不设变量时使用平台缓存（macOS 是 `~/Library/Caches/ms-playwright`，Linux 是 `~/.cache/ms-playwright`）。缺二进制时第一次工具调用会带着启动器的诊断失败，而不是在加载时报错。

### 读取拒绝无头浏览器的站点

`stealth` 选项默认打开，让浏览器如实描述它本来是什么：一个 macOS arm64 的 Chrome，版本就是本包钉住的构建。不打开时 Playwright 的启动会在 `navigator.userAgentData.brands` 和 `navigator.userAgent` 里报 `HeadlessChrome`，让 `navigator.webdriver` 为 true，并发出与 user-agent 字符串不一致的 client hints。站点只要用其中任何一项做机器人检查，就会在内容起作用之前拒绝这个页面；而这些表面一致之后，同一台机器上的同一个 Chromium 就能拿到这个页面。

它同时改三处。启动改用完整 Chromium 构建而不是 headless shell，并带上 `--disable-blink-features=AutomationControlled` 和 `--lang=en-US`。每个页面和每个子框架里都有一份文档起始脚本，替换 `navigator.userAgentData`（含 `getHighEntropyValues`）、`navigator.webdriver`、`navigator.plugins`、`navigator.languages`、`window.chrome`，以及 WebGL 的 vendor 与 renderer 字符串。每个页面还有一次 CDP `Emulation.setUserAgentOverride`，让 `Sec-CH-UA`、完整版本列表、架构、位数和平台版本跟同一个身份对上。新建的标签、站点自己打开的页面，以及从 profile 恢复的页面，都拿到这两半。

它不编造字体列表，不伪造证书，也不应答任何挑战，页面内容一概不碰。仍然拒绝的站点由主人自己接管：接管页照旧工作，挑战本身也正是主人接管的地方。这些用于读取主人有权读取的页面。设 `stealth: false` 就保留浏览器本来的表面。

### 接管页

`headless_browser_hand_over` 返回部署自己服务器上 `/headless-browser` 的地址。页面上是共享页面的实时画面、当前持有者，以及用户的控制按钮。

| 路由 | 用途 |
|---|---|
| `GET /headless-browser` | 页面：实时画面、持有者、取得控制与交还按钮，以及一个逐键输入不了的文本输入框 |
| `GET /headless-browser/status` | JSON：`holder`、用户填写的 `reason`、`launched`、`sessionId`、`url`，以及已连接的页面数 |
| `WS /headless-browser/live` | 画面帧、控制权变化，以及转发进去的输入 |

准入交给部署自己：页面和状态路由用 Web 服务器默认的必须认证策略，所以能打开 Web UI 的同一个 Cookie 或启动令牌也能打开它们。实时 socket 另外要求 owner 身份，因为持有它的人可以在一个已登录的 profile 里操作。

页面上的输入只在用户持有控制权时进入浏览器。从页面取得控制会把持有者设为 `human`，理由是「用户从接管页取得控制」；交还按钮把它还给 agent。两个按钮和两个控制工具是同一个状态转换。

#### 应用内的接管页

本包的浏览器半边也把「浏览器接管」注册成 Web UI 的一个页面：一个键为 `browser-takeover` 的 `main` 面板，由同 id 的侧边栏行选中。主人点那一行就到实时画面，地址栏保持应用自己的 URL，不会跳到站点根路径下面。

画面由页面自己画，不是 iframe，也不打开任何子地址。它用应用自己的来源和 Cookie 读上面的状态路由和实时 socket；「接管」「交回」两个按钮发的是和这页按钮相同的控制消息，只是理由不同。上面那个独立页面留给浏览器允许它的部署。

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

一个 `HeadlessBrowserSession` 拥有上下文。启动是惰性的单飞：工具调用和页面连接同时到达也只会起一个 Chromium；`close()` 会等一个输掉竞争的启动结束。浏览器在一个上下文上维护标签页：第一个页面作为 `t1` 接管，每个新标签拿到下一个 id，关闭的页面会被替换，因此上下文和它的 profile 始终存活。每次启动都有新的 session id，状态路由会报告它。

实时画面是每个页面一个 CDP screencast，由所有已连接的查看者共享。第一个查看者到来时 `Page.startScreencast` 开始，最后一个离开时 `Page.stopScreencast` 停止；每一帧先确认再分发，因为 Chrome 只有收到确认才发下一帧。Chrome 在重绘时发帧，所以这个分发器保留最后一帧：页面静止时后连上来的查看者会立刻看到当前画面，而不是一块空白。帧里带着页面缩放指针输入所需的元数据，只在浏览器页面存在时才有帧。

页面发来的输入是每种事件一条 JSON。`decodeClientMessage` 校验它，`cdpCommand` 把它映射为 `Input.dispatchMouseEvent`（包括 `mouseWheel`）、`Input.dispatchKeyEvent` 或 `Input.insertText`，由 `TakeoverState` 决定是否接受输入。按键把 DOM 的 `keyCode` 同时当作两个 CDP 虚拟键码，所以快捷键和不产生字符的按键表现得和真实窗口一样；逐键打不出来的文本走 `Input.insertText`。

工具共用一个守卫。会操作页面的工具先调用 `TakeoverState.assertAgent`，并在错误结果里带上用户的理由；截图工具跳过守卫，因为它只读页面、不动页面，而读取文本保留守卫，因为读和点击是同一个「看页面—操作页面」循环的前后两半。`headless_browser_scroll` 发送 CDP 滚轮输入并读取 `Page.getLayoutMetrics`，因此移动页面而不执行页面脚本。

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：会话、控制状态、实时画面、工具、路由 |
| [`src/session.ts`](src/session.ts) | 持久上下文、按标签页的 CDP 会话、导航、有上限的截图、读取、求值、无障碍读取、点击、填值、滚动、关闭标签 |
| [`src/read.ts`](src/read.ts) | 页面文本，切成带页码与区间的字符窗口 |
| [`src/inspect.ts`](src/inspect.ts) | 读取规则：eval 结果与诊断、无障碍文本、各种上限、PNG 尺寸 |
| [`src/ax-ids.ts`](src/ax-ids.ts) | 每个页面的稳定 id、操作属性，以及失效 id 得到的拒绝 |
| [`src/tabs.ts`](src/tabs.ts) | 标签 id、活动标签、加载状态、关闭、八标签上限和每次导航的期限 |
| [`src/stealth.ts`](src/stealth.ts) | 身份：启动设置、文档起始脚本，以及每页的 client hints 覆盖 |
| [`src/takeover.ts`](src/takeover.ts) | 持有者状态，以及 agent 动作被拒绝时的错误 |
| [`src/input.ts`](src/input.ts) | 线路消息解码、CDP 命令映射、帧编码 |
| [`src/live-view.ts`](src/live-view.ts) | screencast 分发与查看者记录 |
| [`src/routes.ts`](src/routes.ts) | 页面、状态和实时 socket 的注册 |
| [`src/page.ts`](src/page.ts) | 服务出去的文档和其中的脚本 |
| [`src/tools.ts`](src/tools.ts) | 十二个模型工具 |

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

挂载作用域有工具注册表时，有九个页面工具：`headless_browser_open`（`url`、`newTab`）、`headless_browser_snapshot`（`tab`、`fullPage`）、`headless_browser_read`（`tab`、`selector`、`offset`、`limit`）、`headless_browser_look`（`tab`、`fullPage`、`text`）、`headless_browser_ax`（`tab`、`selector`、`maxNodes`）、`headless_browser_eval`（`tab`、`expression`、`awaitPromise`）、`headless_browser_click`（`selector` 或 `axId`、`tab`）、`headless_browser_type`（`selector` 或 `axId`、`text`、`tab`）、`headless_browser_scroll`（`tab`、`axId` 或 `x`、`y`、`deltaY`、`to`）。每个描述只有一句话，说明操作和结果回答什么：打开返回落定后的 URL 与文档标题，截图返回画面、路径和尺寸，读取返回一段文本窗口和写明页码与区间的 `header`，look 在同一个结果里返回画面和摘要，无障碍读取返回缩进的树，eval 返回 JSON 文本和诊断，点击返回 selector 或 id 与页面 URL，输入返回 selector 或 id 且不回显文本，滚动返回 `x`、`y`、`scrollX`、`scrollY`、`pageHeight`、`viewportHeight`、`atTop`、`atBottom`，模型据此知道是否到达了尽头。结果是一个文本块；画面的文本块先放元数据，图片跟在后面。

#### Token 影响

作用域挂载本包的 agent 每次请求都有固定的 schema 开销，每个工具定义几十个 token。读取受 `limit` 限制，文本最多 20000 个字符；无障碍文本默认最多 300 个节点，摘要最多 60 个节点、2000 个字符；eval 结果上限 8000 个字符。截图或 look 花掉一张图，长边不超过 1568 像素、总面积不超过 120 万像素——这正是重点：看过一次的模型不该再为一次截图加一次读取付两遍。

#### KV Cache 影响

工具定义和描述不变时前缀稳定；结果追加在可复用前缀之后。

### 标签工具

#### 模型看到什么

`headless_browser_close` 接收可选的 `tab`，返回 `{ "closed": "t2", "replaced": false, "tabs": [...] }`：剩下每个标签的 id、标题、URL、加载标志和活动标志。关闭最后一个标签时报告 `"replaced": true`，因为一个空白标签会接替它，浏览器、它的上下文和 profile 都保持打开。八个标签的上限保留；开第九个时回答 `{ "error": "opening <url> failed: the browser allows at most 8 tabs; close one with headless_browser_close before opening another" }`。关闭属于操作类工具，所以用户持有浏览器时会被拒绝。

#### Token 影响

一个很小的定义；结果重复剩下的标签列表，最多八条短记录。

#### KV Cache 影响

只追加：结果进入历史中可复用前缀之后。

### 控制工具

#### 模型看到什么

`headless_browser_hand_over` 接收 `reason`，返回 `{ "url": "<origin>/headless-browser", "holder": "human", "reason": "…" }`；这个 URL 就是用户要打开的地址。`headless_browser_hand_back` 返回 `{ "holder": "agent" }`。用户持有控制期间，每个操作类工具——包括 `headless_browser_read`、`_look`、`_ax`、`_eval`——都回答 `{ "error": "the user holds the browser (<reason>); call headless_browser_hand_back when they are done" }`，而不去碰页面；selector 没有命中回答 `{ "error": "no element matches <selector>; check the selector or read the whole page" }`；未知或失效的 `axId` 会点名这个 id，并说明该重新读一次；标签页不存在回答 `{ "error": "no tab named <id>; use the active tab or open a new one" }`，启动失败回答 `{ "error": "the headless browser could not start: <第一行>" }`。截图全程照常回答，它从不抢输入；`headless_browser_look` 不在此列，因为它同时读用户正在操作的页面。

#### Token 影响

两个很小的定义；一次拒绝只有一行，理由的长短由用户在页面上填的内容决定。

#### KV Cache 影响

只追加：结果和拒绝都进入历史中可复用前缀之后，不改写更早的内容。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **一个浏览器、一个挂载作用域** —— 路由是固定路径，所以一个 Host 只挂载一次；第二次挂载会在 `/headless-browser` 上冲突。浏览器是一个 Chromium、一套标签模型，不是每个 Session 一个，并行运行的 agent 共用它的标签页。
- **浏览器二进制由部署负责** —— `playwright-core` 不带浏览器，本包也不下载。没有 `PLAYWRIGHT_BROWSERS_PATH` 或账号缓存里的安装，每次工具调用都会带着启动器诊断失败。
- **支持的是无头模式** —— `headless: false` 需要已登录的桌面会话；服务账号开不了窗口。
- **拒绝就是拒绝** —— 身份只改浏览器怎么描述自己，不改站点怎么判断：按地址、profile 或请求本身打分的站点仍然可以拒绝这个页面，本包不应答任何挑战。
- **读取拿到的是渲染后的文本** —— `headless_browser_read` 返回页面渲染出来的内容：折叠或隐藏的内容不在其中，selector 命中多个元素时只读第一个，iframe 或 shadow root 里的文本也不属于文档 body。作业列表在折线以下的行就在文本里，尽管任何一张视口截图都拍不到它们。
- **id 只活到它那一份文档** —— `headless_browser_ax` 的 id 只在打印它的页面上解析。导航、关闭标签，或者一个你从没读过的标签，都会带着这个 id 拒绝，并要求重新读一次；解析 id 会把 `data-dsh-axid` 属性写到元素上，因为 locator 需要的正是一个只命中一个节点的 selector。
- **无障碍树是主框架的** —— `headless_browser_ax` 的 `selector` 在主文档里解析，所以 iframe 里的节点只能直接读那个框架的页面。没有角色也没有文本的节点会被丢掉，节点上限会报告挡掉了多少，而不是悄悄截断。
- **求值会在页面里跑模型写的代码** —— `headless_browser_eval` 拥有页面自己的凭证，也能改动页面；它返回的一切都是页面数据，不是指令。表达式与结果的上限限定的是这段交换的大小，不是代码能做什么。
- **超过上限的截图是缩放过的，不是逐像素的** —— 很长的页面整页拍下来时会缩到长边 1568 像素、总面积 120 万像素以内，结果用 `downscaled`、`scale` 和缩小到的尺寸写明这一点。
- **标签页由我们管理，而不是站点** —— 标签模型只管工具或接管页打开的标签；站点自己开的弹窗不会被接管。最多同时保留八个标签；`headless_browser_close` 释放一个，上限错误的文案会点名这个工具。每次导航都有 20 秒期限。
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
- 用户持有控制期间截图仍然可用；它只读页面，不抢输入。`look` 不行：它读的是用户正在操作的页面，所以和其他页面工具走同一个门槛。
- `ax` 的 id 是边打印边发的，所以一次有上限的读取只为模型看到的节点发 id；之后的读取接着往下编号，绝不给另一个节点复用已有的 id。
- 需要浏览器的测试先解析 `chromium.executablePath()`，没有二进制就跳过，所以没装 Playwright 浏览器的 checkout 仍会跑其余全部用例。

</details>
