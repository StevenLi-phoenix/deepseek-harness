# Event service runbook (Mac mini)

Runs the fork as a second dsh instance — the event service — under a dedicated, non-admin macOS user `dsh-runtime`, on `127.0.0.1:3081`, started by a LaunchDaemon. The interactive instance (`app.lishuyu.dsh`, `~/.dsh`, port 3080) is untouched.

You do this once. After that you talk to the agent on WeChat: it creates its own watches (`watch_create`) and reminders (`schedule_create`), and every event result, reminder result, and chat reply comes back to WeChat. No YAML to write.

Every `sudo` line is meant to be run by hand, one at a time. The agent runs without approval prompts (`danger-full-access`), so the account boundary below is the isolation: it must hold before the first event arrives.

## Layout

| Path | Owner | Contents |
|---|---|---|
| `/Users/Shared/lsy-dsh/<sha>/` | lishuyu, 755 | Installed build (≈1.6 GB) plus `lsy/` (event bundle, profile template, `setup-profile.sh`, `wechat-login.mjs`); `dsh-runtime` can read, not write |
| `/Users/Shared/lsy-dsh/current` | lishuyu | Symlink to the active build |
| `/Users/dsh-runtime/.dsh/` | dsh-runtime, 700 | `DSH_HOME`: profile, Sessions, storages (watches, subscriptions, cursors), `.env` secrets |
| `/Users/dsh-runtime/.dsh/lsy-wechat/account.json` | dsh-runtime, 600 | WeChat bot binding written by `wechat-login.mjs` |
| `/Users/dsh-runtime/me/` | dsh-runtime | Clone of `StevenLi-phoenix/me` (private), the WeChat chat Session's workspace; WeChat attachments land in its `.wechat-inbox/` (700, files 600, ignored by its own `.gitignore`) |
| `/Users/dsh-runtime/work/` | dsh-runtime | Workspace of watch-started Sessions |
| `/Users/dsh-runtime/logs/` | dsh-runtime, 755 | `stdout.log`, `stderr.log`; outside the 700 `Library`, so the operator (group `staff`) reads them without sudo, first-login URL included |
| `/Library/LaunchDaemons/app.lishuyu.dsh-events.plist` | root:wheel 644 | Service definition (from `app.lishuyu.dsh-events.plist`) |

## 0. Close `/Volumes/MiniSSD`

`diskutil info /Volumes/MiniSSD` reports `Owners: Disabled` (mounted `noowners`): every local user acts as the owner of every file there, so `dsh-runtime` could read and write kaorou data, backups, and other projects. Turn ownership on and give the volume back to `lishuyu`.

Do it while kaorou has no burn or upload in flight (check its panel): stopping the daemon kills in-flight `ffmpeg`. globalawareness writes to the volume too (`/Volumes/MiniSSD/globalAwarness/data`), so it stops and starts with kaorou.

```sh
launchctl bootout gui/$(id -u)/app.lishuyu.kaorou.daemon
launchctl bootout gui/$(id -u)/app.lishuyu.kaorou.api
launchctl bootout gui/$(id -u)/app.lishuyu.globalawareness
sudo diskutil enableOwnership /Volumes/MiniSSD
find /Volumes/MiniSSD ! -user lishuyu -print 2>/dev/null | head    # expect only /Volumes/MiniSSD
sudo chown lishuyu:staff /Volumes/MiniSSD
chmod 700 /Volumes/MiniSSD
launchctl bootstrap gui/$(id -u) /Users/lishuyu/Library/LaunchAgents/app.lishuyu.kaorou.api.plist
launchctl bootstrap gui/$(id -u) /Users/lishuyu/Library/LaunchAgents/app.lishuyu.kaorou.daemon.plist
launchctl bootstrap gui/$(id -u) /Users/lishuyu/Library/LaunchAgents/app.lishuyu.globalawareness.plist
```

- With ownership on, files keep the uid of the user who wrote them: on 2026-10-21 all 273,037 entries were already `501:20` and only the volume root showed `root:wheel`, so the `chown` touches the root alone. If the `find` lists anything else, `sudo chown -R lishuyu:staff` those paths; leave `.fseventsd`, `.Spotlight-V100`, and `.Trashes` to the system.
- `chmod 700` closes the volume to every other local account. Guest SMB clients of the `MiniSSD` share lose access; logging in to the share as `lishuyu` keeps working.
- On 2026-10-22 each `bootstrap` printed `Bootstrap failed: 5: Input/output error` although the service did start; trust `launchctl print gui/$(id -u)/<label>` (`state = running`) over that message.
- Check: `diskutil info /Volumes/MiniSSD | grep Owners` → `Enabled`; `ls -ld /Volumes/MiniSSD` → `drwx------  lishuyu  staff`; kaorou panel shows the daemon back; globalawareness listens on `127.0.0.1:8790`.

