---
description: "Model-facing cc_list_sessions and cc_send tools: the agent talks to the owner's Claude Code sessions on the same Mac through a local relay, and what those sessions send back reaches the main agent as untrusted data."
kind: "package-reference"
---

# @deepseek-ai/dsh-lsy-cc-bridge

English | [中文](README.zh.md)

## Summary

Your always-on agent and the Claude Code sessions you run on the same Mac can now talk to each other. The agent lists running sessions (`cc_list_sessions`) and hands one a task or asks for progress (`cc_send`); a session's message to the agent arrives in the WeChat chat Session as a turn of its own. Both directions are untrusted data, never your command. A small relay in your account ([`lsy/cc-bridge`](../../../lsy/cc-bridge/README.md)) carries messages over local unix sockets; no port is opened.

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

Run the relay as the owner first ([`lsy/cc-bridge/install.sh`](../../../lsy/cc-bridge/install.sh)), then add the row to the plugin list of the agent preset that should reach Claude Code, in a process that also mounts `@deepseek-ai/dsh-lsy-wechat`. The lsy event profile mounts it in its `unattended` preset.

```yaml
- id: lsy-cc-bridge
  name: '@deepseek-ai/dsh-lsy-cc-bridge'
  config:
    socketPath: /Users/Shared/dsh-cc-bridge/dsh.sock
```

| Option | Default | Meaning |
|---|---|---|
| `enabled` | `true` | `false` registers no tools and opens no connection. |
| `socketPath` | `/Users/Shared/dsh-cc-bridge/dsh.sock` | The relay's DSH-facing unix socket. |
| `mainAgentOnly` | `true` | Only the owner's WeChat chat Sessions may list and message Claude Code sessions; watch, reminder, and event Sessions get an error. |
| `inboundPerHour` | `30` | Messages from Claude Code handed to the main agent per rolling hour; later ones are dropped and logged. |
| `requestTimeoutMs` | `10000` | Longest wait for the relay to answer. |

Without the relay the tools answer with an error and the plugin reconnects with backoff (1 s up to 30 s), so starting the relay later needs no restart here.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`src/client.ts` holds one long-lived connection to the relay: JSON lines, a request id per call, a hello on connect, and reconnect with backoff. The relay pushes `message` events (what a session sent) and `status` events (Claude Code's receipts, such as held or dropped). A message is acknowledged once `onMessage` took it; one that could not be taken is offered again after 30 s, up to 5 times, and the relay replays whatever was never acknowledged on the next connect, so a restart of either side loses nothing within the relay's one-hour window.

`src/index.ts` registers the two tools and wires inbound messages to `ctx.lsyNotifier.tellMainAgent`, the same door the Bilibili Session uses: the chat Session queues the message framed as untrusted data, and its answer goes to the owner on WeChat (`NO_REPLY` sends nothing). The sender's label comes from the relay, which found the session by the process that connected, not from the message; quotes, angle brackets, and control characters in a session name are stripped before it enters the frame. A message that arrives while the chat channel is not running stays unacknowledged and is offered again.

```text
Claude Code session --SendMessage--> relay (owner) --> this plugin --> tellMainAgent --> chat Session
chat Session --cc_send--> this plugin --> relay (owner) --> the session's own inbox socket
```

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: options, the two tools, the inbound hand-over and its hourly cap |
| [`src/client.ts`](src/client.ts) | Relay connection: requests, reconnect, acknowledgement, retry, duplicate suppression |

This is a fork-local package; see [`../UPSTREAM.md`](../UPSTREAM.md).

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Relay and its security model](../../../lsy/cc-bridge/README.md) — sockets, permissions, the Claude Code message format, rate limits
- [WeChat channel](../lsy-wechat/README.md) — the chat Session that receives inbound messages

-----

<a id="model-experience"></a>
## Model Experience

### List tool

#### What the model sees

One tool schema whenever the calling Agent's preset mounts the package: `cc_list_sessions`, no parameters. The description says it lists the owner's running Claude Code sessions on this Mac, newest activity first, with name, pid, working directory, status, and seconds since the last change.

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
- **Delivery is a hand-over** — `sent: true` means the relay put the message in the session's inbox; whether that session reads it, holds it for its user, or ignores it is its own decision, and Claude Code's receipts appear only in the log.
- **Local only** — sessions on other machines are not listed; Claude Code's peer protocol is internal and versioned, so a Claude Code update can break the relay (see its README).

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is non-authoritative working context: undecided directions and notes for maintainers. Shipped behavior and accepted rationale live in the sections above, the package code, and the linked Agent Notes.

- Tests run against a fake relay on a temp unix socket (`tests/fake-relay.ts`); the relay's own tests live in `lsy/cc-bridge/tests`.

</details>
