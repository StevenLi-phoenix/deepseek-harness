# warn

Hand one warning to the owner's DSH from any program on any host. DSH's agent reads it, checks it with read-only commands, and answers `NO_REPLY` unless the owner has something to do (then three Chinese sentences on WeChat). `warn` only delivers: one file, Python standard library only (3.8+), so a host needs nothing installed.

```sh
warn --source n8 --severity error "qwen38-llama.service failed"
journalctl -u foo -n 40 | warn --source phm.foo --severity warn "foo restarted 3 times" --text -
warn --curl        # print the curl one-liner for hosts without Python
```

| Option | Meaning |
|---|---|
| `title` | One line (300 characters) |
| `--source` | Who warns: a host or program, dotted lowercase words (`n8`, `phm.nginx`); kind becomes `warn.<source>.<severity>` |
| `--severity` | `info`, `warn` (default), `error`, `crit` |
| `--key` | Dedupe key; default `<source>-<sha1(title)[:10]>-<UTC yyyymmddhh>`, so one text dedupes within the hour |
| `--subject`, `--url`, `--text` | Optional; `--text -` reads stdin (8000 characters, untrusted data to DSH) |
| `--strict` | Exit 1 when not delivered, 2 on a missing token; the default exit code is 0 so a hook never breaks what it watches |
| `--print` | Show the event JSON without sending |

**Token**: `~/.config/warn/token`, mode 0600, holds the value of `LSY_INGEST_TOKEN_WARN` from the DSH host. Write it through a pipe, never into a chat or a command line.
**Endpoint**: `https://dsh.tailc2559b.ts.net/hooks/lsy` (`$WARN_URL` overrides); timeout 5 s (`$WARN_TIMEOUT`).
**Failure**: a timeout, 5xx, 429, or network error saves the event under `~/.local/state/warn/spool/` and the next run replays it first (at most 20 per run, 100 kept, dropped after 7 days); a 4xx (bad token, bad field) is not retried. Every step is logged to `~/.local/state/warn/warn.log` (256 KB, one rotation), never the token.

```sh
curl -fsS -m 5 -H "Authorization: Bearer $(cat ~/.config/warn/token)" -H 'Content-Type: application/json' \
  -d '{"kind":"warn.n8.error","key":"n8-llama-20261031","subject":"n8","title":"llama failed"}' \
  https://dsh.tailc2559b.ts.net/hooks/lsy
```

Also here: `systemd/` (`warn@.service` + `warn-unit-failed`, for `OnFailure=warn@%n.service` on Linux hosts) and `docker_health_watch.py` (follows `docker events`, warns when a container turns unhealthy; the laptop runs it as a scheduled task).

Tests: `python3 -m unittest discover -s lsy/tools/warn` (starts a fake endpoint on a local port). Procedure for the DSH side, hosts, and sources: [RUNBOOK §17](../../deploy/RUNBOOK.md).
