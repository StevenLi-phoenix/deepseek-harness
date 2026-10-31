# cc-bridge — the relay between the DSH agent and Claude Code sessions

English | [中文](README.zh.md)

Lets the event agent (`dsh-runtime` account) and the owner's Claude Code sessions (`lishuyu` account) on the same Mac talk to each other: the agent lists sessions and messages one (`cc_list_sessions`, `cc_send`, package [`lsy-cc-bridge`](../../packages/lsy/lsy-cc-bridge/README.md)), and a session messages the agent with Claude Code's own `SendMessage` tool, which reaches the WeChat chat Session as untrusted data.

## Why a relay

Claude Code sessions listen on unix sockets in `/tmp/cc-socks` (directory 0700, sockets 0600, owner `lishuyu`) and authenticate senders with per-session token files in `~/.claude/sessions`. `dsh-runtime` cannot open any of that, and those permissions stay as they are. The relay runs as `lishuyu`, speaks Claude Code's peer protocol on one side and a small JSON-lines protocol on the other, and is the only process that crosses the account boundary.

```text
Claude Code session --SendMessage--> inbox.sock (0600, owner only) --+
                                                                      relay.py (LaunchAgent, lishuyu)
DSH plugin (dsh-runtime) <--JSON lines--> dsh.sock (0600 + ACL) -----+
                                                                      |
relay --peer protocol--> /tmp/cc-socks/<pid>.sock (the session's own inbox)
```

## What is where

| Path | Owner / mode | Role |
|---|---|---|
| `~/.local/state/dsh-cc-bridge/` | lishuyu, 0700 | State directory: `relay.log` (rotated, 1 MB x 5), `launchd.err` |
| `~/.local/state/dsh-cc-bridge/cc.sock` | lishuyu, 0600 | Inbox that Claude Code sessions send to (`uds:/Users/lishuyu/.local/state/dsh-cc-bridge/cc.sock`) |
| `/Users/Shared/dsh-cc-bridge/` | lishuyu, 0700 + ACL `dsh-runtime allow search` | DSH-facing directory (`/Users/lishuyu` is closed to `dsh-runtime`, so the socket lives outside it) |
| `/Users/Shared/dsh-cc-bridge/dsh.sock` | lishuyu, 0600 + ACL `dsh-runtime allow read,write` | The DSH plugin connects here |
| `~/.local/libexec/dsh-cc-bridge/relay.py` | lishuyu, 0755 | Installed copy (`install.sh` refreshes it) |
| `~/Library/LaunchAgents/app.lishuyu.dsh-cc-bridge.plist` | lishuyu | LaunchAgent `gui/501/app.lishuyu.dsh-cc-bridge`, RunAtLoad + KeepAlive |
| `~/.claude/sessions/<relay pid>.json` | lishuyu, 0644 | Peer record so `ListAgents` shows the relay as `dsh-agent`; removed on exit, `"dshBridge": true` |

The ACL gives exactly one extra user access. Nothing is opened to the `staff` group or the world, and no TCP port is opened.

## Security model

- **Who may connect.** Both sockets check `LOCAL_PEERCRED` on every connection: the inbox accepts only the owner's uid; the DSH socket accepts the owner and `dsh-runtime`. A connection from any other uid is closed and logged.
- **Who a sender is.** An inbound message is attributed to the session whose registry record has the connecting process's pid (`LOCAL_PEERPID`), checked against the process start time, never to the name inside the message. The name the message claims is carried separately as `claimedName` and the plugin does not show it to the model. A process that is not a live Claude Code session is refused.
- **Outbound endpoint check.** Before the relay writes a token to a session's socket it checks that the process serving it has the recorded pid and the owner's uid.
- **Untrusted data both ways.** A message to a session carries `from-mode="prompting"` (the lowest claim Claude Code accepts), a first line saying it is relayed from the DSH agent and is not the user, and Claude Code's own `<cross-session-message>` frame, in which a closing tag inside the body is defanged. Claude Code treats such messages as information, never as the user's intent. A message to DSH reaches the chat Session framed as `<agent_message trust="untrusted">`, with the label built from the registry.
- **Limits.** Text is at most 8000 characters each way. Per target session 6 sends a minute and 20 in total; inbound 6 a minute per sending session and 30 in total; the plugin adds 30 an hour. Over-limit or oversized inbound messages are dropped and the sender gets one notice a minute.
- **Allow list.** `--targets name1,name2` (or `DSH_CC_BRIDGE_TARGETS`) limits which sessions DSH may message; the default is any listed session. The plugin additionally restricts both tools to the WeChat chat Sessions (`mainAgentOnly`).
- **Pending messages** wait in memory (100 at most, one hour) until the plugin acknowledges them.

## Claude Code's peer protocol (research notes)

