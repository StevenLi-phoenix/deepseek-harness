---
description: "一个持久的无头 Chromium：给模型一组工具，给用户一个网页。用户在网页上看实时画面，需要时自己接管浏览器完成登录、付款之类必须人来的步骤。"
kind: "package-reference"
---

# @deepseek-ai/dsh-headless-browser

[English](README.md) | 中文

## 概述

给 agent 一个能跨轮次保留状态的浏览器，也给人一个进去的办法。一个无头 Chromium 用自己的 profile 目录运行，登录状态能扛过重启。模型可以打开、读取、点击、输入和关闭标签；动作守卫会拒绝人看不见的控件、会破坏东西或动钱的按钮，以及跨站点的跳转，因为页面是数据，不是指令。某一步需要人时，模型交出一个接管页面，等用户交还。cookie 可以作为 Cookie 头交出去，定时重访让登录一直有效。

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
| `stealth` | `true` | 每个页面都报告一个 macOS Chrome 身份，让把「无头浏览器」认出来的站点正常返回页面 |
| `sensitiveActions` | `true` | 名称或值命中敏感表的目标直接拒绝；`false` 时放行，并把这次跳过记成安全事件 |
| `viewportWidth` | `1280` | 页面视口宽度（CSS 像素） |
| `viewportHeight` | `800` | 页面视口高度（CSS 像素） |
| `jpegQuality` | `60` | 实时画面 JPEG 质量 |
| `snapshotDir` | `$DSH_HOME/cache/headless-browser/snapshots` | `headless_browser_snapshot` 写 PNG 的目录 |
| `keepalivePath` | `$DSH_HOME/data/headless-browser/keepalive.json` | 跨重启保留已注册保活项的 JSON 文件 |
| `keepaliveEscalateAfter` | `3` | 连续多少次交互式登录挑战之后，保活项标记为需要人来登录 |
| `downloadDir` | `$DSH_HOME/cache/headless-browser/downloads` | 下载文件的保存目录，每个文件仅所有者可读写 |
| `maxDownloadMB` | `256` | 保留的最大下载；更大的文件会被删除并报告为失败 |
| `downloadRetainDays` | `7` | 下载文件保留的天数；`0` 表示一直保留 |
| `downloadPdfs` | `true` | PDF 直接下载，不在浏览器查看器里打开 |
| `credentialsPath` | `$DSH_HOME/data/headless-browser/credentials.json` | `headless_browser_credential` 建的站点账号文件，含密码，仅所有者可读写 |
| `uploadDirs` | `[$DSH_HOME/data/headless-browser/uploads]` | `headless_browser_upload` 能附加的文件所在目录；裸文件名在第一个目录里找 |
| `maxUploadMB` | `25` | `headless_browser_upload` 附加的最大文件 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-headless-browser)列出了全部可用字段。

### 读取页面文本

截图只拍视口，比视口长的列表到了模型手上就少了下面几行，而且没有把画面滚动下去再拍一次的办法。`headless_browser_read` 交回页面渲染出来的文本而不是像素：整个文档 body，或者 CSS `selector` 命中的第一个元素，按字符切成窗口。`offset` 与 `limit` 逐页翻——默认 8000 个字符，最多 20000——结果里的 `header` 写明标签页、页面 URL、第几页和字符区间，另有 `total`，以及剩余文本的起始偏移 `nextOffset`。过长的一行 URL 在 `header` 里会截断，窗口按字符计数，不会切在代理对（例如 emoji）中间：每个窗口本身就是模型能独立读的文本。

需要画面本身时截图仍然有用：`fullPage: true` 拍整个可滚动页面，而不是视口。

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
| `GET /headless-browser/status` | JSON：`holder`、用户填写的 `reason`、`launched`、`sessionId`、`url`、已连接的页面数、`security`（最新的守卫事件），以及 `keepalive`（每一个已注册的保活项） |
| `WS /headless-browser/live` | 画面帧、控制权变化，以及转发进去的输入 |

准入交给部署自己：页面和状态路由用 Web 服务器默认的必须认证策略，所以能打开 Web UI 的同一个 Cookie 或启动令牌也能打开它们。实时 socket 另外要求 owner 身份，因为持有它的人可以在一个已登录的 profile 里操作。

页面上的输入只在用户持有控制权时进入浏览器。从页面取得控制会把持有者设为 `human`，理由是「用户从接管页取得控制」；交还按钮把它还给 agent。两个按钮和两个控制工具是同一个状态转换。

#### 应用内的接管页

本包的浏览器半边也把「浏览器接管」注册成 Web UI 的一个页面：一个键为 `browser-takeover` 的 `main` 面板，由同 id 的侧边栏行选中。主人点那一行就到实时画面，地址栏保持应用自己的 URL，不会跳到站点根路径下面。

