# Event service runbook (Mac mini)

Runs the fork as a second dsh instance — the event service — under a dedicated, non-admin macOS user `dsh-runtime`, on `127.0.0.1:3081`, started by a LaunchDaemon. The interactive instance (`app.lishuyu.dsh`, `~/.dsh`, port 3080) is untouched.

Every `sudo` line is meant to be run by hand, one at a time. The agent in this service runs without approval prompts (`danger-full-access`), so the account boundary below is the isolation: it must hold before the first event arrives.

## Layout

| Path | Owner | Contents |
|---|---|---|
| `/Users/Shared/lsy-dsh/<sha>/` | lishuyu, 755 | Installed build (≈1.6 GB); `dsh-runtime` can read, not write |
| `/Users/Shared/lsy-dsh/current` | lishuyu | Symlink to the active build |
| `/Users/Shared/lsy-dsh/routing.patch.yml` | lishuyu, 644 | Routing layer: subscriptions, repositories, chat id |
| `/Users/dsh-runtime/.dsh/` | dsh-runtime, 700 | `DSH_HOME`: profile, sessions, storages, `.env` secrets |
| `/Users/dsh-runtime/.dsh/cordis.patch.yml` | dsh-runtime | Symlink to `routing.patch.yml` |
| `/Users/dsh-runtime/work/` | dsh-runtime | Workspaces for event Sessions |
| `/Users/dsh-runtime/Library/Logs/dsh-events/` | dsh-runtime | `stdout.log`, `stderr.log` |
| `/Library/LaunchDaemons/app.lishuyu.dsh-events.plist` | root:wheel 644 | Service definition (from `app.lishuyu.dsh-events.plist`) |

## 0. Decide how to handle `/Volumes/MiniSSD`

`diskutil info /Volumes/MiniSSD` reports `Owners: Disabled` (mounted `noowners`): every local user acts as the owner of every file there, so `dsh-runtime` could read and write kaorou data, backups, and other projects. Pick one before step 3:

- **A — enable ownership (recommended).** Stop kaorou, then `sudo diskutil enableOwnership /Volumes/MiniSSD`, then `sudo chown -R lishuyu:staff /Volumes/MiniSSD`, then start kaorou. Files written while ownership was off are stored as `_unknown` (99), which is why the `chown` is required. Guest SMB clients of the `MiniSSD` share lose write access afterwards.
- **B — accept the exposure** and rely on the agent instructions only.

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
cp lsy/profiles/event/home.patch.example.yml /Users/Shared/lsy-dsh/routing.patch.yml   # then edit the routing
chmod 644 /Users/Shared/lsy-dsh/routing.patch.yml
lsy/deploy/upgrade.sh          # builds, tests, packs, installs, points current at it
```

## 4. Prepare the service home

```sh
sudo -u dsh-runtime mkdir -p /Users/dsh-runtime/.dsh /Users/dsh-runtime/work /Users/dsh-runtime/Library/Logs/dsh-events
sudo -u dsh-runtime chmod 700 /Users/dsh-runtime/.dsh
sudo -u dsh-runtime ln -s /Users/Shared/lsy-dsh/routing.patch.yml /Users/dsh-runtime/.dsh/cordis.patch.yml
sudo -u dsh-runtime /Users/lishuyu/Codes/deepseek-harness/lsy/deploy/setup-profile.sh /Users/dsh-runtime/.dsh /Users/Shared/lsy-dsh/current
```

## 5. Secrets (typed in your terminal, never pasted into a chat)

Use keys that belong to this service only: a separate DeepSeek key, a fine-grained **read-only** GitHub token, a classic token with **only** the `notifications` scope, and the Telegram bot token.

```sh
sudo -u dsh-runtime sh -c 'umask 077; cat >> /Users/dsh-runtime/.dsh/.env'
# paste, then Ctrl-D:
# DEEPSEEK_API_KEY=...
# LSY_GITHUB_TOKEN=...
# LSY_GITHUB_NOTIFICATIONS_TOKEN=...
# LSY_TELEGRAM_BOT_TOKEN=...
```

Everything in this file is readable by the agent (it runs as `dsh-runtime`); that is why each token must be scoped so that a leak costs little.

## 6. Start the service

```sh
sudo cp lsy/deploy/app.lishuyu.dsh-events.plist /Library/LaunchDaemons/
sudo chown root:wheel /Library/LaunchDaemons/app.lishuyu.dsh-events.plist
sudo chmod 644 /Library/LaunchDaemons/app.lishuyu.dsh-events.plist
sudo launchctl bootstrap system /Library/LaunchDaemons/app.lishuyu.dsh-events.plist
```

## 7. Verify

```sh
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3081/               # 401 = up
sudo tail -n 30 /Users/dsh-runtime/Library/Logs/dsh-events/stdout.log         # sensor and bus lines
sudo -u dsh-runtime cat /Users/lishuyu/.env                                    # must fail: Permission denied
sudo -u dsh-runtime ls /Users/lishuyu/.ssh                                     # must fail: Permission denied
sudo -u dsh-runtime touch /Users/Shared/lsy-dsh/current/x                     # must fail: Permission denied
sudo -u dsh-runtime touch /Volumes/MiniSSD/x                                   # must fail after step 0 option A
```

Logs written before the console logger loads (the first second) are not printed; storage under `/Users/dsh-runtime/.dsh/storages/lsy_*.json` shows sensor cursors and bus events.

## 8. Web access (optional)

The first-login URL is printed to stdout: `sudo grep -o 'http://127.0.0.1:3081/?token=[^ ]*' /Users/dsh-runtime/Library/Logs/dsh-events/stdout.log | tail -1`. To reach it from other tailnet devices, publish a Tailscale Service the same way as `svc:dsh`, approve it in the admin console, and keep the plist's `--trusted-host` in sync:

```sh
/Applications/Tailscale.app/Contents/MacOS/Tailscale serve --service=svc:dsh-events --https=443 http://127.0.0.1:3081
/Applications/Tailscale.app/Contents/MacOS/Tailscale serve advertise svc:dsh-events
```

## Operate

| Task | Command |
|---|---|
| Change routing | edit `/Users/Shared/lsy-dsh/routing.patch.yml`, then `sudo launchctl kickstart -k system/app.lishuyu.dsh-events` |
| Upgrade | `lsy/deploy/upgrade.sh`, then the two commands it prints |
| Roll back | `ln -sfn /Users/Shared/lsy-dsh/<old sha> /Users/Shared/lsy-dsh/current`, then kickstart |
| Stop | `sudo launchctl bootout system/app.lishuyu.dsh-events` |
| Status | `sudo launchctl print system/app.lishuyu.dsh-events \| grep -E 'state\|pid'` |
