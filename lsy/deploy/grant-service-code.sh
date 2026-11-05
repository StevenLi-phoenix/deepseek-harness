#!/bin/bash
# Let the service user change the code of the AMS services (RUNBOOK "Service code"). Run on the Mac mini as the
# owner, no root needed.
#
#   grant-service-code.sh apply    move the source repos to $SRC_ROOT (a symlink stays behind) and grant the ACLs
#   grant-service-code.sh check    prove as the service user that it can change and ship code, and read no secret
#   grant-service-code.sh revoke   remove the ACLs and move the repos back
#
# The owner's home stays 0700: it holds world-readable .env files, so the repos move out instead of the home opening up.
set -euo pipefail

AGENT=dsh-runtime
OWNER="$(id -un)"
SRC_ROOT=/Users/Shared/ams-src
APPS_ROOT=/Users/Shared/ams-apps
AGENT_GIT=/usr/bin/git
REPOS=(
  "$HOME/services/asr-service"
  "$HOME/services/autocut"
  "$HOME/services/bili-svc"
  "$HOME/Codes/translate_upload_yt_bilibili"
  "$HOME/Codes/bgutil-ytdlp-pot-provider"
)
APPS=(asr-service autocut bili-svc kaorou bgutil-pot python)
DSH_APPS=/Users/Shared/lsy-dsh
DIR_RIGHTS="list,add_file,search,add_subdirectory,delete_child,readattr,writeattr,readextattr,writeextattr,readsecurity,writesecurity,delete,file_inherit,directory_inherit"
FILE_RIGHTS="read,write,append,execute,delete,readattr,writeattr,readextattr,writeextattr,readsecurity,writesecurity"
# Files that hold credentials in the dev checkouts: never part of a commit or a deploy, so denied outright.
SECRETS=( -name .env -o -name '.env.*' -o -name .registry-secret -o -name worker.env -o -name '.worker.env*' -o -name 'cookies.json*' -o -name message_token.txt )

log() { printf 'grant-service-code: %s\n' "$*"; }

as_agent() { sudo -n -H -u "$AGENT" /bin/sh -c "cd /; export PATH=/opt/homebrew/bin:/usr/bin:/bin; $1"; }

grant_tree() {
  local tree="$1"
  if /bin/ls -led "$tree" | /usr/bin/grep -q "user:$AGENT allow"; then
    log "already granted: $tree"
    return
  fi
  local started=$SECONDS
  /usr/bin/find "$tree" -user "$OWNER" -type d -exec chmod +a "$AGENT allow $DIR_RIGHTS" {} + -exec chmod +a "$OWNER allow $DIR_RIGHTS" {} +
  /usr/bin/find "$tree" -user "$OWNER" -type f ! \( "${SECRETS[@]}" \) -exec chmod +a "$AGENT allow $FILE_RIGHTS" {} +
  /usr/bin/find "$tree" -user "$OWNER" -type f \( "${SECRETS[@]}" \) ! -name '*.example' -exec chmod +a "$AGENT deny read,write,append" {} +
  log "granted $tree ($((SECONDS - started)) s)"
}

revoke_tree() {
  /usr/bin/find "$1" -user "$OWNER" \( -type d -o -type f \) -exec chmod -N {} +
  log "revoked $1"
}

init_repo_if_needed() {
  local repo="$1"
  [ ! -e "$repo/.git" ] || return 0
  log "git init $repo (it had no history to roll back to)"
  printf '%s\n' .venv/ __pycache__/ logs/ '*.bak*' '.*.bak*' .registry-secret >"$repo/.gitignore"
  git -C "$repo" init -q
  git -C "$repo" add -A
  git -C "$repo" commit -qm "chore: start history from the running source"
}

apply() {
  mkdir -p -m 700 "$SRC_ROOT"
  /bin/ls -led "$SRC_ROOT" | /usr/bin/grep -q "user:$AGENT allow" || chmod +a "$AGENT allow list,search,readattr,readextattr,readsecurity" "$SRC_ROOT"
  local repo dest
  for repo in "${REPOS[@]}"; do
    dest="$SRC_ROOT/$(basename "$repo")"
    if [ ! -L "$repo" ]; then
      [ ! -e "$dest" ] || { log "refusing to overwrite $dest"; exit 1; }
      mv "$repo" "$dest"
      ln -s "$dest" "$repo"
      log "moved $repo -> $dest"
    fi
    init_repo_if_needed "$dest"
    git -C "$dest" config receive.denyCurrentBranch updateInstead
    grant_tree "$dest"
  done
  local app
  for app in "${APPS[@]}"; do
    grant_tree "$APPS_ROOT/$app"
  done
  grant_tree "$DSH_APPS"
  as_agent "$AGENT_GIT config --global --get-all safe.directory | /usr/bin/grep -qxF '$SRC_ROOT/*' || $AGENT_GIT config --global --add safe.directory '$SRC_ROOT/*'"
  log "applied; run: $0 check"
}

