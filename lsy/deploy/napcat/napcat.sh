#!/bin/bash
# The QQ protocol end of lsy-qq: NapCat (OneBot v11) in a Docker container on colima, bound to 127.0.0.1.
# Run it as the operator (not as dsh-runtime): the container holds the QQ login session, which the agent's
# account must not be able to read, so only the operator's docker socket reaches it.
#
#   napcat.sh build           fetch NapCat-Docker and NapCat.Shell.zip (pinned, checksummed) and build the image
#   napcat.sh start [UIN]     seed the OneBot config with a fresh token, start the container; with UIN, quick-login that account
#   napcat.sh qr [FILE]       copy the current login QR code out of the container (default /tmp/napcat-qr.png)
#   napcat.sh status | logs | stop
#
# The OneBot access token is generated here (openssl) and written to $DSH_ENV as LSY_QQ_ONEBOT_TOKEN; it is
# never printed. Re-running `start` keeps the existing token.
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
DSH_ENV="${DSH_ENV:-/Users/dsh-runtime/.dsh/.env}"

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

token_exists() { sudo -n -u dsh-runtime /usr/bin/grep -q '^LSY_QQ_ONEBOT_TOKEN=.' "$DSH_ENV"; }

start() {
  local uin="${1:-}"
  docker image inspect "$IMAGE" >/dev/null 2>&1 || die "no image: run build first"
  docker volume create napcat-config >/dev/null
  docker volume create napcat-qq >/dev/null
  if ! token_exists || ! docker run --rm -v napcat-config:/cfg --entrypoint test "$IMAGE" -f /cfg/onebot11.json; then
    local t; t=$(openssl rand -hex 24); export t
    docker run --rm -e t -v napcat-config:/cfg --entrypoint bash "$IMAGE" -c \
      'jq --arg t "$t" ".network.websocketServers[0].token = \$t | .network.websocketServers[0].host = \"0.0.0.0\"" /app/templates/ws.json > /cfg/onebot11.json'
    cd / && printf '%s' "$t" | sudo -n -u dsh-runtime /bin/zsh -fc \
      "umask 077; f=$DSH_ENV; /bin/cp -p \$f \$f.bak.\$(date +%Y%m%d%H%M%S); read -r v; { print -r -- \"LSY_QQ_ONEBOT_TOKEN=\$v\"; /usr/bin/grep -v '^LSY_QQ_ONEBOT_TOKEN=' \$f; } >| \$f.new && /bin/mv -f \$f.new \$f"
    unset t
    echo "wrote a new OneBot token to $DSH_ENV (not shown); restart the dsh service so it reads it"
  fi
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  local account=()
  [ -n "$uin" ] && account=(-e "ACCOUNT=$uin")
  docker run -d --name "$NAME" --restart unless-stopped --memory 2g --memory-swap 2g --shm-size 512m \
    -p "127.0.0.1:$PORT:3001" -v napcat-config:/app/napcat/config -v napcat-qq:/app/.config/QQ \
    ${account[@]+"${account[@]}"} "$IMAGE" >/dev/null
  echo "started $NAME on 127.0.0.1:$PORT${uin:+ (quick login $uin)}"
}

case "${1:-}" in
  build) build ;;
  start) start "${2:-}" ;;
  qr) docker cp "$NAME:/app/napcat/cache/qrcode.png" "${2:-/tmp/napcat-qr.png}" && chmod 600 "${2:-/tmp/napcat-qr.png}" && echo "${2:-/tmp/napcat-qr.png}" ;;
  status) docker ps --filter "name=$NAME" --format '{{.Names}} {{.Status}} {{.Ports}}' ;;
  logs) docker logs --tail "${2:-80}" "$NAME" 2>&1 ;;
  stop) docker stop "$NAME" ;;
  *) sed -n '2,13p' "$0"; exit 2 ;;
esac
