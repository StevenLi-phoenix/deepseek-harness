#!/bin/bash
# Lay out the event profile in a DSH home and link the lsy plugins from an installed prefix.
# usage: setup-profile.sh <DSH_HOME> <installed prefix>
# Re-running refreshes the composition layer and links; the home patch (routing layer) is never overwritten.
set -euo pipefail
HOME_DIR=${1:?DSH_HOME}
PREFIX=${2:?installed prefix}
HERE=$(cd "$(dirname "$0")" && pwd)
PROFILE_SRC="$HERE/../profiles/event"
PROFILE="$HOME_DIR/profiles/event"
mkdir -p "$PROFILE/node_modules/@deepseek-ai"
cp "$PROFILE_SRC/cordis.patch.yml" "$PROFILE/cordis.patch.yml"
node - "$PROFILE_SRC/package.json" "$PROFILE/package.json" "$PREFIX" <<'NODE'
const { readFileSync, writeFileSync, symlinkSync, rmSync, existsSync } = require('node:fs')
const { join } = require('node:path')
const [source, target, prefix] = process.argv.slice(2)
const manifest = JSON.parse(readFileSync(source, 'utf8'))
manifest.dependencies = {}
// The installed product resolves only its own default packages; the experimental webhook runtime and the
// console logger are profile plugins here, linked like the lsy packages.
for (const name of ['@deepseek-ai/dsh-webhook', '@deepseek-ai/cordis-plugin-logger-console', '@deepseek-ai/dsh-lsy-event-bus', '@deepseek-ai/dsh-lsy-github-sensor', '@deepseek-ai/dsh-lsy-telegram']) {
  const directory = join(prefix, 'node_modules', name)
  if (!existsSync(join(directory, 'package.json'))) throw new Error(`setup-profile: ${name} is not installed in ${prefix}`)
  const link = join(target, '..', 'node_modules', name)
  rmSync(link, { force: true, recursive: false })
  symlinkSync(directory, link)
  manifest.dependencies[name] = `file:${directory}`
}
writeFileSync(target, `${JSON.stringify(manifest, null, 2)}\n`)
console.log(`setup-profile: ${Object.keys(manifest.dependencies).length} plugin link(s) in ${join(target, '..')}`)
NODE
if [ ! -e "$HOME_DIR/cordis.patch.yml" ]; then
  cp "$PROFILE_SRC/home.patch.example.yml" "$HOME_DIR/cordis.patch.yml"
  echo "setup-profile: wrote $HOME_DIR/cordis.patch.yml from the example; edit the routing before starting"
fi