## 1. Close the home directory

`/Users/lishuyu` is `drwxr-x---` with group `staff`, and every local user is in `staff`, so a new account could read `~/.env`, `~/.ssh`, and the dsh credentials. No process runs as another user that needs to read it (checked 2026-10-21; guest SMB already cannot traverse `750`).

```sh
chmod 700 /Users/lishuyu
```

## 2. Create the service user

Non-admin, hidden, random password nobody knows; SSH is limited to admins (`com.apple.access_ssh` nests the admin group), so this account cannot log in remotely.

```sh
sudo sysadminctl -addUser dsh-runtime -fullName "dsh runtime" -shell /bin/zsh -password "$(openssl rand -base64 32)" -home /Users/dsh-runtime
sudo createhomedir -c -u dsh-runtime
sudo dscl . create /Users/dsh-runtime IsHidden 1
```

## 3. Install the build (as lishuyu, no sudo)

```sh
mkdir -p /Users/Shared/lsy-dsh && chmod 755 /Users/Shared/lsy-dsh
cd /Volumes/MiniSSD/deepseek-harness && lsy/deploy/upgrade.sh    # builds, tests, packs, installs, points current at it
```

`upgrade.sh` refuses a dirty checkout and takes a few minutes. It ends by printing the commands of step 4 and step 7.

## 4. Prepare the service home

```sh
sudo -u dsh-runtime mkdir -p /Users/dsh-runtime/.dsh /Users/dsh-runtime/work /Users/dsh-runtime/logs
sudo -u dsh-runtime chmod 700 /Users/dsh-runtime/.dsh
sudo -u dsh-runtime /Users/Shared/lsy-dsh/current/lsy/deploy/setup-profile.sh /Users/dsh-runtime/.dsh /Users/Shared/lsy-dsh/current
```

## 5. Secrets (typed in your terminal, never pasted into a chat)

Two keys, both for this service only: an OpenRouter key (models) and a classic GitHub token with `repo`, `workflow`, and `read:org` (sensor, notifications, `git push`, `gh`). Leave out `admin:public_key`: it can add SSH keys to the account, which outlive revoking the token. `repo` already covers `/notifications`, so the same token fills both GitHub names. Every command below reads input with echo off and prints only names and modes.

```sh
cd / && sudo -u dsh-runtime /bin/zsh -fc 'umask 077; f=/Users/dsh-runtime/.dsh/.env; read -rs "v?OpenRouter key (hidden): "; print; [[ -n $v ]] || exit 1; { print -r -- "OPENROUTER_API_KEY=$v"; /usr/bin/grep -v -e "^OPENROUTER_API_KEY=" -e "^DEEPSEEK_API_KEY=" $f 2>/dev/null; } >| $f.new && /bin/mv -f $f.new $f && /bin/ls -l $f && /usr/bin/cut -d= -f1 $f'
cd / && sudo -u dsh-runtime /bin/zsh -fc 'umask 077; f=/Users/dsh-runtime/.dsh/.env; read -rs "v?GitHub classic token (hidden): "; print; [[ -n $v ]] && print -r -- "LSY_GITHUB_TOKEN=$v" >> $f && print -r -- "LSY_GITHUB_NOTIFICATIONS_TOKEN=$v" >> $f; /bin/ls -l $f; /usr/bin/cut -d= -f1 $f'
```

Models start on OpenRouter: the owner's profile patch is seeded (once, by `setup-profile.sh`) with the `openrouter` route of `llm-pi-ai` keyed by `OPENROUTER_API_KEY` and the default model `deepseek/deepseek-v4.1-flash`; change either from the Web UI afterwards. The home patch (`lsy/deploy/home.cordis.patch.yml`) holds only what the UI must not edit: the 365-day sign-in cookie and the disabled DeepSeek key onboarding. The UI refuses to save any entry a home patch sets, so never put UI settings there:

```sh
/bin/cat /Volumes/MiniSSD/deepseek-harness/lsy/deploy/home.cordis.patch.yml | sudo -u dsh-runtime /bin/zsh -fc 'umask 077; /bin/cat >| /Users/dsh-runtime/.dsh/cordis.patch.yml'
```

The harness strips every variable whose name contains `KEY`, `PASSWORD`, `SECRET`, or `TOKEN` from the agent's shell commands, so `git` never sees the `.env` token. Log `gh` in for the service user instead; `git push` and `gh pr` then authenticate through it:

```sh
cd / && sudo -u dsh-runtime /usr/bin/env HOME=/Users/dsh-runtime PATH=/opt/homebrew/bin:/usr/bin:/bin /bin/zsh -fc '/usr/bin/sed -n "s/^LSY_GITHUB_TOKEN=//p" ~/.dsh/.env | gh auth login --hostname github.com --git-protocol https --insecure-storage --with-token && gh auth setup-git --hostname github.com && git config --global user.name "dsh-events[bot]" && git config --global user.email "346633139+dsh-events[bot]@users.noreply.github.com" && gh auth status'
```

The agent runs as `dsh-runtime`, so it can read `.env` and `~/.config/gh/hosts.yml` (plain text: a daemon user has no unlocked keychain). Keep each key scoped so that a leak costs little.

The WeChat chat works in a clone of the owner's tracking repository (the event bundle sets `chat.workspacePath`):

```sh
cd / && sudo -u dsh-runtime /usr/bin/env HOME=/Users/dsh-runtime PATH=/opt/homebrew/bin:/usr/bin:/bin git clone https://github.com/StevenLi-phoenix/me.git /Users/dsh-runtime/me
```

Without the clone, `lsy-wechat` creates an empty directory there and the agent has no repository to commit to.

## 6. Bind WeChat

Scan a QR code with the phone's WeChat to bind a ClawBot to this service. The binding is written to `/Users/dsh-runtime/.dsh/lsy-wechat/account.json` (600); the token is never printed.

```sh
sudo -u dsh-runtime env DSH_HOME=/Users/dsh-runtime/.dsh /opt/homebrew/bin/node /Users/Shared/lsy-dsh/current/lsy/deploy/wechat-login.mjs
```

- If WeChat shows a number, type it into the terminal.
- WeChat lets a bot write to you only within about 24 hours of your last message to it, and only about 10 messages per message you send. Messages that do not fit wait in an outbox and arrive as a digest the next time you write anything. If you expect alerts, send the bot a word once a day.
- Re-binding later (for example after `bot token is stale` in the log) is the same command; the running service picks up the new file without a restart.

## 7. Start the service

```sh
sudo cp /Volumes/MiniSSD/deepseek-harness/lsy/deploy/app.lishuyu.dsh-events.plist /Library/LaunchDaemons/
sudo chown root:wheel /Library/LaunchDaemons/app.lishuyu.dsh-events.plist
sudo chmod 644 /Library/LaunchDaemons/app.lishuyu.dsh-events.plist
sudo launchctl bootstrap system /Library/LaunchDaemons/app.lishuyu.dsh-events.plist
```

## 8. Verify

```sh
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3081/               # 401 = up
tail -n 30 /Users/dsh-runtime/logs/stdout.log              # sensor, bus, and wechat lines
sudo -u dsh-runtime cat /Users/lishuyu/.env                                    # must fail: Permission denied
sudo -u dsh-runtime ls /Users/lishuyu/.ssh                                     # must fail: Permission denied
sudo -u dsh-runtime ls /Volumes/MiniSSD                                        # must fail: Permission denied
sudo -u dsh-runtime touch /Users/Shared/lsy-dsh/current/x                     # must fail: Permission denied
```

Then write to the bot on WeChat, e.g. `你好，你能做什么？`. The reply comes from the agent in a long-lived chat Session (`/new` starts a fresh one).

Logs written before the console logger loads (the first second) are not printed; storage under `/Users/dsh-runtime/.dsh/storages/lsy_*.json` shows watches, subscriptions, sensor cursors, and the WeChat outbox.

## 9. Tell the agent what to watch

Say it in WeChat; the agent sets it up with its tools and confirms:

- `盯一下 deepseek-ai/deepseek-harness 的 release 和 tag，有新的就告诉我` → a `notify` watch.
- `deepseek-ai/deepseek-harness 出新 release 时，读一下更新说明，看会不会影响我 fork 里的 packages/lsy，告诉我结论` → a `session` watch: each release starts an agent run, and its answer comes to WeChat.
- `我的 GitHub 通知有新的就推给我` → a notifications watch (needs `LSY_GITHUB_NOTIFICATIONS_TOKEN`).
- `每天早上 9 点看一下 kaorou 队列有没有卡住的任务，没问题就别打扰我` → a reminder; quiet runs answer `NO_REPLY` and send nothing.
- `列一下你现在在盯什么` / `把 xxx 那个删掉` → `watch_list` / `watch_delete`; reminders use `schedule_list` / `schedule_delete`.