画面由页面自己画，不是 iframe，也不打开任何子地址。它用应用自己的来源和 Cookie 读上面的状态路由和实时 socket；「接管」「交回」两个按钮发的是和这页按钮相同的控制消息，只是理由不同。上面那个独立页面留给浏览器允许它的部署。

<a id="understand-the-implementation"></a>
### 下载

这个浏览器从不询问保存位置。它是无头模式，Playwright 把每次下载固定到私有目录，所以 Chromium 不会打开保存面板，也不会出现 `prompt_for_download` 的询问。以前出的问题是无声的：返回 `Content-Disposition: attachment` 的 URL 会让 `headless_browser_open` 以 `Download is starting` 失败，点击下载链接模型看不到任何结果，文件留在浏览器关闭时就被删除的临时目录里。

现在浏览器打开的每个页面都会保留自己的下载。完成的文件复制到 `downloadDir`，命名为 `<时间>-<随机>-<名字>`，目录权限 `0700`，文件 `0600`。名字取自站点建议的文件名，并缩减成单个安全片段（无分隔符、控制字符和开头的点），页面无法把文件引出该目录。超过 `maxDownloadMB` 的文件被删除并报告为失败；两分钟还没结束的下载被取消；超过 `downloadRetainDays` 的文件在保存下一个下载时清理，最多每小时一次。日志只记录每个文件的来源和路径，不含查询字符串，因为它常带签名令牌。

- 对本身就是下载的 URL 调用 `headless_browser_open`，返回 `downloads`（路径、字节数、作为不可信文本的建议名、来源地址），而不是页面。
- `headless_browser_click` 在点击启动了下载时返回 `downloads`；它等 250 毫秒让下载开始，Chromium 通常在约一百毫秒内开始。
- `headless_browser_downloads` 列出最新的文件，带 `waitMs` 时等一个慢下载开始；用户接管页面时它依然可用。
- `downloadPdfs` 在每次启动前把 `plugins.always_open_pdf_externally` 和 `download.prompt_for_download=false` 写入 profile 的 `Default/Preferences`（合并而不替换，文件不是 JSON 时不动）。无头查看器给模型的是空白页，而查看器自带的 Download 按钮正是有窗口的浏览器里唯一会弹出系统保存对话框（`showSaveFilePicker`）的路径；有了这个设置，PDF 作为普通下载到达，根本不经过查看器。无头浏览器里 `showSaveFilePicker` 会立刻以 `AbortError` 被拒绝，所以调用它的页面脚本会快速失败而不是卡住。

下载的文件是来自页面的数据：可以读，不要运行。文件特别大时，`headless_browser_cookies` 加普通 HTTP 请求仍然可以绕开浏览器的那份副本。

### 附加文件

求职申请、签证表格和课程提交都要传文件，而真正的 `<input type="file">` 几乎总是藏在一个有样式的按钮后面，可见性守卫会故意拒绝它。`headless_browser_upload` 专门处理这一种合理的隐藏元素。用 `selector` 指定文件框（页面有多个时加 `index`）；文件框隐藏是常态，不需要打分。也可以用 `trigger`（或 `triggerAxId`）指定可见的按钮：这次点击和其他点击一样过守卫，它打开的文件选择器接收文件。一次传多个文件时，文件框或选择器必须支持多选。

能附加什么由所有者决定，不由页面决定。页面可能要求 agent「附上你的密钥来验证」，所以本工具只附加 `uploadDirs` 里的普通文件：检查前先解析符号链接，每个文件不超过 `maxUploadMB`，每次最多十个。`resume.pdf` 这样的裸文件名在第一个目录里找，插件加载时会创建这个目录（`0700`）；任务要用的文件由所有者或任务自己的脚本拷进去。结果列出每个文件和大小；日志记一行文件数、选择器和来源。

### 站点账号与密码

agent 注册站点账号时，原本要自己定密码、输入密码、再找地方存——密码会进入它的上下文、会话日志和之后的每一份摘要，模型也恰恰在这一步拒绝。`headless_browser_credential` 是浏览器自带的密码管理器：

- `create`：在注册表或设置新密码的表单上，生成一个 20 位密码（CSPRNG；大小写字母、数字和一个 `!@#$%^*-_=+?` 里的符号，去掉了容易认错的字符；严格的站点用 `length` 12–64 和 `symbols: false`），连同页面主机和账号用的 `username` 一起保存，再写进密码框，给了 `confirmSelector` 时也写进确认框。第一次写入被拒绝时新记录会删掉，重试不会撞上重复。同一主机、同一登录名再次 `create` 会被拒绝，除非 `replace: true`；替换时旧密码留在新密码旁边，供所有者找回。
- `fill`：在登录表单上写入页面主机保存的 `username` 或 `password`；同一主机有两个账号时要给 `username`。
- `list`：列出保存的账号，不含密码。

