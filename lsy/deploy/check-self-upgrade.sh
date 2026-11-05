#!/bin/bash
# Regression check for self-upgrade.sh in a throwaway apps directory, with the build, the restart, and the health check faked:
# a healthy build stays, a build that does not come up is rolled back, a failed build leaves current alone, and a build that is
# already current restarts nothing.
# usage: check-self-upgrade.sh
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
WORK=$(mktemp -d "${TMPDIR:-/tmp}/lsy-self-upgrade.XXXXXX")
trap 'rm -rf "${WORK:?}"' EXIT
fail() { echo "check-self-upgrade: FAIL: $*" >&2; exit 1; }

cat >"$WORK/hooks.sh" <<'HOOKS'
run_upgrade() { echo upgrade >>"$CALLS"; eval "$FAKE_UPGRADE"; }
setup_profile() { echo "setup $(basename "$(readlink "$APPS/current")")" >>"$CALLS"; }
restart_dsh() { echo restart >>"$CALLS"; }
dsh_pid() { echo 1; }
wait_healthy() { echo health >>"$CALLS"; [ "$(basename "$(readlink "$APPS/current")")" != "$FAKE_BROKEN" ]; }
notify() { echo "notify $1" >>"$CALLS"; }
HOOKS

# run <name> <FAKE_UPGRADE> <FAKE_BROKEN>; leaves the exit code in RC and the call log in CALLS.
run() {
  APPS="$WORK/$1"
  mkdir -p "$APPS/old" "$APPS/new"
  ln -sfn "$APPS/old" "$APPS/current"
  CALLS="$WORK/$1.calls"
  : >"$CALLS"
  RC=0
  ( cd "$HERE" && APPS="$APPS" CALLS="$CALLS" FAKE_UPGRADE="$2" FAKE_BROKEN="$3" DSH_UPGRADE_APPS="$APPS" DSH_UPGRADE_WORK="$WORK/w" \
      DSH_UPGRADE_TEST_HOOKS="$WORK/hooks.sh" "$HERE/self-upgrade.sh" >/dev/null ) || RC=$?
}
now() { basename "$(readlink "$APPS/current")"; }
called() { /usr/bin/grep -q "$1" "$CALLS"; }

run healthy 'ln -sfn "$APPS/new" "$APPS/current"' none
[ "$RC" = 0 ] || fail "a healthy build must exit 0"
[ "$(now)" = new ] || fail "a healthy build must stay current"
called 'setup new' && called restart && called 'notify DSH 已部署' || fail "a healthy build must set up, restart, and report"

run broken 'ln -sfn "$APPS/new" "$APPS/current"' new
[ "$RC" != 0 ] || fail "a rollback must exit non-zero, so AMS escalates"
[ "$(now)" = old ] || fail "a build that does not come up must be rolled back"
called 'setup old' && called '自动回滚' || fail "a rollback must set up the old build and report"

run failed 'ln -sfn "$APPS/new" "$APPS/current"; false' none
[ "$RC" != 0 ] || fail "a failed build must exit non-zero"
[ "$(now)" = old ] || fail "a failed build must leave current as it was"
called restart && fail "a failed build must not restart DSH"
called '线上版本没动' || fail "a failed build must report"

run same ':' none
[ "$RC" = 0 ] || fail "a build that is already current must exit 0"
called restart && fail "a build that is already current must not restart DSH"

echo "check-self-upgrade: ok"
