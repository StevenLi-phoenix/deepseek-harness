# Event service runbook (Mac mini)

Runs the fork as a second dsh instance — the event service — under a dedicated, non-admin macOS user `dsh-runtime`, on `127.0.0.1:3081`, started by a LaunchDaemon. The interactive instance (`app.lishuyu.dsh`, `~/.dsh`, port 3080) is untouched.

You do this once. After that you talk to the agent on WeChat: it creates its own watches (`watch_create`) and reminders (`schedule_create`), and every event result, reminder result, and chat reply comes back to WeChat. No YAML to write.

Every `sudo` line is meant to be run by hand, one at a time. The agent runs without approval prompts (`danger-full-access`), so the account boundary below is the isolation: it must hold before the first event arrives.

## Layout

| Path | Owner | Contents |
|---|---|---|
| `/Users/Shared/lsy-dsh/builds.noindex/<sha>/` | lishuyu, 755 | Installed build (≈1.6 GB) plus `lsy/` (event bundle, profile template, `setup-profile.sh`, `wechat-login.mjs`); `dsh-runtime` can read, not write; the `.noindex` name keeps Spotlight out of every build's `node_modules` (indexing each new 1.7 GB build held the mini at load 24 on 2026-10-31) |
| `/Users/Shared/lsy-dsh/current` | lishuyu | Symlink to the active build; the LaunchDaemon, the sudoers rules, and the profile links use this path only |
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

Two keys, both for this service only: an llmgateway key (models, `opencode-go/*`, USD 2 a day) and a classic GitHub token with `repo`, `workflow`, and `read:org` (sensor, notifications, `git push`, `gh`). Leave out `admin:public_key`: it can add SSH keys to the account, which outlive revoking the token. `repo` already covers `/notifications`, so the same token fills both GitHub names. Every command below reads input with echo off and prints only names and modes.

```sh
cd / && sudo -u dsh-runtime /bin/zsh -fc 'umask 077; f=/Users/dsh-runtime/.dsh/.env; read -rs "v?llmgateway key (hidden): "; print; [[ -n $v ]] || exit 1; { print -r -- "LLMGW_DSH_API_KEY=$v"; /usr/bin/grep -v -e "^LLMGW_DSH_API_KEY=" -e "^DEEPSEEK_API_KEY=" $f 2>/dev/null; } >| $f.new && /bin/mv -f $f.new $f && /bin/ls -l $f && /usr/bin/cut -d= -f1 $f'
cd / && sudo -u dsh-runtime /bin/zsh -fc 'umask 077; f=/Users/dsh-runtime/.dsh/.env; read -rs "v?GitHub classic token (hidden): "; print; [[ -n $v ]] && print -r -- "LSY_GITHUB_TOKEN=$v" >> $f && print -r -- "LSY_GITHUB_NOTIFICATIONS_TOKEN=$v" >> $f; /bin/ls -l $f; /usr/bin/cut -d= -f1 $f'
```

Models start on llmgateway: the owner's profile patch is seeded (once, by `setup-profile.sh`) with the `opencode-go` route of `llm-pi-ai` pointing at `https://api.lishuyu.app/llm/v1`, keyed by `LLMGW_DSH_API_KEY`, serving `opencode-go/deepseek-v4.1-flash` as the default model (step 14); change either from the Web UI afterwards. The home patch (`lsy/deploy/home.cordis.patch.yml`) holds only what the UI must not edit: the 365-day sign-in cookie and the disabled DeepSeek key onboarding. The UI refuses to save any entry a home patch sets, so never put UI settings there:

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

**Primary: Settings → WeChat (微信) in the Web UI.** Choose "Scan to bind", scan the code with WeChat, and type the number into the field the page shows if WeChat asks for one. The running service reads the new account at once. The same page shows the binding (ids masked), the long-poll's health, the reply window, and the outbox, and "Unbind" moves `account.json` to `account.json.bak.<timestamp>` beside it (kept, never deleted).

**Fallback, with only a shell on the Mac mini:**

```sh
sudo -u dsh-runtime env DSH_HOME=/Users/dsh-runtime/.dsh /opt/homebrew/bin/node /Users/Shared/lsy-dsh/current/lsy/deploy/wechat-login.mjs
```

- If WeChat shows a number, type it into the terminal.
- WeChat lets a bot write to you only within about 24 hours of your last message to it, and only about 10 messages per message you send. Messages that do not fit wait in an outbox and arrive as a digest the next time you write anything. If you expect alerts, send the bot a word once a day.
- Re-binding later (for example after `bot token is stale` in the log, which the page shows as "Sign-in expired, bind again") is the same flow; the running service picks up the new file without a restart (the command's file within `accountPollMs`, the page's at once).

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

`lsy-qq` lets the agent lurk in QQ groups with a personal QQ account and learn from them: it records the groups you list, digests them daily, and the main agent reads them with `qq_groups`, `qq_digest`, `qq_recent`, and `qq_search`. It never speaks (sending is off) and is not a chat entrance. The QQ side is NapCat (OneBot v11), a container on colima on the operator's account, so the login session (which could sign the QQ account in) is out of the agent's reach: the **qq-recorder** service (§19, an AMS service of `dsh-runtime`) is the one process that connects, only to `ws://127.0.0.1:3001` with an access token; DSH asks the recorder and never connects to NapCat. The OneBot port is published on 127.0.0.1 only, and NapCat's WebUI (which can open a shell in the container and read the QQ session) is not published at all: the login QR code reaches the DSH Settings page through the *login door*, a second small container (`napcat-login`, `127.0.0.1:3002`) that holds the WebUI token itself and answers only `GET /v1/login` and `POST /v1/login/refresh` to callers that present the OneBot token.

Use a spare ("小号") account: NapCat is an unofficial client, and Tencent can restrict or sign out an account that uses one. Keep it read-only, log it in once on this Mac, and avoid logging in from other devices or places meanwhile. Add the account to each group by hand first (the observer sees only groups the account is a member of).