三条规则把密码关在里面：密码只写进 `input[type=password]`；只在页面处于记录所属主机时写，写入那一刻再检查；任何工具结果、日志和错误都不含密码——结果只写账号（`id`、`host`、`username`、`label`、时间）。记录绑定完整主机而不是可注册域名，因为一个 ATS 域名服务很多公司（`acme.wd5.myworkdayjobs.com` 和 `other.wd5.myworkdayjobs.com` 是两个账号）。

`credentialsPath` 处的文件是版本 1 的 JSON，权限 `0600`，原子写入；遇到其他版本的文件会拒绝，而不是覆盖。所有者通过两个仅所有者可用的路由读取（已登录的非所有者得到 403）：

| 路由 | 返回 |
|---|---|
| `GET /headless-browser/credentials` | JSON `{ accounts, export }`：所有账号，不含密码 |
| `GET /headless-browser/credentials.csv` | `name,url,username,password,note`——Chrome 密码管理器能导入的 CSV（chrome://password-manager/settings → 导入），密码也就进了所有者自己的管理器 |

### 用会话的 cookie 直接取页面

每读一次页面就开一次浏览器既慢，站点也看得见。会话登录之后，调用方通常只需要 Cookie 头：带同一份会话的纯 HTTP 请求几毫秒就能取回页面。`headless_browser_cookies` 交回浏览器上下文自己的 cookie——`name`、`value`、`domain`、`path`、`expires`、`httpOnly`、`secure`——调用里给了域名后缀就只留下匹配的那些，外加 `toHeader`，也就是那个请求会发出的 `name=value; name=value` 一行：

```json
{"cookies":[{"name":"session","value":"…","domain":".example.com","path":"/","expires":1800000000,"httpOnly":true,"secure":true}],"toHeader":"session=…"}
```

域名过滤接受裸后缀、带点的 cookie 域名，或者整个 URL，匹配这个主机和它下面的一切：`example.com` 覆盖 `.example.com` 和 `mail.example.com`，而 `notexample.com` 是另一个站点。cookie 按路径从具体到宽泛排列，也就是请求发出的顺序。

拿到 `toHeader` 的调用方自己发请求，不用再开浏览器：

```sh
curl -s -H "Cookie: session=…; theme=dark" https://example.com/inbox
```

这些值是凭据。本包从不把它们写到磁盘，从不把任何一个放进日志行：调试行只说每条 cookie 的名字和它值的长度（`session ‹42 chars›`）。它们会到达模型，因为这个工具就是为此存在的，所以只在一次取页需要会话时调用，而不是为了展示。`httpOnly` 的 cookie 照样在头里，因为浏览器是替这个请求持有它的；调用之后站点轮换过的 cookie 已经过期；一个上下文的 cookie 也不是另一台机器的会话。

### 让会话保持活着

没人访问，登录就会死。站点让自己的会话过期，下一次真正的任务从一个登录页开始，主人的注意力花在了一次访问本来就能避免的一步上。`headless_browser_keepalive` 按定时器访问一个地址并检查回来的东西，于是这次访问在站点自己的会话还活着时把它续上。

**认证检查。** 仅能打开页面还不够：最终 URL 必须与 `domain`（未配置时为请求 URL）同属一个可注册域，且不能落到已知登录主机或路径；看得见的密码框或一次性验证码框也会使检查失败。`add` 接受 `expect` 数组，每个匹配器都必须通过。`allowHosts` 或 `allowOrigins` 可覆盖默认域名规则，但不会放行已知登录地址；`forbidPath` 禁止指定路径及子路径。用 `expectText` 要求出现可见文字、用 `forbidText` 禁止出现可见文字，或用 `expectRegex`（不带分隔符）匹配必须出现的文字。`waitForTextMs` 可等待异步加载的内容；超时仍为 `recovering`，原因为 `timeout`。插件配置 `keepaliveExpect` 可以按保活项 id 覆盖匹配器，规则变化后会立即安排复查。

**会话死了是插件的事。** 检查失败会把条目移到 `recovering`，按 5 分钟、15 分钟、之后每小时的退避重试，因为很多故障来自站点自己，一次能续上会话的访问就把它结束了。反复未通过认证检查可能需要人来登录：连续 `keepaliveEscalateAfter` 次（默认 3）失败之后，条目标成 `needs-human`，并最多每小时重复一次通知，通知里始终带着从什么时候开始、试了多少次、最后的 URL、卡在哪一步。只要有一次检查通过，条目就回到 `ok`，计数清零，并发出一条 `recovered` 事件。完全没能跑起来的一次访问——浏览器死了、连接被拒——报 `error`，从不升级，因为登录并不能修它。

