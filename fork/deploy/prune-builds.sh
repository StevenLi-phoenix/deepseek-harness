#!/bin/bash
# Remove what deploys leave behind: only the build that runs stays, and any commit rebuilds from git.
# Builds live in <apps>/builds.noindex/<sha>: Spotlight skips directories named *.noindex, so a 1.7 GB
# node_modules per deploy is not indexed again and again (mdworker held the mini at load 24 on
# 2026-10-31). <apps>/current stays the one path the LaunchDaemon and the sudoers rules know.
# usage: prune-builds.sh <apps dir> <build> [<running build>]   remove every other build
#        prune-builds.sh --dist <dist root> <sha>               remove the tarballs of every other commit
# <running build> is the one the service still reads from until it restarts: its modules load lazily, so
# it goes in a second call, once the new process is up. The build current points at is never removed.
# A legacy build is a <sha> directory directly under <apps dir> (the layout before 2026-10-31).
# Deleting beats the Trash: each build is ~1.6 GB on the internal disk.
set -euo pipefail
SHA_NAME='^[0-9a-f]{7,40}$'
if [ "${1:-}" = "--dist" ]; then
  ROOT=${2:?dist root}; KEEP=${3:?sha}
  for dir in "$ROOT"/*/; do
    [ -d "$dir" ] || continue
    dir=${dir%/}
    [ -L "$dir" ] && continue
    [[ $(basename "$dir") =~ $SHA_NAME ]] && [ "$(basename "$dir")" != "$KEEP" ] || continue
    echo "prune-builds: removing old tarballs ${dir:?}"
    rm -rf "${dir:?}"
  done
  exit 0
fi
APPS=${1:?apps dir}; PREFIX=${2:?build to keep}; RUNNING=${3:-}
[ -d "$PREFIX" ] || { echo "prune-builds: $PREFIX is not a build; removing nothing" >&2; exit 1; }
BUILDS="$APPS/builds.noindex"
mkdir -p "$BUILDS"
: > "$BUILDS/.metadata_never_index"
for dir in "$BUILDS" "$APPS"; do
  for build in "$dir"/*/; do
    [ -d "$build" ] || continue
    build=${build%/}
    [ -L "$build" ] && continue
    [[ $(basename "$build") =~ $SHA_NAME ]] || continue
    # -ef, not a string compare: the same build spelled through another path must stay.
    { [ "$build" -ef "$PREFIX" ] || [ "$build" -ef "$APPS/current" ] || { [ -n "$RUNNING" ] && [ "$build" -ef "$RUNNING" ]; }; } && continue
    echo "prune-builds: removing old build ${build:?}"
    rm -rf "${build:?}"
  done
done
