#!/bin/bash
# Lay out the event profile in a DSH home: link the fork plugins and the event bundle from an installed
# prefix, and create the owner's patch layer once.
# usage: setup-profile.sh <DSH_HOME> <installed prefix>
# Re-running refreshes the manifest and the links. The profile's cordis.patch.yml belongs to the owner
# (Web UI settings save there) and is never replaced; a pre-bundle copy that still holds the composition
# is moved aside once. Routing state lives in storage, not in files.
set -euo pipefail
HOME_DIR=${1:?DSH_HOME}
PREFIX=${2:?installed prefix}
HERE=$(cd "$(dirname "$0")" && pwd)
PROFILE_SRC="$HERE/../profiles/event"
BUNDLE_SRC=$(cd "$HERE/../bundles/event" && pwd)
PROFILE="$HOME_DIR/profiles/event"
PATCH="$PROFILE/cordis.patch.yml"
mkdir -p "$PROFILE/node_modules/@deepseek-ai"
# Before the bundle existed, setup-profile.sh copied the composition here; its first line marks that copy.
if [ -f "$PATCH" ] && head -1 "$PATCH" | /usr/bin/grep -qF '# fork event profile — composition layer (code-owned)'; then
  ASIDE="$PATCH.pre-bundle.$(date +%Y%m%d%H%M%S)"
  mv "$PATCH" "$ASIDE"
  echo "setup-profile: moved the pre-bundle composition copy to $ASIDE"
fi
if [ ! -f "$PATCH" ]; then
  cp "$PROFILE_SRC/cordis.patch.yml" "$PATCH"
  echo "setup-profile: created the owner patch layer $PATCH"
fi
node - "$PROFILE_SRC/package.json" "$PROFILE/package.json" "$PREFIX" "$BUNDLE_SRC" <<'NODE'
const { readFileSync, writeFileSync, symlinkSync, rmSync, existsSync } = require('node:fs')
const { join } = require('node:path')
const [source, target, prefix, bundleDir] = process.argv.slice(2)
const shipped = JSON.parse(readFileSync(source, 'utf8'))
// Keep what the owner added through the plugin manager; the shipped bundles and links always win.
const current = existsSync(target) ? JSON.parse(readFileSync(target, 'utf8')) : {}
const bundles = shipped.dsh.profile.bundles
const extraBundles = (current.dsh?.profile?.bundles ?? []).filter(name => !bundles.includes(name))
const manifest = {
  ...current,
  ...shipped,
  dependencies: { ...current.dependencies },
  dsh: { ...current.dsh, ...shipped.dsh, profile: { ...current.dsh?.profile, ...shipped.dsh.profile, bundles: [...bundles, ...extraBundles] } },
}
// A `file:` dependency whose directory no longer holds a package (renamed or removed since the last run) is dead:
// drop it, its link, and its bundle entry, so a renamed bundle is not composed twice under its old name.
const dropped = []
for (const [name, spec] of Object.entries(manifest.dependencies)) {
  if (typeof spec !== 'string' || !spec.startsWith('file:') || existsSync(join(spec.slice('file:'.length), 'package.json'))) continue
  delete manifest.dependencies[name]
  rmSync(join(target, '..', 'node_modules', name), { force: true, recursive: false })
  dropped.push(name)
}
manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter(name => !dropped.includes(name))
if (dropped.length > 0) console.log(`setup-profile: dropped ${dropped.length} dead link(s): ${dropped.join(' ')}`)
const links = []
function link(name, directory) {
  if (!existsSync(join(directory, 'package.json'))) throw new Error(`setup-profile: ${name} is not installed in ${directory}`)
  const path = join(target, '..', 'node_modules', name)
  rmSync(path, { force: true, recursive: false })
  symlinkSync(directory, path)
  manifest.dependencies[name] = `file:${directory}`
  links.push(name)
}
// The installed product resolves only its own default packages; the experimental webhook runtime, its
// GitHub adapter, and the console logger are profile plugins here, linked like the fork packages.
for (const name of ['@deepseek-ai/dsh-webhook', '@deepseek-ai/dsh-webhook-github', '@deepseek-ai/cordis-plugin-logger-console', '@deepseek-ai/dsh-event-bus', '@deepseek-ai/dsh-github-sensor',
  '@deepseek-ai/dsh-wechat', '@deepseek-ai/dsh-tool-watch', '@deepseek-ai/dsh-tool-wechat', '@deepseek-ai/dsh-provider-balance', '@deepseek-ai/dsh-owner-memory', '@deepseek-ai/dsh-owner-memory-admin',
  '@deepseek-ai/dsh-event-ingest', '@deepseek-ai/dsh-tool-monitor', '@deepseek-ai/dsh-cc-bridge', '@deepseek-ai/dsh-sysmon', '@deepseek-ai/dsh-plugin-config', '@deepseek-ai/dsh-event-console', '@deepseek-ai/dsh-cc-admin', '@deepseek-ai/dsh-presence', '@deepseek-ai/dsh-wechat-settings', '@deepseek-ai/dsh-bili',
  '@deepseek-ai/dsh-voice', '@deepseek-ai/dsh-tool-voice', '@deepseek-ai/dsh-tool-up',
  '@deepseek-ai/dsh-tool-bili', '@deepseek-ai/dsh-owner-relay', '@deepseek-ai/dsh-qq', '@deepseek-ai/dsh-qq-login', '@deepseek-ai/dsh-tool-qq', '@deepseek-ai/dsh-qqbot',
  '@deepseek-ai/dsh-turn-taint', '@deepseek-ai/dsh-integrity-watch', '@deepseek-ai/dsh-speaking-style', '@deepseek-ai/dsh-speaking-style-settings', '@deepseek-ai/dsh-content-guard', '@deepseek-ai/dsh-time-gap',
  '@deepseek-ai/dsh-courses', '@deepseek-ai/dsh-courses-settings', '@deepseek-ai/dsh-tool-courses',
  '@deepseek-ai/dsh-gmail', '@deepseek-ai/dsh-gmail-settings', '@deepseek-ai/dsh-tool-gmail', '@deepseek-ai/dsh-subagent-activity']) {
  link(name, join(prefix, 'node_modules', name))
}
link('@deepseek-ai/dsh-event-bundle', bundleDir)
writeFileSync(target, `${JSON.stringify(manifest, null, 2)}\n`)
console.log(`setup-profile: ${links.length} link(s) in ${join(target, '..')}`)
NODE
# Owner skills shipped with the build (fork/skills/<name>): the skill-filesystem user root <DSH_HOME>/skills
# picks them up live, so linking is enough (no restart). A plain directory left by a manual install is replaced.
if [ -d "$PREFIX/fork/skills" ]; then
  mkdir -p "$HOME_DIR/skills"
  for skill in "$PREFIX"/fork/skills/*/; do
    name=$(basename "$skill")
    [ -L "$HOME_DIR/skills/$name" ] || rm -rf "${HOME_DIR:?}/skills/${name:?}"
    ln -sfn "${skill%/}" "$HOME_DIR/skills/$name"
  done
  echo "setup-profile: linked skills from $PREFIX/fork/skills into $HOME_DIR/skills"
fi
