// Write a consumer package.json that installs every packed tarball in the given directories.
// usage: node consumer-manifest.mjs <out/package.json> <tarball dir>...
import { execFileSync } from 'node:child_process'
import { readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const [out, ...dirs] = process.argv.slice(2)
if (out === undefined || dirs.length === 0) throw new Error('usage: consumer-manifest.mjs <out/package.json> <tarball dir>...')
const dependencies = {}
for (const dir of dirs) {
  for (const file of readdirSync(dir).filter(name => name.endsWith('.tgz')).sort()) {
    const tarball = resolve(join(dir, file))
    const manifest = JSON.parse(execFileSync('tar', ['-xOzf', tarball, 'package/package.json'], { encoding: 'utf8' }))
    dependencies[manifest.name] = pathToFileURL(tarball).href
  }
}
writeFileSync(out, `${JSON.stringify({ name: 'lsy-dsh-app', version: '0.0.0', private: true, dependencies }, null, 2)}\n`)
console.log(`consumer-manifest: ${Object.keys(dependencies).length} package(s) → ${out}`)