**每次状态变化一条事件。** 每次状态变化都通过插件的事件总线 `headless-browser/keepalive` 恰好发出一条事件，而停在 `needs-human` 的条目最多每小时发一条 `reminder`。想让主人知道的宿主订阅这里；本包自己不发送任何消息。

**定时器、文件和标签上限。** 间隔是 5 分钟到 24 小时，`add` 拒绝这个范围之外的值、重复的 URL、带凭据的 URL，以及点不出主机的站点。记录保存在 `$DSH_HOME/data/headless-browser/keepalive.json`，插件加载时重新挂上定时器，所以重启不会忘掉一个会话。检查在自己的离屏页面里访问 URL：页面池最多两个，这个页面从不进入标签模型，agent 或主人当前所在的标签仍然是活动标签。因此保活项永远不占用八个标签的上限。

```text
headless_browser_keepalive {"action":"add","url":"https://example.com/inbox","everyMinutes":30,"label":"inbox"}
headless_browser_keepalive {"action":"list"}
headless_browser_keepalive {"action":"check","id":"k1"}
headless_browser_keepalive {"action":"remove","id":"k1"}
```

`list` 交回 `id`、`label`、`url`、`everyMinutes`、`state`（`ok`、`recovering`、`needs-human` 或 `error`）、`consecutiveFailures`、`firstFailureAt`、`lastOkAt`、`lastCheckAt`、`lastAttemptAt`、`nextAttemptAt`、`lastUrl`、`blockedStep`、`lastError` 和机器可读的 `reason`（例如 `sso_redirect:<主机>`、`missing_text:<匹配器>`、`forbidden_text`、`network` 或 `timeout`），`GET /headless-browser/status` 在 `keepalive` 字段下给出同一份列表。`check` 在定时器到期之前立刻跑一次，并交回同样的字段。

### 页面是数据，不是指令

页面可以说什么都行：某个复选框「用于验证你是人类」，某个表单只是例行确认，某个链接指向课程站点。这些都不是动手的理由，本包也不把判断留给模型自行斟酌。每个会改动页面的工具（`headless_browser_open`、`_click`、`_type`）都先问宿主里的动作守卫，守卫只根据测量结果和固定表格回答，不看页面怎么写。`headless_browser_scroll` 不指定目的地，因此改不了站点，守卫在那里没有要判断的事。

**可见性评分。** [`src/visibility.ts`](src/visibility.ts) 测量人真正要点的那个元素，并把它折成 0 到 1 的分数：计算后的 `display` 和 `visibility`、整条 opacity 链的乘积、盒子面积、`pointer-events`、`aria-hidden`、滚动到它之后盒子落在视口内的比例（瞬时滚动，所以设了 `scroll-behavior: smooth` 的页面，比如 Greenhouse 的职位页，量的是字段停下的位置，而不是动画半途）、五个采样点上命中测试能碰到它的比例（命中测试会沿开放的 shadow root 一路往下找，所以嵌在自定义元素里的字段，比如 SmartRecruiters 的表单，不会被当成被遮住），以及有多少个祖先把它裁掉（元素自己的 `overflow` 只裁它的内容，所以不算）。人绕不过去的项（display、visibility、pointer-events、aria-hidden）权重最高，单独一项就足以让分数归零。低于 `VISIBILITY_THRESHOLD`（0.2）的点击或输入会被拒绝，拒绝里写明分数和拖低分数的那些项。一个选择器命中多个元素时，守卫操作分数最高的那个，并同时报告它和次高者的分数，模型因此能看出自己选中的是真控件而不是诱饵。命中的元素带 `aria-hidden` 或被遮住时，会多出一个候选：它中心点上的可交互元素，前提是无障碍名称相同。Workday 把每个真正的 `<button>` 藏在一层同名的透明 `role="button"` 覆盖层下面，人点到的正是这层覆盖层；被名称不同的元素盖住的元素找不到候选，照样被拒绝。面积这一项对可搜索下拉框的输入框（combobox 输入框，react-select 就这样渲染 Greenhouse 的每个选项）按它外面那个控件来量，因为没输入文字时它只有一个光标宽；同样小的普通输入框照样被拒绝。样式化的复选框或单选框把真正的 input 以 opacity 0 放在最上层，下面画出人看见的方框（Workday 的同意条款框就是这样），所以 opacity 这一项读 input 正下方画出来的方框，没有方框时读 input 自己看得见的 label；两样都没有的 opacity 0 复选框照样被拒绝。

