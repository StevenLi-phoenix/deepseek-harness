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
  mkdir -p "$PREFIX/lsy/deploy" "$PREFIX/lsy/profiles"
  cp "$ROOT/lsy/deploy/setup-profile.sh" "$PREFIX/lsy/deploy/"
  cp -R "$ROOT/lsy/profiles/event" "$PREFIX/lsy/profiles/"
fi
ln -sfn "$PREFIX" "$APPS/current"
echo "upgrade: $APPS/current -> $PREFIX"
cat <<NEXT

Finish the switch (privileged; run one at a time):
  sudo -u dsh-runtime $APPS/current/lsy/deploy/setup-profile.sh /Users/dsh-runtime/.dsh $APPS/current
  sudo launchctl kickstart -k system/app.lishuyu.dsh-events
Roll back: ln -sfn $APPS/<previous sha> $APPS/current, then the kickstart line.
NEXT