## 10. Web access: take over `dsh.tailc2559b.ts.net`

The event service replaced the interactive instance on 2026-10-22: the existing Tailscale Service `svc:dsh` now proxies to port 3081 (the plist already trusts that name, and the profile's `webUrl` points there), and the old LaunchAgent is stopped and disabled, keeping its plist, `~/.dsh`, and the npm install for a rollback:

```sh
/Applications/Tailscale.app/Contents/MacOS/Tailscale serve --service=svc:dsh --https=443 http://127.0.0.1:3081
launchctl bootout gui/$(id -u)/app.lishuyu.dsh && launchctl disable gui/$(id -u)/app.lishuyu.dsh
```

Every restart prints a new first-login URL to stdout (`grep -o 'http://127.0.0.1:3081/?token=[^ ]*' /Users/dsh-runtime/logs/stdout.log | tail -1`); open it with the host replaced by `https://dsh.tailc2559b.ts.net`. The cookie it sets lasts 30 days. Roll back with `launchctl enable` and `launchctl bootstrap` of `~/Library/LaunchAgents/app.lishuyu.dsh.plist` and the serve line with port 3080.

## 11. GitHub webhooks through phm (optional)

Polling reports within a minute and spends the owner's shared REST quota on anything that is not a 304. A private GitHub App pushes repository events instead, in seconds and at no quota cost. GitHub cannot reach the mini, so deliveries go through the `github-relay` service of the API platform on phm (`StevenLi-phoenix/api`, `plugins/github-relay`), which forwards the untouched body and signature headers over the tailnet to `https://dsh.tailc2559b.ts.net/hooks/github`. The mini verifies the signature; phm holds no secret.

1. The webhook secret is `LSY_GITHUB_WEBHOOK_SECRET` in `/Users/dsh-runtime/.dsh/.env` (`openssl rand -hex 32`; restart after changing it). Export a copy for the GitHub form without printing it:
   ```sh
   umask 077; sudo -n -u dsh-runtime /usr/bin/sed -n 's/^LSY_GITHUB_WEBHOOK_SECRET=//p' /Users/dsh-runtime/.dsh/.env > ~/lsy-github-webhook-secret.txt
   ```
2. Publish the relay: merge the `github-relay` plugin into the API platform's `main`, then on phm add the Caddy route and reload:
   ```sh
   ssh phm "printf 'handle /github-relay/* {\n  reverse_proxy 127.0.0.1:18080\n}\n' > /etc/caddy/services-api/github-relay.caddy && caddy validate --config /etc/caddy/Caddyfile && systemctl reload caddy"
   ```
3. Register the App with the form prefilled (private, webhook to the relay, read-only permissions, the events below), paste the secret from `~/lsy-github-webhook-secret.txt` (`pbcopy < ~/lsy-github-webhook-secret.txt`), create it, and install it on the repositories to watch:
   `https://github.com/settings/apps/new?name=dsh-events&description=Webhooks%20for%20the%20lsy%20dsh%20event%20service&url=https://github.com/StevenLi-phoenix/deepseek-harness&public=false&webhook_active=true&webhook_url=https://api.lishuyu.app/github-relay/github&metadata=read&contents=read&issues=read&pull_requests=read&actions=read&events[]=push&events[]=create&events[]=release&events[]=pull_request&events[]=pull_request_review&events[]=issues&events[]=issue_comment&events[]=workflow_run`
4. Remove the exported copy: `trash ~/lsy-github-webhook-secret.txt`.
5. The App is `dsh-events`; its bot is `dsh-events[bot]` (user id 346633139). Generate a private key on the App page and pipe it to the service account without printing it, then trash the download:
   ```sh
   cat ~/dsh-events.*.private-key.pem | sudo -n -u dsh-runtime /bin/sh -c 'umask 077; cat > /Users/dsh-runtime/.dsh/github-app.private-key.pem'
   ```
   The service's git identity is the bot (step 5's `git config`), so the agent's commits carry the login the event bus suppresses (`suppress.actors`), whichever token pushes them.

Verify on the App's **Advanced** page: the `ping` delivery shows `202`, and `stdout.log` gains `lsy-github-sensor: webhook …` lines for later deliveries. A `401` means the secrets differ; `502` means phm could not reach the mini; `415` means the content type is not `application/json`. Watches still poll, so a missed delivery is caught within a minute.

## 12. Import memory (optional)

