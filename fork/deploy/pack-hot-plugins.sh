#!/bin/bash
# Pack only the plugins a hot deploy can replace, from an already built checkout: the whole release takes about three minutes for
# some 400 tarballs a hot deploy never opens. Same `pnpm pack` as scripts/release/pack.ts, so the files match an installed build.
# usage: pack-hot-plugins.sh <out dir>            (from the repository root)
set -euo pipefail
OUT=${1:?out dir}
rm -rf "${OUT:?}"
mkdir -p "$OUT"
pnpm pack --recursive --workspace-concurrency=8 --pack-destination "$OUT" \
  --filter='@deepseek-ai/dsh-fork-*' --filter=@deepseek-ai/dsh-bili --filter=@deepseek-ai/dsh-tool-bili --filter=@deepseek-ai/dsh-owner-relay >/dev/null
COUNT=$(find "$OUT" -name '*.tgz' | wc -l | tr -d ' ')
[ "$COUNT" != 0 ] || { echo "pack-hot-plugins: no tarball in $OUT" >&2; exit 1; }
echo "pack-hot-plugins: $COUNT tarball(s) in $OUT"
