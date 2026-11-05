#!/bin/bash
# Copy the fork's scripts, profile, bundle, and skills from a checkout into an installed build, so the service user (who cannot
# read the operator's home) sets up exactly the composition this build was tested with.
# usage: install-fork-files.sh <checkout> <installed prefix>
set -euo pipefail
ROOT=${1:?checkout}
PREFIX=${2:?installed prefix}
mkdir -p "$PREFIX/fork/deploy" "$PREFIX/fork/profiles" "$PREFIX/fork/bundles"
for script in setup-profile.sh wechat-login.mjs qqbot-login.mjs memory-import.mjs memory-admin.mjs disk-watch.mjs; do
  [ ! -f "$ROOT/fork/deploy/$script" ] || cp "$ROOT/fork/deploy/$script" "$PREFIX/fork/deploy/"
done
[ ! -d "$ROOT/fork/profiles/event" ] || /usr/bin/rsync -rlpc --delete "$ROOT/fork/profiles/event/" "$PREFIX/fork/profiles/event/"
[ ! -d "$ROOT/fork/bundles/event" ] || /usr/bin/rsync -rlpc --delete "$ROOT/fork/bundles/event/" "$PREFIX/fork/bundles/event/"
[ ! -d "$ROOT/fork/skills" ] || /usr/bin/rsync -rlpc --delete "$ROOT/fork/skills/" "$PREFIX/fork/skills/"