The agent remembers the owner in `/Users/dsh-runtime/.dsh/lsy-memory/memory.jsonl` (600): instructions and preferences reach every new Session in full, career and project entries by their opening words, identity entries only as a count, and the agent saves and corrects entries itself ([`lsy-memory`](../../packages/lsy/lsy-memory/README.md)). To start from a claude.ai memory export, pipe it to the importer as the service user; it keeps the export's dates, skips entries already present, and prints counts only:

```sh
sudo -n -u dsh-runtime /usr/bin/env DSH_HOME=/Users/dsh-runtime/.dsh /opt/homebrew/bin/node /Users/Shared/lsy-dsh/current/lsy/deploy/memory-import.mjs < ~/Downloads/memory.md
```

Add `--dry-run` to only count. The next Session sees the entries; no restart is needed.

## 13. QQ group observer (optional)

`lsy-qq` lets the agent lurk in QQ groups with a personal QQ account and learn from them: it records the groups you list, digests them daily, and the main agent reads them with `qq_groups`, `qq_digest`, `qq_recent`, and `qq_search`. It never speaks (sending is off) and is not a chat entrance. The QQ side is NapCat (OneBot v11), a container on colima on the operator's account, so the login session (which could sign the QQ account in) is out of the agent's reach: `dsh-runtime` connects only to `ws://127.0.0.1:3001` with an access token. The container publishes the port on 127.0.0.1 only and has no WebUI port.

Use a spare ("小号") account: NapCat is an unofficial client, and Tencent can restrict or sign out an account that uses one. Keep it read-only, log it in once on this Mac, and avoid logging in from other devices or places meanwhile. Add the account to each group by hand first (the observer sees only groups the account is a member of).

