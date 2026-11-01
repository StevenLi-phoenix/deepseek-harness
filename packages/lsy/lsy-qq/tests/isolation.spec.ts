/**
 * The recorder owns `qq.db`, the media files, the state files, and the OneBot connection exclusively. DSH reaches them only
 * through the protocol in `src/protocol.ts`. These checks fail when DSH-side code starts to open the database, read a file
 * of the recorder's data directory, or reach for the OneBot client.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import * as dsh from '../src/index.ts'

const LSY = join(import.meta.dirname, '..', '..')
const SRC = join(import.meta.dirname, '..', 'src')

/** Modules only the recorder process may load. */
const RECORDER_SIDE = ['store.ts', 'recorder.ts', 'server.ts', 'onebot.ts', 'media.ts', 'login.ts', 'text.ts'] as const

/** Source without comments, so a sentence about a file is not mistaken for opening it. */
function code(path: string): string {
  return readFileSync(path, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1')
}

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (name === 'node_modules' || name === 'lib') return []
    if (statSync(path).isDirectory()) return sources(path)
    return /\.(ts|tsx)$/.test(name) && !name.endsWith('.d.ts') ? [path] : []
  })
}

describe('DSH never touches the recorder\'s data', () => {
  const dshSide = readdirSync(SRC).filter(name => name.endsWith('.ts') && !(RECORDER_SIDE as readonly string[]).includes(name))

  it('has a DSH side and a recorder side that together are every module of the package', () => {
    expect([...dshSide, ...RECORDER_SIDE].sort()).toEqual(readdirSync(SRC).filter(name => name.endsWith('.ts')).sort())
  })

  it.each(dshSide)('%s imports nothing of the recorder side, opens no SQLite file, and names none of the recorder\'s files', (name) => {
    const text = code(join(SRC, name))
    for (const module of RECORDER_SIDE) expect(text, `${name} imports ${module}`).not.toMatch(new RegExp(`from '\\./${module.replace('.', '\\.')}'`))
    expect(text).not.toMatch(/node:sqlite|DatabaseSync|QqStore|from 'ws'/)
    expect(text).not.toMatch(/qq\.db|connection-state\.json|recorder-config\.json|outage-notice\.json|QQ_RECORDER_DATA_DIR/)
  })

  it('exports nothing of the recorder side from the package entry point', () => {
    for (const forbidden of ['QqStore', 'QqRecorder', 'OneBotClient', 'LoginDoor', 'startRecorderServer', 'saveMedia', 'fetchCapped']) {
      expect(Object.keys(dsh), forbidden).not.toContain(forbidden)
    }
  })

  it('keeps every other package away from the recorder\'s modules and files', () => {
    const offenders: string[] = []
    for (const pkg of readdirSync(LSY)) {
      if (pkg === 'lsy-qq') continue
      const src = join(LSY, pkg, 'src')
      try {
        statSync(src)
      } catch {
        continue
      }
      for (const file of sources(src)) {
        const text = code(file)
        if (/dsh-lsy-qq\/src\/(store|recorder|server|onebot|media|login|text)\.ts|\bQqStore\b|\bQqRecorder\b|qq\.db|recorder-config\.json|lsy-qq\/media/.test(text)) offenders.push(relative(LSY, file))
      }
    }
    expect(offenders).toEqual([])
  })

  it('keeps the recorder\'s modules from importing DSH services', () => {
    for (const name of RECORDER_SIDE) {
      expect(code(join(SRC, name)), name).not.toMatch(/from '@deepseek-ai\/(cordis|dsh-)/)
    }
  })
})
