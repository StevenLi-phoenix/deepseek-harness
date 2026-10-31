# cc-bridge——DSH agent 与 Claude Code 会话之间的 relay

[English](README.md) | 中文

让这台 Mac 上的事件 agent（`dsh-runtime` 账号）和 owner 的 Claude Code 会话（`lishuyu` 账号）互相通信：agent 列出会话并给其中一个发消息（`cc_list_sessions`、`cc_send`，见包 [`lsy-cc-bridge`](../../packages/lsy/lsy-cc-bridge/README.zh.md)）；会话用 Claude Code 自带的 `SendMessage` 工具给 agent 发消息，消息以不可信数据的形式进入微信对话 Session。

## 为什么需要 relay

Claude Code 会话监听 `/tmp/cc-socks` 里的 unix socket（目录 0700、socket 0600、属主 `lishuyu`），并用 `~/.claude/sessions` 里每个会话的 token 文件验证发送者。`dsh-runtime` 打不开其中任何一个，而这些权限保持原样。relay 以 `lishuyu` 身份运行，一边说 Claude Code 的 peer 协议，一边说一个小的 JSON 行协议，是唯一跨越账号边界的进程。

```text
Claude Code session --SendMessage--> inbox.sock (0600, owner only) --+
                                                                      relay.py (LaunchAgent, lishuyu)
DSH plugin (dsh-runtime) <--JSON lines--> dsh.sock (0600 + ACL) -----+
                                                                      |
relay --peer protocol--> /tmp/cc-socks/<pid>.sock (the session's own inbox)
```

## 各个文件在哪

| 路径 | 属主 / 权限 | 作用 |
|---|---|---|
| `~/.local/state/dsh-cc-bridge/` | lishuyu，0700 | 状态目录：`relay.log`（轮转，1 MB x 5）、`launchd.err` |
| `~/.local/state/dsh-cc-bridge/cc.sock` | lishuyu，0600 | Claude Code 会话发送的收件 socket（`uds:/Users/lishuyu/.local/state/dsh-cc-bridge/cc.sock`） |
| `/Users/Shared/dsh-cc-bridge/` | lishuyu，0700 + ACL `dsh-runtime allow search` | 面向 DSH 的目录（`/Users/lishuyu` 对 `dsh-runtime` 关闭，所以 socket 放在它外面） |
| `/Users/Shared/dsh-cc-bridge/dsh.sock` | lishuyu，0600 + ACL `dsh-runtime allow read,write` | DSH 插件连这里 |
| `~/.local/libexec/dsh-cc-bridge/relay.py` | lishuyu，0755 | 安装出来的副本（`install.sh` 负责更新） |
| `~/Library/LaunchAgents/app.lishuyu.dsh-cc-bridge.plist` | lishuyu | LaunchAgent `gui/501/app.lishuyu.dsh-cc-bridge`，RunAtLoad + KeepAlive |
| `~/.claude/sessions/<relay pid>.json` | lishuyu，0644 | 让 `ListAgents` 把 relay 显示为 `dsh-agent` 的 peer 记录；退出时删除，带 `"dshBridge": true` |

ACL 只多放行一个用户。没有向 `staff` 组或所有人开放任何东西，也不开 TCP 端口。

## 安全模型

- **谁能连接。** 两个 socket 在每次连接时都检查 `LOCAL_PEERCRED`：收件 socket 只接受 owner 的 uid；DSH socket 接受 owner 和 `dsh-runtime`。其他 uid 的连接会被关闭并记录。
- **发送者是谁。** 入站消息归属于注册记录里 pid 等于连接进程 pid（`LOCAL_PEERPID`）的会话，并核对进程启动时间，而不是消息里写的名字。消息自称的名字单独以 `claimedName` 携带，插件不会把它展示给模型。不是在线 Claude Code 会话的进程会被拒绝。
- **出站端点检查。** relay 把 token 写进会话的 socket 之前，先检查监听它的进程 pid 与记录一致、uid 是 owner。
- **双向都是不可信数据。** 发给会话的消息带 `from-mode="prompting"`（Claude Code 接受的最低声明）、第一行写明它由 DSH agent 转发而且不是用户，并放在 Claude Code 自己的 `<cross-session-message>` 框里，正文中的结束标签会被打散。Claude Code 把这类消息当作信息，绝不当作用户意图。发给 DSH 的消息以 `<agent_message trust="untrusted">` 的格式进入对话 Session，标签来自注册记录。
- **限制。** 每个方向文本最多 8000 个字符。向每个目标会话每分钟 6 条、总共 20 条；入站每个发送会话每分钟 6 条、总共 30 条；插件另加每小时 30 条。超限或过长的入站消息会被丢弃，发送者每分钟收到一条通知。
- **允许列表。** `--targets name1,name2`（或 `DSH_CC_BRIDGE_TARGETS`）限定 DSH 能给哪些会话发消息；默认是任何已列出的会话。插件另外把两个工具限定在微信对话 Session 内（`mainAgentOnly`）。
- **待确认消息** 保存在内存里（最多 100 条、一小时），直到插件确认。

## Claude Code 的 peer 协议（调研笔记）