**敏感名称。** [`SENSITIVE_ACTIONS`](src/guard.ts) 是唯一一张会破坏东西、会动钱的动词表：submit、pay、purchase、下单或确认订单、transfer、approve、delete、移除/归档/停用账户、unsubscribe、revoke。目标的无障碍名称或值命中其中任何一条就会被拒绝，需要 `headless_browser_hand_over`。这张表是故意保守的：误判的代价是主人花几秒钟确认一次，漏判的代价是一个账户或一笔钱。

**关闭名称规则。** `sensitiveActions: false` 只关掉这一条规则：名称或值命中的目标照常执行，而这个决定仍会记成一条安全事件，带 `rule: 'sensitive-name'` 和 `skipped: true`，所以审计里照样留着规则本来会拒绝的每一个目标。它存在的理由是主人亲自盯着的任务——主人已经看过这个表单，要的就是让 agent 按下 Submit——可见性评分和站点规则则原样保留：它们量的是人能不能点到这个目标、动作会不会离开站点，而不是主人是否已经同意这一次点击。

**站点漂移。** 点击和输入按它所在页面的注册域来判断，所以不会因为另一个标签刚才停在 Handshake，就把这个标签里的表单当成跨站；还没有站点的新标签和漂移记录用会话最后所在的站点。打开、点击或输入会把浏览器带到另一个域时，第一次会被拒绝；agent 要带上 `allowOrigin: true` 再请求一次，这次放行会被记录成事件。同一个注册域下的子域算同一个站点，所以 `mail.example.com` 和 `example.com` 之间可以直接走。页面自己跳走的情况会被记录成一次漂移。

**每次拒绝都是安全事件。** 每个决定一条事件，带页面 URL、选择器、无障碍 id 或坐标点、无障碍名称、触发的规则、分数和一行理由。列表只保留最新 50 条，由 `GET /headless-browser/status` 的 `security` 字段提供；插件同时发出 `headless-browser/security` 事件，供需要观察的宿主订阅。模型看到的是 `blocked` 工具结果：它要把这次拦截报告给主人，不能换个选择器、坐标或无障碍 id 再试。

**合法的不可见元素。** 文件上传输入框是最常见的一种：真正的 `<input type="file">` 往往是 `display:none` 或 `opacity:0`，由外面那个样式化的 label 触发。守卫会拒绝这个隐藏的输入框，让人来接手：`headless_browser_hand_over` 把页面交给主人，主人点 label，剩下的交给操作系统的文件选择器。样式化开关背后、input 并不压在上面的那个隐藏原生复选框同理，这两种都不需要给选择器开例外。

**坐标。** 在视口坐标上点击或输入没有元素可以评分，所以守卫对那个点做命中测试，只对命中的元素跑敏感名称和站点规则，并记录标签、坐标、命中元素的无障碍名称和它的分数。这里的分数是审计信息而不是门槛：模型点的是它在截图里看到的东西。

**无障碍 id。** `axId` 通过页面读取用 `HeadlessBrowserSession.setAxResolver` 注册的 id 表解析；会话不保留第二份表，所以一个 id 不会指向两个元素。表里没有的 id（读取之后页面导航过）会按 id 名拒绝，agent 要重新读页面，而不是退回选择器或坐标。读取没有注册 id 表的构建会带着这个理由拒绝该 id，而不是猜一个元素。

**包装。** 工具结果里每个来自页面的字段都以 `{ "untrusted": "<origin>", "content": "..." }` 的形式出现，每个工具描述都用一句话说明这一点：页面标题、一次读取的文本、无障碍名称、截图捕获的那个页面。包装是工具层的职责，不是提示词的。

## 理解实现

<details>
<summary>实现细节——点击展开</summary>

一个 `HeadlessBrowserSession` 拥有上下文。启动是惰性的单飞：工具调用和页面连接同时到达也只会起一个 Chromium；`close()` 会等一个输掉竞争的启动结束。浏览器在一个上下文上维护标签页：第一个页面作为 `t1` 接管，每个新标签拿到下一个 id，关闭的页面会被替换，因此上下文和它的 profile 始终存活。每次启动都有新的 session id，状态路由会报告它。

实时画面是每个页面一个 CDP screencast，由所有已连接的查看者共享。第一个查看者到来时 `Page.startScreencast` 开始，最后一个离开时 `Page.stopScreencast` 停止；每一帧先确认再分发，因为 Chrome 只有收到确认才发下一帧。Chrome 在重绘时发帧，所以这个分发器保留最后一帧：页面静止时后连上来的查看者会立刻看到当前画面，而不是一块空白。帧里带着页面缩放指针输入所需的元数据，只在浏览器页面存在时才有帧。

