#!/bin/bash
# Regression check for self-upgrade.sh in a throwaway apps directory, with the build, the restart, and the health check faked:
# a healthy build stays, a build that does not come up is rolled back, a failed build leaves current alone, and a build that is
# already current restarts nothing. The hot path runs for real on files in a throwaway repository and build, with only the
# reconcile faked: a plugin change replaces the running files and keeps the process, anything else takes the restart, a
# replacement that does not hold is reported and keeps no old copy, and deploying the old commit then goes back.
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
prune_builds() { echo "prune $(basename "$1")" >>"$CALLS"; }
dsh_pid() { echo 1; }
turns_running() { echo drain >>"$CALLS"; echo 0; }
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
[ "$(/usr/bin/grep -n drain "$CALLS" | head -1 | cut -d: -f1)" -lt "$(/usr/bin/grep -n restart "$CALLS" | head -1 | cut -d: -f1)" ] || fail "a restart must wait for running turns first"
called 'prune new' || fail "a healthy build must remove the build it replaced"
[ "$(/usr/bin/grep -n health "$CALLS" | head -1 | cut -d: -f1)" -lt "$(/usr/bin/grep -n prune "$CALLS" | head -1 | cut -d: -f1)" ] || fail "the old build must stay until the new process is up"
called '上一版' && fail "a healthy build must not name a rollback build that is gone"

run broken 'ln -sfn "$APPS/new" "$APPS/current"' new
[ "$RC" != 0 ] || fail "a rollback must exit non-zero, so AMS escalates"
[ "$(now)" = old ] || fail "a build that does not come up must be rolled back"
called 'setup old' && called '自动回滚' || fail "a rollback must set up the old build and report"
called 'prune old' || fail "a rollback must remove the build that did not come up"
called 'prune new' && fail "a rollback must keep the build it went back to"

run failed 'ln -sfn "$APPS/new" "$APPS/current"; false' none
[ "$RC" != 0 ] || fail "a failed build must exit non-zero"
[ "$(now)" = old ] || fail "a failed build must leave current as it was"
called restart && fail "a failed build must not restart DSH"
called '线上版本没动' || fail "a failed build must report"
called 'prune old' || fail "a failed build must remove what it installed"

run same ':' none
[ "$RC" = 0 ] || fail "a build that is already current must exit 0"
called restart && fail "a build that is already current must not restart DSH"
called prune && fail "a build that is already current must remove nothing"

cat >"$WORK/hot-hooks.sh" <<'HOOKS'
run_upgrade() { echo upgrade >>"$CALLS"; ln -sfn "$APPS/builds.noindex/cold" "$APPS/current"; }
run_build() {
  echo build >>"$CALLS"
  [ -z "$FAKE_BUILD_FAILS" ] || return 1
  rm -rf "$WORK/dist/$SHA"
  mkdir -p "$WORK/dist/$SHA/hot" "$WORK/pack/package/lib"
  echo "$FAKE_LIB" >"$WORK/pack/package/lib/index.js"
  echo "$FAKE_MANIFEST" >"$WORK/pack/package/package.json"
  COPYFILE_DISABLE=1 tar -czf "$WORK/dist/$SHA/hot/deepseek-ai-dsh-lsy-demo-1.0.0.tgz" -C "$WORK/pack" package
  rm -rf "$WORK/pack"
}
setup_profile() { echo setup >>"$CALLS"; }
restart_dsh() { echo restart >>"$CALLS"; }
prune_builds() { echo "prune $(basename "$1")" >>"$CALLS"; }
dsh_pid() { echo "$FAKE_PIDS" | cut -d' ' -f"$(cat "$CALLS.pids")"; echo $(($(cat "$CALLS.pids") + 1)) >"$CALLS.pids"; }
answers() { :; }
# The running-turn counts the deploy sees, one per call; the last repeats. "x" means the count could not be read.
turns_running() {
  local word
  word=$(cut -d' ' -f1 <"$CALLS.turns")
  echo "turns $word" >>"$CALLS"
  [ "$(cat "$CALLS.turns")" = "$word" ] || cut -d' ' -f2- <"$CALLS.turns" >"$CALLS.turns.new"
  [ ! -f "$CALLS.turns.new" ] || mv "$CALLS.turns.new" "$CALLS.turns"
  [ "$word" != x ] || return 1
  echo "$word"
}
wait_healthy() { echo health >>"$CALLS"; [ -z "$FAKE_UNHEALTHY" ]; }
# One word per call: applied, failed, or pending; the last repeats.
reconcile() {
  local word
  word=$(echo "$FAKE_RECONCILE" | cut -d' ' -f1)
  echo "reconcile $word $(cat "$APPS/current/node_modules/@deepseek-ai/dsh-lsy-demo/lib/index.js")" >>"$CALLS"
  [ "$FAKE_RECONCILE" = "$word" ] || FAKE_RECONCILE=${FAKE_RECONCILE#* }
  case "$word" in applied) return 0 ;; pending) return 2 ;; *) return 1 ;; esac
}
notify() { echo "notify $1" >>"$CALLS"; }
HOOKS

