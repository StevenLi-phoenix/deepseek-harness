#!/bin/bash
# Build, pack, and install the current fork/main checkout as a new release of the event service.
# Runs as the operator (no sudo), or as the service user through self-upgrade.sh. Prints the two commands that finish the switch.
# usage: fork/deploy/upgrade.sh            (from the repository root)
set -euo pipefail
export PATH="/opt/homebrew/bin:$HOME/.local/bin:$PATH"
ROOT=$(git rev-parse --show-toplevel)
cd "$ROOT"
[ -z "$(git status --porcelain)" ] || { echo "upgrade: commit or stash local changes first" >&2; exit 1; }
SHA=$(git rev-parse --short HEAD)
DIST=${FORK_DSH_DIST_ROOT:-/Volumes/MiniSSD/fork-dsh-dist}/$SHA
APPS=/Users/Shared/fork-dsh
# Builds sit in a *.noindex directory so Spotlight leaves their node_modules alone (see prune-builds.sh);
# <apps>/current stays the stable path the LaunchDaemon and the sudoers rules use.
BUILDS=$APPS/builds.noindex
PREFIX=$BUILDS/$SHA
echo "upgrade: building $SHA"
pnpm install --frozen-lockfile
pnpm run build:official
pnpm exec vitest run packages/fork
if [ ! -d "$DIST/dsh" ]; then
  pnpm run release:pack --family vendor --out "$DIST/vendor"
  pnpm run release:pack --family dsh --out "$DIST/dsh"
fi
if [ ! -d "$PREFIX" ]; then
  "$ROOT/fork/deploy/install-app.sh" "$DIST" "$PREFIX"
  # Ship the profile and its setup script with the build, so the service user (who cannot
  # read the operator's home) sets up exactly the composition this build was tested with.
  mkdir -p "$PREFIX/fork/deploy" "$PREFIX/fork/profiles" "$PREFIX/fork/bundles"
  cp "$ROOT/fork/deploy/setup-profile.sh" "$ROOT/fork/deploy/wechat-login.mjs" "$ROOT/fork/deploy/qqbot-login.mjs" "$ROOT/fork/deploy/memory-import.mjs" "$ROOT/fork/deploy/memory-admin.mjs" "$ROOT/fork/deploy/disk-watch.mjs" "$PREFIX/fork/deploy/"
  cp -R "$ROOT/fork/profiles/event" "$PREFIX/fork/profiles/"
  cp -R "$ROOT/fork/bundles/event" "$PREFIX/fork/bundles/"
  [ ! -d "$ROOT/fork/skills" ] || cp -R "$ROOT/fork/skills" "$PREFIX/fork/"
fi
# The profile layout must hold in throwaway homes before current points at this build.
"$ROOT/fork/deploy/check-setup-profile.sh" "$PREFIX"
PREVIOUS=$(readlink "$APPS/current" || true)
ln -sfn "$PREFIX" "$APPS/current"
echo "upgrade: $APPS/current -> $PREFIX"
# Keep this build and the one current pointed at before (the rollback); delete older ones
# outright. Each is ~1.6 GB of node_modules on the internal disk and rebuilds from git; moved
# to the Trash they kept their space, which filled the disk on 2026-10-22.
if [ -n "$PREVIOUS" ] && [ "$PREVIOUS" != "$PREFIX" ]; then
  "$ROOT/fork/deploy/check-prune-builds.sh"
  "$ROOT/fork/deploy/prune-builds.sh" "$APPS" "$PREFIX" "$PREVIOUS"
fi
# The QQ recorder is an AMS service of its own and holds QQ's one connection. Its bundle is built and pinned here, before
# the DSH switch below is printed, so a recorder is never older than the DSH that talks to it (a newer recorder serves an
# older DSH; the protocol only adds). On an upgrade deploy.sh reloads AMS, which restarts the recorder alone; on a first
# install it only places the declaration and says how to start it.
QQ_OUT=$(mktemp -d)
QQ_RECORDER_OUT="$QQ_OUT" pnpm exec tsdown -c fork/deploy/qq-recorder/tsdown.config.ts
"$ROOT/fork/deploy/qq-recorder/deploy.sh" "$QQ_OUT/qq-recorder.mjs"
rm -rf "${QQ_OUT:?}"
cat <<NEXT

Finish the switch (passwordless with /etc/sudoers.d/dsh-events):
  sudo -n -u dsh-runtime /usr/bin/env PATH=/opt/homebrew/bin:/usr/bin:/bin $APPS/current/fork/deploy/setup-profile.sh /Users/dsh-runtime/.dsh $APPS/current
  sudo -n /bin/launchctl kickstart -k system/app.lishuyu.dsh-events
Roll back: stop the recorder first (two processes must never hold QQ's connection):
  cd / && sudo -n -u dsh-runtime env AMS_STATE_DIR=/Users/dsh-runtime/.ams /Users/dsh-runtime/ams/.venv/bin/ams ctl stop qq-recorder
then ln -sfn ${PREVIOUS:-$BUILDS/<previous sha>} $APPS/current, and the same two lines (RUNBOOK, "qq-recorder").
If the previous build is still directly under $APPS (the layout before builds.noindex), move it once nothing runs from it:
  $ROOT/fork/deploy/prune-builds.sh --relocate $APPS <that build>
NEXT
