#!/bin/bash
# Regression check for prune-builds.sh in a throwaway apps directory: builds live under builds.noindex (Spotlight
# skips it), the build that still runs stays until the new process is up, and after that only one build is left,
# in the old layout directly under the apps directory too. Old tarballs go the same way.
# usage: check-prune-builds.sh
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
WORK=$(mktemp -d "${TMPDIR:-/tmp}/fork-prune-builds.XXXXXX")
trap 'rm -rf "${WORK:?}"' EXIT
fail() { echo "check-prune-builds: FAIL: $*" >&2; exit 1; }
mk() { mkdir -p "$1/node_modules"; : > "$1/node_modules/x"; }

# At the switch: the new build, the one the service still runs from, and an older one.
APPS="$WORK/switch"; B="$APPS/builds.noindex"
mk "$B/aaaaaaa1"; mk "$B/bbbbbbb2"; mk "$B/ccccccc3"; mkdir "$B/not-a-build"
"$HERE/prune-builds.sh" "$APPS" "$B/aaaaaaa1" "$B/bbbbbbb2" >/dev/null
[ -d "$B/aaaaaaa1" ] && [ -d "$B/bbbbbbb2" ] || fail "the new build and the running one must stay at the switch"
[ ! -e "$B/ccccccc3" ] || fail "an older build must be removed"
[ -d "$B/not-a-build" ] || fail "a directory that is not a build must stay"
[ -e "$B/.metadata_never_index" ] || fail "the builds directory must carry .metadata_never_index"

# Once the new process is up nothing keeps the old build.
ln -s "$B/aaaaaaa1" "$APPS/current"
"$HERE/prune-builds.sh" "$APPS" "$B/aaaaaaa1" >/dev/null
[ -d "$B/aaaaaaa1" ] || fail "the build that runs must stay"
[ ! -e "$B/bbbbbbb2" ] || fail "the replaced build must be removed once the new process is up"
[ -L "$APPS/current" ] || fail "the current symlink must survive"

# The same build under another spelling, and whatever current points at, are never removed.
APPS="$WORK/spelling"; B="$APPS/builds.noindex"
mk "$B/aaaaaaa1"; mk "$B/bbbbbbb2"; mk "$B/ccccccc3"
ln -s "$B/bbbbbbb2" "$APPS/current"
"$HERE/prune-builds.sh" "$APPS" "$B/../builds.noindex/aaaaaaa1" >/dev/null
[ -d "$B/aaaaaaa1" ] || fail "the build to keep must stay under another spelling of its path"
[ -d "$B/bbbbbbb2" ] || fail "the build current points at must stay even when nobody names it"
[ ! -e "$B/ccccccc3" ] || fail "a build that is neither must be removed"

# A build to keep that does not exist means the caller is wrong: nothing is removed.
if "$HERE/prune-builds.sh" "$APPS" "$B/fffffff6" >/dev/null 2>&1; then fail "a missing build to keep must be refused"; fi
[ -d "$B/aaaaaaa1" ] && [ -d "$B/bbbbbbb2" ] || fail "a refused call must remove nothing"

# Migration: legacy builds directly under the apps directory go too, but not the one that still runs.
APPS="$WORK/legacy"; B="$APPS/builds.noindex"
mk "$APPS/ddddddd4"; mk "$APPS/eeeeeee5"; mk "$B/1111111a"
ln -s "$B/1111111a" "$APPS/current"
"$HERE/prune-builds.sh" "$APPS" "$B/1111111a" "$APPS/ddddddd4" >/dev/null
[ -d "$APPS/ddddddd4" ] || fail "a legacy build the service still runs from must stay"
[ ! -e "$APPS/eeeeeee5" ] || fail "a legacy build nothing runs from must be removed"

# Tarballs: only this commit's stay; logs, other names, and links are not ours to remove.
D="$WORK/dist"
mkdir -p "$D/aaaaaaa1/dsh" "$D/bbbbbbb2/dsh" "$D/not-a-commit" "$WORK/elsewhere/ccccccc3"
: > "$D/upgrade-bbbbbbb2.log"
ln -s "$WORK/elsewhere/ccccccc3" "$D/ccccccc3"
"$HERE/prune-builds.sh" --dist "$D" aaaaaaa1 >/dev/null
[ -d "$D/aaaaaaa1/dsh" ] || fail "this commit's tarballs must stay"
[ ! -e "$D/bbbbbbb2" ] || fail "another commit's tarballs must be removed"
[ -d "$D/not-a-commit" ] && [ -f "$D/upgrade-bbbbbbb2.log" ] && [ -L "$D/ccccccc3" ] && [ -d "$WORK/elsewhere/ccccccc3" ] || fail "only commit directories may be removed"
"$HERE/prune-builds.sh" --dist "$WORK/no-such-dist" aaaaaaa1 >/dev/null || fail "a missing dist root must not fail"
echo "check-prune-builds: ok"