# hot <name> <changed path> [VAR=value ...]: a build with the old plugin, a checkout one commit ahead changing <changed path>.
# A running file that nobody changed, a nested dependency, and a skill must survive or follow as the case says.
hot() {
  local name="$1" path="$2"
  shift 2
  APPS="$WORK/$name"
  CALLS="$WORK/$name.calls"
  : >"$CALLS"
  echo 1 >"$CALLS.pids"
  echo "${HOT_TURNS:-0}" >"$CALLS.turns"
  REPO="$WORK/$name.repo"
  mkdir -p "$REPO"
  git -C "$REPO" init -q
  git -C "$REPO" -c user.name=c -c user.email=c@localhost commit -q --allow-empty -m base
  BASE=$(git -C "$REPO" rev-parse --short HEAD)
  mkdir -p "$REPO/$(dirname "$path")" "$REPO/lsy/skills/demo"
  echo new >"$REPO/$path"
  echo new-skill >"$REPO/lsy/skills/demo/SKILL.md"
  git -C "$REPO" add -A
  git -C "$REPO" -c user.name=c -c user.email=c@localhost commit -q -m change
  BUILD="$APPS/builds.noindex/$BASE"
  PLUGIN="$BUILD/node_modules/@deepseek-ai/dsh-lsy-demo"
  mkdir -p "$PLUGIN/lib" "$PLUGIN/node_modules/dep" "$BUILD/lsy/skills/demo" "$APPS/builds.noindex/cold"
  echo old >"$PLUGIN/lib/index.js"
  echo removed-by-the-new-build >"$PLUGIN/lib/stale.js"
  echo '{"name":"@deepseek-ai/dsh-lsy-demo"}' >"$PLUGIN/package.json"
  echo nested >"$PLUGIN/node_modules/dep/index.js"
  echo old-skill >"$BUILD/lsy/skills/demo/SKILL.md"
  ln -sfn "$BUILD" "$APPS/current"
  RC=0
  ( cd "$REPO" && env APPS="$APPS" CALLS="$CALLS" WORK="$WORK" FAKE_LIB=new FAKE_MANIFEST='{"name":"@deepseek-ai/dsh-lsy-demo"}' FAKE_PIDS='7 7 7 7' \
      FAKE_RECONCILE=applied FAKE_UNHEALTHY= FAKE_BUILD_FAILS= DSH_UPGRADE_APPS="$APPS" DSH_UPGRADE_WORK="$WORK" \
      DSH_UPGRADE_SETTLE_S=0 DSH_UPGRADE_DRAIN_POLL_S=0 "$@" DSH_UPGRADE_TEST_HOOKS="$WORK/hot-hooks.sh" "$HERE/self-upgrade.sh" >"$WORK/$name.out" 2>&1 ) || RC=$?
}
lib() { cat "$PLUGIN/lib/index.js"; }

PLUGIN_SRC=packages/lsy/lsy-demo/src/index.ts

