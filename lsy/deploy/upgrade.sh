#!/bin/bash
# Build, pack, and install the current lsy/main checkout as a new release of the event service.
# Runs as the operator (no sudo). Prints the two privileged commands that finish the switch.
# usage: lsy/deploy/upgrade.sh            (from the repository root)
set -euo pipefail
export PATH="/opt/homebrew/bin:$HOME/.local/bin:$PATH"
ROOT=$(git rev-parse --show-toplevel)
cd "$ROOT"
[ -z "$(git status --porcelain)" ] || { echo "upgrade: commit or stash local changes first" >&2; exit 1; }
SHA=$(git rev-parse --short HEAD)
DIST=/Volumes/MiniSSD/lsy-dsh-dist/$SHA
APPS=/Users/Shared/lsy-dsh
PREFIX=$APPS/$SHA
echo "upgrade: building $SHA"
pnpm install --frozen-lockfile
pnpm run build:official
pnpm exec vitest run packages/lsy
if [ ! -d "$DIST/dsh" ]; then
  pnpm run release:pack --family vendor --out "$DIST/vendor"
  pnpm run release:pack --family dsh --out "$DIST/dsh"
fi
if [ ! -d "$PREFIX" ]; then
  "$ROOT/lsy/deploy/install-app.sh" "$DIST" "$PREFIX"
  # Ship the profile and its setup script with the build, so the service user (who cannot
  # read the operator's home) sets up exactly the composition this build was tested with.
  mkdir -p "$PREFIX/lsy/deploy" "$PREFIX/lsy/profiles" "$PREFIX/lsy/bundles"
  cp "$ROOT/lsy/deploy/setup-profile.sh" "$ROOT/lsy/deploy/wechat-login.mjs" "$ROOT/lsy/deploy/memory-import.mjs" "$PREFIX/lsy/deploy/"
  cp -R "$ROOT/lsy/profiles/event" "$PREFIX/lsy/profiles/"
  cp -R "$ROOT/lsy/bundles/event" "$PREFIX/lsy/bundles/"
fi
# The profile layout must hold in throwaway homes before current points at this build.
"$ROOT/lsy/deploy/check-setup-profile.sh" "$PREFIX"
PREVIOUS=$(readlink "$APPS/current" || true)
ln -sfn "$PREFIX" "$APPS/current"
echo "upgrade: $APPS/current -> $PREFIX"
# Keep this build and the one current pointed at before (the rollback); delete older ones
# outright. Each is ~1.6 GB of node_modules on the internal disk and rebuilds from git; moved
# to the Trash they kept their space, which filled the disk on 2026-10-22.
if [ -n "$PREVIOUS" ] && [ "$PREVIOUS" != "$PREFIX" ]; then
  for build in "$APPS"/*/; do
    build=${build%/}
    [ -L "$build" ] && continue
    { [ "$build" = "$PREFIX" ] || [ "$build" = "$PREVIOUS" ]; } && continue
    [[ $(basename "$build") =~ ^[0-9a-f]{7,40}$ ]] || continue
    echo "upgrade: removing old build $build"
    rm -rf "$build"
  done
fi
cat <<NEXT

Finish the switch (passwordless with /etc/sudoers.d/dsh-events):
  sudo -n -u dsh-runtime /usr/bin/env PATH=/opt/homebrew/bin:/usr/bin:/bin $APPS/current/lsy/deploy/setup-profile.sh /Users/dsh-runtime/.dsh $APPS/current
  sudo -n /bin/launchctl kickstart -k system/app.lishuyu.dsh-events
Roll back: ln -sfn $APPS/<previous sha> $APPS/current, then the same two lines.
NEXT