1. Install the runtime once (operator, no sudo): `brew install colima docker`, then `colima start --cpu 2 --memory 3 --disk 20 --vm-type vz`. To start it at login, `brew services start colima` (a LaunchAgent, `~/Library/LaunchAgents/sh.brew.colima.plist`; stop it with `brew services stop colima`). The VM disk lives in `~/.colima` on the internal disk.
2. Build and start the protocol end (operator): `lsy/deploy/napcat/napcat.sh build`, then `lsy/deploy/napcat/napcat.sh start`. `build` clones NapCat-Docker at a pinned commit, downloads `NapCat.Shell.zip` of a pinned release and refuses it unless its SHA-256 matches, and builds the image from them (Tencent's own Linux QQ package comes from `qqdl.gtimg.cn` during the build). `start` writes the OneBot config with a fresh access token generated by `openssl`, stores the token in `/Users/dsh-runtime/.dsh/.env` as `LSY_QQ_ONEBOT_TOKEN` (never printed; the old `.env` is copied to `.env.bak.<time>` first), and runs the container. Restart the dsh service afterwards (`sudo -n /bin/launchctl kickstart -k system/app.lishuyu.dsh-events`) so it reads the token.
3. Log the account in (you, with your phone): `lsy/deploy/napcat/napcat.sh qr /tmp/napcat-qr.png`, open the image, and scan it with the spare account's QQ. NapCat renews the code about every two minutes; `napcat.sh logs` shows the same code in the terminal. After the scan, restart with the account number so a restart logs in without a code: `lsy/deploy/napcat/napcat.sh start <QQ number>`.
4. Check `napcat.sh logs` for the login, then `grep 'lsy-qq' /Users/dsh-runtime/logs/stdout.log | tail`: `connected to the protocol end`, `logged in as <number>`, and one `not recording group <number> (<name>)` line for each group the account is in.
5. List the groups to record in the owner layer, `/Users/dsh-runtime/.dsh/profiles/event/cordis.patch.yml` (reloads live; no restart):
   ```yaml
   - id: lsy-qq
     config:
       groups: ['<group number>']
   ```
   The backfill then fetches recent history, and new messages arrive as they are sent. Digests start once a group has `digest.minMessages` (15) new messages and a day has passed; set `digest.provider` and `digest.model` there to run them on a cheap model (otherwise the profile's default model runs).
6. Optional switches in the same entry: `asr.enabled: true` transcribes voice messages (needs `lsy-voice` with `asr.enabled`), `media.retainDays` ages out downloaded images, `media.maxTotalBytes` caps them (5 GiB).

Where the data is: `/Users/dsh-runtime/.dsh/lsy-qq/` (database `qq.db`, `media/`, `digest-raw/`), on the internal disk: the volume `/Volumes/MiniSSD` is closed to `dsh-runtime` by step 0, and the agent must read this data. Text is small; images are capped (check `du -sh` now and then, or set `media.retainDays`). The data never leaves this Mac except the transcript that goes to the digest model (the provider of the profile's model route, OpenRouter by default) and what the agent reads through its tools.

Stop or remove: `lsy/deploy/napcat/napcat.sh stop` (the account goes offline; the observer reconnects when it returns and tells the owner on WeChat after ten minutes without a connection), or `- id: lsy-qq` with `disabled: true` in the owner layer. To forget the QQ login entirely, `docker rm -f napcat && docker volume rm napcat-qq napcat-config`, and sign the device out in QQ's settings. Roll the token by deleting `LSY_QQ_ONEBOT_TOKEN` from `.env`, `docker volume rm napcat-config`, and running `start` again.

## 13b. Official QQ bot channel (disabled by default)

`lsy-qqbot` answers owner-listed people on QQ through the official QQ Open Platform bot, one chat Session each (preset `qqbot`, no tools). It is separate from the observer of step 13 and is not needed for it. The bundle carries its row with `disabled: true`, so a stock install loads nothing and opens no connection. A bot sees only private messages and the group messages that @-mention it, cannot message first, and has no voice, which is why the QQ account is used by the observer instead.

To enable it:

1. Create the bot (you, with your phone): `ssh -t mini 'sudo -u dsh-runtime env DSH_HOME=/Users/dsh-runtime/.dsh /opt/homebrew/bin/node /Users/Shared/lsy-dsh/current/lsy/deploy/qqbot-login.mjs --qr-png /Users/dsh-runtime/qqbot-login.png'` and scan the code with your phone's QQ (a code lives about three minutes; the command replaces it up to three times). It writes `LSY_QQBOT_APP_ID` and `LSY_QQBOT_APP_SECRET` into `/Users/dsh-runtime/.dsh/.env` (mode 600) and prints the AppID and your openid; the secret is never shown. A bot made at `q.qq.com` works too: put its AppID and AppSecret in `.env` by hand.
2. In `/Users/dsh-runtime/.dsh/profiles/event/cordis.patch.yml` add
   ```yaml
   - id: lsy-qqbot
     disabled: false
     config:
       allow:
         users: ['<user_openid>']
         groups: ['<group_openid>']
   ```
   and restart (`sudo -n /bin/launchctl kickstart -k system/app.lishuyu.dsh-events`). The first message of an unlisted sender is dropped and logged with its openid (`dropped a c2c message from user <openid>`), and the owner gets one WeChat note with it; openids are not QQ numbers.
3. Disable it again: remove the entry or set `disabled: true`, and delete `LSY_QQBOT_APP_SECRET` from `.env`.

Limits of the platform: a group message reaches the bot only if it @-mentions it; a reply must quote the inbound message within about an hour (private) or five minutes (group), at most five times; later answers go out as proactive messages, which QQ may refuse, and then fall back to the owner's WeChat.

## 14. Claude Code for the service user (optional)

The agent can start and talk to Claude Code sessions of its own. They run as `dsh-runtime`, so the agent reaches their sockets (`/tmp/cc-socks-502`, 0600) directly; the owner's sessions under `lishuyu` stay out of reach. The `unattended` preset already mounts the `lsy-cc-bridge` plugin; until this step is done `cc_start` reports that the session did not register.

Provision (as the operator; no password prompts with the sudoers file of "Operator access"):

```sh
/Users/Shared/lsy-dsh/current/lsy/deploy/claude-dsh/install.sh      # copies the operator's Claude Code binary (same version), the launcher, and the settings
```

Sign in with a long-lived token the owner generates (`claude setup-token` in the owner's own terminal; the owner types it, nobody pastes it into a chat). Store it without printing it, then check:

```sh
umask 077; sudo -n -u dsh-runtime /usr/bin/tee /Users/dsh-runtime/.config/claude-code/oauth_token >/dev/null < <file holding only the token>
sudo -n -u dsh-runtime /Users/dsh-runtime/bin/claude-dsh -p "reply with exactly: OK" < /dev/null     # prints OK
```

The file must hold the bare `sk-ant-oat01-…` value (mode 0600, directory 0700). `claude-dsh` exports it as `CLAUDE_CODE_OAUTH_TOKEN` for the one process it execs. The first interactive start asks for a theme and to trust `/Users/dsh-runtime/work/cc` once; run `sudo -n -u dsh-runtime /opt/homebrew/bin/tmux -L dsh-cc-setup new-session -s setup -c /Users/dsh-runtime/work/cc /Users/dsh-runtime/bin/claude-dsh` from a terminal, answer both (choose "Yes, I trust this folder"), and exit.

What a started session may do (`/Users/dsh-runtime/.claude/settings.json`, `dontAsk`: whatever is not allowed is refused, because nobody can answer a prompt): read and search files, run `ls` and `git status|log|diff`, send and list peer messages. It cannot edit files, run other commands, or use the web, and it cannot read `~/.dsh`, `~/.config`, `~/.ssh`, `.env`, `*.pem`, or `*.key`. Loosen the allow list in that file if a task needs more; it is the owner's layer and `install.sh` never replaces it.

Verify the bridge end to end: `cc_start` a session named `probe` from the chat (or start one by hand in tmux), see `cc-bridge: cc_start "probe" is up` in `stdout.log`, `cc_send` it a line, have it `SendMessage` to `dsh-agent`, and see `cc-bridge: passed … chars from "probe"`. Stop it with `cc_stop`. After a Claude Code update (copy the new binary with `install.sh <version>`), repeat the round trip: the peer message format is internal and may change.

Remote Control (`remoteControlAtStartup` and `enableRemoteControl` are on in the seeded settings, as for the owner's own sessions) needs a full claude.ai login: the inference-only token from `claude setup-token` makes a session print `Remote Control disconnected — /login`. To enable it, the owner signs in once as the service user (`sudo -n -u dsh-runtime /Users/dsh-runtime/bin/claude-dsh`, then `/login` and follow the browser link); `claude-dsh` stops exporting the token once `/Users/dsh-runtime/.claude/.credentials.json` exists.

Switch the agent side off with `enabled: false` in the `lsy-cc-bridge` row of the profile patch (`spawn: false` keeps messaging but removes `cc_start`/`cc_stop`).

## 15. Memory and persona safety

Three plugins keep what the agent learns from steering it by accident or by a stranger's words. They need no setup beyond the build; this step is the operator's reference.

- **`lsy-memory`** stamps every entry with where it came from, keeps a history and daily snapshots, and tells the owner on WeChat about protected writes (`instructions`, `preferences`, `identity`). Files next to `memory.jsonl` in `/Users/dsh-runtime/.dsh/lsy-memory/`: `memory.history.jsonl`, `memory.pending.jsonl`, `snapshots/` (all 600/700). Review and undo as the service user; the tool prints ids, categories, and counts, never text:
  ```sh
  sudo -n -u dsh-runtime env DSH_HOME=/Users/dsh-runtime/.dsh /opt/homebrew/bin/node /Users/Shared/lsy-dsh/current/lsy/deploy/memory-admin.mjs ids
  # approve <id>... | discard <id>... | revert <id>... | rollback --session <id> [--dry-run] | rollback --since <ISO time> | forget --purge <id>...
  ```
  Back up first when changing the store by hand: `sudo -n -u dsh-runtime /bin/cp -p /Users/dsh-runtime/.dsh/lsy-memory/memory.jsonl /Users/dsh-runtime/.dsh/lsy-memory/.memory.jsonl.bak.$(date +%Y%m%d%H%M%S)`.
- **`lsy-taint`** (in the `unattended` preset) reads from the Session log who started each turn. With `enforce: true` it refuses `cc_send` and `cc_start` outside a turn the owner started alone and reports reminders and watches made in other turns. The log shows `lsy-taint: cc_send refused …` or `would be refused` (`enforce: false`).
- **`lsy-integrity`** (at the root) watches the profile patches, instruction files, skills, schedule, and memory file, and tells the owner on WeChat which one changed. State is in `/Users/dsh-runtime/.dsh/lsy-integrity/` (`baseline.json`, `persona.json`, `tics.json`). After a deliberate change, nothing needs resetting: the new state becomes the baseline when the notice goes out. Delete `baseline.json` to start over silently.

Switches live in the owner layer (`$DSH_HOME/profiles/event/cordis.patch.yml`, reloads live), one entry per plugin, restating its whole `config`:

```yaml
- id: lsy-memory
  config: { hold: false }           # provenance, history, and notices stay; nothing is held
- id: lsy-taint
  config: { enforce: false }        # log only
- id: lsy-integrity
  config: { enabled: false }        # no watch
```

Optional hardening for the operator, not done by any script: make the home patch immutable, so the agent's account cannot edit the file that can override a persona. Test it on a copy first; the Web UI refuses to save an entry the home patch sets, so nothing it edits lives there.

```sh
sudo chown root:wheel /Users/dsh-runtime/.dsh/cordis.patch.yml
sudo chflags uchg /Users/dsh-runtime/.dsh/cordis.patch.yml     # undo: sudo chflags nouchg …; sudo chown dsh-runtime:staff …
```

## Operator access without passwords (optional)

`/etc/sudoers.d/dsh-events` (root:wheel 440, written with `sudo visudo -f /etc/sudoers.d/dsh-events`) lets the operator act as the service user and restart the daemon without a password, so config edits, `.env` changes, and upgrades need no one at the keyboard:

```
lishuyu ALL = (dsh-runtime) NOPASSWD: ALL
lishuyu ALL = (root) NOPASSWD: /bin/launchctl kickstart -k system/app.lishuyu.dsh-events
```

Acting as `dsh-runtime` is a step down from `lishuyu`; root is limited to the one restart.

## 13. Voice (optional)

`lsy-voice` gives the WeChat agent a `speak` tool (text to speech, delivered as an mp3 file because iLink bots cannot send voice bubbles) and can transcribe audio files the owner sends. It is mounted by the bundle; only the key needs a step. The Mac mini TTS service (`http://127.0.0.1:8098`, about 25 s plus 2.4 s per character, so `tts.maxChars` is 200) answers first; feiyu on the laptop (`http://100.117.175.117:19880`, first request after idle about 45 s, then 6-8 s) is the fallback because the mini could not open that port on 2026-10-30. Check with `curl -m 8 http://100.117.175.117:19880/health` from the mini, and set `tts.provider: feiyu` in the profile patch once it answers.

1. Add the feiyu key to the service `.env` without printing it (the laptop's container holds it; restart afterwards):
   ```sh
   KEY=$(ssh laptop-stevenli '<docker> exec feiyu-voice cat /store/runtime/api_key.txt' | tr -d '\r\n')
   printf 'LSY_FEIYU_API_KEY=%s\n' "$KEY" | sudo -n -u dsh-runtime /bin/sh -c 'umask 077; cat >> /Users/dsh-runtime/.dsh/.env'
   sudo -n /bin/launchctl kickstart -k system/app.lishuyu.dsh-events
   ```
   `<docker>` is the laptop's Docker CLI invocation (see the API platform runner notes). Without the key the feiyu fallback fails with `feiyu: the API key is not configured`.
2. Check: ask the agent on WeChat to say something; `stdout.log` shows `lsy-voice: spoke N chars with mac-mini in … ms -> /Users/dsh-runtime/.dsh/lsy-voice/audio/…mp3` and `lsy-tool-voice: spoke … sent as file`. Raw answers and audio stay in `$DSH_HOME/lsy-voice/` for 14 days.
3. Speech to text is off. To turn it on, add to `$DSH_HOME/profiles/event/cordis.patch.yml` (reloads live):
   ```yaml
   - id: lsy-voice
     config:
       asr:
         enabled: true
   ```
   Audio files the owner sends on WeChat are then transcribed by `http://127.0.0.1:8099/transcribe` (the mini's asr-service; `asr.engine: whisper` for English) and the text joins the attachment note. Nothing records or listens; only files already sent are read.

## Operate

Patch edits (`$DSH_HOME/cordis.patch.yml`, the profile patch) reload live; `.env` edits and new builds need a restart. The composition is the `@deepseek-ai/dsh-lsy-event-bundle` layer linked from the build; the profile patch `profiles/event/cordis.patch.yml` is the owner's layer, where Web UI settings save, and upgrades keep it. A home patch entry replaces that entry's whole `config`, so override only entries whose config it restates in full, and the Web UI refuses to save an entry the home patch sets ("Configuration for … is overridden by a home patch").

| Task | Command |
|---|---|
| Change what is watched | Ask the agent on WeChat |
| Upgrade | `lsy/deploy/upgrade.sh` (run it from a separate `git worktree` so the main tree stays editable; it keeps the new build and the one it replaces and deletes older ones), then `sudo -n -u dsh-runtime /Users/Shared/lsy-dsh/current/lsy/deploy/setup-profile.sh /Users/dsh-runtime/.dsh /Users/Shared/lsy-dsh/current` and `sudo -n launchctl kickstart -k system/app.lishuyu.dsh-events` |
| Roll back | `ln -sfn /Users/Shared/lsy-dsh/<previous sha> /Users/Shared/lsy-dsh/current`, then the two commands above; only the previous build is kept |
| Re-bind WeChat | Step 6 again; no restart needed |
| New chat Session (e.g. after a model change) | Send `/new` on WeChat |
| Stop | `sudo launchctl bootout system/app.lishuyu.dsh-events` |
| Status | `launchctl print system/app.lishuyu.dsh-events \| grep -E 'state\|pid'`; `tail /Users/dsh-runtime/logs/stdout.log` |