1. Install the runtime once (operator, no sudo): `brew install colima docker`, then `colima start --cpu 2 --memory 3 --disk 20 --vm-type vz`. To start it at login, `brew services start colima` (a LaunchAgent, `~/Library/LaunchAgents/sh.brew.colima.plist`; stop it with `brew services stop colima`). The VM disk lives in `~/.colima` on the internal disk.
2. Build and start the protocol end (operator): `lsy/deploy/napcat/napcat.sh build`, then `lsy/deploy/napcat/napcat.sh start`. `build` clones NapCat-Docker at a pinned commit, downloads `NapCat.Shell.zip` of a pinned release and refuses it unless its SHA-256 matches, and builds the image from them (Tencent's own Linux QQ package comes from `qqdl.gtimg.cn` during the build). `start` also starts the login door (`napcat.sh door` starts only the door; it is created after NapCat and again whenever `start` recreates NapCat). `start` writes the OneBot config with a fresh access token generated by `openssl`, stores the token as the AMS secret `LSY_QQ_ONEBOT_TOKEN` of the service `qq-recorder` (`ams secret set`, value on stdin, never printed; for one release cycle it is also kept in `/Users/dsh-runtime/.dsh/.env`, which the previous build reads, after copying the old `.env` to `.env.bak.<time>`), and runs the container. A token that exists only in `.env` is copied into the secret, not regenerated. A new token restarts the recorder (`ams ctl restart qq-recorder`), not DSH.
3. Log the account in (you, with your phone): open the DSH page, **Settings → QQ**, and scan the code with the spare account's QQ (see "QQ 掉线恢复" below; without the page, `lsy/deploy/napcat/napcat.sh qr /tmp/napcat-qr.png` saves the same code as an image). NapCat renews the code about every two minutes and the page follows it. After the scan, run `lsy/deploy/napcat/napcat.sh start <QQ number>` once. QQ ties a login to the device, so the container is created with a fixed MAC address and hostname (the data lives in the docker volumes `napcat-qq` and `napcat-config`); with those, `docker restart` and a recreate by `start <QQ number>` log in again without a code (tested 2026-10-31).
4. Check `napcat.sh logs` for the login, then the recorder's log (§19): `connected to the protocol end`, `logged in as <number>`, and one `not recording group <number> (<name>)` line for each group the account is in.
5. List the groups to record in the owner layer, `/Users/dsh-runtime/.dsh/profiles/event/cordis.patch.yml` (reloads live; no restart):
   ```yaml
   - id: lsy-qq
     config:
       groups: ['<group number>']
   ```
   The backfill then fetches recent history, and new messages arrive as they are sent. Digests start once a group has `digest.minMessages` (15) new messages and a day has passed; set `digest.provider` and `digest.model` there to run them on a cheap model (otherwise the profile's default model runs).
6. Optional switches in the same entry: `media.images: true` saves pictures as messages arrive (the digest's attached pictures and `qq_image` need it; backfilled messages never download theirs), `media.retainDays` ages out downloaded images, `media.maxTotalBytes` caps them (5 GiB). Voice transcription (`asr.enabled`) and sending (`send.enabled`) are not offered; turning either on fails the load.

<a id="qq-recovery"></a>
### QQ 掉线恢复 (QQ recovery)

QQ signs the account out now and then (a kick, an expired session, a device check). You learn of it from one WeChat notice per outage ("QQ 号掉线了" or, after ten minutes without a connection, "QQ 协议端连不上"; it names Settings → QQ, and quotes `lsy-qq`'s `settingsUrl` when you set it in the owner layer) or from the red or blue verdict on the page. Recover from the phone, with no terminal:

1. Open the DSH page and go to **Settings → QQ**. The first line says what is wrong and what to do.
2. **需要扫码登录 (Scan to log in)**: scan the code with the spare account's QQ (Scan), confirm on the phone. The page goes through "已扫码" and "正在登录" to **QQ 已连接** within seconds; the observer reconnects by itself the moment NapCat is logged in. On a phone, take a screenshot of the page and pick it in QQ's Scan → Album. The code renews itself about every two minutes; **刷新二维码** asks NapCat for a new one at once (refused while QQ is logged in and for ten minutes after: a fresh code then only invites a sign-out).
3. **NapCat 没有响应**: the container is restarting or stopped. On the Mac mini (operator): `lsy/deploy/napcat/napcat.sh status`, then `docker restart napcat` if it is down; the page recovers by itself.
4. **扫码入口没有运行 / 拒绝了访问令牌 / 回答看不懂**: the login door is down or out of date. On the Mac mini: `lsy/deploy/napcat/napcat.sh door` (or `start`, which also keeps the token in step); `napcat.sh logs door` shows its log (state changes only; never a token or a code).
5. **QQ 的访问令牌未设置**: the recorder's secret `LSY_QQ_ONEBOT_TOKEN` is not set; run `napcat.sh start` (it writes the secret and restarts the recorder).
6. If the page itself is unreachable, the fallback is the old path: `napcat.sh qr /tmp/napcat-qr.png` and open the image. A QR code you see is a login for the account: do not post or forward it.
7. **QQ 记录器没有运行 / 协议版本不一致**: the recorder is a service of its own, see §19 "Recover".

If QQ keeps signing the account out within hours, stop re-scanning and look at the cause (another device logged in with the same account, the container's MAC or hostname changed by a recreate that did not go through `napcat.sh`, a Tencent restriction on the account).

Retention and privacy: raw messages and downloaded media are deleted after 30 days (`retention.textDays`, `media.retainDays`; `0` keeps), digests stay until deleted (`qq_forget`, or the owner asks the agent) and are capped at 200 per group; digests name members only by alias (`digest.aliasMembers`) and carry no per-member profile unless `digest.profiles: true`. NapCat itself logs at warn level only and keeps no log file (`napcat.sh start` sets `consoleLogLevel`/`fileLogLevel` to `warn` and `fileLog` to false in `napcat.json` and in each account's `napcat_<QQ number>.json`, the latter made at the first login at info level and the one that wins; at info level it prints every received group message, and docker kept that output), and the container's docker log rotates at 3 × 10 MB. The same step turns on all of NapCat's native bypasses (`bypass.*`, shipped off in NapCat.Shell.zip): while they were off QQ invalidated the login every few hours; a changed `napcat_<QQ number>.json` takes effect at the next `docker restart napcat`.

Group text also stays outside that directory: each recorded group has a resident digest Session (titled `QQ: <group>`, working directory `/Users/dsh-runtime/work/qq`), and the Session logs under the DSH home hold the transcripts it read. DSH has no API to delete a stored Session, so `retention.textDays` does not reach them; replaced Sessions are archived (hidden), not deleted. Clearing old logs is offline maintenance on the Mac mini (stop the service, remove the archived Sessions' files, start it); nothing in the package does it.

Where the data is: `/Users/dsh-runtime/.dsh/lsy-qq/` (database `qq.db`, `media/`, `connection-state.json`, `recorder-config.json`; the recorder's alone, DSH never opens it), and DSH's own digests, notes, and raw digest answers in its storage domain `lsy_qq` and `/Users/dsh-runtime/.dsh/lsy-qq-digest/raw/`, on the internal disk: the volume `/Volumes/MiniSSD` is closed to `dsh-runtime` by step 0, and the agent must read this data. Text is small; images are capped (check `du -sh` now and then, or set `media.retainDays`). The data never leaves this Mac except the transcript that goes to the digest model (the provider of the profile's model route, OpenRouter by default) and what the agent reads through its tools.

Stop or remove: `lsy/deploy/napcat/napcat.sh stop` (stops NapCat and the login door; the account goes offline; the observer reconnects when it returns and tells the owner on WeChat after ten minutes without a connection), or `- id: lsy-qq` with `disabled: true` in the owner layer. To forget the QQ login entirely, `docker rm -f napcat napcat-login && docker volume rm napcat-qq napcat-config`, and sign the device out in QQ's settings. Roll the token by `ams secret rm qq-recorder LSY_QQ_ONEBOT_TOKEN` and deleting `LSY_QQ_ONEBOT_TOKEN` from `.env`, `docker rm -f napcat napcat-login && docker volume rm napcat-config` (a volume in use cannot be removed), and running `start` again; the login door reads the token on every request, so it needs no restart for a new one.

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

What a started session may do (`/Users/dsh-runtime/.claude/settings.json`, `dontAsk`: whatever is not allowed is refused, because nobody can answer a prompt): read and search files, edit under `/Users/Shared/ams-src` and `/Users/dsh-runtime/src`, run `ls`, `git`, `uv`, `pnpm`, and `pytest`, send and list peer messages. It cannot edit elsewhere, run other commands, or use the web, and it cannot read `~/.dsh`, `~/.config`, `~/.ssh`, `.env`, `*.pem`, or `*.key`. Loosen the allow list in that file if a task needs more; it is the owner's layer and `install.sh` never replaces it.

Verify the bridge end to end: `cc_start` a session named `probe` from the chat (or start one by hand in tmux), see `cc-bridge: cc_start "probe" is up` in `stdout.log`, `cc_send` it a line, have it `SendMessage` to `dsh-agent`, and see `cc-bridge: passed … chars from "probe"`. Stop it with `cc_stop`. After a Claude Code update (copy the new binary with `install.sh <version>`), repeat the round trip: the peer message format is internal and may change.

Remote Control (`remoteControlAtStartup` and `enableRemoteControl` are on in the seeded settings, as for the owner's own sessions) needs a full claude.ai login: the inference-only token from `claude setup-token` makes a session print `Remote Control disconnected — /login`. To enable it, the owner signs in once as the service user (`sudo -n -u dsh-runtime /Users/dsh-runtime/bin/claude-dsh`, then `/login` and follow the browser link); `claude-dsh` stops exporting the token once `/Users/dsh-runtime/.claude/.credentials.json` exists.

Switch the agent side off with `enabled: false` in the `lsy-cc-bridge` row of the profile patch (`spawn: false` keeps messaging but removes `cc_start`/`cc_stop`).

## 15. Memory and persona safety

Three plugins keep what the agent learns from steering it by accident or by a stranger's words. They need no setup beyond the build; this step is the operator's reference.

- **`lsy-memory`** stamps every entry with where it came from, keeps a history and daily snapshots, and tells the owner on WeChat about protected writes (`instructions`, `preferences`, `identity`) in one plain sentence per turn, at most 12 notices a day (`noticesPerDay`), for example `记住了一条偏好：…（来源：微信对话）`. WeChat has no command words and no ids: the notice asks for no reply. Reviewing and undoing is in **Settings → Memory** in the Web UI (`lsy-memory-admin`, with its route `lsy-memory-settings`; both mounted by the event bundle): waiting writes first, then the entries, a rollback card, and the feedback verdicts; a rollback or an erase always shows a preview and applies only that preview. The CLI below does the same and is the fallback when the Web UI is unreachable, run over SSH by the owner or by Claude Code on the owner's behalf. Files next to `memory.jsonl` in `/Users/dsh-runtime/.dsh/lsy-memory/`: `memory.history.jsonl`, `memory.pending.jsonl`, `snapshots/` (all 600/700).

  Full command (the `cd /` matters: the service user cannot read the SSH user's home as a working directory):
  ```sh
  ssh mini 'cd / && sudo -n -u dsh-runtime env DSH_HOME=/Users/dsh-runtime/.dsh /opt/homebrew/bin/node /Users/Shared/lsy-dsh/current/lsy/deploy/memory-admin.mjs <command>'
  ```
  | `<command>` | Does |
  |---|---|
  | `ids` | id, category, and source of every entry and waiting write (no text) |
  | `recent --limit 10` | newest changes first, waiting writes on top, with the opening of each text: find the entry a notice meant |
  | `show <id>` | one entry in full with its history |
  | `approve <id>…` / `discard <id>…` | keep or drop writes that `hold` kept waiting |
  | `revert <id>…` | undo the latest change of an entry (a waiting write is dropped) |
  | `rollback --session <id> [--dry-run]` / `rollback --since <ISO time> [--dry-run]` | undo what a Session's turns, or everything since a time, changed |
  | `forget --purge <id>…` | erase an entry from the file, the history, every snapshot, and the waiting writes |
  | `notices mute` / `notices unmute` / `notices status` | silence the memory, reminder, and integrity notices to WeChat for 30 minutes (`$DSH_HOME/notices.muted`; it lapses by itself): run it before any test that writes memory or edits the profile patch, so nothing reaches the owner's phone |
  | `feedback add` (JSON on stdin) / `feedback list [--scope up]` / `feedback forget <id>` | the owner's keep/delete verdicts on the `up` persona's replies (`feedback.jsonl`); bili-svc calls `feedback add`, the `up` preset reads its scope as examples of tone, and no agent tool writes it |

  A typical review after a notice: `recent --limit 5`, then `revert <id>` for the one that should not be there. Back up first when changing the store by hand: `ssh mini 'cd / && sudo -n -u dsh-runtime /bin/cp -p /Users/dsh-runtime/.dsh/lsy-memory/memory.jsonl /Users/dsh-runtime/.dsh/lsy-memory/.memory.jsonl.bak.$(date +%Y%m%d%H%M%S)'`.
- **`lsy-taint`** (in the `unattended` preset) reads from the Session log who started each turn. With `enforce: true` it refuses `cc_send` and `cc_start` outside a turn the owner started alone and reports reminders and watches made in other turns. The log shows `lsy-taint: cc_send refused …` or `would be refused` (`enforce: false`).
- **`lsy-integrity`** (at the root) watches the profile patches, instruction files, skills, schedule, and memory file, and logs which one changed; its WeChat notice is off (`notify: false` in the bundle row). State is in `/Users/dsh-runtime/.dsh/lsy-integrity/` (`baseline.json`, `persona.json`, `tics.json`). After a deliberate change, nothing needs resetting: the new state becomes the baseline on the next scan. Delete `baseline.json` to start over silently.
- **`lsy-time-gap`** (at the root) puts a `Time check:` notice before an input that starts a turn after 5 minutes of silence in any Session; the owner's WeChat messages get lsy-wechat's own check instead. Each notice logs `lsy-time-gap: Session <id>, <owner|sender|event|reminder> input after <gap> of silence` (no text). Settings → 订阅与监控 → 时间间隔提示 changes the threshold, zone, and excluded presets, or sets `enabled: false`.

Switches. `hold` (protected writes from turns the owner did not start alone wait for `approve`/`discard`) and `enforce` (`cc_send` and `cc_start` refused in such turns) are **off** (2026-10-31): the owner decides when they go on. In the observing state the log still records what they would do: `memory added … [would be held]` and `lsy-taint: cc_send would be refused …`, and `lsy-memory: hold off …` / `lsy-taint: enforce off …` at startup show the state. Both are set twice: `hold: false` and `enforce: false` in the bundle rows, and `LSY_MEMORY_HOLD=0` and `LSY_TAINT_ENFORCE=0` in `$DSH_HOME/.env` (the environment switch wins over the row, and a profile patch cannot reach a row inside the `unattended` preset). To turn one on, set its bundle row to `true`, remove its `.env` line, deploy, and restart. `lsy-integrity` is a root row, so the owner layer reaches it: `- id: lsy-integrity` with `disabled: true`.

```sh
ssh mini 'cd / && sudo -n -u dsh-runtime /bin/cp -p /Users/dsh-runtime/.dsh/.env /Users/dsh-runtime/.dsh/.env.bak.$(date +%Y%m%d%H%M%S)'
ssh mini 'cd / && printf "LSY_MEMORY_HOLD=0\n" | sudo -n -u dsh-runtime /bin/sh -c "umask 077; cat >> /Users/dsh-runtime/.dsh/.env"'    # remove the line to turn it back on
ssh mini 'sudo -n /bin/launchctl kickstart -k system/app.lishuyu.dsh-events'
```

Probes: `lsy/probes/` holds nine situations (E1 to E9: a relayed message or a hidden web instruction asks for a memory write or a Claude Code message, the owner states a wrong fact, a memory entry conflicts with the persona, strangers ask who the owner is, a QQ line poses as the witch, form of address) and E10, the persona probes across models. They build the prompt the real preset sees and ask a model what it would do; tools are not executed, so they measure a model's disposition and not the Host's guards (the unit and agent-loop tests cover those). Run them on a laptop with Claude Code logged in (the subscription, no API key); every raw answer is saved before it is parsed:

```sh
pnpm exec tsx lsy/probes/run.mts --models haiku,sonnet --samples 3          # all probes
pnpm exec tsx lsy/probes/run.mts --models haiku --samples 1 --only E1,E2    # a quick check
```

Rerun them after a persona change, a model change, or a Claude Code upgrade, and compare the table with the previous run.

Optional hardening for the operator, not done by any script: make the home patch immutable, so the agent's account cannot edit the file that can override a persona. Test it on a copy first; the Web UI refuses to save an entry the home patch sets, so nothing it edits lives there.

```sh
sudo chown root:wheel /Users/dsh-runtime/.dsh/cordis.patch.yml
sudo chmod 644 /Users/dsh-runtime/.dsh/cordis.patch.yml        # the service still has to read it; the 700 directory keeps others out
sudo chflags uchg /Users/dsh-runtime/.dsh/cordis.patch.yml     # undo: sudo chflags nouchg …; sudo chown dsh-runtime:staff …; sudo chmod 600 …
```

## Operator access without passwords (optional)

`/etc/sudoers.d/dsh-events` (root:wheel 440, written with `sudo visudo -f /etc/sudoers.d/dsh-events`) lets the operator act as the service user and restart the daemon without a password, so config edits, `.env` changes, and upgrades need no one at the keyboard:

```
lishuyu ALL = (dsh-runtime) NOPASSWD: ALL
lishuyu ALL = (root) NOPASSWD: /bin/launchctl kickstart -k system/app.lishuyu.dsh-events
```

Acting as `dsh-runtime` is a step down from `lishuyu`; root is limited to the one restart.

## 13. Voice (optional)

`lsy-voice` gives the WeChat agent a `speak` tool (text to speech, delivered as an mp3 file because iLink bots cannot send voice bubbles) and can transcribe audio files the owner sends. It is mounted by the bundle; only the key needs a step. feiyu on the laptop (`http://100.117.175.117:19880`, first request after idle about 45 s, then 6-8 s) is the only TTS provider and the code default (`tts.provider: feiyu`, `tts.fallback: none`); the Mac mini TTS service was stopped on 2026-10-31 and is not used. Check the route with `curl -m 8 http://100.117.175.117:19880/health` from the mini. `setup-profile.sh` never replaces an existing `cordis.patch.yml`, and a fresh home gets the template without an `lsy-voice` row, so the defaults must be right in code.

1. Add the feiyu key to the service `.env` without printing it (the laptop's container holds it; restart afterwards):
   ```sh
   KEY=$(ssh laptop-stevenli '<docker> exec feiyu-voice cat /store/runtime/api_key.txt' | tr -d '\r\n')
   printf 'LSY_FEIYU_API_KEY=%s\n' "$KEY" | sudo -n -u dsh-runtime /bin/sh -c 'umask 077; cat >> /Users/dsh-runtime/.dsh/.env'
   sudo -n /bin/launchctl kickstart -k system/app.lishuyu.dsh-events
   ```
   `<docker>` is the laptop's Docker CLI invocation (see the API platform runner notes). Without the key `speak` fails with `feiyu: the API key is not configured`.
2. Check: ask the agent on WeChat to say something; `stdout.log` shows `lsy-voice: spoke N chars with feiyu in … ms -> /Users/dsh-runtime/.dsh/lsy-voice/audio/…mp3` and `lsy-tool-voice: spoke … sent as file`. Raw answers and audio stay in `$DSH_HOME/lsy-voice/` for 14 days.
3. Speech to text is off. To turn it on, add to `$DSH_HOME/profiles/event/cordis.patch.yml` (reloads live; if the patch already has an `lsy-voice` row, put `asr` into that row's `config` instead of adding a second row):
   ```yaml
   - id: lsy-voice
     config:
       asr:
         enabled: true
   ```
   Audio files the owner sends on WeChat are then transcribed by `http://127.0.0.1:8099/transcribe` (the mini's asr-service; `asr.engine: whisper` for English) and the text joins the attachment note. Nothing records or listens; only files already sent are read.

## 16. Creator account replies through bili-svc (optional)

bili-svc is a separate private service on this Mac (`app.lishuyu.bili.svc`, `127.0.0.1:8097`); it owns the creator account's session, the Reply Gate, and the events. This service only hosts the `up` preset (`lsy-tool-up`) and the `bili` ingest source.

1. Two tokens, both made on the Mac without printing them, written to the service `.env` (back it up first; restart afterwards):
   - `LSY_INGEST_TOKEN_BILI`: bili-svc pushes events to `/hooks/lsy` with it (the same value is in bili-svc's `ingest-token` file).
   - `BILI_SVC_TOKEN_UP`: bili-svc's `up` caller (scopes `read`, `reply`), made with `bili-svc token create --name up --scopes read,reply`.
2. Check: `stdout.log` shows the `bili` source accepting events (`202`); the first batch of new comments starts the `bili-up` Session, and later batches log `entered persistent Session <id> of bili-digest` and one `bili-digest batch … ended: …; context …; compaction …; tool calls …` line each; `up_status` in it reports the gate mode. Every 30 days the next batch starts a new Session and archives the old one (Web UI archive). The ledger and the brake live in bili-svc (`bili-svc ledger`, `bili-svc gate status`).
   - Channel notes: `$DSH_HOME/lsy-tool-up/channel-notes.json` (read it, or delete it to clear every note). `evidence-salt` beside it keys viewers for lsy-style's evidence; deleting it changes every key.
3. Stop: `bili-svc gate readonly` (replies stop at once, reads continue), or remove the `bili-digest` subscription. Only a person lifts a brake: `bili-svc gate release`, then `bili-svc gate mode auto`.

## 16b. The agent's own Bilibili account through bili-svc

`ctx.bili` (the `bili` preset's account, 魔女的猫猫) holds no Bilibili session: bili-svc holds and refreshes it, and every read, action, and reply to the owner goes through bili-svc. One account has one session owner, so bili-svc takes the session over before this build runs, and DSH's old copy is retired.

1. In bili-svc's configuration: `[accounts.maomao]` with `refresh_mode = "owner"` and the account's `mid`, `routes.agent_account = "maomao"`, and the owner's main UID in `gate.owner_mids` (the Gate answers the owner without its classifier, cap, or time window). Import the session once, from the record DSH kept (`bili/account` in `/Users/dsh-runtime/.dsh/.credentials.yaml`), piped straight into `bili-svc session import maomao` (JSON `{ "cookies": {…}, "refresh_token": "…" }` on stdin; nothing is echoed); then `bili-svc session status maomao` shows its mid and fingerprint. From then on only bili-svc refreshes it: delete the `bili/account` record (back the file up first), since a second refresher would invalidate bili-svc's refresh token.
2. A token for DSH, made on the Mac without printing it, written to the service `.env` (back it up first; restart afterwards): `BILI_SVC_TOKEN_BILI` from `bili-svc token create --name bili --scopes bili,read,reply --accounts maomao`.
2b. A second token for the Settings page, scope `manage`, made on the Mac mini in `~/services/bili-svc` and appended to the service `.env` by shell substitution, never printed (back up the `.env` first; the token is read only by the Settings route and never by an agent tool):
   ```sh
   cd ~/services/bili-svc
   t=$(.venv/bin/python -m bili_svc token create --name dsh-settings --scopes manage)   # the command prints the token once
   env_file=/Users/dsh-runtime/.dsh/.env
   printf '%s' "$t" | sudo -n -u dsh-runtime /bin/zsh -fc "umask 077; f=$env_file; /bin/cp -p \$f \$f.bak.\$(date +%Y%m%d%H%M%S); read -r v; { print -r -- \"BILI_SVC_TOKEN_MANAGE=\$v\"; /usr/bin/grep -v '^BILI_SVC_TOKEN_MANAGE=' \$f; } >| \$f.new && /bin/mv -f \$f.new \$f"
   unset t
   ```
   Without it, Settings → B站账号 stays read-only and says which credential is missing (`manageTokenEnv`, default `BILI_SVC_TOKEN_MANAGE`). Restart afterwards (`.env` edits need a restart).
3. Install the build and restart (step 7 and Operate). `BILI_SVC_URL` changes the address from `http://127.0.0.1:8097` if bili-svc moves.
4. Check: Settings → B站账号 shows 魔女的猫猫 with its UID and 在线, read from bili-svc's `/v1/status`; with the manage token it also lists maodeng (its session is kept by kaorou: no write control), the gate with today's counters, and the ledger, and 扫码登录 on 魔女的猫猫 shows a QR code that turns 已扫码 and then closes when scanned; a message from the owner's main account to the account is answered as a Bilibili message within ten minutes, and `bili-svc ledger` lists it as a DM reply; `bili_like` in the `bili` Session appears in `bili-svc ledger` as `like`. Without the token, `stdout.log` shows `BILI_SVC_TOKEN_BILI is not set` on the first call and nothing reaches Bilibili.
5. Stop: `bili-svc gate readonly` holds every action and reply of both accounts at once (an answer to the owner then comes on WeChat with `held`); only a person lifts a brake: `bili-svc gate release`, then `bili-svc gate mode auto`.

## 17. Unified warning intake (AMS)

Warnings do not enter DSH through an ingest source. Every machine hands them to **AMS** (agent-managed-services, `ams run` as `dsh-runtime`), which appends them to the escalation journal that the journal Monitor reads. Pieces:

- **Intake**: the AMS service `intake` (`/Users/dsh-runtime/.ams/services/intake/service.toml`, port 18090, secret `INTAKE_TOKEN`) is an HTTP receiver, `POST /escalate` with the `warn` payload. Hosts reach it over the tailnet; the owner's `ams watch` reaches it on loopback. Hosts tagged `tag:server` (racknerd, like the mini) need a tailnet grant to `tcp:18090` on the mini.
- **Senders** (`tools/warn` in the AMS repository): the `warn` CLI, the `warn@.service` template with `OnFailure=warn@%n.service` drop-ins on Linux hosts, `docker_health_watch.py` on the laptop. Token and address are per-host files `~/.config/warn/{token,url}`.
- **Host watcher**: `ams watch` (LaunchAgent `app.lishuyu.ams-watch`, the former mini-ops without its model) escalates launchd jobs, probes, logs and Tailscale Services through the same intake.
- **The Monitor** `mon-127dc2` (`work/ga-watch/watch.py`, a launcher) runs `ams watch journal` with `work/ga-watch/journal.toml`: one gate for every record (new / back after 12 h / flapping), ignore rules scoped per service, a health poll of `global-awareness`, `disk-watch` and `intake`. A host restart starts the Monitor over, which is when a changed script takes effect. If AMS cannot be imported the launcher falls back to `watch_legacy.py`.
- **In DSH**: nothing but the Monitor and the agent. CI failures are the exception that proves the rule: they already arrive as GitHub App webhooks, so the bundle's `ci` subscription (`github.workflow_run.completed` of `StevenLi-phoenix/*`, 4 sessions an hour, successes `NO_REPLY`) stays.

Check: `ams escalations -n 5` (as `dsh-runtime`, `AMS_STATE_DIR=/Users/dsh-runtime/.ams`) shows the record; the Monitor prints a `[新问题]` line for a new cause. The WeChat reply allowance (about 10 per owner message) is shared by every source, and alert text is untrusted data. Details and the AMS side: `docs/watch.md` in the AMS repository.

## 18. Quiet hours: the owner's sleep (optional)

`lsy-presence` decides whether the owner is asleep; while the owner is, `lsy-wechat` holds the messages that are not urgent and sends them as one digest on waking. The signal is the Sleep Focus that iCloud syncs from the phone, which `focus-watch` (a signed binary on the Mac mini under `lishuyu`, with Full Disk Access) reads and posts to `http://127.0.0.1:3081/hooks/lsy` as `presence.sleep.on` / `presence.sleep.off` on every change and as a heartbeat every 30 minutes (keys `sleep-on-<ts>` / `sleep-off-<ts>` for changes, `sleep-on-hb-<bucket>` / `sleep-off-hb-<bucket>` for heartbeats, subject `owner`). A signal holds for 2 hours without a newer one (14 hours for asleep), so a stopped watcher hands over to the daily window (03:30-10:30 New York); **Settings → 勿扰** has buttons that win over both. Urgent kinds (`host.disk.full`, `host.*.critical`, `bili.risk.*`, `bili.gate.readonly`) and the replies to a message the owner sent in the last 30 minutes are never held.

1. Create the ingest token for the `presence` source on the Mac mini without printing it, back up the service `.env` first, and restart afterwards:
   ```sh
   sudo -u dsh-runtime cp -p /Users/dsh-runtime/.dsh/.env /Users/dsh-runtime/.dsh/.env.bak.$(date +%Y%m%d%H%M%S)
   TOKEN=$(openssl rand -hex 32)
   printf 'LSY_INGEST_TOKEN_PRESENCE=%s\n' "$TOKEN" | sudo -u dsh-runtime tee -a /Users/dsh-runtime/.dsh/.env >/dev/null
   mkdir -p ~/.config/focus-watch && (umask 077 && printf %s "$TOKEN" > ~/.config/focus-watch/ingest-token); unset TOKEN
   sudo /bin/launchctl kickstart -k system/app.lishuyu.dsh-events
   ```
   The bundle already declares the `presence` ingest source (a sink of `ctx.lsyPresence`: its events never reach the event bus) and the `lsy-presence` row. `~/.config/focus-watch/ingest-token` is `lishuyu`'s file, mode 0600; the value is the same as `LSY_INGEST_TOKEN_PRESENCE`.
2. Install `focus-watch` as `lishuyu` on the Mac mini per its README (build, sign, grant Full Disk Access, start). It posts to the local address above, so nothing leaves the machine.
3. Check: **Settings → 勿扰 → 睡眠信号** shows the latest signal and heartbeat within 30 minutes, and `stdout.log` shows `presence sleep-on-hb-…` or `sleep-off-hb-…` answered `asleep` / `awake`. Turning Sleep Focus on or off on the phone shows `lsy-presence: asleep by focus (focus on)` (or off) after iCloud syncs it. With no signal for over an hour the page says: "focus-watch 没在发信号：在 mini 上运行 `~/.local/libexec/focus-watch/focus-watch status` 查看". By hand: `curl -sS -X POST http://127.0.0.1:3081/hooks/lsy -H "Authorization: Bearer $(cat ~/.config/focus-watch/ingest-token)" -H 'content-type: application/json' -d '{"kind":"presence.sleep.off","key":"sleep-off-hb-0","subject":"owner","title":"test"}'` answers `{"outcome":"awake"}`.
4. Stop: set `disabled: true` on the `lsy-presence` row in the profile patch (everything is sent as before), or press **我醒了** for up to 12 hours. Held messages are in the WeChat outbox; **立即发送** sends them.

## 19. qq-recorder: the QQ connection as its own service

`qq-recorder` is an **AMS service** (user `dsh-runtime`, declared in `/Users/dsh-runtime/.ams/services/qq-recorder/service.toml`), not a LaunchDaemon, and it needs no root. It is the only process that connects to NapCat, and it owns `qq.db`, the downloaded media, and its state files in `/Users/dsh-runtime/.dsh/lsy-qq/`. The `lsy-qq` plugin in DSH is its client over a unix socket (`/Users/dsh-runtime/.dsh/run/qq-recorder.sock`, mode 0600, bearer token): a DSH restart, a deploy, or a settings save no longer reconnects QQ, which is what got the account kicked on 2026-10-31. DSH keeps the digests and notes in its own storage; the recorder logs routine connection trouble at `info` and only faults a person must fix at `error`, which AMS sends to the escalation journal, ga-watch, and DSH (the owner-facing "QQ 号掉线了" notice stays in DSH).

**Install (the owner, once; every command is non-root and goes through the passwordless `sudo -n -u dsh-runtime`).** Values travel on stdin and are never printed. Order matters: `ams secret check` needs the declaration, which `upgrade.sh` places.

```sh
# 1. The token DSH presents to the recorder: into DSH's .env (backed up first) and the recorder's AMS secret
cd / && sudo -n -u dsh-runtime /bin/zsh -fc 'umask 077; t=$(openssl rand -hex 32); f=/Users/dsh-runtime/.dsh/.env; /bin/cp -p $f $f.bak.$(date +%Y%m%d%H%M%S); { /usr/bin/grep -v "^LSY_QQ_RECORDER_TOKEN=" $f; print -r -- "LSY_QQ_RECORDER_TOKEN=$t"; } >| $f.new && /bin/mv -f $f.new $f; print -r -- $t | AMS_STATE_DIR=/Users/dsh-runtime/.ams /Users/dsh-runtime/ams/.venv/bin/ams secret set qq-recorder QQ_RECORDER_TOKEN'
# 2. NapCat's OneBot token, copied from .env into the recorder's AMS secret
cd / && sudo -n -u dsh-runtime /bin/zsh -fc '/usr/bin/grep "^LSY_QQ_ONEBOT_TOKEN=" /Users/dsh-runtime/.dsh/.env | /usr/bin/cut -d= -f2- | AMS_STATE_DIR=/Users/dsh-runtime/.ams /Users/dsh-runtime/ams/.venv/bin/ams secret set qq-recorder LSY_QQ_ONEBOT_TOKEN'
# 3. Build and install (as lishuyu): builds DSH and the recorder bundle, pins the bundle, and places service.toml.
#    On this first install it does NOT start the recorder.
lsy/deploy/upgrade.sh
# 4. Both secrets must have values (exit 1 lists what is missing)
cd / && sudo -n -u dsh-runtime env AMS_STATE_DIR=/Users/dsh-runtime/.ams /Users/dsh-runtime/ams/.venv/bin/ams secret check qq-recorder
# 5. Switch DSH to the client build: from now on DSH never connects to NapCat (the two lines upgrade.sh printed)
sudo -n -u dsh-runtime /usr/bin/env PATH=/opt/homebrew/bin:/usr/bin:/bin /Users/Shared/lsy-dsh/current/lsy/deploy/setup-profile.sh /Users/dsh-runtime/.dsh /Users/Shared/lsy-dsh/current
sudo -n /bin/launchctl kickstart -k system/app.lishuyu.dsh-events
# 6. Start the recorder: AMS starts only the service that is new
cd / && sudo -n -u dsh-runtime env AMS_STATE_DIR=/Users/dsh-runtime/.ams /Users/dsh-runtime/ams/.venv/bin/ams ctl reload
```

The gap between steps 5 and 6 is about a minute in which nothing holds the connection; a message sent then is lost like one during any reconnect (the recorder reconnects quietly, without a backfill, when its state file says the last connection was alive under ten minutes ago). Later `upgrade.sh` runs pin the new bundle first and, because the declaration changed, reload AMS, which restarts the recorder alone. Check `ams secret list qq-recorder` shows both names (names only).

**Acceptance on the mini** (run once after the first install, as `dsh-runtime` where it says so):

1. `ams ctl status` lists `qq-recorder` running and healthy.
2. `sudo -n -u dsh-runtime /usr/sbin/lsof -nP -a -iTCP:3001 -sTCP:ESTABLISHED` shows exactly one connection, owned by the recorder's pid. Note its local port.
3. `sudo -n /bin/launchctl kickstart -k system/app.lishuyu.dsh-events`, wait 60 s: the pid and the local port are the same, the recorder's log shows no new `connected to the protocol end`, and the status (below) has the same `connection.since`.
4. In Settings → QQ the connection is green and the group list loads. Change `backfill.maxGroups` under **All settings** and save: the recorder logs `config applied … reconnect=false`, the lsof line does not change. Tick a group: `now recording group`.
5. Change `digest.everyHours` and save (DSH reloads the plugin): the lsof line does not change.
6. Ask the WeChat agent for `qq_recent`: it shows messages sent after the kickstart. DSH's log has `took over N digest(s)` once, and N is what the old `digests` table held.
7. `ams ctl stop qq-recorder`: within about 10 s Settings → QQ says the recorder is not running and the overview card is red. `ams ctl start qq-recorder` restores both.
8. After 24 h: no unexpected alert about `qq-recorder`, and QQ has not signed the account out.

The status, by hand (the token never leaves the shell): `sudo -n -u dsh-runtime /bin/zsh -fc 'set -a; . /Users/dsh-runtime/.dsh/.env; /usr/bin/curl -s --unix-socket /Users/dsh-runtime/.dsh/run/qq-recorder.sock -H "Authorization: Bearer $LSY_QQ_RECORDER_TOKEN" -H "X-Lsy-Protocol: qq-recorder/1.0" http://localhost/v1/status'`. Health, for AMS: `GET http://127.0.0.1:<PORT_health>/healthz` says only that the process is alive.

**Recover.**

- *Settings says the recorder is not running.* `ams ctl status` shows why. `ams ctl restart qq-recorder` restarts it (QQ reconnects quietly). AMS restarts it by itself after a crash and escalates after repeated failures; look at `ams escalations -n 5` and `/Users/dsh-runtime/logs/ams.out.log`.
- *Settings says the protocol version differs.* DSH and the recorder came from different builds: run `lsy/deploy/upgrade.sh` again (recorder first, then the two printed lines).
- *It cannot start.* `secret check` names a missing secret; `QQ_RECORDER_DATA_DIR` must be writable by `dsh-runtime`; another process holding the socket is refused (`already listens`).
- *Deploying.* `upgrade.sh` does it: the bundle is pinned under `/Users/Shared/lsy-dsh/qq-recorder.noindex/<fingerprint>/` (only the current build stays), the declaration names that file, and AMS restarts the recorder only when the declaration's bytes change. A DSH-only change never touches the recorder.

The pushed settings live in `/Users/dsh-runtime/.dsh/lsy-qq/recorder-config.json` (0600); the old digest tables inside `qq.db` stay frozen and are never deleted.

<a id="course-deadlines"></a>
## 20. Course deadlines (lsy-courses)

`lsy-courses` reads the owner's course records from the courses service (`https://api.lishuyu.app/courses`) every 15 minutes and messages the owner on WeChat before each deadline, at once when an on-time deadline passed while late submissions are open, and when the course sync stays broken. The agent answers "我还有什么 DDL" and "交了" with the `courses_*` tools. DSH reads the records and their sync health only; the sync agents run on other machines.

1. Mint a PAT for the service user with the audience (scope) `courses`, never `admin`, and append it to `/Users/dsh-runtime/.dsh/.env` as `LSY_COURSES_PAT` without printing it (back up the file first, as in step 19); check it with `sudo -n -u dsh-runtime /bin/zsh -fc 't=$(/usr/bin/grep "^LSY_COURSES_PAT=" /Users/dsh-runtime/.dsh/.env | /usr/bin/cut -d= -f2-); /usr/bin/curl -s -o /dev/null -w "%{http_code}\n" https://api.lishuyu.app/courses/v1/me -H "Authorization: Bearer $t"'`, which answers `200`. A new `.env` line needs a restart.
2. The bundle mounts `lsy-courses`, `lsy-courses-settings`, and `lsy-tool-courses` (unattended preset) with their defaults; owner values (checkpoints, quiet window, the switch) are edited in **Settings → 课程 DDL** and saved to the profile patch.
3. Check: the log shows `lsy-courses: reminders on, every 15 min, …` at start and `lsy-courses: poll (timer) ok in … ms: N open task(s), M reminder(s) …, sync <status>` every poll; **Settings → 课程 DDL** shows the last check, the sync health, and the next deadlines. **立即检查** runs one poll (it sends what is due).
4. Stop: turn **enabled** off in the page's settings card (the tools keep working), or `disabled: true` on the `lsy-courses` row in the profile patch. Sent reminders are in the storage domain `lsy_courses` (key per task, deadline, and checkpoint); deleting it re-sends the current checkpoint of every open task once.

## 21. Service code

The main agent may change and ship the code of the AMS services; the skill `service-code` (`lsy/skills/service-code`) is its map of sources, tests, deploys, and rollbacks. `deploy/grant-service-code.sh` sets this up, as the owner, without root:

- `apply` moves the source repos to `/Users/Shared/ams-src` (a symlink stays at the old path), starts a git history where there was none, and grants `dsh-runtime` read and write through ACLs there and on the deploy copies in `/Users/Shared/ams-apps`. Files named like credentials (`.env*`, `worker.env`, `.registry-secret`, `cookies.json*`, `message_token.txt`) get a deny entry. The owner's home stays 0700, because it holds world-readable `.env` files.
- `check` proves as `dsh-runtime` that it can clone, commit, push, and write the deploy copies, and that it reads no such file and cannot enter the owner's home.
- `revoke` removes the ACLs and moves the repos back. Files `dsh-runtime` created stay owned by it.

Deploy rsyncs use `-rlpc`, not `-a`: the copies hold files of both users, and only a file's owner may set its mtime, so `-a` ends with rc=23 and stops a `set -e` script.

Only the `unattended` preset has a shell, so only the WeChat main agent can use this; `up`, `bili`, `qqbot`, and `qq-digest` cannot (`packages/lsy/bili/tests/preset-isolation.spec.ts`). `lsy-taint` guards `cc_send` and `cc_start` only: `tool-bash` also runs in turns that are not clean, where the skill's rule that strangers' words are data is an instruction, not an enforcement. The owner's own services (`chrome-cookie-proxy`, `claude-rc-launcher`) are outside the grant.

**DSH itself.** The agent pushes to `lsy/main`, writes `lsy/main` or a commit into `/Users/dsh-runtime/.ams/services/dsh-upgrade/request`, and runs `ams ctl start dsh-upgrade`. From another machine `lsy/deploy/deploy-dsh.sh [--plan] [<commit>]` does the same with a pinned commit, says the path beforehand, refuses a commit that is not on `origin/lsy/main`, a dirty checkout, or a deploy already running, waits, and exits 0 only when that commit runs (`deploy/check-deploy-dsh.sh`). A request `start.sh` cannot act on, such as a commit nobody pushed, says so on stderr, which AMS escalates, and deploys nothing. The service runs in AMS because the restart ends everything under DSH and because AMS holds the volume grant for the build directory `/Volumes/MiniSSD/dsh-self` (checkout `wt`, `dist`, `pnpm-store`, `logs`). On its restart path `deploy/self-upgrade.sh` runs `upgrade.sh`, including `vitest run packages/lsy`, then `setup-profile.sh`, then TERMs the process, which launchd restarts because of `KeepAlive`, so no root is involved. A new process that does not answer and stay the same process for 60 s is rolled back, and a build that fails leaves `current` alone; the old build stays on disk only for that window, since the service runs from it until the restart, and goes once the new process is up. Only the build that runs stays, and only this commit's tarballs in `dist`. To go back, deploy the old commit: write it into `request` like any other. The outcome reaches the main agent as `operator.dsh-upgrade`, and a failure also exits non-zero for AMS. The recorder stays on its newer build through a rollback, which the protocol allows. One-time setup, in a session with the volume grant:

```sh
mkdir -p /Volumes/MiniSSD/dsh-self
chmod +a "dsh-runtime allow list,add_file,search,add_subdirectory,delete_child,readattr,writeattr,readextattr,writeextattr,readsecurity,writesecurity,delete,file_inherit,directory_inherit" /Volumes/MiniSSD/dsh-self
```

Then, as `dsh-runtime`, copy `deploy/dsh-upgrade/{service.toml,start.sh}` to `/Users/dsh-runtime/.ams/services/dsh-upgrade/` and run `ams ctl reload`. `deploy/check-self-upgrade.sh` checks both paths below and `start.sh` with the build, the restart, and the reconcile faked. `start.sh` is the installed copy: after changing it, copy it again.

`self-upgrade.sh` chooses by `git diff` against the commit that runs (`<current>/.hot-sha`, else the build directory's name):

- **Hot, no build.** Every changed path is one no process loads or one the deploy copies as it is: `docs/`, `.agents/`, a README or CHANGELOG, `lsy/skills/`, or `lsy/deploy/` other than `setup-profile.sh` and `qq-recorder/` (`deploy/deploy-paths.sh`). It copies the files and relinks the skills, in seconds, with no reconcile.
- **Hot.** Every changed path is a plugin's own file under `packages/lsy` (not its `package.json`), or under `lsy/` other than `deploy/setup-profile.sh`, `profiles/`, and `bundles/`. It builds and tests with `LSY_DSH_BUILD_ONLY=1` and packs only the plugins (`deploy/pack-hot-plugins.sh`; the whole release takes about three minutes for tarballs this path never opens), which installs no new prefix, replaces the changed plugins' files in the running build, and calls `pluginManager/setBundleEnabled` on the bundle that is already selected. That reconciles the profile with disk: the framework's HMR restarts the changed plugins and nothing else, and the process stays. `current` keeps its name, and `.hot-sha` records what the disk now holds. No copy of the old files is made, and HMR does not restore a version it stopped: a plugin that fails to start stays down, the deploy reports it and exits non-zero, and every later reconcile imports it again. Deploy a fix, or the old commit, which then goes the same way. Deploying the commit that failed again does nothing; only a restart would retry it. If the failed plugin is `lsy-wechat` or `owner-relay`, the report does not reach WeChat, so use the Web UI or SSH.
- **Restart.** Anything else, including a plugin a live agent holds, for which the reconcile answers `restart-required` (`unmanaged-plugin`). It waits until no Session has a running turn (`session/list`, at most 30 minutes, then restarts anyway and says so), then TERMs the process. Background jobs and monitors are not counted and end with the restart.

What the framework can replace live, measured with a model stream held open across each replacement:

| | Plugins |
|---|---|
| Hot | `lsy-wechat`, `owner-relay`, `lsy-voice`, `lsy-presence`, `lsy-guard`, `lsy-event-ingest`, `lsy-balance`, `lsy-sysmon`, `lsy-time-gap`, `lsy-config`, `lsy-console`, `lsy-cc-admin`, `lsy-qq-login`, `lsy-memory-admin`, and the `*-settings` pages |
| Restart: in the `unattended` preset, so an agent runs them | `lsy-tool-*`, `tool-bili`, `lsy-memory`, `lsy-taint`, `lsy-cc-bridge`, `lsy-style` |
| Restart: such a plugin imports code from them | `lsy-event-bus`, `lsy-qq`, `bili`, `lsy-courses`, `lsy-github-sensor`, `lsy-integrity` |

A resumed Session's agent stays alive until the process ends and nothing can release it, so these do not become hot by waiting. The reconcile decides at deploy time, so this table only says what to expect.

## 22. DAG workflows

The skill `dag-workflow` (`lsy/skills/dag-workflow`) tells the main agent how to use the `workflow` tool when the owner asks for it: order and parallelism come from the script body, with no scheduler helper in the prompt. It adds no plugin or tool: `workflow-ptc` and `tool-workflow` were already in the `unattended` preset, and `setup-profile.sh` links the skill into `$DSH_HOME/skills`. Other presets have no `workflow` tool. Runs appear in the chat as workflow cards and in the job list when backgrounded. Each child spends the route's daily limit. `packages/lsy/bili/tests/dag-workflow-skill.spec.ts` runs the example from `SKILL.md` through the real workflow guest.

Going back to a build older than the 2026-11-06 upstream sync: a Session that created a subagent on the newer build carries `subagent/catalog` version 3, which older releases refuse to open, so start a new Session for those chats.

## 23. Notification desk (message flow page, 通知台)

Host notices that are not urgent and autocut runs that wait for confirmation or failed reach one long Session, the `notify-funnel` subscription (agent preset `notify`: persona, time, compaction, no tools), which remembers earlier batches, merges repeats, and answers `NO_REPLY` unless the owner has something to do. Its result note goes out like any bus result: the owner's WeChat, held by `lsy-presence` while the owner sleeps. The bundle declares the subscription and the preset; nothing to install. It runs on the cheap route `opencode`, like `ci` and `qq-main`; `packages/lsy/bili/tests/bundle.spec.ts` pins the list.

- **Naming.** The bus gives an event to every subscription that matches, so `host-alerts` (urgent: `host.disk.full`, `host.*.critical`, straight to WeChat with no model) and `notify-funnel` (`host.*.warn`, `host.*.info`, `autocut.ready`, `autocut.failed`) must not overlap. Name a new host kind `host.<thing>.critical`, `.warn`, or `.info`; a kind outside both lists is stored and delivered to no one (`unmatched`). The urgent list has to equal `DEFAULT_URGENT_KINDS` of `lsy-presence`, because a Session's result note is not marked urgent and sleep would hold a disk-full alert until the owner wakes; `lsy-event-ingest/tests/funnel-bundle.spec.ts` pins both.
- **Check.** Push a notice as the `host` source: `curl -fsS -X POST http://127.0.0.1:3081/hooks/lsy -H "Authorization: Bearer $LSY_INGEST_TOKEN_HOST" -H 'content-type: application/json' -d '{"kind":"host.test.info","key":"desk-check-1","subject":"mini","title":"desk check"}'` (token from `.env` by shell substitution, never typed); **Settings → Subscriptions** shows `notify-funnel` with a batch after 10 minutes, and a `NO_REPLY` answer sends nothing.
- **Stop.** Pause `notify-funnel` in **Settings → Subscriptions**; its events wait, and nothing reaches WeChat from it.

## 24. Shared QQ main session (`qq-main`)

`lsy-qq` publishes each stored digest with something in it as `qq.digest.new` (source `qq`, subject: the group), and the `qq-main` subscription gives them to one long Session (agent preset `qq-main`: persona, time, compaction, no tools; route `opencode`). `session.quietResult` keeps its answers out of WeChat, and the QQ onebot exit stays unbuilt, so the Session reads and keeps the picture across groups. Batches are coalesced for 30 minutes, at most 2 an hour. **Settings → Subscriptions** shows it, and pausing it there stops the spending; digests keep working without it.

## 25. Local uploads and auto-repair (message flow page)

Two boxes of the message flow picture that ride on pieces already there.

- **Local upload** (`upload` ingest source, `upload-local` subscription). A video the owner made or recorded on another machine is announced to DSH as `upload.local.ready` (subject: the file's name; text: where the file is, its size, and whether the owner asked for an edit); the subscription starts a Session with the autocut skill, which decides whether the video needs cutting. Cutting: it opens a job and runs the pipelines of the skill, which stop at "waiting for the owner's confirmation". No cutting: it tells the owner in one line that the video is ready and asks whether to upload it; only the owner's yes starts the hand-over to kaorou (`ar confirm` with the owner's words, then `ar handoff --to kaorou`, visibility `self`). The confirmation gate of the autocut skill is not bypassed.
  1. Create the token on the Mac mini without printing it, as in §18 (back up `.env` first, `LSY_INGEST_TOKEN_UPLOAD`, restart afterwards), and give the same value to the sender on the other machine (a file readable by its owner only).
  2. The sender posts to `http://<mini tailnet address>:3081/hooks/lsy` with `Authorization: Bearer <token>` and the body `{"kind":"upload.local.ready","key":"<file name>-<mtime>","subject":"<file name>","title":"<one line>","text":"path: …\nsize: …\nedit requested: yes|no"}`. The sender script is the machine's own; nothing in this repository sends it.
  3. Check: **Settings → Subscriptions** shows `upload-local` with a batch five seconds after the post.
- **Auto-repair** (no subscription, no ingest source). A service's error reaches the main agent through the AMS journal Monitor (§17); the `ams-repair` skill (`lsy/skills/ams-repair`, linked into the home by `setup-profile.sh`) tells the agent when a fault is one Claude Code may fix (a clear cause in a service's code or configuration, a reversible change, a test that proves it) and when it only reports (credentials, quota, outages, a full disk, an unknown cause, a repeat), how to brief a `cc_start` session (a `repair/<service>-<date>` branch, tests, no push, no deploy, no restart, no credentials), and how to report in one or two sentences. Deploying and restarting wait for the owner's yes. Switch it off by removing the skill link from `$DSH_HOME/skills`.

## Operate

Patch edits (`$DSH_HOME/cordis.patch.yml`, the profile patch) reload live; `.env` edits need a restart; a new build hot-reloads or restarts as "DSH itself" describes. The composition is the `@deepseek-ai/dsh-lsy-event-bundle` layer linked from the build; the profile patch `profiles/event/cordis.patch.yml` is the owner's layer, where Web UI settings save, and upgrades keep it. A home patch entry replaces that entry's whole `config`, so override only entries whose config it restates in full, and the Web UI refuses to save an entry the home patch sets ("Configuration for … is overridden by a home patch").

| Task | Command |
|---|---|
| Change what is watched | Ask the agent on WeChat, or use Settings → Subscriptions and monitors (pause, resume, delete, create; reminders too) |
| See whether every service is up | Settings → Service overview (bili-svc, QQ, WeChat, voice, Claude Code, AMS intake, event bus, balance); its Manage links open each service's section |
| Start or stop a Claude Code session, try the voice | Settings → Claude Code and voice |
| Upgrade | `lsy/deploy/deploy-dsh.sh` from a checkout of the pushed commit (§21, "DSH itself"), which picks the hot path or the restart |
| Upgrade by hand: a first install, or `dsh-upgrade` cannot run | `lsy/deploy/upgrade.sh` (run it from a separate `git worktree` so the main tree stays editable; it keeps the new build and the one the service still runs from and deletes the rest, in `builds.noindex` or in the old layout directly under `/Users/Shared/lsy-dsh`), then `sudo -n -u dsh-runtime /Users/Shared/lsy-dsh/current/lsy/deploy/setup-profile.sh /Users/dsh-runtime/.dsh /Users/Shared/lsy-dsh/current`, `sudo -n launchctl kickstart -k system/app.lishuyu.dsh-events`, and once the service answers `lsy/deploy/prune-builds.sh /Users/Shared/lsy-dsh /Users/Shared/lsy-dsh/current/` to remove the replaced build |
| Go back | Deploy the old commit like any other (`git revert` and upgrade, or write the commit into `dsh-upgrade/request`); no old build is kept, and any commit rebuilds from git |
| Re-bind WeChat | Step 6 again; no restart needed |
| New chat Session (e.g. after a model change) | Send `/new` on WeChat |
| Stop | `sudo launchctl bootout system/app.lishuyu.dsh-events` |
| Status | `launchctl print system/app.lishuyu.dsh-events \| grep -E 'state\|pid'`; `tail /Users/dsh-runtime/logs/stdout.log` |
