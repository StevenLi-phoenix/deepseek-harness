#!/bin/bash
# Install a packed lsy dsh build into a self-contained prefix.
# usage: install-app.sh <dist dir with vendor/ and dsh/> <prefix>
# The prefix should be owned by the operator and only readable by the service user.
# Optional dependencies stay on: koffi loads its macOS prebuild from one (@koromix/koffi-darwin-arm64).
set -euo pipefail
DIST=${1:?dist dir}
PREFIX=${2:?install prefix}
HERE=$(cd "$(dirname "$0")" && pwd)
[ -d "$DIST/vendor" ] && [ -d "$DIST/dsh" ] || { echo "install-app: $DIST must contain vendor/ and dsh/" >&2; exit 1; }
[ ! -e "$PREFIX" ] || { echo "install-app: $PREFIX already exists; install each build into a fresh prefix" >&2; exit 1; }
mkdir -p "$PREFIX"
node "$HERE/consumer-manifest.mjs" "$PREFIX/package.json" "$DIST/vendor" "$DIST/dsh"
echo "install-app: npm install into $PREFIX"
( cd "$PREFIX" && env -u npm_config_user_agent npm install --cache "$PREFIX/.npm-cache" --no-audit --no-fund --package-lock=false --loglevel=warn )
rm -rf "$PREFIX/.npm-cache"
VERSION=$(node "$PREFIX/node_modules/@deepseek-ai/dsh/lib/bin.js" --version)
echo "install-app: installed dsh $VERSION at $PREFIX"
