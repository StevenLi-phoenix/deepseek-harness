#!/bin/bash
# Keep the installed builds of the event service tidy and out of Spotlight's reach.
# Builds live in <apps>/builds.noindex/<sha>: Spotlight skips directories named *.noindex, so a 1.7 GB
# node_modules per deploy is not indexed again and again (mdworker held the mini at load 24 on
# 2026-10-31). <apps>/current stays the one path the LaunchDaemon and the sudoers rules know.
# usage: prune-builds.sh <apps dir> <new build> <previous build>   remove builds that are neither
#        prune-builds.sh --relocate <apps dir> <legacy build>      move a legacy build into builds.noindex
# A legacy build is a <sha> directory directly under <apps dir> (the layout before 2026-10-31).
# The previous build is kept for rollback wherever it lives; a legacy one stays in place until nothing
# runs from it, then --relocate moves it. Deleting beats the Trash: each build is ~1.6 GB on the
# internal disk and rebuilds from git.
set -euo pipefail
SHA_NAME='^[0-9a-f]{7,40}$'
if [ "${1:-}" = "--relocate" ]; then
  APPS=${2:?apps dir}; LEGACY=${3:?legacy build}
  BUILDS="$APPS/builds.noindex"
  [[ $(basename "$LEGACY") =~ $SHA_NAME ]] && [ -d "$LEGACY" ] && [ ! -L "$LEGACY" ] || { echo "prune-builds: $LEGACY is not a legacy build" >&2; exit 1; }
  [ "$(dirname "$LEGACY")" = "$APPS" ] || { echo "prune-builds: $LEGACY is not directly under $APPS" >&2; exit 1; }
  [ "$(readlink "$APPS/current" || true)" != "$LEGACY" ] || { echo "prune-builds: current points at $LEGACY; switch it first" >&2; exit 1; }
  mkdir -p "$BUILDS"
  [ ! -e "$BUILDS/$(basename "$LEGACY")" ] || { echo "prune-builds: $BUILDS/$(basename "$LEGACY") already exists" >&2; exit 1; }
  mv "$LEGACY" "$BUILDS/"
  echo "prune-builds: moved $LEGACY into $BUILDS"
  exit 0
fi
APPS=${1:?apps dir}; PREFIX=${2:?new build}; PREVIOUS=${3:-}
BUILDS="$APPS/builds.noindex"
mkdir -p "$BUILDS"
: > "$BUILDS/.metadata_never_index"
for dir in "$BUILDS" "$APPS"; do
  for build in "$dir"/*/; do
    [ -d "$build" ] || continue
    build=${build%/}
    [ -L "$build" ] && continue
    [[ $(basename "$build") =~ $SHA_NAME ]] || continue
    { [ "$build" = "$PREFIX" ] || [ "$build" = "$PREVIOUS" ]; } && continue
    echo "prune-builds: removing old build ${build:?}"
    rm -rf "${build:?}"
  done
done