hot hot-applied "$PLUGIN_SRC"
[ "$RC" = 0 ] || fail "a plugin change must exit 0 (rc $RC): $(cat "$WORK/hot-applied.out")"
[ "$(readlink "$APPS/current")" = "$BUILD" ] || fail "a plugin change must leave current where it is"
[ "$(lib)" = new ] || fail "a plugin change must replace the running file"
[ ! -e "$PLUGIN/lib/stale.js" ] || fail "a file the new build dropped must go"
[ "$(cat "$PLUGIN/node_modules/dep/index.js")" = nested ] || fail "a plugin's nested dependencies must stay"
[ "$(cat "$BUILD/lsy/skills/demo/SKILL.md")" = new-skill ] || fail "skills must follow the checkout"
[ "$(cat "$BUILD/.hot-sha")" = "$(git -C "$REPO" rev-parse --short HEAD)" ] || fail "the running build must record the commit it now runs"
called 'reconcile applied new' || fail "the reconcile must see the new file"
called restart && fail "a plugin change must not restart DSH"
called upgrade && fail "a plugin change must not install a whole build"
called 'setup' || fail "a plugin change must relink the skills"
called 'notify .*热更新' || fail "a plugin change must report the hot path"
called turns && fail "a plugin change must not wait for turns: it does not interrupt them"
[ ! -e "$WORK/hot-backup" ] || fail "a hot deploy must not copy the old files"
called prune && fail "a hot deploy leaves no other build to remove"

# The next deploy compares against what runs, not against the build's name: the same commit again does nothing.
RC=0
: >"$CALLS"
echo 1 >"$CALLS.pids"
( cd "$REPO" && env APPS="$APPS" CALLS="$CALLS" WORK="$WORK" FAKE_LIB=new FAKE_MANIFEST='{"name":"@deepseek-ai/dsh-lsy-demo"}' FAKE_PIDS='7 7' FAKE_RECONCILE=applied FAKE_UNHEALTHY= FAKE_BUILD_FAILS= \
    DSH_UPGRADE_APPS="$APPS" DSH_UPGRADE_WORK="$WORK" DSH_UPGRADE_SETTLE_S=0 DSH_UPGRADE_TEST_HOOKS="$WORK/hot-hooks.sh" "$HERE/self-upgrade.sh" >/dev/null 2>&1 ) || RC=$?
[ "$RC" = 0 ] || fail "the commit that already runs must exit 0"
called build && fail "the commit that already runs must not build"
called '已经是' || fail "the commit that already runs must report"

# A change no process loads needs no build, no reconcile, and no time to settle: it is on disk in seconds.
for inert in docs/guide/x.md .agents/notes/x.json README.md lsy/CHANGELOG.md lsy/deploy/RUNBOOK.md packages/lsy/lsy-demo/README.md packages/client/ui/README.i18n.yaml lsy/skills/demo/extra.md; do
  INERT_START=$SECONDS
  hot hot-inert "$inert" DSH_UPGRADE_SETTLE_S=30
  [ $((SECONDS - INERT_START)) -lt 30 ] || fail "$inert must not wait for the process to settle: nothing was reloaded"
  [ "$RC" = 0 ] || fail "$inert must exit 0 (rc $RC): $(cat "$WORK/hot-inert.out")"
  called build && fail "$inert must not build"
  called upgrade && fail "$inert must not install a whole build"
  called reconcile && fail "$inert must not reconcile"
  called restart && fail "$inert must not restart DSH"
  [ "$(cat "$BUILD/lsy/skills/demo/SKILL.md")" = new-skill ] || fail "$inert: skills must follow the checkout"
  [ "$(cat "$BUILD/.hot-sha")" = "$(git -C "$REPO" rev-parse --short HEAD)" ] || fail "$inert must record the commit"
  called '没有插件代码变化' || fail "$inert must report that no plugin changed"
  rm -rf "${APPS:?}" "${REPO:?}" "$WORK/hot-stage"
done

# What looks like a document or a script but reaches a process still builds, or restarts.
hot hot-recorder lsy/deploy/qq-recorder/main.ts
called build || fail "the recorder is built by the deploy, so a change to it must build"
hot hot-prompt packages/agents/prompts/system.md
called upgrade && called restart || fail "a Markdown file outside the docs may be loaded at run time, so it must take the restart"
hot hot-bundle-doc lsy/bundles/event/persona.md
called upgrade && called restart || fail "a file in the bundle must take the restart, Markdown or not"

# A restart says everything that forced it, not only the first path in sort order.
hot hot-reasons packages/boot/hmr/src/index.ts
/usr/bin/grep -q 'restart path: packages/boot/hmr/src/index.ts' "$WORK/hot-reasons.out" || fail "a restart must name the path that forced it: $(cat "$WORK/hot-reasons.out")"

