#!/bin/bash
# Copy the fork's scripts, profile, bundle, and skills from a checkout into an installed build, so the service user (who cannot
# read the operator's home) sets up exactly the composition this build was tested with.
# usage: install-lsy-files.sh <checkout> <installed prefix>
set -euo pipefail
ROOT=${1:?checkout}
PREFIX=${2:?installed prefix}
mkdir -p "$PREFIX/lsy/deploy" "$PREFIX/lsy/profiles" "$PREFIX/lsy/bundles"
for script in setup-profile.sh wechat-login.mjs qqbot-login.mjs memory-import.mjs memory-admin.mjs disk-watch.mjs; do
  [ ! -f "$ROOT/lsy/deploy/$script" ] || cp "$ROOT/lsy/deploy/$script" "$PREFIX/lsy/deploy/"
done
[ ! -d "$ROOT/lsy/profiles/event" ] || /usr/bin/rsync -rlpc --delete "$ROOT/lsy/profiles/event/" "$PREFIX/lsy/profiles/event/"
[ ! -d "$ROOT/lsy/bundles/event" ] || /usr/bin/rsync -rlpc --delete "$ROOT/lsy/bundles/event/" "$PREFIX/lsy/bundles/event/"
[ ! -d "$ROOT/lsy/skills" ] || /usr/bin/rsync -rlpc --delete "$ROOT/lsy/skills/" "$PREFIX/lsy/skills/"
