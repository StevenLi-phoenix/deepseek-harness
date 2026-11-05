#!/bin/bash
# Build, pack, and install the current lsy/main checkout as a new release of the event service.
# Runs as the operator (no sudo), or as the service user through self-upgrade.sh. Prints the two commands that finish the switch.
# With LSY_DSH_BUILD_ONLY=1 it stops at the packed, tested tarballs and the recorder: self-upgrade.sh then replaces plugins in the
# running build, and neither a new prefix nor a switch happens.
# usage: lsy/deploy/upgrade.sh            (from the repository root)
set -euo pipefail
export PATH="/opt/homebrew/bin:$HOME/.local/bin:$PATH"
ROOT=$(git rev-parse --show-toplevel)
cd "$ROOT"
[ -z "$(git status --porcelain)" ] || { echo "upgrade: commit or stash local changes first" >&2; exit 1; }
SHA=$(git rev-parse --short HEAD)
DIST=${LSY_DSH_DIST_ROOT:-/Volumes/MiniSSD/lsy-dsh-dist}/$SHA
APPS=${LSY_DSH_APPS:-/Users/Shared/lsy-dsh}
BUILD_ONLY=${LSY_DSH_BUILD_ONLY:-}
# Builds sit in a *.noindex directory so Spotlight leaves their node_modules alone (see prune-builds.sh);
# <apps>/current stays the stable path the LaunchDaemon and the sudoers rules use.
BUILDS=$APPS/builds.noindex
PREFIX=$BUILDS/$SHA
echo "upgrade: building $SHA"
pnpm install --frozen-lockfile
pnpm run build:official
pnpm exec vitest run packages/lsy
if [ ! -d "$DIST/dsh" ]; then
  pnpm run release:pack --family vendor --out "$DIST/vendor"
  pnpm run release:pack --family dsh --out "$DIST/dsh"
fi
"$ROOT/lsy/deploy/check-prune-builds.sh"
# Only this commit's tarballs stay: every deploy adds a directory, and any commit rebuilds from git.
"$ROOT/lsy/deploy/prune-builds.sh" --dist "${DIST%/*}" "$SHA"
if [ -z "$BUILD_ONLY" ]; then
  if [ ! -d "$PREFIX" ]; then
    "$ROOT/lsy/deploy/install-app.sh" "$DIST" "$PREFIX"
    # Ship the profile and its setup script with the build.
    "$ROOT/lsy/deploy/install-lsy-files.sh" "$ROOT" "$PREFIX"
  fi
  # The profile layout must hold in throwaway homes before current points at this build.
  "$ROOT/lsy/deploy/check-setup-profile.sh" "$PREFIX"
  PREVIOUS=$(readlink "$APPS/current" || true)
  ln -sfn "$PREFIX" "$APPS/current"
  echo "upgrade: $APPS/current -> $PREFIX"
  # Keep this build and the one the service still runs from until it restarts; delete the rest
  # outright. Each is ~1.6 GB of node_modules on the internal disk and rebuilds from git; moved
  # to the Trash they kept their space, which filled the disk on 2026-10-22.
  if [ -n "$PREVIOUS" ] && [ "$PREVIOUS" != "$PREFIX" ]; then
    "$ROOT/lsy/deploy/prune-builds.sh" "$APPS" "$PREFIX" "$PREVIOUS"
  fi
fi
# The QQ recorder is an AMS service of its own and holds QQ's one connection. Its bundle is built and pinned here, before
# the DSH switch below is printed, so a recorder is never older than the DSH that talks to it (a newer recorder serves an
# older DSH; the protocol only adds). On an upgrade deploy.sh reloads AMS, which restarts the recorder alone; on a first
# install it only places the declaration and says how to start it.
QQ_OUT=$(mktemp -d)
QQ_RECORDER_OUT="$QQ_OUT" pnpm exec tsdown -c lsy/deploy/qq-recorder/tsdown.config.ts
"$ROOT/lsy/deploy/qq-recorder/deploy.sh" "$QQ_OUT/qq-recorder.mjs"
rm -rf "${QQ_OUT:?}"
[ -z "$BUILD_ONLY" ] || { echo "upgrade: built $SHA, tarballs in $DIST"; exit 0; }
cat <<NEXT

Finish the switch (passwordless with /etc/sudoers.d/dsh-events):
  sudo -n -u dsh-runtime /usr/bin/env PATH=/opt/homebrew/bin:/usr/bin:/bin $APPS/current/lsy/deploy/setup-profile.sh /Users/dsh-runtime/.dsh $APPS/current
  sudo -n /bin/launchctl kickstart -k system/app.lishuyu.dsh-events
Once the service answers on the new build, remove the one it replaced:
  $ROOT/lsy/deploy/prune-builds.sh $APPS $PREFIX
Before that, ln -sfn ${PREVIOUS:-<the replaced build>} $APPS/current and the same two lines go back; after it, deploy the old commit.
NEXT
