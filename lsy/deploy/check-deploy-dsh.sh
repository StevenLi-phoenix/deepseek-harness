#!/bin/bash
# Regression check for deploy-dsh.sh against a throwaway origin, with the mini faked: it says the path beforehand, it refuses what
# would deploy something else than was meant, and it reports success only when that commit is what runs.
# usage: check-deploy-dsh.sh
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
WORK=$(mktemp -d "${TMPDIR:-/tmp}/lsy-deploy-dsh.XXXXXX")
trap 'rm -rf "${WORK:?}"' EXIT
fail() { echo "check-deploy-dsh: FAIL: $*" >&2; exit 1; }

cat >"$WORK/hooks.sh" <<'HOOKS'
mini() {
  echo "mini $*" >>"$CALLS"
  case "$1" in
    commit) cat "$STATE/commit" ;;
    pid) cat "$STATE/pid" ;;
    log) echo /fake/log; echo 'dsh-upgrade: done' ;;
    upgrade-status)
      local word
      word=$(cut -d' ' -f1 <"$STATE/status")
      [ "$(cat "$STATE/status")" = "$word" ] || cut -d' ' -f2- <"$STATE/status" >"$STATE/status.new"
      [ ! -f "$STATE/status.new" ] || mv "$STATE/status.new" "$STATE/status"
      [ "$word" != lost ] || return 255
      echo "$word"
      ;;
    request) [ -n "${FAKE_NO_EFFECT:-}" ] || git -C "$CHECKOUT" rev-parse --short "$2" >"$STATE/commit" ;;
  esac
}
HOOKS

git init -q --bare -b lsy/main "$WORK/origin.git"
CHECKOUT="$WORK/checkout"
git clone -q "$WORK/origin.git" "$CHECKOUT" 2>/dev/null
G() { git -C "$CHECKOUT" -c user.name=c -c user.email=c@localhost "$@"; }
G checkout -q -b lsy/main
mkdir -p "$CHECKOUT/lsy/deploy"
cp "$HERE/deploy-dsh.sh" "$HERE/deploy-paths.sh" "$CHECKOUT/lsy/deploy/"
G add -A; G commit -q -m base; G push -q origin lsy/main
BASE=$(G rev-parse --short HEAD)
# change <path>: a pushed commit touching <path>.
change() { mkdir -p "$CHECKOUT/$(dirname "$1")"; echo "$RANDOM" >>"$CHECKOUT/$1"; G add -A; G commit -q -m "change $1"; G push -q origin lsy/main; }

# deploy <args...>: from a fresh state running $BASE; leaves the exit code in RC, the output in OUT, the calls in CALLS.
STATE="$WORK/state"
CALLS="$WORK/calls"
deploy() {
  rm -rf "${STATE:?}"
  mkdir -p "$STATE"
  echo "${FAKE_RUNNING:-$BASE}" >"$STATE/commit"
  echo 7 >"$STATE/pid"
  echo "${FAKE_STATUS:-stopped running stopped}" >"$STATE/status"
  : >"$CALLS"
  RC=0
  OUT=$( cd "$CHECKOUT" && env CALLS="$CALLS" STATE="$STATE" CHECKOUT="$CHECKOUT" DSH_DEPLOY_POLL_S=0 DSH_DEPLOY_TEST_HOOKS="$WORK/hooks.sh" \
    "$CHECKOUT/lsy/deploy/deploy-dsh.sh" "$@" 2>&1 ) || RC=$?
}
said() { printf '%s' "$OUT" | /usr/bin/grep -q "$1"; }
requested() { /usr/bin/grep -q '^mini request' "$CALLS"; }

deploy
[ "$RC" = 0 ] || fail "what already runs must exit 0: $OUT"
said 'already runs' || fail "what already runs must say so: $OUT"
requested && fail "what already runs must not deploy"

change docs/guide.md
deploy --plan
[ "$RC" = 0 ] && said 'hot, no build' || fail "a docs change must plan no build: $OUT"
requested && fail "--plan must not deploy"

change packages/lsy/lsy-demo/src/index.ts
deploy --plan
said 'hot: build' || fail "a plugin change must plan the hot path: $OUT"

change packages/boot/hmr/src/index.ts
deploy --plan
said 'by restart.*packages/boot/hmr/src/index.ts' || fail "a framework change must plan the restart and name why: $OUT"

deploy
[ "$RC" = 0 ] || fail "a pushed commit must deploy: $OUT"
requested || fail "a pushed commit must be requested"
/usr/bin/grep -q "^mini request $(G rev-parse HEAD)$" "$CALLS" || fail "the request must pin the full commit, not the branch: $(cat "$CALLS")"
said "$(G rev-parse --short HEAD) runs" || fail "a deploy that took must say what runs: $OUT"

FAKE_STATUS='stopped running lost lost running stopped' deploy
[ "$RC" = 0 ] || fail "losing the connection while waiting must keep waiting: $OUT"

FAKE_NO_EFFECT=1 deploy
[ "$RC" != 0 ] || fail "a deploy that ended with something else running must fail, not report success"
said 'runs, not' || fail "a deploy that ended with something else running must say so: $OUT"

FAKE_STATUS=running deploy
[ "$RC" != 0 ] || fail "a deploy already running must refuse"
requested && fail "a deploy already running must not be overwritten"

FAKE_STATUS=lost deploy
[ "$RC" != 0 ] && ! requested || fail "when AMS cannot say whether a deploy runs, it must not start another"

# The push that failed: HEAD is ahead of origin, and deploying would ship the old commit.
echo x >>"$CHECKOUT/local.txt"; G add -A; G commit -q -m unpushed
deploy
[ "$RC" != 0 ] || fail "an unpushed commit must refuse"
said 'push it first' || fail "an unpushed commit must say what to do: $OUT"
requested && fail "an unpushed commit must not deploy"
G reset -q --hard origin/lsy/main

echo x >>"$CHECKOUT/docs/guide.md"
deploy
[ "$RC" != 0 ] || fail "uncommitted changes must refuse"
said 'uncommitted' || fail "uncommitted changes must say so: $OUT"
requested && fail "uncommitted changes must not deploy"
deploy "$(G rev-parse HEAD)"
[ "$RC" = 0 ] || fail "naming the commit must deploy it despite uncommitted changes: $OUT"
G checkout -q -- docs/guide.md

echo "check-deploy-dsh: ok"
