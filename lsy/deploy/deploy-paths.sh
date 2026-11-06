# Which way a change reaches the running service, by the paths it touches. Sourced by self-upgrade.sh, which acts on it, and by
# deploy-dsh.sh, which says beforehand what will happen.

# Whether a changed path needs no build: docs that no process loads, and skills and scripts the deploy copies as they are.
no_build_path() {
  case "$1" in
    lsy/bundles/* | lsy/profiles/* | lsy/deploy/setup-profile.sh | lsy/deploy/qq-recorder/*) return 1 ;;
    docs/* | .agents/* | lsy/skills/* | lsy/deploy/* | lsy/*.md | README.i18n.yaml | */README.i18n.yaml) return 0 ;;
    */*.md) case "${1##*/}" in README*.md | CHANGELOG*.md) return 0 ;; *) return 1 ;; esac ;;
    *.md) return 0 ;;
    *) return 1 ;;
  esac
}

# Whether a changed path reaches the process only through a plugin's own files, or not at all.
hot_path() {
  no_build_path "$1" && return 0
  case "$1" in
    packages/lsy/*/package.json | lsy/deploy/setup-profile.sh | lsy/profiles/* | lsy/bundles/*) return 1 ;;
    packages/lsy/* | lsy/*) return 0 ;;
    *) return 1 ;;
  esac
}

# Prints why going from the running commit to another needs the restart path, or nothing when it can be replaced live. Leaves the
# changed paths in <paths file>. usage: restart_reason <running commit> <target commit> <paths file>
restart_reason() {
  local path named="" count=0
  git cat-file -e "$1^{commit}" 2>/dev/null || { echo "$1 is not in this checkout's history"; return 0; }
  git diff --no-renames --name-only "$1" "$2" >"$3"
  while IFS= read -r path; do
    hot_path "$path" && continue
    count=$((count + 1))
    [ "$count" -gt 3 ] || named="$named${named:+, }$path"
  done <"$3"
  [ "$count" = 0 ] && return 0
  [ "$count" -le 3 ] || named="$named and $((count - 3)) more"
  echo "$named changed"
}

# Whether any of the changed paths in <paths file> needs the build. usage: needs_build <paths file>
needs_build() {
  local path
  while IFS= read -r path; do
    no_build_path "$path" || return 0
  done <"$1"
  return 1
}
