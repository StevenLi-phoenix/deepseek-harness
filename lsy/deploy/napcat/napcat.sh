#!/bin/bash
# The QQ protocol end of lsy-qq: NapCat (OneBot v11) in a Docker container on colima, bound to 127.0.0.1.
# Run it as the operator (not as dsh-runtime): the container holds the QQ login session, which the agent's
# account must not be able to read, so only the operator's docker socket reaches it.
#
#   napcat.sh build           fetch NapCat-Docker and NapCat.Shell.zip (pinned, checksummed) and build the image
#   napcat.sh start [UIN]     seed the OneBot config with a fresh token, start the container and the login door; with UIN, quick-login that account
#   napcat.sh door            (re)start only the login door: the DSH Settings page's QQ section reads NapCat's login state and QR code through it
#   napcat.sh qr [FILE]       copy the current login QR code out of the container (default /tmp/napcat-qr.png); the Settings page shows the same code
#   napcat.sh status | logs [N] | logs door [N] | stop
#
# Boundary: the qq-recorder service (an AMS service of dsh-runtime) holds the OneBot token and nothing else of NapCat;
# DSH never connects to NapCat, it asks the recorder. Through the OneBot API the recorder
# reads the groups it is told to; through the login door (127.0.0.1:3002) it can read whether QQ is logged in, read the
# login QR link while a scan is needed, and ask for a fresh code (refused while QQ is logged in and for ten minutes after, otherwise once per 10 s). It cannot reach NapCat's WebUI (config,
# files, a shell in the container, logout, restart), the docker socket, or the volumes that hold the QQ session: the door
# alone holds the WebUI token, and the door's only two endpoints are the ones above.
#
# The OneBot access token is generated here (openssl) and stored as the AMS secret LSY_QQ_ONEBOT_TOKEN of the service
# qq-recorder (`ams secret set`, the value on stdin); it is never printed. For one release cycle it is also written to
# $DSH_ENV, which the previous build reads, so a rollback finds it. Re-running `start` keeps the existing token; a token
# that is in $DSH_ENV but not yet a secret is copied into the secret, not regenerated. A new token restarts the recorder
# (not DSH).
set -euo pipefail
export PATH="/opt/homebrew/bin:/usr/bin:/bin:$PATH"

DOCKER_REPO="https://github.com/NapNeko/NapCat-Docker"
DOCKER_REPO_SHA="dc3ca1a"            # the commit this was reviewed at (security-scan medium, 2026-10-30)
SHELL_TAG="v4.18.42"
SHELL_SHA256="02e5ff0f79916c1e04c81c1b4590056406fb4293f1f1300c955e71fd08b2829d"   # GitHub's digest of NapCat.Shell.zip for $SHELL_TAG
WORK="${NAPCAT_WORK:-$HOME/dsh-qq-napcat}"
IMAGE="dsh-napcat:local"
NAME="napcat"
PORT="${NAPCAT_PORT:-3001}"
DOOR_NAME="napcat-login"
DOOR_PORT="${NAPCAT_DOOR_PORT:-3002}"
HERE="$(cd "$(dirname "$0")" && pwd)"
DSH_ENV="${DSH_ENV:-/Users/dsh-runtime/.dsh/.env}"
AMS_BIN="${AMS_BIN:-/Users/dsh-runtime/ams/.venv/bin/ams}"
AMS_STATE="${AMS_STATE:-/Users/dsh-runtime/.ams}"

die() { echo "napcat.sh: $*" >&2; exit 1; }