hot hot-framework packages/boot/hmr/src/index.ts
called upgrade && called restart || fail "a framework change must take the whole build and the restart"
called reconcile && fail "a framework change must not reconcile"
called 'prune cold' || fail "a framework change must remove the build it replaced"
[ "$(lib)" = old ] || fail "a framework change must leave the running build's files"

HOT_TURNS='2 1 0' hot hot-drain packages/boot/hmr/src/index.ts
[ "$(/usr/bin/grep -c '^turns' "$CALLS")" = 3 ] || fail "a restart must keep waiting while turns run"
called restart || fail "a restart must follow once no turn runs"

HOT_TURNS=1 hot hot-drain-timeout packages/boot/hmr/src/index.ts DSH_UPGRADE_DRAIN_S=0
called restart || fail "a turn that never ends must not hold a deploy forever"
called '仍有' || fail "a restart that cut a turn must say so"

HOT_TURNS=x hot hot-drain-unknown packages/boot/hmr/src/index.ts
called restart || fail "a turn count that cannot be read must not hold a deploy"

hot hot-manifest packages/lsy/lsy-demo/package.json
called upgrade && called restart || fail "a plugin's manifest change must take the restart"
hot hot-lockfile pnpm-lock.yaml
called upgrade && called restart || fail "a lockfile change must take the restart"
hot hot-setup lsy/deploy/setup-profile.sh
called upgrade && called restart || fail "a change to the profile layout must take the restart"

hot hot-packed-manifest "$PLUGIN_SRC" FAKE_MANIFEST='{"name":"@deepseek-ai/dsh-lsy-demo","dependencies":{"x":"1"}}'
called upgrade && called restart || fail "a packed manifest that differs must take the restart"
[ "$(lib)" = old ] || fail "a packed manifest that differs must leave the running files"

hot hot-build-fails "$PLUGIN_SRC" FAKE_BUILD_FAILS=1
[ "$RC" != 0 ] || fail "a failed build must exit non-zero"
[ "$(lib)" = old ] || fail "a failed build must leave the running files"
called reconcile && fail "a failed build must not reconcile"
called '线上版本没动' || fail "a failed build must report"

hot hot-rejected "$PLUGIN_SRC" FAKE_RECONCILE=failed
[ "$RC" != 0 ] || fail "a replacement that fails must exit non-zero"
[ "$(lib)" = new ] || fail "a replacement that fails stays on the new file: there is no old copy"
[ ! -e "$WORK/hot-backup" ] || fail "a replacement must not copy the old files"
called restart && fail "a replacement that fails must not restart"
called '失败' || fail "a replacement that fails must report"
[ "$(cat "$BUILD/.hot-sha")" = "$(git -C "$REPO" rev-parse --short HEAD)" ] || fail "a replacement that fails must record what the disk now holds"

# After that the old commit deploys like any other: the same commit as the failed one would do nothing.
git -C "$REPO" checkout -q "$BASE"
RC=0
: >"$CALLS"
echo 1 >"$CALLS.pids"
( cd "$REPO" && env APPS="$APPS" CALLS="$CALLS" WORK="$WORK" FAKE_LIB=old FAKE_MANIFEST='{"name":"@deepseek-ai/dsh-lsy-demo"}' FAKE_PIDS='7 7' FAKE_RECONCILE=applied FAKE_UNHEALTHY= FAKE_BUILD_FAILS= \
    DSH_UPGRADE_APPS="$APPS" DSH_UPGRADE_WORK="$WORK" DSH_UPGRADE_SETTLE_S=0 DSH_UPGRADE_TEST_HOOKS="$WORK/hot-hooks.sh" "$HERE/self-upgrade.sh" >/dev/null 2>&1 ) || RC=$?
[ "$RC" = 0 ] || fail "deploying the old commit after a failed replacement must exit 0"
[ "$(lib)" = old ] || fail "deploying the old commit must bring its file back"
called 'reconcile applied old' || fail "deploying the old commit must reconcile"
[ "$(cat "$BUILD/.hot-sha")" = "$BASE" ] || fail "deploying the old commit must record it"

