import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { Config } from '../src/index.ts'

/** One loader patch row. */
interface Row {
  id: string
  name?: string
  config?: Record<string, unknown>
  insert?: Row[]
}

const root = join(import.meta.dirname, '../../../..')
const inserted = (parse(readFileSync(join(root, 'lsy/bundles/event/cordis.patch.yml'), 'utf8'), { logLevel: 'error' }) as Row[]).flatMap(row => row.insert ?? [])

describe('event bundle', () => {
  it('mounts the guard once at the root with the defaults', () => {
    const rows = inserted.filter(row => row.name === '@deepseek-ai/dsh-lsy-guard')
    expect(rows.map(row => row.id)).toEqual(['lsy-guard'])
    const layers = { patterns: true, canary: true, memory: true, llm: true }
    expect(Config((rows[0]?.config ?? {}) as never)).toMatchObject({ layers, extraCanaries: [] })
  })

  it('is linked by setup-profile.sh and checked by check-setup-profile.sh', () => {
    expect(readFileSync(join(root, 'lsy/deploy/setup-profile.sh'), 'utf8')).toContain("'@deepseek-ai/dsh-lsy-guard'")
    expect(readFileSync(join(root, 'lsy/deploy/check-setup-profile.sh'), 'utf8')).toContain('id: lsy-guard')
  })

  it('carries no honeypot or canary value in this public repository', () => {
    expect(readFileSync(join(root, 'lsy/bundles/event/cordis.patch.yml'), 'utf8')).not.toContain('honeypot_')
  })
})