对照 Claude Code 2.1.314 检查（会话记录里 `peerProtocol: 1`）。它没有公开文档；以下内容来自随附的二进制，并在真实会话与这个 relay 之间做了端到端验证。

- 开启消息功能的会话绑定 `/tmp/cc-socks/<pid>.sock`，并把它记为 `~/.claude/sessions/<pid>.json` 里的 `messagingSocketPath`。`claude --messaging-socket-path` 可显式指定。会话自己的调试日志写明了注入格式：`{"type":"auth","token":"…"}` 然后 `{"type":"user","message":{"role":"user","content":"…"}}`，以换行分隔。
- token 在 `~/.claude/sessions/<pid>.<socket 路径的 sha256>.key`（`{"peerToken": "<32 位十六进制>"}`，0600）。某个 socket 没有 key 时，Claude Code 的发送端在 macOS 上省略 auth 行，所以会话不需要任何 key 就能用原生工具给这个 relay 的收件 socket 发消息。
- peer 消息是 `{"msgV":1,"msg_id":"<uuid>","type":"user","message":{"role":"user","content":"<cross-session-message from=\"uds:<path>\" from-name=\"…\" from-mode=\"prompting\">\n…\n</cross-session-message>"},"priority":"next","from":"uds:<path>"}`。接收方按解析出的属性重建这个框，不一致就忽略，所以 relay 逐字节按 Claude Code 的方式构造。`from-mode` 取 `bypass` 或 `prompting`。
- 回复用同一协议发到 `from` 地址。接收方检查连接进程拥有它回复所用的 socket，所以 relay 用同一个进程承担两个角色。
- `ListAgents` 读 `~/.claude/sessions` 的记录：pid 存活且 `procStart` 等于 `LC_ALL=C TZ=UTC` 下 `ps -o lstart= -p <pid>` 的记录才算数。relay 写这样一条记录（kind 为 `daemon`），会话就能找到 `dsh-agent`；没有它时，`SendMessage` 到 `uds:<cc.sock 的路径>` 效果相同。
- Claude Code 的发送端在 macOS 上写完后保持连接 150 毫秒，因为接收方在 accept 时读取对端 pid；relay 自己的发送也这样做。

因为这是内部接口，Claude Code 更新可能改变它。relay 会记录每次拒绝及原因，`python3 -m unittest discover -s lsy/cc-bridge/tests` 覆盖了消息格式；Claude Code 更新后，先各方向发一条消息（RUNBOOK 的 “Verify the Claude Code bridge”）再依赖它。

## 面向 DSH 的协议

`dsh.sock` 上以换行分隔的 JSON。请求带 `id`，得到一条同 `id` 的响应。

| 请求 | 响应 |
|---|---|
| `{"op":"hello"}` | `{"ok":true,"version","name","maxText","targets","pending"}`；先推送所有未确认的入站消息 |
| `{"op":"list"}` | `{"ok":true,"sessions":[{name,pid,cwd,status,kind,version,updatedAt,tmux,…}]}`（不含 socket 路径和 token） |
| `{"op":"send","to":"<名字或 pid>","text":"…"}` | `{"ok":true,"to":{…},"msg_id"}` 或 `{"ok":false,"error"}` |
| `{"op":"ack","ids":["…"]}` | `{"ok":true,"pending"}` |
| `{"op":"stats"}` | 计数器 |

推送事件：`{"event":"message","id","at","from":{name,pid,cwd,…},"text","claimedName"}` 和 `{"event":"status","pid","action","status","reason"}`（Claude Code 的回执，例如消息被扣留等待用户确认）。

不经插件时：`printf '{"id":1,"op":"list"}\n' | sudo -n -u dsh-runtime nc -U /Users/Shared/dsh-cc-bridge/dsh.sock`。

## 安装、运维、移除

```sh
lsy/cc-bridge/install.sh             # as the owner: copy relay.py, write the plist, load the agent
launchctl print gui/$(id -u)/app.lishuyu.dsh-cc-bridge | grep -E 'state|pid'
tail -f ~/.local/state/dsh-cc-bridge/relay.log
lsy/cc-bridge/install.sh --uninstall # stop and remove the agent, the plist, and the installed copy
```

临时停止：`launchctl bootout gui/$(id -u)/app.lishuyu.dsh-cc-bridge`。期间插件持续重连，工具返回 “not connected”。要关掉 agent 一侧，在 `lsy-cc-bridge` 行设 `enabled: false`。

选项（命令行参数，列出环境变量的以环境变量为准）：`--name`（`ListAgents` 里的 peer 名，默认 `dsh-agent`）、`--no-register`（不写 peer 记录）、`--targets` / `DSH_CC_BRIDGE_TARGETS`、`--dsh-user`（默认 `dsh-runtime`；留空则 DSH socket 只对 owner 开放）、`--max-text`、`--verbose`、`--state-dir`、`--sessions-dir`、`--dsh-dir`。

## 测试

```sh
python3 -m unittest discover -s lsy/cc-bridge/tests      # real unix sockets in a temp dir, Python 3.9+ (the Mac's /usr/bin/python3 is 3.9)
pnpm exec vitest run packages/lsy/lsy-cc-bridge          # the plugin against a fake relay
```