Checked against Claude Code 2.1.314 (session records report `peerProtocol: 1`). It is not documented publicly; what follows comes from the shipped binary and was confirmed end to end between a real session and this relay.

- A session with messaging on binds `/tmp/cc-socks/<pid>.sock` and records it as `messagingSocketPath` in `~/.claude/sessions/<pid>.json`. `claude --messaging-socket-path` sets it explicitly. The session's debug log documents the injection format: `{"type":"auth","token":"…"}` then `{"type":"user","message":{"role":"user","content":"…"}}`, newline-delimited.
- The token is in `~/.claude/sessions/<pid>.<sha256 of the socket path>.key` (`{"peerToken": "<32 hex>"}`, 0600). When no key exists for a socket, Claude Code's sender omits the auth line on macOS, which is why a session can message this relay's inbox with the native tool without any key.
- A peer message is `{"msgV":1,"msg_id":"<uuid>","type":"user","message":{"role":"user","content":"<cross-session-message from=\"uds:<path>\" from-name=\"…\" from-mode=\"prompting\">\n…\n</cross-session-message>"},"priority":"next","from":"uds:<path>"}`. The receiver rebuilds the frame from the parsed attributes and ignores the message if it differs, so the relay builds it byte for byte as Claude Code does. `from-mode` is `bypass` or `prompting`.
- Replies go to the `from` address with the same protocol. Receivers check that the connecting process owns the socket it answered on, so the relay uses one process for both roles.
- The `ListAgents` listing reads the records in `~/.claude/sessions`: a record counts when its pid is alive and `procStart` equals `ps -o lstart= -p <pid>` under `LC_ALL=C TZ=UTC`. The relay writes such a record (kind `daemon`) so sessions find it as `dsh-agent`; without it, `SendMessage` to `uds:<path of cc.sock>` works the same.
- Claude Code senders keep the connection open for 150 ms after writing on macOS because the receiver reads the peer pid at accept time; the relay's own sends do the same.

Because this is an internal interface, a Claude Code update can change it. The relay logs every refusal with its reason, and `python3 -m unittest discover -s lsy/cc-bridge/tests` covers the frame shape; after a Claude Code update, send one message each way (RUNBOOK step "Verify the Claude Code bridge") before relying on it.

## DSH-facing protocol

Newline-delimited JSON on `dsh.sock`. Requests carry an `id` and get one response with the same `id`.

| Request | Response |
|---|---|
| `{"op":"hello"}` | `{"ok":true,"version","name","maxText","targets","pending"}`; every unacknowledged inbound message is pushed first |
| `{"op":"list"}` | `{"ok":true,"sessions":[{name,pid,cwd,status,kind,version,updatedAt,tmux,…}]}` (no socket paths or tokens) |
| `{"op":"send","to":"<name or pid>","text":"…"}` | `{"ok":true,"to":{…},"msg_id"}` or `{"ok":false,"error"}` |
| `{"op":"ack","ids":["…"]}` | `{"ok":true,"pending"}` |
| `{"op":"stats"}` | counters |

Pushed events: `{"event":"message","id","at","from":{name,pid,cwd,…},"text","claimedName"}` and `{"event":"status","pid","action","status","reason"}` (Claude Code's receipts, e.g. a message held for the user's approval).

Without the plugin: `printf '{"id":1,"op":"list"}\n' | sudo -n -u dsh-runtime nc -U /Users/Shared/dsh-cc-bridge/dsh.sock`.

## Install, operate, remove

```sh
lsy/cc-bridge/install.sh             # as the owner: copy relay.py, write the plist, load the agent
launchctl print gui/$(id -u)/app.lishuyu.dsh-cc-bridge | grep -E 'state|pid'
tail -f ~/.local/state/dsh-cc-bridge/relay.log
lsy/cc-bridge/install.sh --uninstall # stop and remove the agent, the plist, and the installed copy
```

Stop temporarily: `launchctl bootout gui/$(id -u)/app.lishuyu.dsh-cc-bridge`. The plugin keeps reconnecting and the tools answer "not connected" meanwhile. Switch the agent side off with `enabled: false` in the `lsy-cc-bridge` row.

Options (flags, or the environment variable where listed): `--name` (peer name in `ListAgents`, default `dsh-agent`), `--no-register` (no peer record), `--targets` / `DSH_CC_BRIDGE_TARGETS`, `--dsh-user` (default `dsh-runtime`; empty keeps the DSH socket owner-only), `--max-text`, `--verbose`, `--state-dir`, `--sessions-dir`, `--dsh-dir`.

## Tests

```sh
python3 -m unittest discover -s lsy/cc-bridge/tests      # real unix sockets in a temp dir, Python 3.9+ (the Mac's /usr/bin/python3 is 3.9)
pnpm exec vitest run packages/lsy/lsy-cc-bridge          # the plugin against a fake relay
```
