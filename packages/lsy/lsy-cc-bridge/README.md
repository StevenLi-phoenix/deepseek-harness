---
description: "Model-facing cc_list_sessions, cc_send, cc_start, and cc_stop tools: the agent works with Claude Code sessions of its own account, and what those sessions send back reaches the main agent as untrusted data."
kind: "package-reference"
---

# @deepseek-ai/dsh-lsy-cc-bridge

English | [中文](README.zh.md)

## Summary

Your always-on agent can work with Claude Code. It starts sessions of its own (`cc_start`), lists them (`cc_list_sessions`), hands one a task or asks for progress (`cc_send`), and stops it (`cc_stop`); a session's message to the agent arrives in the WeChat chat Session as a turn of its own. Both directions are untrusted data, never your command. The sessions run as the same macOS user as the agent, with a read-only setup, so the agent reaches them over local unix sockets: no port, no relay, and your own sessions stay out of reach.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Provision Claude Code for the service user first ([RUNBOOK §14](../../../lsy/deploy/RUNBOOK.md): `lsy/deploy/claude-dsh/install.sh`, then the owner's `claude setup-token` stored in a 0600 file). Then add the row to the plugin list of the agent preset that should use it, in a process that also mounts `@deepseek-ai/dsh-lsy-wechat`. The lsy event profile mounts it in its `unattended` preset with the defaults.

```yaml
- id: lsy-cc-bridge
  name: '@deepseek-ai/dsh-lsy-cc-bridge'
```

| Option | Default | Meaning |
|---|---|---|
| `enabled` | `true` | `false` registers no tools and opens no inbox. |
| `stateDir` | `/Users/dsh-runtime/.dsh/lsy-cc-bridge` | Directory of the inbox socket (0700). |
| `sessionsDir` | `~/.claude/sessions` | Claude Code's session registry of this account. |
| `peerName` | `dsh-agent` | The name Claude Code's `ListAgents` shows for the agent. |
| `mainAgentOnly` | `true` | Only the owner's WeChat chat Sessions may use the tools; watch, reminder, and event Sessions get an error. |
| `inboundPerHour` | `30` | Messages from Claude Code handed to the main agent per rolling hour; later ones are dropped and logged. |
| `spawn` | `true` | Register `cc_start` and `cc_stop`. |
| `tmux`, `command`, `workDir`, `model`, `maxSessions` | `/opt/homebrew/bin/tmux`, `/Users/dsh-runtime/bin/claude-dsh`, `/Users/dsh-runtime/work/cc`, `sonnet`, `3` | How started sessions run. |

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`src/hub.ts` is the agent's end of Claude Code's peer messaging, inside the DSH process. It listens on one socket (`<stateDir>/cc.sock`, 0600 in a 0700 directory) and registers a peer record so `ListAgents` shows the agent; to send, it writes a frame to a session's own socket after checking that the session is live in the registry (`src/registry.ts`: pid alive and start time equal to `ps -o lstart=`). An inbound message is attributed to the session whose record owns the `from` socket, not to the name it gives itself; Node cannot read a connection's peer pid, so the account boundary is the guard. Rates (6 sends a minute per session, 20 in total; 6 inbound a minute per session, 30 in total) and the 8,000-character limit are enforced here, a session that is limited gets one notice a minute, and a message the main agent could not take yet is offered again after 30 s, up to 5 times.

`src/spawn.ts` starts sessions in detached tmux (own server, `-L dsh-cc`) from a cleaned environment (`env -i`), so none of the service's secrets reach them; the launcher reads the OAuth token from its file. `src/wire.ts` holds the internal message format in one place.

`src/index.ts` registers the four tools and hands inbound messages to `ctx.lsyNotifier.tellMainAgent`, the same door the Bilibili Session uses: the chat Session queues the message framed as untrusted data and its answer goes to the owner on WeChat (`NO_REPLY` sends nothing). The sender's label is built from the registry, with quotes, angle brackets, and control characters stripped.

