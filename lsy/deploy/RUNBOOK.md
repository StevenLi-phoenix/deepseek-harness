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
| `/tmp/dsh-wechat/` | dsh-runtime, 700 | Scratch directory of the WeChat chat Session; `lsy-wechat` recreates it before each message, since a restart empties `/tmp` |
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
cd / && sudo -u dsh-runtime /usr/bin/env HOME=/Users/dsh-runtime PATH=/opt/homebrew/bin:/usr/bin:/bin /bin/zsh -fc '/usr/bin/sed -n "s/^LSY_GITHUB_TOKEN=//p" ~/.dsh/.env | gh auth login --hostname github.com --git-protocol https --insecure-storage --with-token && gh auth setup-git --hostname github.com && git config --global user.name "Steven Li (dsh)" && git config --global user.email lishuyustevenli@163.com && gh auth status'
```

The agent runs as `dsh-runtime`, so it can read `.env` and `~/.config/gh/hosts.yml` (plain text: a daemon user has no unlocked keychain). Keep each key scoped so that a leak costs little.

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

## Operator access without passwords (optional)

`/etc/sudoers.d/dsh-events` (root:wheel 440, written with `sudo visudo -f /etc/sudoers.d/dsh-events`) lets the operator act as the service user and restart the daemon without a password, so config edits, `.env` changes, and upgrades need no one at the keyboard:

```
lishuyu ALL = (dsh-runtime) NOPASSWD: ALL
lishuyu ALL = (root) NOPASSWD: /bin/launchctl kickstart -k system/app.lishuyu.dsh-events
```

Acting as `dsh-runtime` is a step down from `lishuyu`; root is limited to the one restart.

## Operate

Patch edits (`$DSH_HOME/cordis.patch.yml`, the profile patch) reload live; `.env` edits and new builds need a restart. The composition is the `@deepseek-ai/dsh-lsy-event-bundle` layer linked from the build; the profile patch `profiles/event/cordis.patch.yml` is the owner's layer, where Web UI settings save, and upgrades keep it. A home patch entry replaces that entry's whole `config`, so override only entries whose config it restates in full, and the Web UI refuses to save an entry the home patch sets ("Configuration for … is overridden by a home patch").

| Task | Command |
|---|---|
| Change what is watched | Ask the agent on WeChat |
| Upgrade | `lsy/deploy/upgrade.sh`, then `sudo -n -u dsh-runtime /Users/Shared/lsy-dsh/current/lsy/deploy/setup-profile.sh /Users/dsh-runtime/.dsh /Users/Shared/lsy-dsh/current` and `sudo -n launchctl kickstart -k system/app.lishuyu.dsh-events` |
| Roll back | `ln -sfn /Users/Shared/lsy-dsh/<old sha> /Users/Shared/lsy-dsh/current`, then the two commands above |
| Re-bind WeChat | Step 6 again; no restart needed |
| New chat Session (e.g. after a model change) | Send `/new` on WeChat |
| Stop | `sudo launchctl bootout system/app.lishuyu.dsh-events` |
| Status | `launchctl print system/app.lishuyu.dsh-events \| grep -E 'state\|pid'`; `tail /Users/dsh-runtime/logs/stdout.log` |
