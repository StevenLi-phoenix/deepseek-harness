#!/bin/bash
# Install a built qq-recorder bundle as the pinned version of the AMS service `qq-recorder`. Runs as the operator (no root).
#   usage: fork/deploy/qq-recorder/deploy.sh <qq-recorder.mjs>
#
# 1. The bundle is copied once to <shared>/<fingerprint>/qq-recorder.mjs (fingerprint = first 12 hex of its sha256), so the
#    service runs a file that no build, prune, or `current` switch can move under it.
# 2. service.toml.in is rendered for that file. When the declaration AMS holds is byte for byte the same, nothing happens.
# 3. Otherwise the declaration is written (as dsh-runtime). On a FIRST install the script stops there and prints the command
#    that starts the service; DSH must be switched to the client build first (see upgrade.sh). On an upgrade it reloads AMS,
#    which restarts the qq-recorder only (AMS compares declarations by their bytes).
# 4. Every other bundle is removed; going back means deploying the old commit.
#
# Environment (all for tests, with the production defaults):
#   QQ_RECORDER_AS      command prefix that runs a command as dsh-runtime (default: sudo -n -u dsh-runtime)
#   QQ_RECORDER_SHARED  where the pinned bundles live (default: /Users/Shared/fork-dsh/qq-recorder.noindex)
#   QQ_RECORDER_DECL    the declaration's path (default: /Users/dsh-runtime/.ams/services/qq-recorder/service.toml)
#   QQ_RECORDER_AMS     the ams executable (default: /Users/dsh-runtime/ams/.venv/bin/ams)
#   QQ_RECORDER_STATE   AMS_STATE_DIR (default: /Users/dsh-runtime/.ams)
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
BUNDLE=${1:?usage: deploy.sh <qq-recorder.mjs>}
[ -f "$BUNDLE" ] || { echo "deploy: $BUNDLE is not a file" >&2; exit 1; }
SHARED=${QQ_RECORDER_SHARED:-/Users/Shared/fork-dsh/qq-recorder.noindex}
DECL=${QQ_RECORDER_DECL:-/Users/dsh-runtime/.ams/services/qq-recorder/service.toml}
AMS=${QQ_RECORDER_AMS:-/Users/dsh-runtime/ams/.venv/bin/ams}
STATE=${QQ_RECORDER_STATE:-/Users/dsh-runtime/.ams}
read -r -a AS <<<"${QQ_RECORDER_AS:-sudo -n -u dsh-runtime}"

FP=$(shasum -a 256 "$BUNDLE" | cut -c1-12)
case "$FP" in *[!0-9a-f]*) echo "deploy: bad fingerprint $FP" >&2; exit 1 ;; esac
TARGET=$SHARED/$FP/qq-recorder.mjs
echo "deploy: qq-recorder build $FP"

if [ ! -f "$TARGET" ]; then
  mkdir -p "$SHARED/$FP"
  cp "$BUNDLE" "$TARGET.new"
  chmod 755 "$SHARED" "$SHARED/$FP"
  chmod 644 "$TARGET.new"
  mv "$TARGET.new" "$TARGET"
  echo "deploy: pinned $TARGET"
fi

NEW=$(mktemp)
trap 'rm -f "$NEW"' EXIT
sed -e "s#@BUNDLE@#$TARGET#g" -e "s#@BUILD@#$FP#g" "$HERE/service.toml.in" >"$NEW"
if grep -q '@[A-Z]*@' "$NEW"; then echo "deploy: the template has an unfilled placeholder" >&2; exit 1; fi

HAD_DECL=no
if "${AS[@]}" test -f "$DECL"; then
  HAD_DECL=yes
  if "${AS[@]}" cat "$DECL" | cmp -s - "$NEW"; then
    echo "deploy: the declaration already runs build $FP; nothing to do"
    exit 0
  fi
fi

"${AS[@]}" mkdir -p "$(dirname "$DECL")"
"${AS[@]}" tee "$DECL" <"$NEW" >/dev/null
echo "deploy: wrote $DECL"

RELOAD=("${AS[@]}" env "AMS_STATE_DIR=$STATE" "$AMS" ctl reload)
if [ "$HAD_DECL" = no ]; then
  cat <<NEXT
deploy: first install. The service is declared but NOT started: DSH must run the client build first, or two processes would
hold QQ's one connection. After DSH has been switched and restarted, start the recorder with:
  cd / && ${RELOAD[*]}
NEXT
else
  echo "deploy: reloading AMS (it restarts the qq-recorder only)"
  "${RELOAD[@]}"
fi

# Only this build stays: the recorder is one bundled file, which it has read by the time it runs.
for dir in "$SHARED"/*; do
  [ -d "$dir" ] || continue
  name=$(basename "$dir")
  case "$name" in *[!0-9a-f]* | "") continue ;; esac
  [ ${#name} -eq 12 ] || continue
  if [ "$name" != "$FP" ]; then
    rm -rf "${SHARED:?}/${name:?}"
    echo "deploy: removed old build $name"
  fi
done
