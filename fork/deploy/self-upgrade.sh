#!/bin/bash
# Build the current checkout and switch DSH to it, as the service user and without root: upgrade.sh, setup-profile.sh, then
# TERM the running process, which launchd restarts (KeepAlive). A build that does not stay up is rolled back by itself, and the
# main agent hears the outcome in a new turn. Runs from the AMS service dsh-upgrade (dsh-upgrade/start.sh), since the restart
# ends every process under DSH. Overridable for check-self-upgrade.sh.
set -euo pipefail
APPS=${DSH_UPGRADE_APPS:-/Users/Shared/fork-dsh}
WORK=${DSH_UPGRADE_WORK:-/Volumes/MiniSSD/dsh-self}
DSH_HOME=${DSH_UPGRADE_HOME:-/Users/dsh-runtime/.dsh}
URL=${DSH_UPGRADE_URL:-http://127.0.0.1:3081}
WAIT_S=${DSH_UPGRADE_WAIT_S:-180}
SETTLE_S=${DSH_UPGRADE_SETTLE_S:-60}

log() { printf '%s dsh-upgrade: %s\n' "$(date '+%F %T')" "$*"; }

run_upgrade() { FORK_DSH_DIST_ROOT="$WORK/dist" QQ_RECORDER_AS=env fork/deploy/upgrade.sh; }

setup_profile() { "$APPS/current/fork/deploy/setup-profile.sh" "$DSH_HOME" "$APPS/current"; }

dsh_pid() { pgrep -u "$(id -u)" -f '/@deepseek-ai/dsh/lib/bin\.js event' | head -1 || true; }

restart_dsh() {
  local pid
  pid=$(dsh_pid)
  [ -n "$pid" ] || { log "no running DSH to stop"; return 0; }
  log "stopping DSH: $(ps -o pid=,command= -p "$pid" | cut -c1-120)"
  kill -TERM "$pid"
}

answers() { curl -s -m 5 -o /dev/null "$URL/"; }

# Up means: another process than `old` answers, and is still the same process after SETTLE_S, so a crash loop does not pass.
wait_healthy() {
  local old="$1" deadline=$((SECONDS + WAIT_S)) pid=""
  while [ "$SECONDS" -lt "$deadline" ]; do
    pid=$(dsh_pid)
    if [ -n "$pid" ] && [ "$pid" != "$old" ] && answers; then
      sleep "$SETTLE_S"
      [ "$(dsh_pid)" = "$pid" ] && answers && { log "DSH is up as pid $pid"; return 0; }
    fi
    sleep 5
  done
  log "DSH did not stay up within ${WAIT_S}s"
  return 1
}

# The new turn this starts is how the agent learns the outcome: its own turn ended with the restart.
notify() {
  local token body
  token=$(/usr/bin/grep '^FORK_INGEST_TOKEN_OPERATOR=' "$DSH_HOME/.env" | cut -d= -f2-) || { log "no operator token; not notifying"; return 0; }
  body=$(/usr/bin/python3 -I -c 'import json,sys,time; print(json.dumps({"kind":"operator.dsh-upgrade","key":"dsh-upgrade-%d" % time.time(),"subject":"DSH 部署","title":sys.argv[1][:290],"text":"用一句话在微信告诉主人这个结果。"}))' "$1")
  curl -s -m 15 -o /dev/null -X POST "$URL/hooks/events" -H "Authorization: Bearer $token" -H 'Content-Type: application/json' -d "$body" || log "notify failed"
}

[ -z "${DSH_UPGRADE_TEST_HOOKS:-}" ] || . "$DSH_UPGRADE_TEST_HOOKS"

SHA=$(git rev-parse --short HEAD)
PREVIOUS=$(readlink "$APPS/current")
log "upgrading to $SHA from $(basename "$PREVIOUS")"

if ! run_upgrade; then
  [ "$(readlink "$APPS/current")" = "$PREVIOUS" ] || ln -sfn "$PREVIOUS" "$APPS/current"
  log "build of $SHA failed; the running DSH was not touched"
  notify "DSH 部署 ${SHA} 失败：构建或测试没过，线上版本没动。日志在 ${WORK}/logs。"
  exit 1
fi
if [ "$(readlink "$APPS/current")" = "$PREVIOUS" ]; then
  log "$SHA is already current"
  notify "DSH 已经是 ${SHA}，这次部署什么也没做。"
  exit 0
fi

OLD_PID=$(dsh_pid)
setup_profile
restart_dsh
if wait_healthy "$OLD_PID"; then
  notify "DSH 已部署到 ${SHA}，运行正常。回滚用的上一版是 $(basename "$PREVIOUS")。"
  log "done"
  exit 0
fi

log "rolling back to $PREVIOUS"
OLD_PID=$(dsh_pid)
ln -sfn "$PREVIOUS" "$APPS/current"
setup_profile
restart_dsh
if wait_healthy "$OLD_PID"; then
  notify "DSH 部署 ${SHA} 失败：新版本起不来，已自动回滚到 $(basename "$PREVIOUS")。日志在 ${WORK}/logs。"
else
  log "the rollback did not come up either"
fi
exit 1
