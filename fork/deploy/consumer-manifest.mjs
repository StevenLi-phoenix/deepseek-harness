// Write a consumer package.json that installs every packed tarball in the given directories.
// usage: node consumer-manifest.mjs <out/package.json> <tarball dir>...
// A tarball whose `os`/`cpu` excludes this host goes to optionalDependencies: npm refuses a plain
// dependency for that platform (EBADPLATFORM) even though the runtime never loads it here, and an
// optional one is skipped instead. Upstream's @deepseek-ai/dsh-cua-windows is win32/linux only.
import { execFileSync } from 'node:child_process'
import { readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const [out, ...dirs] = process.argv.slice(2)
if (out === undefined || dirs.length === 0) throw new Error('usage: consumer-manifest.mjs <out/package.json> <tarball dir>...')
const dependencies = {}
const optionalDependencies = {}
for (const dir of dirs) {
  for (const file of readdirSync(dir).filter(name => name.endsWith('.tgz')).sort()) {
    const tarball = resolve(join(dir, file))
    const manifest = JSON.parse(execFileSync('tar', ['-xOzf', tarball, 'package/package.json'], { encoding: 'utf8' }))
    const host = !(Array.isArray(manifest.os) && !manifest.os.includes(process.platform))
      && !(Array.isArray(manifest.cpu) && !manifest.cpu.includes(process.arch))
    ;(host ? dependencies : optionalDependencies)[manifest.name] = pathToFileURL(tarball).href
  }
}
const optional = Object.keys(optionalDependencies).length === 0 ? {} : { optionalDependencies }
writeFileSync(out, `${JSON.stringify({ name: 'fork-dsh-app', version: '0.0.0', private: true, dependencies, ...optional }, null, 2)}\n`)
console.log(`consumer-manifest: ${Object.keys(dependencies).length} package(s), ${Object.keys(optionalDependencies).length} optional → ${out}`)
