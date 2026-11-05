#!/bin/bash
# Deploy the current checkout to DSH, as the service user and without root. Two paths, chosen by what changed since the commit
# that runs:
#   hot      only fork plugins' own files, skills, scripts, or docs: build and test, replace the changed plugins' files in the
#            running build, and have the framework's HMR restart just those plugins. The process, and every turn in it, stays.
#            No copy of the old files is made: a plugin that does not load stays down until a commit with good files is deployed.
#   restart  anything else, and plugins a live agent holds: wait until no turn runs, then TERM the process, which launchd restarts
#            (KeepAlive). A build that does not stay up is rolled back by itself, while the old build is still on disk.
# Afterwards only the build that runs is left; going back means deploying the old commit.
# The main agent hears the outcome in a new turn. Runs from the AMS service dsh-upgrade (dsh-upgrade/start.sh), since a restart
# ends every process under DSH. Overridable for check-self-upgrade.sh.
set -euo pipefail
APPS=${DSH_UPGRADE_APPS:-/Users/Shared/fork-dsh}
WORK=${DSH_UPGRADE_WORK:-/Volumes/MiniSSD/dsh-self}
DSH_HOME=${DSH_UPGRADE_HOME:-/Users/dsh-runtime/.dsh}
URL=${DSH_UPGRADE_URL:-http://127.0.0.1:3081}
WAIT_S=${DSH_UPGRADE_WAIT_S:-180}
SETTLE_S=${DSH_UPGRADE_SETTLE_S:-60}
DRAIN_S=${DSH_UPGRADE_DRAIN_S:-1800}
DRAIN_POLL_S=${DSH_UPGRADE_DRAIN_POLL_S:-10}
DSH_LOG=${DSH_UPGRADE_LOG:-/Users/dsh-runtime/logs/stdout.log}
# The reconcile needs a selected bundle to name; the selection itself does not change.
RECONCILE_BUNDLE=${DSH_UPGRADE_RECONCILE_BUNDLE:-@deepseek-ai/dsh-fork-event-bundle}
HERE=$(cd "$(dirname "$0")" && pwd)
STAGE=$WORK/hot-stage

log() { printf '%s dsh-upgrade: %s\n' "$(date '+%F %T')" "$*"; }

run_upgrade() { FORK_DSH_APPS="$APPS" FORK_DSH_DIST_ROOT="$WORK/dist" QQ_RECORDER_AS=env fork/deploy/upgrade.sh; }

run_build() { FORK_DSH_BUILD_ONLY=1 FORK_DSH_APPS="$APPS" FORK_DSH_DIST_ROOT="$WORK/dist" QQ_RECORDER_AS=env fork/deploy/upgrade.sh; }

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

# Nothing runs from the other builds any more, and a failure to remove them does not change how the deploy went.
prune_builds() { "$HERE/prune-builds.sh" "$APPS" "$1" || log "could not remove the other builds"; }

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

# Call a Remote of the running process and print the JSON answer. The token stays off the command line, where any local user
# could read it. usage: api <service/method> <args as JSON>
api() {
  local token jar rc=0
  token=$(/usr/bin/grep -a 'dsh web:' "$DSH_LOG" | tail -1 | sed -E 's/.*token=([^ &]+).*/\1/') || true
  [ -n "$token" ] || { log "no web token in $DSH_LOG" >&2; return 1; }
  jar=$(mktemp)
  printf 'url = "%s/connect?token=%s"\n' "$URL" "$token" | curl -s -m 15 -K - -o /dev/null -c "$jar" \
    && curl -s -m 300 -b "$jar" -X POST "$URL/api/$1" -H 'Content-Type: application/json' \
      -d "{\"type\":\"client-request\",\"rpcId\":\"self-upgrade\",\"method\":\"$1\",\"payload\":{\"args\":$2}}" || rc=$?
  rm -f "${jar:?}"
  return "$rc"
}

# Ask the running process to reload what changed on disk, through the plugin manager: selecting the bundle that is already
# selected changes nothing and reconciles the profile with disk. Returns 0 when it applied, 2 when the change waits for a restart,
# 1 when it failed or could not be asked.
reconcile() {
  local response
  response=$(api pluginManager/setBundleEnabled "{\"name\":\"$RECONCILE_BUNDLE\",\"enabled\":true}") || { log "the reconcile request failed"; return 1; }
  printf '%s' "$response" | /usr/bin/python3 -I -c '
import json, sys
try:
    result = json.load(sys.stdin)["result"]
except (ValueError, KeyError, TypeError):
    print("reconcile: unreadable answer"); sys.exit(1)
if not result.get("ok"):
    print("reconcile: refused:", str(result.get("error"))[:500]); sys.exit(1)
change = result.get("value") or {}
print("reconcile:", str({k: change.get(k) for k in ("application", "restartReason", "warnings", "failure", "error") if change.get(k)})[:800])
sys.exit(0 if change.get("application") == "applied" and not change.get("restartReason") else 2 if change.get("application") == "restart-required" else 1)'
}

# How many Sessions have a running turn; fails when the process cannot say.
turns_running() {
  api session/list '{"_request":{}}' | /usr/bin/python3 -I -c '
import json, sys
print(sum(1 for item in json.load(sys.stdin)["result"]["value"]["items"] if item.get("running")))'
}

# Hold a restart until no turn runs, so it ends none. Bounded: a turn that never ends must not hold a deploy forever, and DRAINED
# says what happened for the report.
drain_turns() {
  local deadline=$((SECONDS + DRAIN_S)) count
  DRAINED=
  while :; do
    count=$(turns_running) || { log "cannot read the running turns; restarting without waiting"; return 0; }
    [ "$count" != 0 ] || { log "no turn is running"; return 0; }
    if [ "$SECONDS" -ge "$deadline" ]; then
      log "$count turn(s) still running after ${DRAIN_S}s; restarting anyway"
      DRAINED="等了 $((DRAIN_S / 60)) 分钟仍有 ${count} 个回合没结束，被这次重启打断。"
      return 0
    fi
    log "waiting for $count running turn(s)"
    sleep "$DRAIN_POLL_S"
  done
}

# The commit the running build runs: a hot deploy keeps the build directory, so its name stops telling.
running_commit() { cat "$APPS/current/.hot-sha" 2>/dev/null || basename "$(readlink "$APPS/current")"; }

# Whether a changed path reaches the process only through a plugin's own files, or not at all.
hot_path() {
  case "$1" in
    packages/fork/*/package.json | fork/deploy/setup-profile.sh | fork/profiles/* | fork/bundles/*) return 1 ;;
    packages/fork/* | fork/*) return 0 ;;
    *) return 1 ;;
  esac
}

# Prints why this change needs the restart path, or nothing when it can be replaced live.
restart_reason() {
  local path
  git cat-file -e "$1^{commit}" 2>/dev/null || { echo "$1 is not in this checkout's history"; return 0; }
  git diff --no-renames --name-only "$1" HEAD >"$WORK/hot-paths"
  while IFS= read -r path; do
    hot_path "$path" || { echo "$path changed"; return 0; }
  done <"$WORK/hot-paths"
}

# Unpack this build's plugin tarballs and list in $STAGE/changed the ones that differ from what runs, as <name> <unpacked dir>.
# Fails, with the reason in REASON, when a difference cannot be replaced live.
stage_plugins() {
  local tarball unpacked name target
  rm -rf "${STAGE:?}"
  mkdir -p "$STAGE"
  : >"$STAGE/changed"
  for tarball in "$WORK/dist/$SHA/dsh"/deepseek-ai-dsh-fork-*.tgz "$WORK/dist/$SHA/dsh"/deepseek-ai-dsh-bili-*.tgz \
      "$WORK/dist/$SHA/dsh"/deepseek-ai-dsh-tool-bili-*.tgz "$WORK/dist/$SHA/dsh"/deepseek-ai-dsh-owner-relay-*.tgz; do
    [ -f "$tarball" ] || continue
    unpacked="$STAGE/$(basename "$tarball" .tgz)"
    mkdir -p "$unpacked"
    /usr/bin/tar -xzf "$tarball" -C "$unpacked"
    name=$(/usr/bin/python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["name"])' "$unpacked/package/package.json")
    target="$APPS/current/node_modules/$name"
    [ -d "$target" ] || { REASON="$name is new"; return 1; }
    /usr/bin/diff -rq -x node_modules "$unpacked/package" "$target" >/dev/null && continue
    cmp -s "$unpacked/package/package.json" "$target/package.json" || { REASON="the manifest of $name changed"; return 1; }
    printf '%s %s\n' "$name" "$unpacked" >>"$STAGE/changed"
  done
}

replace_running() {
  local name unpacked
  # A plugin imports only when the reconcile starts it, so a file swapped ahead of that is not half-read.
  while read -r name unpacked; do
    log "replacing $name"
    /usr/bin/rsync -rlpc --delete --exclude node_modules "$unpacked/package/" "$APPS/current/node_modules/$name/"
  done <"$STAGE/changed"
  "$HERE/install-fork-files.sh" "$(git rev-parse --show-toplevel)" "$APPS/current"
}

# Report a hot deploy that did not hold, and stop. HMR does not bring back a version it stopped and no old files are kept, so the
# way out is another deploy, of a fix or of the old commit. usage: hot_failed <what went wrong>
hot_failed() {
  log "the hot deploy of $SHA failed: $1"
  notify "DSH 热更新 ${SHA} 失败：$1。修好后再部署，或部署 ${RUNNING} 回到旧代码。日志在 ${WORK}/logs。"
  exit 1
}

# The hot path past the build; exits with the outcome.
hot_deploy() {
  local names old rc=0
  names=$(cut -d' ' -f1 "$STAGE/changed" | sed 's#@deepseek-ai/dsh-##' | tr '\n' ' ' | sed 's/ $//')
  log "hot path: replacing [${names}]"
  old=$(dsh_pid)
  replace_running
  # The disk holds this commit from here on, whatever happens next; the next deploy compares against that.
  printf '%s\n' "$SHA" >"$APPS/current/.hot-sha"
  setup_profile
  if [ -s "$STAGE/changed" ]; then reconcile || rc=$?; fi
  if [ "$rc" = 0 ]; then
    sleep "$SETTLE_S"
    if [ "$(dsh_pid)" = "$old" ] && answers; then
      if [ -n "$names" ]; then
        notify "DSH 已热更新到 ${SHA}：替换了 ${names}，进程没重启。"
      else
        notify "DSH 已热更新到 ${SHA}：这次没有插件代码变化，进程没动。"
      fi
      log "done, still pid $old"
      exit 0
    fi
    hot_failed "进程在替换后退出了"
  fi
  if [ "$rc" = 2 ]; then
    log "the change waits for a restart; restarting on the new files once no turn runs"
    drain_turns
    old=$(dsh_pid)
    restart_dsh
    if wait_healthy "$old"; then
      notify "DSH 已部署到 ${SHA}：这次改动有活着的 agent 在用，没法热更新，等回合结束后重启了进程，运行正常。${DRAINED}"
      log "done"
      exit 0
    fi
    hot_failed "重启后起不来"
  fi
  hot_failed "新插件没能加载，修好之前它不运行"
}

[ -z "${DSH_UPGRADE_TEST_HOOKS:-}" ] || . "$DSH_UPGRADE_TEST_HOOKS"

SHA=$(git rev-parse --short HEAD)
PREVIOUS=$(readlink "$APPS/current")
RUNNING=$(running_commit)
log "upgrading to $SHA from $RUNNING"
mkdir -p "$WORK"

if [ "$(git rev-parse -q --verify "$RUNNING^{commit}" 2>/dev/null || true)" = "$(git rev-parse HEAD)" ]; then
  log "$SHA is already running"
  notify "DSH 已经是 ${SHA}，这次部署什么也没做。"
  exit 0
fi

REASON=$(restart_reason "$RUNNING")
if [ -z "$REASON" ]; then
  log "only plugin files changed since $RUNNING; building for the hot path"
  if ! run_build; then
    log "build of $SHA failed; the running DSH was not touched"
    notify "DSH 部署 ${SHA} 失败：构建或测试没过，线上版本没动。日志在 ${WORK}/logs。"
    exit 1
  fi
  stage_plugins && hot_deploy
fi
log "restart path: $REASON"

if ! run_upgrade; then
  [ "$(readlink "$APPS/current")" = "$PREVIOUS" ] || ln -sfn "$PREVIOUS" "$APPS/current"
  prune_builds "$PREVIOUS"
  log "build of $SHA failed; the running DSH was not touched"
  notify "DSH 部署 ${SHA} 失败：构建或测试没过，线上版本没动。日志在 ${WORK}/logs。"
  exit 1
fi
if [ "$(readlink "$APPS/current")" = "$PREVIOUS" ]; then
  log "$SHA is already current"
  notify "DSH 已经是 ${SHA}，这次部署什么也没做。"
  exit 0
fi

setup_profile
drain_turns
OLD_PID=$(dsh_pid)
restart_dsh
if wait_healthy "$OLD_PID"; then
  prune_builds "$(readlink "$APPS/current")"
  notify "DSH 已部署到 ${SHA}，重启了进程（${REASON}），运行正常。${DRAINED}"
  log "done"
  exit 0
fi

log "rolling back to $PREVIOUS"
OLD_PID=$(dsh_pid)
ln -sfn "$PREVIOUS" "$APPS/current"
setup_profile
restart_dsh
if wait_healthy "$OLD_PID"; then
  prune_builds "$PREVIOUS"
  notify "DSH 部署 ${SHA} 失败：新版本起不来，已自动回滚到 $(basename "$PREVIOUS")。日志在 ${WORK}/logs。"
else
  log "the rollback did not come up either"
fi
exit 1
