#!/bin/bash
# Lay out the event profile in a DSH home: link the lsy plugins and the event bundle from an installed
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
if [ -f "$PATCH" ] && head -1 "$PATCH" | /usr/bin/grep -qF '# lsy event profile — composition layer (code-owned)'; then
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
// GitHub adapter, and the console logger are profile plugins here, linked like the lsy packages.
for (const name of ['@deepseek-ai/dsh-webhook', '@deepseek-ai/dsh-webhook-github', '@deepseek-ai/cordis-plugin-logger-console', '@deepseek-ai/dsh-lsy-event-bus', '@deepseek-ai/dsh-lsy-github-sensor',
  '@deepseek-ai/dsh-lsy-wechat', '@deepseek-ai/dsh-lsy-tool-watch', '@deepseek-ai/dsh-lsy-tool-wechat', '@deepseek-ai/dsh-lsy-balance', '@deepseek-ai/dsh-lsy-memory',
  '@deepseek-ai/dsh-lsy-event-ingest', '@deepseek-ai/dsh-lsy-tool-monitor', '@deepseek-ai/dsh-lsy-sysmon', '@deepseek-ai/dsh-bili',
  '@deepseek-ai/dsh-tool-bili']) {
  link(name, join(prefix, 'node_modules', name))
}
link('@deepseek-ai/dsh-lsy-event-bundle', bundleDir)
writeFileSync(target, `${JSON.stringify(manifest, null, 2)}\n`)
console.log(`setup-profile: ${links.length} link(s) in ${join(target, '..')}`)
NODE
