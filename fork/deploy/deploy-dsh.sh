#!/bin/bash
# The way to deploy DSH from a checkout: says which path a commit will take, refuses what would deploy something else than you
# think, asks the AMS service dsh-upgrade to do it, waits, and exits 0 only when that commit is what runs.
# Runs on any machine with `ssh mini`, or on the mini as dsh-runtime.
# usage: fork/deploy/deploy-dsh.sh [--plan] [<commit>]     (default HEAD; --plan stops before deploying)
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
. "$HERE/deploy-paths.sh"
WAIT_S=${DSH_DEPLOY_WAIT_S:-2700}
POLL_S=${DSH_DEPLOY_POLL_S:-5}

die() { echo "deploy-dsh: $*" >&2; exit 1; }
say() { echo "deploy-dsh: $*"; }

# The service user's side, one word per action. Nothing here needs more than the service user.
remote_body() {
  cat <<'REMOTE'
set -euo pipefail
export HOME=/Users/dsh-runtime PATH=/Users/dsh-runtime/ams/.venv/bin:/opt/homebrew/bin:/usr/bin:/bin AMS_STATE_DIR=/Users/dsh-runtime/.ams
APPS=/Users/Shared/dsh
# The repo's dsh-upgrade/start.sh logs under the build volume; the copy installed on the mini logs beside stdout.log.
LOGS=/Volumes/MiniSSD/dsh-self/logs
SERVICE_LOGS=/Users/dsh-runtime/logs
case "$1" in
  commit) cat "$APPS/current/.hot-sha" 2>/dev/null || basename "$(readlink "$APPS/current")" ;;
  pid) pgrep -u "$(id -u)" -f '/@deepseek-ai/dsh/lib/bin\.js event' | head -1 || true ;;
  upgrade-status) ams ctl status 2>/dev/null | /usr/bin/python3 -I -c 'import json,sys; print(json.load(sys.stdin)["services"]["dsh-upgrade"]["status"])' ;;
  request)
    printf '%s\n' "$2" >/Users/dsh-runtime/.ams/services/dsh-upgrade/request
    ams ctl start dsh-upgrade >/dev/null
    ;;
  log)
    newest=$(ls -1t "$LOGS"/upgrade-*.log "$SERVICE_LOGS"/dsh-upgrade-*.log 2>/dev/null | head -1)
    echo "$newest"
    /usr/bin/grep -E '^[0-9-]+ [0-9:]+ dsh-upgrade:|^reconcile:' "$newest" | cut -c1-200 || tail -c 400 "$newest"
    ;;
esac
REMOTE
}

mini() {
  if [ "$(id -un)" = dsh-runtime ]; then
    remote_body | /bin/bash -s -- "$@"
  else
    remote_body | ssh -o ConnectTimeout=15 -o ServerAliveInterval=30 mini "cd /tmp && sudo -n -u dsh-runtime /bin/bash -s -- $*"
  fi
}

[ -z "${DSH_DEPLOY_TEST_HOOKS:-}" ] || . "$DSH_DEPLOY_TEST_HOOKS"

PLAN=
[ "${1:-}" != --plan ] || { PLAN=1; shift; }
TARGET=${1:-HEAD}
[ "$#" -le 1 ] || die "usage: deploy-dsh.sh [--plan] [<commit>]"

cd "$(git rev-parse --show-toplevel)"
git fetch -q origin main:refs/remotes/origin/main || die "cannot fetch origin main"
SHA=$(git rev-parse --verify -q "$TARGET^{commit}") || die "$TARGET is not a commit here"
SHORT=$(git rev-parse --short "$SHA")
[ "$TARGET" != HEAD ] || [ -z "$(git status --porcelain)" ] || die "the checkout has uncommitted changes, which would not deploy; commit them, or name the commit"
git merge-base --is-ancestor "$SHA" origin/main || die "$SHORT is not on origin/main; push it first (the last push may have failed)"

RUNNING=$(mini commit)
[ -n "$RUNNING" ] || die "cannot read what runs on the mini"
if [ "$(git rev-parse -q --verify "$RUNNING^{commit}" 2>/dev/null || true)" = "$SHA" ]; then
  say "$SHORT already runs; nothing to do"
  exit 0
fi

PATHS=$(mktemp)
trap 'rm -f "${PATHS:?}"' EXIT
REASON=$(restart_reason "$RUNNING" "$SHA" "$PATHS")
if [ -n "$REASON" ]; then
  say "plan: $RUNNING -> $SHORT by restart, once no turn runs: $REASON"
elif needs_build "$PATHS"; then
  say "plan: $RUNNING -> $SHORT hot: build, test, and reload the changed plugins; a plugin an agent holds still restarts"
else
  say "plan: $RUNNING -> $SHORT hot, no build: only docs, skills, or scripts changed"
fi
[ -z "$PLAN" ] || exit 0

# An SSH hiccup while waiting is not the end of the deploy, so only a state AMS reported ends the wait.
upgrade_running() {
  local status
  status=$(mini upgrade-status) || return 0
  case "$status" in stopped | failed) return 1 ;; *) return 0 ;; esac
}

! upgrade_running || die "another deploy is running, or AMS cannot say; see the newest upgrade log on the mini (/Users/dsh-runtime/logs/dsh-upgrade-*.log or /Volumes/MiniSSD/dsh-self/logs)"
PID_BEFORE=$(mini pid)
mini request "$SHA"
say "requested; waiting (log on the mini: /Users/dsh-runtime/logs/dsh-upgrade-*.log or /Volumes/MiniSSD/dsh-self/logs)"
START=$SECONDS
while upgrade_running; do
  [ $((SECONDS - START)) -lt "$WAIT_S" ] || die "still running after ${WAIT_S}s; see the log on the mini"
  sleep "$POLL_S"
done

mini log | sed 's/^/  /'
NOW=$(mini commit)
PID_AFTER=$(mini pid)
[ "$(git rev-parse -q --verify "$NOW^{commit}" 2>/dev/null || true)" = "$SHA" ] || die "the deploy ended but $NOW runs, not $SHORT"
say "$SHORT runs after $((SECONDS - START))s; process $([ "$PID_BEFORE" = "$PID_AFTER" ] && echo "kept ($PID_AFTER)" || echo "restarted ($PID_BEFORE -> $PID_AFTER)")"