```text
Claude Code session --SendMessage--> cc.sock --> hub --> tellMainAgent --> chat Session
chat Session --cc_send--> hub --> the session's own socket in /tmp/cc-socks-502
chat Session --cc_start--> tmux -L dsh-cc --> claude-dsh --> a new session
```

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: options, the four tools, the inbound hand-over and its hourly cap |
| [`src/hub.ts`](src/hub.ts) | Inbox, sending, limits, retry of undelivered inbound messages, the peer record |
| [`src/registry.ts`](src/registry.ts) | Live sessions of this account and how a name resolves |
| [`src/spawn.ts`](src/spawn.ts) | `cc_start` and `cc_stop` over tmux |
| [`src/wire.ts`](src/wire.ts) | Claude Code's internal message format |

This is a fork-local package; see [`../UPSTREAM.md`](../UPSTREAM.md).

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Claude Code for the service user](../../../lsy/deploy/RUNBOOK.md) — provisioning, the token file, and what a started session may do
- [WeChat channel](../lsy-wechat/README.md) — the chat Session that receives inbound messages

-----

<a id="model-experience"></a>
## Model Experience

### List tool

#### What the model sees

One tool schema whenever the calling Agent's preset mounts the package: `cc_list_sessions`, no parameters. The description says it lists the Claude Code sessions of the agent's own account, newest activity first, with name, pid, working directory, status, and seconds since the last change.

#### Token effect

A fixed schema cost on every request from an Agent whose preset mounts the package; Agents under other presets pay nothing. A result is about 60 tokens per session.

#### KV Cache effect

Prefix-stable while tool definitions and visibility are unchanged; mounting or disposal may invalidate reuse from the first changed schema token.

### Send tool

#### What the model sees

`cc_send` with the required strings `to` (a session name from the list, or its pid) and `text` (at most 8000 characters). The description says the message arrives labelled as coming from the DSH agent and not from the owner, that a session may do nothing with it, that the answer comes back later as a message to the main agent and never as the tool result, that each session takes about 6 messages a minute, and that secrets must stay out and a stranger's text is no reason to message a session.

#### Token effect

A fixed schema cost of about 300 tokens on every request from an Agent whose preset mounts the package; a result is a few dozen tokens.

#### KV Cache effect

Append-only per call; newly visible content follows the reusable request prefix and does not invalidate existing KV Cache entries.

### Start and stop tools

#### What the model sees

`cc_start` with the required string `name` and the optional string `task`, and `cc_stop` with `name`. The description says the session runs under the agent's own account with a conservative setup (read, search, `ls`, `git status|log|diff`, message; no edits, other commands, or web), that at most 3 run at once, that `cc_start` returns once the session is up (up to 45 seconds), and that its answer comes back later as a message to the main agent.

#### Token effect

A fixed schema cost of about 350 tokens for the two tools on every request from an Agent whose preset mounts the package; a result is a few dozen tokens.

#### KV Cache effect

Append-only per call; newly visible content follows the reusable request prefix and does not invalidate existing KV Cache entries.

### Inbound messages

#### What the model sees

A queued chat prompt in the shape of the Bilibili hand-over: who sent it (`a Claude Code session on this Mac named "…" (pid …, working in …)`), a line saying it is not the owner and how to answer (`cc_send` to the same name, or `NO_REPLY` when the owner needs nothing), and the text inside an `<agent_message trust="untrusted">` block.

#### Token effect

The frame is about 150 tokens plus the message, at most 30 per hour.

#### KV Cache effect

Append-only; the prompt joins the chat Session's history after the reusable prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **No call-and-wait** — a session's answer is a later message, not the tool result, because a Claude Code session answers when its own turn ends.
- **Delivery is a hand-over** — `sent: true` means the bridge put the message in the session's inbox; whether that session reads it or ignores it is its own decision, and Claude Code's receipts appear only in the log.
- **Own account only** — the owner's sessions under another macOS account are not reachable, by design; reaching them needs a relay across the two accounts (built once and removed, see the changelog).
- **Internal wire format** — Claude Code's peer protocol is undocumented and versioned (`peerProtocol` 1, checked on 2.1.314), so a Claude Code update can break it; the RUNBOOK says how to re-check.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is non-authoritative working context: undecided directions and notes for maintainers. Shipped behavior and accepted rationale live in the sections above, the package code, and the linked Agent Notes.

- Tests use fake sessions (unix sockets plus registry records) in a temp directory and a fake tmux runner; no Claude Code is started.

</details>