页面发来的输入是每种事件一条 JSON。`decodeClientMessage` 校验它，`cdpCommand` 把它映射为 `Input.dispatchMouseEvent`（包括 `mouseWheel`）、`Input.dispatchKeyEvent` 或 `Input.insertText`，由 `TakeoverState` 决定是否接受输入。按键把 DOM 的 `keyCode` 同时当作两个 CDP 虚拟键码，所以快捷键和不产生字符的按键表现得和真实窗口一样；逐键打不出来的文本走 `Input.insertText`。

一个 `KeepaliveService` 拥有保活项、它们的定时器和离屏页面池。一次检查借一个页面，访问 URL，跑页面侧的探针，然后结算条目；每个条目在途的 promise 让定时器和强制的 `check` 共用同一次尝试，两格的信号量限制并发访问，每次尝试都先写文件再重新挂定时器。事件经 `ctx.emit` 发出，和动作守卫是同一条总线，所以宿主用一套订阅方式就能看住两者。

工具共用一个守卫。会操作页面的工具先调用 `TakeoverState.assertAgent`，并在错误结果里带上用户的理由；截图工具跳过守卫，因为它只读页面、不动页面，而读取文本保留守卫，因为读和点击是同一个「看页面—操作页面」循环的前后两半。`headless_browser_scroll` 发送 CDP 滚轮输入并读取 `Page.getLayoutMetrics`，因此移动页面而不执行页面脚本。随后会操作页面的工具再问 `ActionGuard`：给「人会去点」的那个元素打分，检查敏感名称表和会话所在的站点，把拒绝变成 `blocked` 结果；读取文本和截图同样跳过这个守卫，因为它们不操作任何元素。

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：会话、控制状态、实时画面、工具、路由 |
| [`src/session.ts`](src/session.ts) | 持久上下文、按标签页的 CDP 会话、导航、截图、读取、点击、填值、滚动、关闭标签 |
| [`src/read.ts`](src/read.ts) | 页面文本，切成带页码与区间的字符窗口 |
| [`src/tabs.ts`](src/tabs.ts) | 标签 id、活动标签、加载状态、关闭、八标签上限和每次导航的期限 |
| [`src/stealth.ts`](src/stealth.ts) | 身份：启动设置、文档起始脚本，以及每页的 client hints 覆盖 |
| [`src/takeover.ts`](src/takeover.ts) | 持有者状态，以及 agent 动作被拒绝时的错误 |
| [`src/input.ts`](src/input.ts) | 线路消息解码、CDP 命令映射、帧编码 |
| [`src/live-view.ts`](src/live-view.ts) | screencast 分发与查看者记录 |
| [`src/routes.ts`](src/routes.ts) | 页面、状态和实时 socket 的注册 |
| [`src/page.ts`](src/page.ts) | 服务出去的文档和其中的脚本 |
| [`src/guard.ts`](src/guard.ts) | 动作守卫：敏感名称表、站点记忆、安全事件、untrusted 包装 |
| [`src/visibility.ts`](src/visibility.ts) | 页面侧的探针和可见性评分 |
| [`src/keepalive.ts`](src/keepalive.ts) | 保活存储、定时器、退避、通知、离屏页面池和它的 JSON 文件 |
| [`src/challenge.ts`](src/challenge.ts) | 通用登录测试：页面侧探针，以及给被拦访问分类的规则 |
| [`src/cookies.ts`](src/cookies.ts) | cookie 过滤、Cookie 头和日志安全的摘要 |
| [`src/tools.ts`](src/tools.ts) | 十一个模型工具 |

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

挂载作用域有工具注册表时，有七个页面工具：`headless_browser_open`（`url`、`newTab`、`allowOrigin`）、`headless_browser_snapshot`（`tab`、`fullPage`）、`headless_browser_downloads`（`limit`、`waitMs`）、`headless_browser_read`（`tab`、`selector`、`offset`、`limit`）、`headless_browser_click`（`selector`、`axId`、`x`、`y`、`allowOrigin`、`tab`）、`headless_browser_type`（`selector`、`axId`、`x`、`y`、`text`、`allowOrigin`、`tab`）、`headless_browser_scroll`（`tab`、`x`、`y`、`deltaY`、`to`）。点击或输入只指定一个目标：CSS 选择器、页面读取给出的无障碍 id，或视口坐标。每个描述只有一句话，说明操作、结果回答什么，以及来自页面的字段以 `{ "untrusted": "<origin>", "content": "..." }` 的形式到达。打开返回落定后的 URL 和作为不可信数据的文档标题；截图返回 PNG 路径和被捕获的页面；读取返回一段作为不可信数据的文本窗口，`header` 写明它的页面和区间；点击或输入返回目标或坐标点、无障碍名称、它胜出的分数以及次高分；滚动返回 `x`、`y`、`scrollX`、`scrollY`、`pageHeight`、`viewportHeight`、`atTop`、`atBottom`，模型据此知道是否到达了尽头。拒绝返回一个 `blocked` 对象，包含规则、页面、引用、名称、理由、提示、分数、阈值、未通过的项和每一项的值，提示里说明要报告这次拦截而不是重试。结果是一个 JSON 文本块。输入的结果不回显文本，所以模型敲进表单的密码不会进入会话日志。

