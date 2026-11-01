/** `fork/deploy/qq-recorder/deploy.sh` against a fake `ams` and temp directories: it must never reload on a first install. */
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const SCRIPT = resolve(import.meta.dirname, '../../../../fork/deploy/qq-recorder/deploy.sh')
let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'qq-recorder-deploy-'))
  // The fake ams records its arguments and the state directory it was given.
  writeFileSync(join(dir, 'ams'), `#!/bin/sh\necho "$AMS_STATE_DIR $*" >> "${dir}/ams.log"\n`)
  chmodSync(join(dir, 'ams'), 0o755)
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

const decl = (): string => join(dir, 'ams-state', 'services', 'qq-recorder', 'service.toml')
const pinned = (): string => join(dir, 'shared')
const amsCalls = (): string[] => (existsSync(join(dir, 'ams.log')) ? readFileSync(join(dir, 'ams.log'), 'utf8').trim().split('\n') : [])

function bundle(content: string): string {
  const path = join(dir, `bundle-${Buffer.from(content).toString('hex').slice(0, 8)}.mjs`)
  writeFileSync(path, content)
  return path
}

function deploy(file: string) {
  const run = spawnSync('/bin/bash', [SCRIPT, file], {
    encoding: 'utf8',
    env: {
      PATH: process.env['PATH'] ?? '', QQ_RECORDER_AS: 'env', QQ_RECORDER_SHARED: pinned(), QQ_RECORDER_DECL: decl(),
      QQ_RECORDER_AMS: join(dir, 'ams'), QQ_RECORDER_STATE: join(dir, 'ams-state'),
    },
  })
  return { code: run.status, out: run.stdout, err: run.stderr }
}

const fingerprint = (out: string): string => /build ([0-9a-f]{12})/.exec(out)![1]!

describe('deploy.sh', () => {
  it('on a first install pins the bundle and places the declaration, prints the command that starts the service, and does not reload', () => {
    const first = deploy(bundle('console.log("one")'))
    expect(first.code, first.err).toBe(0)
    const fp = fingerprint(first.out)
    expect(readFileSync(join(pinned(), fp, 'qq-recorder.mjs'), 'utf8')).toBe('console.log("one")')
    expect(statSync(join(pinned(), fp, 'qq-recorder.mjs')).mode & 0o777).toBe(0o644)
    const text = readFileSync(decl(), 'utf8')
    expect(text).toContain('id = "qq-recorder"')
    expect(text).toContain(`"${join(pinned(), fp, 'qq-recorder.mjs')}"`)
    expect(text).toContain(`QQ_RECORDER_BUILD = "${fp}"`)
    expect(text).not.toMatch(/@[A-Z]+@/)
    expect(text).toContain('secrets = ["FORK_QQ_ONEBOT_TOKEN", "QQ_RECORDER_TOKEN"]')
    expect(text).toContain('kind = "none"')
    expect(amsCalls()).toEqual([])
    expect(first.out).toContain('first install')
    expect(first.out).toContain(`AMS_STATE_DIR=${join(dir, 'ams-state')}`)
    expect(first.out).toContain('ctl reload')
  })

  it('writes nothing and reloads nothing when the declaration already runs this build', () => {
    const file = bundle('console.log("one")')
    deploy(file)
    const before = statSync(decl())
    const again = deploy(file)
    expect(again.code, again.err).toBe(0)
    expect(again.out).toContain('nothing to do')
    expect(statSync(decl()).mtimeMs).toBe(before.mtimeMs)
    expect(statSync(decl()).ino).toBe(before.ino)
    expect(amsCalls()).toEqual([])
  })

  it('on an upgrade writes the new declaration and reloads AMS once, so the recorder alone restarts', () => {
    const one = fingerprint(deploy(bundle('console.log("one")')).out)
    const second = deploy(bundle('console.log("two")'))
    expect(second.code, second.err).toBe(0)
    const two = fingerprint(second.out)
    expect(two).not.toBe(one)
    expect(readFileSync(decl(), 'utf8')).toContain(`QQ_RECORDER_BUILD = "${two}"`)
    expect(amsCalls()).toEqual([`${join(dir, 'ams-state')} ctl reload`])
    // The build it replaced stays for a rollback.
    expect(readdirSync(pinned()).sort()).toEqual([one, two].sort())
  })

  it('removes builds older than the current and the previous one', () => {
    const fps = ['one', 'two', 'three'].map(name => fingerprint(deploy(bundle(`console.log("${name}")`)).out))
    expect(readdirSync(pinned()).sort()).toEqual([fps[1]!, fps[2]!].sort())
    expect(amsCalls()).toHaveLength(2)
  })

  it('leaves other files in the shared directory alone', () => {
    mkdirSync(join(pinned(), 'not-a-build'), { recursive: true })
    deploy(bundle('console.log("one")'))
    deploy(bundle('console.log("two")'))
    expect(existsSync(join(pinned(), 'not-a-build'))).toBe(true)
  })

  it('refuses a missing bundle', () => {
    const run = deploy(join(dir, 'nope.mjs'))
    expect(run.code).toBe(1)
    expect(run.err).toContain('is not a file')
    expect(existsSync(decl())).toBe(false)
  })
})