build() {
  rm -rf "$WORK.new" && mkdir -p "$WORK.new"
  git clone --quiet "$DOCKER_REPO" "$WORK.new/src"
  git -C "$WORK.new/src" -c advice.detachedHead=false checkout --quiet "$DOCKER_REPO_SHA"
  gh release download "$SHELL_TAG" -R NapNeko/NapCatQQ -p NapCat.Shell.zip -D "$WORK.new/src" --clobber
  [ "$(shasum -a 256 "$WORK.new/src/NapCat.Shell.zip" | cut -d' ' -f1)" = "$SHELL_SHA256" ] || die "NapCat.Shell.zip does not match the pinned checksum"
  cd "$WORK.new/src"
  sed -i '' 's#^FROM mlikiowa/napcat-docker:base#FROM napcat-base:local#' Dockerfile
  docker build -q -t napcat-base:local -f base/Dockerfile base
  docker build -q -t "$IMAGE" .
  rm -rf "$WORK" && mv "$WORK.new" "$WORK"
  echo "built $IMAGE (NapCat-Docker $DOCKER_REPO_SHA, NapCat.Shell $SHELL_TAG)"
}

# The login door (login-door.py) is the only thing the event service may use of NapCat's WebUI, which can open a shell in
# the container and read the QQ session. It runs in its own container from the same image (python3 is in it), holds the WebUI
# token by reading webui.json from the config volume (read-only mount), checks callers against the OneBot token, and is
# published on 127.0.0.1 only. It is linked to NapCat by name, so it is created after NapCat and again whenever NapCat is.
door() {
  docker image inspect "$IMAGE" >/dev/null 2>&1 || die "no image: run build first"
  docker inspect "$NAME" >/dev/null 2>&1 || die "$NAME is not created: run start first"
  docker rm -f "$DOOR_NAME" >/dev/null 2>&1 || true
  docker run -d --name "$DOOR_NAME" --restart unless-stopped --memory 128m --memory-swap 128m \
    --cap-drop ALL --security-opt no-new-privileges --read-only --tmpfs /tmp \
    --log-opt max-size=1m --log-opt max-file=2 \
    --link "$NAME:napcat" -p "127.0.0.1:$DOOR_PORT:3002" -v napcat-config:/cfg:ro \
    --entrypoint python3 "$IMAGE" -I -c "$(cat "$HERE/login-door.py")" >/dev/null
  echo "started $DOOR_NAME on 127.0.0.1:$DOOR_PORT (the Settings page's QQ section reads NapCat's login through it)"
}

# AMS, as dsh-runtime (it owns the state directory): the recorder's secrets and its process.
ams() { (cd / && sudo -n -u dsh-runtime env AMS_STATE_DIR="$AMS_STATE" "$AMS_BIN" "$@"); }
secret_exists() { ams secret list qq-recorder 2>/dev/null | /usr/bin/grep -qx 'LSY_QQ_ONEBOT_TOKEN'; }
env_token_exists() { sudo -n -u dsh-runtime /usr/bin/grep -q '^LSY_QQ_ONEBOT_TOKEN=.' "$DSH_ENV"; }
token_exists() { secret_exists || env_token_exists; }
# Restart the recorder so it reads a changed secret; it may not be declared yet (first install), which is not an error.
restart_recorder() {
  if ams ctl restart qq-recorder >/dev/null 2>&1; then echo "restarted the qq-recorder (it reads the new token)"
  else echo "the qq-recorder is not running here; after it starts it reads the token"; fi
}