#### Token 影响

作用域挂载本包的 agent 每次请求都有固定的 schema 开销，每个工具定义几十个 token。结果是一个很短的 JSON 对象；截图只增加路径，不增加图片，读取受 `limit` 限制，文本最多 20000 个字符。

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

`headless_browser_hand_over` 接收 `reason`，返回 `{ "url": "<origin>/headless-browser", "holder": "human", "reason": "…" }`；这个 URL 就是用户要打开的地址。`headless_browser_hand_back` 返回 `{ "holder": "agent" }`。用户持有控制期间，每个操作类工具——包括 `headless_browser_read`——都回答 `{ "error": "the user holds the browser (<reason>); call headless_browser_hand_back when they are done" }`，而不去碰页面；selector 没有命中回答 `{ "error": "no element matches <selector>; check the selector or read the whole page" }`，标签页不存在回答 `{ "error": "no tab named <id>; use the active tab or open a new one" }`，启动失败回答 `{ "error": "the headless browser could not start: <第一行>" }`。截图全程照常回答，它从不抢输入。

#### Token 影响

两个很小的定义；一次拒绝只有一行，理由的长短由用户在页面上填的内容决定。

#### KV Cache 影响

只追加：结果和拒绝都进入历史中可复用前缀之后，不改写更早的内容。

### 会话工具

#### 模型看到什么

`headless_browser_cookies`（`domain`）交回 `{ "cookies": [ … ], "toHeader": "session=…; theme=dark" }`，每条 cookie 一个对象，带 `name`、`value`、`domain`、`path`、`expires`、`httpOnly` 和 `secure`。`headless_browser_keepalive` 接受一个 `action`：`add` 和 `check` 交回 `{ "keepalive": { … } }`，`list` 交回 `{ "keepalives": [ … ] }`，`remove` 交回 `{ "removed": "k1" }`；被拒绝的请求交回 `{ "error": "everyMinutes must be 5 through 1440: 5 minutes through 24 hours" }` 或 `{ "error": "k1 (inbox) already visits https://example.com/inbox" }`，什么也不存。

#### Token 影响

挂载本包的作用域每次请求多两个定义：cookie 列表是每条一个短对象，保活列表是每个条目一个对象，而两个工具都很少调用——由定时器照看的会话不需要模型每一轮都去看它。

#### KV Cache 影响

定义不变时前缀稳定；结果追加在可复用的前缀之后。

### 表单工具

#### 模型看到什么

`headless_browser_upload`（`files`，加 `selector` 和 `index`，或 `trigger`/`triggerAxId`）交回 `{ "attached": [{ "name": "resume.pdf", "bytes": 81234 }], "ref": "#resume", "url": "…", "inputs": 1 }`，或 `{ "error": "/etc/passwd is outside the upload directories (…); copy the file there first" }`。`headless_browser_credential` 接受一个 `action`：`create` 和 `fill` 交回 `{ "action": "create", "account": { "id": "c1a2b3c4d5e6", "host": "acme.wd5.myworkdayjobs.com", "username": "cv@example.com", "createdAt": "…" }, "wrote": ["#password", "#confirm"], "url": "…", "target": { … } }`，`list` 交回 `{ "action": "list", "accounts": [ … ] }`，任何返回都不含密码。

#### Token 影响

挂载本包的作用域每次请求多两个定义；结果是一个短对象，密码根本不进上下文。

#### KV Cache 影响

