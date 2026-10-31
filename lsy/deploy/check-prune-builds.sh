#!/bin/bash
# Regression check for prune-builds.sh in a throwaway apps directory: builds live under
# builds.noindex (Spotlight skips it), the new build and the one `current` pointed at stay, a legacy
# build directly under the apps directory that is neither of them is removed, and a legacy build that
# is the rollback target stays where it is.
# usage: check-prune-builds.sh
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
WORK=$(mktemp -d "${TMPDIR:-/tmp}/lsy-prune-builds.XXXXXX")
trap 'rm -rf "${WORK:?}"' EXIT
fail() { echo "check-prune-builds: FAIL: $*" >&2; exit 1; }
mk() { mkdir -p "$1/node_modules"; : > "$1/node_modules/x"; }

# Steady state: new build, previous build, and an older one, all under builds.noindex.
APPS="$WORK/steady"; B="$APPS/builds.noindex"
mk "$B/aaaaaaa1"; mk "$B/bbbbbbb2"; mk "$B/ccccccc3"; mkdir "$B/not-a-build"
"$HERE/prune-builds.sh" "$APPS" "$B/aaaaaaa1" "$B/bbbbbbb2" >/dev/null
[ -d "$B/aaaaaaa1" ] && [ -d "$B/bbbbbbb2" ] || fail "the new and the previous build must stay"
[ ! -e "$B/ccccccc3" ] || fail "an older build must be removed"
[ -d "$B/not-a-build" ] || fail "a directory that is not a build must stay"
[ -e "$B/.metadata_never_index" ] || fail "the builds directory must carry .metadata_never_index"

# Migration: current and the rollback target are legacy directories under the apps directory.
APPS="$WORK/legacy"; B="$APPS/builds.noindex"
mk "$APPS/ddddddd4"; mk "$APPS/eeeeeee5"; mk "$APPS/fffffff6"; mk "$B/1111111a"
ln -s "$APPS/ddddddd4" "$APPS/current"
"$HERE/prune-builds.sh" "$APPS" "$B/1111111a" "$APPS/ddddddd4" >/dev/null
[ -d "$B/1111111a" ] || fail "the new build must stay"
[ -d "$APPS/ddddddd4" ] || fail "a legacy rollback target must stay in place (the service may still run from it)"
[ ! -e "$APPS/eeeeeee5" ] && [ ! -e "$APPS/fffffff6" ] || fail "legacy builds that are neither new nor previous must be removed"
[ -L "$APPS/current" ] || fail "the current symlink must survive"

# Relocation of a legacy build once nothing runs from it.
"$HERE/prune-builds.sh" --relocate "$APPS" "$APPS/ddddddd4" >/dev/null && fail "relocating the build current points at must be refused" || true
ln -sfn "$B/1111111a" "$APPS/current"
"$HERE/prune-builds.sh" --relocate "$APPS" "$APPS/ddddddd4" >/dev/null
[ -d "$B/ddddddd4" ] && [ ! -e "$APPS/ddddddd4" ] || fail "--relocate must move the legacy build into builds.noindex"
echo "check-prune-builds: ok"
