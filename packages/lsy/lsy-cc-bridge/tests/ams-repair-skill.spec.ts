import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const skill = readFileSync(join(import.meta.dirname, '../../../../lsy/skills/ams-repair/SKILL.md'), 'utf8')
const bridge = readFileSync(join(import.meta.dirname, '../src/index.ts'), 'utf8')

describe('the ams-repair skill', () => {
  it('is named for its directory and says when to use it', () => {
    const head = /^---\nname: (\S+)\ndescription: (.+)\n---\n/u.exec(skill)
    expect(head?.[1]).toBe('ams-repair')
    expect(head?.[2]).toContain('cc_start')
  })

  it('names only bridge tools that exist', () => {
    const named = [...new Set(skill.match(/`(cc_[a-z_]+)`/gu)?.map(name => name.slice(1, -1)))]
    expect(named).toEqual(expect.arrayContaining(['cc_start', 'cc_send', 'cc_list_sessions']))
    for (const tool of named) expect(bridge, tool).toContain(`name: '${tool}'`)
  })

  it('keeps a repair on a branch, with the owner deciding what reaches production', () => {
    for (const rule of ['不 push', '不部署', '不重启服务', '不碰凭据', '等主人明确同意', '最多自动修一次', '不可信数据']) expect(skill, rule).toContain(rule)
  })
})