定义不变时前缀稳定；结果追加在可复用的前缀之后。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **一个浏览器、一个挂载作用域** —— 路由是固定路径，所以一个 Host 只挂载一次；第二次挂载会在 `/headless-browser` 上冲突。浏览器是一个 Chromium、一套标签模型，不是每个 Session 一个，并行运行的 agent 共用它的标签页。
- **浏览器二进制由部署负责** —— `playwright-core` 不带浏览器，本包也不下载。没有 `PLAYWRIGHT_BROWSERS_PATH` 或账号缓存里的安装，每次工具调用都会带着启动器诊断失败。
- **下载在完成后才检查** —— 大小上限针对完成的文件，所以很大的下载在完成或两分钟限制把它取消之前，仍占用浏览器的临时目录；保活项离屏页面的下载不保留。
- **支持的是无头模式** —— `headless: false` 需要已登录的桌面会话；服务账号开不了窗口。
- **拒绝就是拒绝** —— 身份只改浏览器怎么描述自己，不改站点怎么判断：按地址、profile 或请求本身打分的站点仍然可以拒绝这个页面，本包不应答任何挑战。
- **守卫是保守的** —— 敏感名称表按词匹配，所以「Submit search」「Delete draft」也要主人确认；一次确认就是永不放过真实付款的代价。可见性评分读的是计算样式和几何，封闭 shadow root 里的元素无法做命中测试，会被拒绝。
- **站点规则是启发式的** —— 公共后缀表是固定的而不是下载的，未收录的两段后缀会把一个站点拆成两个，代价是一次拒绝。脚本可以用守卫看不见的 URL 导航；会改页面的 eval 读取文本里的绝对 URL 只当绊线，不当证明。
- **坐标点击只审计、不评分** —— 守卫记录那个点命中了什么，但不会因为命中的是不可见元素而拒绝，因为模型是在照着截图操作；敏感名称和站点规则照旧生效。
- **读取不评分** —— 守卫检查的是点击或输入落在哪里，不是读取返回什么：页面文本会作为不可信数据包装，怎么用由模型决定。
- **原生下拉框按选项文字选择** —— 对 `<select>` 调 `headless_browser_type` 会选中标签（其次是 value）与文本相同的可用选项（忽略大小写和空白差异），否则选文本唯一开头或唯一包含的那个选项，并在 `selected` 里返回它的标签；文本有歧义或不存在时拒绝，并提示先读取这个 select 的选项。对可搜索下拉框的输入框（`role="combobox"` 或 `aria-autocomplete="list"`），文本按键盘逐键输入，因为直接写入的值打不开 react-select 的列表；它打开的列表（`aria-controls`）里文本指名的那个可见选项经守卫放行后被点击，并在 `selected` 里返回，否则列表保持打开，由模型自己点选。
- **读取拿到的是渲染后的文本** —— `headless_browser_read` 返回页面渲染出来的内容：折叠或隐藏的内容不在其中，selector 命中多个元素时只读第一个，iframe 或 shadow root 里的文本也不属于文档 body。读取整个页面时，`frames`（`url`、`width`、`height`）列出每个至少 200 × 100 像素的内嵌 http(s) 页面，最多五个：iCIMS 把整张申请表放在这样一个页面里，打开那个 `url` 表单就成了独立页面。作业列表在折线以下的行就在文本里，尽管任何一张视口截图都拍不到它们。
- **站点的弹窗会变成标签** —— 页面自己打开的窗口（"Continue with Google" 登录、`target=_blank` 链接）会被收为标签并设为当前标签，接管页里也一样，超过标签上限也照收；`headless_browser_click` 等它 250 毫秒，在 `popups`（`tab`、`opener`、`url`）里写明它，它自己关闭后打开它的标签重新成为当前标签。除此之外最多同时保留八个标签；`headless_browser_close` 释放一个，上限错误的文案会点名这个工具。每次导航都有 20 秒期限。
- **画面只实时** —— 只有接管页连着时才有帧，不录制，Chrome 繁忙时会掉帧。静止页面不会产生新帧，后连上来的页面看到的是最后画出的那一帧。渲染进程崩溃会结束推流，重新加载页面并连接之后画面才会回来。
- **接管地址需要 Web 服务器** —— 在没有 Web 服务器的组合里，`headless_browser_hand_over` 只返回 `/headless-browser`，用户打不开。
- **生成的目录跟着挂载走** —— `docs/tool-catalog.md` 和 `docs/config-catalog.md` 只有在某个组合挂载本包并运行生成器之后，才会列出本包的工具和字段。
- **页面没有做本地化** —— 服务出去的页面文案固定为中文，和由 locale 拥有文案的 Client 插件不同；它不属于任何 Client bundle。
- **登录测试是启发式的** —— 它读结构不读含义：同源、没有密码框也没有一次性验证码的页面就算通过，哪怕它不是主人想要的那一页；只弹验证码的挑战看起来也像一个普通页面。这次访问仍然会续上站点允许续的部分。
- **保活项没法替你登录** —— 访问续上的是站点还认的会话。站点自己的会话真的没了之后，只有人才能恢复：条目标成 `needs-human`，通过事件总线最多每小时重复一次通知，本包自己不发消息。
- **保活是看不见的** —— 它的离屏页面不在标签条里，也没法在接管页上看；页面池最多两个，站点弹出对话框时检查就停在它落到的那个页面上。
- **cookie 会进入会话记录** —— 一次 cookie 调用的值会进模型的历史，也就进了磁盘上的会话日志，因为调用方要的就是它们；本包自己不写也不记任何值。

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