hot hot-pending "$PLUGIN_SRC" FAKE_RECONCILE=pending
[ "$RC" = 0 ] || fail "a replacement that waits for a restart must finish by restarting"
[ "$(lib)" = new ] || fail "a replacement that waits for a restart keeps the new files"
[ "$(cat "$BUILD/.hot-sha")" = "$(git -C "$REPO" rev-parse --short HEAD)" ] || fail "a replacement that waits for a restart must record the commit"
called restart || fail "a replacement that waits for a restart must restart"
called '重启' || fail "a replacement that waits for a restart must say it restarted"
called turns || fail "a replacement that waits for a restart must wait for running turns"

HOT_TURNS=1 hot hot-died-busy "$PLUGIN_SRC" FAKE_PIDS='7 8 8 8'
called turns && fail "a process that died must not wait for turns: it is already in trouble"

hot hot-pending-broken "$PLUGIN_SRC" FAKE_RECONCILE=pending FAKE_UNHEALTHY=1
[ "$RC" != 0 ] || fail "a new build that does not come up must exit non-zero"
called '失败' || fail "a new build that does not come up must report"

hot hot-died "$PLUGIN_SRC" FAKE_PIDS='7 8 8 8'
[ "$RC" != 0 ] || fail "a process that died after the replacement must exit non-zero"
called '失败' || fail "a process that died after the replacement must report"
called restart && fail "launchd restarts a process that died; the deploy must not"

# start.sh: a request for a commit lsy/main does not hold must say so where AMS sees it, not end in a log nobody reads.
ORIGIN="$WORK/start-origin"
git init -q -b lsy/main "$ORIGIN"
mkdir -p "$ORIGIN/lsy/deploy"
printf '#!/bin/bash\necho ran >>"$DSH_UPGRADE_CHECK_RAN"\n' >"$ORIGIN/lsy/deploy/self-upgrade.sh"
chmod +x "$ORIGIN/lsy/deploy/self-upgrade.sh"
git -C "$ORIGIN" add -A
git -C "$ORIGIN" -c user.name=c -c user.email=c@localhost commit -q -m base
ON_MAIN=$(git -C "$ORIGIN" rev-parse HEAD)
git -C "$ORIGIN" checkout -q -b elsewhere
git -C "$ORIGIN" -c user.name=c -c user.email=c@localhost commit -q --allow-empty -m other
OFF_MAIN=$(git -C "$ORIGIN" rev-parse HEAD)
git -C "$ORIGIN" checkout -q lsy/main
# start <name> <request>; leaves the exit code in RC, stderr in START_ERR, and whether the deploy ran in START_RAN.
start() {
  local dir="$WORK/start-$1"
  mkdir -p "$dir"
  printf '%s\n' "$2" >"$dir/request"
  START_RAN="$dir/ran"
  START_ERR="$dir/err"
  RC=0
  DSH_UPGRADE_REQUEST="$dir/request" DSH_UPGRADE_WORK="$WORK/start-work" DSH_UPGRADE_REPO="file://$ORIGIN" DSH_UPGRADE_CHECK_RAN="$START_RAN" \
    "$HERE/dsh-upgrade/start.sh" >/dev/null 2>"$START_ERR" || RC=$?
}
start main lsy/main
[ "$RC" = 0 ] && [ -f "$START_RAN" ] || fail "start.sh must deploy lsy/main (rc $RC): $(cat "$START_ERR")"
start pinned "$ON_MAIN"
[ "$RC" = 0 ] && [ -f "$START_RAN" ] || fail "start.sh must deploy a commit on lsy/main (rc $RC): $(cat "$START_ERR")"
start missing 0123456789012345678901234567890123456789
[ "$RC" != 0 ] || fail "a commit nobody pushed must exit non-zero"
[ ! -f "$START_RAN" ] || fail "a commit nobody pushed must not deploy"
/usr/bin/grep -q 'not on lsy/main' "$START_ERR" || fail "a commit nobody pushed must say so on stderr, which AMS escalates: $(cat "$START_ERR")"
start offmain "$OFF_MAIN"
[ "$RC" != 0 ] && [ ! -f "$START_RAN" ] || fail "a commit on another branch must not deploy"

echo "check-self-upgrade: ok"