revoke() {
  local repo dest app
  revoke_tree "$DSH_APPS"
  for app in "${APPS[@]}"; do
    revoke_tree "$APPS_ROOT/$app"
  done
  for repo in "${REPOS[@]}"; do
    dest="$SRC_ROOT/$(basename "$repo")"
    [ -L "$repo" ] && [ -d "$dest" ] || continue
    revoke_tree "$dest"
    rm "$repo"
    mv "$dest" "$repo"
    log "moved back $repo"
  done
  as_agent "$AGENT_GIT config --global --unset-all safe.directory '$SRC_ROOT/\\*' || true"
  chmod -N "$SRC_ROOT"
  rmdir "$SRC_ROOT"
  log "revoked; files the service user created stay owned by it"
}

check() {
  local failures=0 scratch
  scratch="/tmp/grant-check.$$"
  ok() { log "ok   $1"; }
  bad() { log "FAIL $1"; failures=$((failures + 1)); }
  local repo name app secret
  for repo in "${REPOS[@]}"; do
    name="$(basename "$repo")"
    [ -L "$repo" ] && ok "$name: the old path is a symlink" || bad "$name: the old path is not a symlink"
    if as_agent "$AGENT_GIT clone -q '$SRC_ROOT/$name' '$scratch.$name' \
        && cd '$scratch.$name' && $AGENT_GIT checkout -q -b dsh-grant-check \
        && $AGENT_GIT -c user.name=check -c user.email=check@localhost commit -q --allow-empty -m check \
        && $AGENT_GIT push -q origin dsh-grant-check && $AGENT_GIT push -q origin --delete dsh-grant-check" >/dev/null 2>&1; then
      ok "$name: clone, commit, push, delete a branch"
    else
      bad "$name: clone, commit, push, delete a branch"
    fi
    as_agent "rm -rf '$scratch.$name'" || true
    if as_agent "/usr/bin/touch '$SRC_ROOT/$name/.grant-check' && rm '$SRC_ROOT/$name/.grant-check'" >/dev/null 2>&1; then
      ok "$name: write in the work tree"
    else
      bad "$name: write in the work tree"
    fi
    while IFS= read -r secret; do
      [ -n "$secret" ] || continue
      if as_agent "/bin/cat '$secret'" >/dev/null 2>&1; then bad "readable secret: $secret"; fi
    done < <(/usr/bin/find "$SRC_ROOT/$name" \( -name node_modules -o -name .venv -o -name .git \) -prune -o -type f \( "${SECRETS[@]}" \) ! -name '*.example' -print 2>/dev/null)
  done
  for app in "${APPS[@]}"; do
    if as_agent "/usr/bin/touch '$APPS_ROOT/$app/.grant-check' && rm '$APPS_ROOT/$app/.grant-check'" >/dev/null 2>&1; then
      ok "deploy copy $app: write"
    else
      bad "deploy copy $app: write"
    fi
  done
  if as_agent "/usr/bin/touch '$DSH_APPS/.grant-check' && rm '$DSH_APPS/.grant-check'" >/dev/null 2>&1; then
    ok "DSH builds: write"
  else
    bad "DSH builds: write"
  fi
  if as_agent "/bin/ls '$HOME'" >/dev/null 2>&1; then bad "the owner's home is reachable"; else ok "the owner's home stays closed"; fi
  if as_agent "AMS_STATE_DIR=/Users/$AGENT/.ams /Users/$AGENT/ams/.venv/bin/ams ctl status" >/dev/null 2>&1; then
    ok "ams ctl reaches the harness"
  else
    bad "ams ctl reaches the harness"
  fi
  [ "$failures" = 0 ] || { log "$failures check(s) failed"; exit 1; }
  log "all checks passed"
}

case "${1:-}" in
  apply) apply ;;
  check) check ;;
  revoke) revoke ;;
  *) echo "usage: grant-service-code.sh apply|check|revoke" >&2; exit 2 ;;
esac