start() {
  local uin="${1:-}"
  docker image inspect "$IMAGE" >/dev/null 2>&1 || die "no image: run build first"
  docker volume create napcat-config >/dev/null
  docker volume create napcat-qq >/dev/null
  if token_exists && ! secret_exists; then
    # Migration: the token predates the recorder; copy it into the secret (stdin to stdin, never printed).
    sudo -n -u dsh-runtime /usr/bin/grep '^LSY_QQ_ONEBOT_TOKEN=' "$DSH_ENV" | /usr/bin/cut -d= -f2- | ams secret set qq-recorder LSY_QQ_ONEBOT_TOKEN
    echo "copied the OneBot token from $DSH_ENV into the qq-recorder's secrets"
  fi
  if ! token_exists || ! docker run --rm -v napcat-config:/cfg --entrypoint test "$IMAGE" -f /cfg/onebot11.json; then
    local t; t=$(openssl rand -hex 24); export t
    docker run --rm -e t -v napcat-config:/cfg --entrypoint bash "$IMAGE" -c \
      'jq --arg t "$t" ".network.websocketServers[0].token = \$t | .network.websocketServers[0].host = \"0.0.0.0\"" /app/templates/ws.json > /cfg/onebot11.json'
    cd / && printf '%s' "$t" | sudo -n -u dsh-runtime /bin/zsh -fc \
      "umask 077; f=$DSH_ENV; /bin/cp -p \$f \$f.bak.\$(date +%Y%m%d%H%M%S); read -r v; { print -r -- \"LSY_QQ_ONEBOT_TOKEN=\$v\"; /usr/bin/grep -v '^LSY_QQ_ONEBOT_TOKEN=' \$f; } >| \$f.new && /bin/mv -f \$f.new \$f"
    printf '%s' "$t" | ams secret set qq-recorder LSY_QQ_ONEBOT_TOKEN
    unset t
    echo "wrote a new OneBot token to the qq-recorder's secrets and to $DSH_ENV (not shown)"
    NEW_TOKEN=1
  fi
  # NapCat logs every received group message (group, nickname, text) at info level, and docker keeps that
  # output: log only warnings and errors, and keep no log file. The login QR code is announced at warn level.
  # The default file seeds new accounts, but each logged-in account has its own napcat_<uin>.json made on its first login
  # (info level), and that one wins: patch every one of them.
  # NapCat.Shell.zip ships every native bypass switched off (its schema defaults them on); while they were off QQ invalidated
  # the login every few hours (KickedOffLine "登录已失效", three times on 2026-11-01), so turn them all on.
  docker run --rm -v napcat-config:/cfg --entrypoint bash "$IMAGE" -c \
    '[ -f /cfg/napcat.json ] || cp /app/napcat/config/napcat.json /cfg/napcat.json 2>/dev/null || echo "{}" > /cfg/napcat.json
     for f in /cfg/napcat.json /cfg/napcat_[0-9]*.json; do
       [ -f "$f" ] || continue
       jq ".consoleLogLevel = \"warn\" | .fileLogLevel = \"warn\" | .fileLog = false
           | .bypass = {hook: true, window: true, module: true, process: true, container: true, js: true}" "$f" > "$f.new" && mv "$f.new" "$f"
     done'
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  local account=()
  [ -n "$uin" ] && account=(-e "ACCOUNT=$uin")
  # QQ ties a login to the device. A container gets a random MAC when it is created, so without a fixed one every
  # recreate looks like a new device and the saved session is useless (the official compose files fix it the same way).
  docker run -d --name "$NAME" --restart unless-stopped --memory 2g --memory-swap 2g --shm-size 512m \
    --log-opt max-size=10m --log-opt max-file=3 \
    --mac-address 02:42:ac:11:00:02 --hostname localhost \
    -p "127.0.0.1:$PORT:3001" -v napcat-config:/app/napcat/config -v napcat-qq:/app/.config/QQ \
    ${account[@]+"${account[@]}"} "$IMAGE" >/dev/null
  echo "started $NAME on 127.0.0.1:$PORT${uin:+ (quick login $uin)}"
  door
  [ "${NEW_TOKEN:-0}" = 1 ] && restart_recorder
  return 0
}

case "${1:-}" in
  build) build ;;
  start) start "${2:-}" ;;
  qr) docker cp "$NAME:/app/napcat/cache/qrcode.png" "${2:-/tmp/napcat-qr.png}" && chmod 600 "${2:-/tmp/napcat-qr.png}" && echo "${2:-/tmp/napcat-qr.png}" ;;
  door) door ;;
  status) docker ps --filter "name=$NAME" --format '{{.Names}} {{.Status}} {{.Ports}}' ;;
  logs) if [ "${2:-}" = door ]; then docker logs --tail "${3:-80}" "$DOOR_NAME" 2>&1; else docker logs --tail "${2:-80}" "$NAME" 2>&1; fi ;;
  stop) docker stop "$DOOR_NAME" "$NAME" ;;
  *) sed -n '2,15p' "$0"; exit 2 ;;
esac
