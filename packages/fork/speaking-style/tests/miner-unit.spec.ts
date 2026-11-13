import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { StyleGate } from '../src/guard.ts'
import type { ModelCall } from '../src/model.ts'
import { NotesStore } from '../src/notes.ts'
import { MemeMiner, parseJson, screenInputs, type MineInput, type MinerDeps, type MinerSettings } from '../src/miner.ts'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map(async (dir) => { await rm(dir, { recursive: true, force: true }) }))
})

const SETTINGS: MinerSettings = {
  minLikes: 10, maxInputs: 50, maxNew: 5, maxSearches: 3, termChars: 20, exampleChars: 60, meaningChars: 60,
  blocklist: [], rawKept: 20, commonShare: 0.5, commonFrom: 10,
}
const qq = (text: string, likes = 0): MineInput => ({ kind: 'qq', text, likes })
const comment = (text: string, likes = 0): MineInput => ({ kind: 'comment', text, likes })
const web = (text: string): MineInput => ({ kind: 'web', text, likes: 0 })
const hot = (text: string): MineInput => ({ kind: 'hot', text, likes: 0 })
const proposal = (term: string, example: string, extra: Record<string, unknown> = {}) => ({ term, meaning: '', example, related: [], ...extra })

interface Setup {
  propose?: unknown
  meaning?: unknown
  settings?: Partial<MinerSettings>
  deps?: Partial<MinerDeps>
  guard?: { check: (text: string) => Promise<{ ok: true } | { ok: false; rule: string; publicReason: string }> } | undefined
  noModel?: boolean
}

async function setup(options: Setup = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'speaking-style-miner-'))
  dirs.push(dir)
  const notes = new NotesStore(join(dir, 'notes.json'), { maxMemes: 40, maxTraits: 10, expireDays: 30, maxVersions: 5 })
  const asked: Array<{ system: string; user: string }> = []
  const answerOf = (value: unknown): string => (typeof value === 'string' ? value : JSON.stringify(value))
  const model = vi.fn<ModelCall>(async (request) => {
    asked.push(request)
    const value = request.system.includes('学网络热梗') ? options.propose : options.meaning
    if (value instanceof Error || (typeof value === 'object' && value !== null && 'fail' in value)) throw value instanceof Error ? value : value.fail
    return { text: answerOf(value ?? []), raw: { answer: value ?? null } }
  })
  const logger = { info: vi.fn(), warn: vi.fn() }
  const guard = 'guard' in options ? options.guard : { check: async () => ({ ok: true as const }) }
  const gateWarn = vi.fn()
  const gate = new StyleGate({ get: () => guard } as never as Context, gateWarn, vi.fn())
  const rawDir = join(dir, 'raw')
  const deps: MinerDeps = {
    notes, hotwatch: undefined, gate, model: options.noModel === true ? undefined : model, search: undefined,
    settings: { ...SETTINGS, ...options.settings },
    rawDir, logger, ...options.deps,
  }
  const miner = new MemeMiner(deps)
  const run = (inputs: MineInput[], signal = new AbortController().signal) => miner.run(inputs, signal)
  const rawNames = async () => (await readdir(rawDir).catch(() => [])).toSorted()
  return { dir, notes, model, asked, logger, gateWarn, miner, run, rawDir, rawNames, deps }
}

const stored = async (notes: NotesStore) => Object.fromEntries((await notes.notes()).map(note => [note.term, note]))

describe('parseJson', () => {
  it('reads the whole answer, a fenced block, or the outermost bracket pair, and gives up on anything else', () => {
    expect(parseJson('[1,2]')).toEqual([1, 2])
    expect(parseJson('```json\n{"a":1}\n```')).toEqual({ a: 1 })
    expect(parseJson('好的，结果如下：[{"a":1}] 以上。')).toEqual([{ a: 1 }])
    expect(parseJson('没有 JSON')).toBeUndefined()
    expect(parseJson('{ 不完整')).toBeUndefined()
    expect(parseJson('] 反着 [')).toBeUndefined()
  })
})

describe('screenInputs', () => {
  it('drops duplicates and blanks silently, counts the texts the filter refuses, and ranks hot words, then likes', () => {
    const raw = [
      comment('普通评论', 3), comment('  普通评论 ', 9), qq('   '), qq('联系我 13800138000'), qq('点赞很多的评论', 50), hot('热搜词条'), web('网页一句话。'),
    ]
    const { inputs, dropped } = screenInputs(raw, 4, [])
    expect(dropped).toBe(1)
    expect(inputs.map(input => input.text)).toEqual(['热搜词条', '点赞很多的评论', '普通评论', '网页一句话。'])
  })
})

describe('MemeMiner', () => {
  it('has nothing to do without readable text, and says so', async () => {
    const { run, model } = await setup()
    const report = await run([qq('   ')])
    expect(report).toMatchObject({ skipped: 'no_inputs', candidates: 0, kept: 0, llmCalls: 0 })
    expect(model).not.toHaveBeenCalled()
  })

  it('refreshes the memes it knows when their term shows up again, even with no model to ask', async () => {
    const { run, notes } = await setup({ noModel: true })
    await notes.note({ kind: 'meme', term: '典中典', meaning: '经典', example: '典中典', source: 'qq' })
    const report = await run([qq('这又是典中典了'), qq('别的话题')])
    expect(report).toMatchObject({ skipped: 'no_model', touched: 1, llmCalls: 0 })
    const unrelated = await run([qq('完全不相关的话题')])
    expect(unrelated).toMatchObject({ skipped: 'no_model', touched: 0 })
  })

  it.each([
    ['an Error that carries the raw answer', Object.assign(new Error('model down'), { raw: { finish: 'error' } }), 'model down', { finish: 'error' }],
    ['an Error without one', new Error('plain'), 'plain', null],
    ['something that is not an Error', { fail: 'boom' }, 'boom', null],
  ])('keeps the failure and skips the run when the model fails with %s', async (_name, failure, message, raw) => {
    const { run, logger, rawNames, rawDir } = await setup({ propose: failure })
    const report = await run([qq('海水过滤器真的绝了'), qq('今天又是海水过滤器')])
    expect(report).toMatchObject({ skipped: 'model_error', llmCalls: 1, kept: 0 })
    expect(logger.warn).toHaveBeenCalledWith(`speaking-style: miner model call failed: ${message}`)
    const [file] = await rawNames()
    expect(file).toContain('propose-error')
    expect(JSON.parse(await readFile(join(rawDir, file!), 'utf8'))).toEqual({ error: message, raw })
  })

  it('refuses each proposal for the rule it breaks and counts them', async () => {
    const inputs = [
      qq('海水过滤器真的绝了'), qq('今天又是海水过滤器'), qq('海水过滤器笑死我了'), qq('海水过滤器天天见'), qq('孤证词条只出现一次'), qq('典中典这个词我见过'),
    ]
    const { run, notes } = await setup({
      settings: { commonFrom: 6 },
      propose: [
        proposal('海水过滤器', '海水过滤器真的绝了'),
        proposal('海水过滤器', '海水过滤器真的绝了'),
        proposal('孤证词条', '孤证词条只出现一次'),
        proposal('典中典', '典中典这个词我见过'),
        proposal('被删的梗', '被删的梗'),
        proposal('草', '草'),
        proposal('链接词', '看 http://a.cn'),
        proposal('编造词', '这句话输入里没有'),
        proposal('另一个词', '孤证词条只出现一次'),
        proposal('', '没有词'),
        proposal('没有例子', ''),
        'not an object',
        null,
      ],
    })
    await notes.note({ kind: 'meme', term: '典中典', meaning: '经典', example: '典中典', source: 'qq' })
    await notes.block('被删的梗')
    const report = await run(inputs)
    expect(report.rejected).toEqual({
      too_common: 1, duplicate: 1, no_evidence: 1, known: 1, removed: 1, 'too-short': 1, link: 1, not_verbatim: 1, term_not_in_example: 1,
    })
    expect(report).toMatchObject({ kept: 0, candidates: 9, touched: 1, llmCalls: 1 })
  })

  it('reads a proposal list that is fenced, wrapped in prose, or not a list at all', async () => {
    const inputs = [qq('海水过滤器真的绝了'), qq('今天又是海水过滤器')]
    const list = JSON.stringify([proposal('海水过滤器', '海水过滤器真的绝了', { meaning: '一个梗' })])
    const fenced = await setup({ propose: `\`\`\`json\n${list}\n\`\`\``, deps: { hotwatch: { lookup: async () => ({ title: '海水过滤器', summary: '资料' }) } as never }, meaning: { 海水过滤器: '来自某手游广告' } })
    expect((await fenced.run(inputs)).kept).toBe(1)
    const prose = await setup({ propose: `结果：${list} 完毕`, noModel: false, meaning: {} })
    expect((await prose.run(inputs)).candidates).toBe(1)
    const object = await setup({ propose: { not: 'a list' } })
    expect((await object.run(inputs)).candidates).toBe(0)
    const text = await setup({ propose: '没有梗' })
    expect((await text.run(inputs)).candidates).toBe(0)
  })

  it('skips proposal fields that are not text and a related list that is not a list', async () => {
    const { run, notes } = await setup({
      deps: { hotwatch: { lookup: async () => ({ title: 'x', summary: '资料' }) } as never },
      propose: [{ term: 5, example: '海水过滤器真的绝了' }, { term: '海水过滤器', example: '海水过滤器真的绝了', related: '没有列表', meaning: 7 }],
      meaning: { 海水过滤器: '源自手游广告' },
    })
    const report = await run([qq('海水过滤器真的绝了'), qq('今天又是海水过滤器')])
    expect(report).toMatchObject({ candidates: 1, kept: 1 })
    const note = (await stored(notes))['海水过滤器']!
    expect(note).toMatchObject({ meaning: '源自手游广告' })
    expect(note).not.toHaveProperty('related')
  })

  it('keeps the related terms that are real, distinct, short, clean, and in the text, at most four, and names where each meme was read', async () => {
    const inputs = [
      web('网页上说海水过滤器是梗'), web('海水过滤器 电鳗发电机 都在这'), comment('评论区也有摇摆梗', 30), comment('摇摆梗 真的好用', 12), qq('群里在说群梗啊'), qq('群梗 又出现了'),
      qq('甲乙丙丁戊'), qq('相关一 相关二 相关三 相关四 相关五'),
    ]
    const { run, notes } = await setup({
      deps: { hotwatch: { lookup: async () => ({ title: 'x', summary: '资料' }) } as never },
      meaning: { 海水过滤器: '源自手游广告', 摇摆梗: '某个流行的说法', 群梗: '群里的说法' },
      propose: [
        proposal('海水过滤器', '网页上说海水过滤器是梗', { related: ['海水过滤器', '', '电鳗发电机', '电鳗发电机', '链接 http://a.cn', '从没出现过', '很长很长很长很长很长很长很长很长很长很长'] }),
        proposal('摇摆梗', '评论区也有摇摆梗'),
        proposal('群梗', '群里在说群梗啊', { related: ['相关一', '相关二', '相关三', '相关四', '相关五'] }),
      ],
    })
    const report = await run(inputs)
    expect(report.kept).toBe(3)
    const byTerm = await stored(notes)
    expect(byTerm['海水过滤器']).toMatchObject({ source: 'web', related: ['电鳗发电机'], meaningSource: 'hotwatch' })
    expect(byTerm['摇摆梗']).toMatchObject({ source: 'bili' })
    expect(byTerm['摇摆梗']).not.toHaveProperty('related')
    expect(byTerm['群梗']).toMatchObject({ source: 'qq', related: ['相关一', '相关二', '相关三', '相关四'] })
  })

  it('takes a meaning from pages the main agent read, else from one search, and falls back to the model\'s guess only with strong evidence', async () => {
    const inputs = [qq('抓马梗真的好玩'), qq('又见抓马梗啦'), qq('搜索梗让人上头'), qq('今天搜索梗刷屏'), qq('空白梗只一次'), qq('空白梗在这里'), qq('猜测梗满天飞'), qq('猜测梗再出现'), qq('猜测梗第三次')]
    const search = vi.fn(async (query: string) => (query.startsWith('搜索梗') ? { text: '搜索到的资料', raw: { hit: query } } : undefined))
    const webMaterial = vi.fn(async (term: string) => (term === '抓马梗' ? '读过的页面' : term === '空白梗' ? '' : undefined))
    const { run, notes, asked, rawNames } = await setup({
      deps: { search, webMaterial },
      meaning: { 抓马梗: '页面里的解释', 搜索梗: '搜索里的解释' },
      propose: [
        proposal('抓马梗', '抓马梗真的好玩'), proposal('搜索梗', '搜索梗让人上头'), proposal('空白梗', '空白梗只一次', { meaning: '猜的' }),
        proposal('猜测梗', '猜测梗满天飞', { meaning: '模型的猜测' }),
      ],
    })
    const report = await run(inputs)
    expect(report).toMatchObject({ kept: 3, searches: 3, llmCalls: 2, rejected: { no_material: 1 } })
    const byTerm = await stored(notes)
    expect(byTerm['抓马梗']).toMatchObject({ meaning: '页面里的解释', meaningSource: 'web' })
    expect(byTerm['搜索梗']).toMatchObject({ meaning: '搜索里的解释', meaningSource: 'search' })
    expect(byTerm['猜测梗']).toMatchObject({ meaning: '模型的猜测', meaningSource: 'llm' })
    expect(byTerm['空白梗']).toBeUndefined()
    expect(search.mock.calls.map(call => call[0])).toEqual(['猜测梗 梗 出处', '搜索梗 梗 出处', '空白梗 梗 出处'])
    expect(JSON.parse(asked.at(-1)!.user)).toEqual([{ term: '抓马梗', material: '读过的页面' }, { term: '搜索梗', material: '搜索到的资料' }])
    expect((await rawNames()).filter(name => name.includes('-search-'))).toHaveLength(1)
  })

  it('stops searching at the limit, and goes on when a search finds nothing, returns blank text, or fails', async () => {
    const inputs = ['甲梗', '乙梗', '丙梗', '丁梗'].flatMap(term => [qq(`${term}出现一次`), qq(`${term}又出现`), qq(`${term}第三次`)])
    const answers: Array<{ text: string; raw: unknown } | Error | string | undefined> = [{ text: '   ', raw: {} }, new Error('search down'), 'weird', undefined]
    const search = vi.fn(async () => {
      const next = answers.shift()
      if (next instanceof Error) throw next
      if (typeof next === 'string') throw next
      return next
    })
    const { run, logger } = await setup({
      settings: { maxSearches: 3 }, deps: { search },
      propose: ['甲梗', '乙梗', '丙梗', '丁梗'].map(term => proposal(term, `${term}出现一次`, { meaning: '猜测' })),
    })
    const report = await run(inputs)
    expect(report.searches).toBe(3)
    expect(search).toHaveBeenCalledTimes(3)
    expect(report).toMatchObject({ kept: 4, llmCalls: 1 })
    expect(logger.warn).toHaveBeenCalledWith('speaking-style: miner search failed: search down')
    expect(logger.warn).toHaveBeenCalledWith('speaking-style: miner search failed: weird')
  })

  it('stops looking for meanings once the run is cancelled', async () => {
    const controller = new AbortController()
    const search = vi.fn(async () => undefined)
    const { run, model } = await setup({ deps: { search }, propose: [proposal('海水过滤器', '海水过滤器真的绝了', { meaning: '猜测' })] })
    vi.mocked(model).mockImplementationOnce(async () => {
      controller.abort()
      return { text: JSON.stringify([proposal('海水过滤器', '海水过滤器真的绝了', { meaning: '猜测' })]), raw: {} }
    })
    const report = await run([hot('海水过滤器真的绝了'), qq('海水过滤器笑死')], controller.signal)
    expect(search).not.toHaveBeenCalled()
    expect(report).toMatchObject({ kept: 1, llmCalls: 1, searches: 0 })
  })

  it('falls back to the guess when the meaning call fails, keeping the failure on disk', async () => {
    const inputs = [qq('海水过滤器真的绝了'), qq('今天又是海水过滤器'), qq('海水过滤器笑死我了')]
    const { run, logger, rawNames, notes } = await setup({
      deps: { hotwatch: { lookup: async () => ({ title: 'x', summary: '资料' }) } as never },
      propose: [proposal('海水过滤器', '海水过滤器真的绝了', { meaning: '模型的猜测' })],
      meaning: Object.assign(new Error('meaning down'), { raw: { finish: 'error' } }),
    })
    const report = await run(inputs)
    expect(report).toMatchObject({ kept: 1, llmCalls: 2 })
    expect(logger.warn).toHaveBeenCalledWith('speaking-style: miner meaning call failed: meaning down')
    expect((await rawNames()).some(name => name.includes('meaning-error'))).toBe(true)
    expect((await stored(notes))['海水过滤器']).toMatchObject({ meaning: '模型的猜测', meaningSource: 'llm' })
    const odd = await setup({
      deps: { hotwatch: { lookup: async () => ({ title: 'x', summary: '资料' }) } as never },
      propose: [proposal('海水过滤器', '海水过滤器真的绝了', { meaning: '模型的猜测' })], meaning: { fail: 'closed' },
    })
    await odd.run(inputs)
    expect(odd.logger.warn).toHaveBeenCalledWith('speaking-style: miner meaning call failed: closed')
  })

  it.each([
    ['a list', ['x']],
    ['text that is not JSON', '随便说说'],
    ['a map whose values are not text', { 海水过滤器: 5 }],
  ])('ignores a meaning answer that is %s and keeps the guess', async (_name, meaning) => {
    const { run, notes } = await setup({
      deps: { hotwatch: { lookup: async () => ({ title: 'x', summary: '资料' }) } as never },
      propose: [proposal('海水过滤器', '海水过滤器真的绝了', { meaning: '模型的猜测' })], meaning,
    })
    await run([qq('海水过滤器真的绝了'), qq('今天又是海水过滤器'), qq('海水过滤器笑死我了')])
    expect((await stored(notes))['海水过滤器']).toMatchObject({ meaning: '模型的猜测', meaningSource: 'llm' })
  })

  it('drops a meme the material shows to be an ordinary word, and asks the model only about terms that have material', async () => {
    const lookup = vi.fn(async (term: string) => (term === '普通词' ? { title: term, summary: '一个普通词语' } : undefined))
    const { run, notes, asked } = await setup({
      deps: { hotwatch: { lookup } as never },
      propose: [proposal('普通词', '普通词在这里'), proposal('真梗词', '真梗词在这里', { meaning: '猜测' })],
      meaning: { 普通词: '' },
    })
    const report = await run([qq('普通词在这里'), qq('又是普通词'), qq('真梗词在这里'), qq('真梗词再来'), qq('真梗词第三次')])
    expect(report.rejected).toEqual({ not_a_meme: 1 })
    expect(report.kept).toBe(1)
    expect(Object.keys(await stored(notes))).toEqual(['真梗词'])
    expect(JSON.parse(asked.at(-1)!.user)).toEqual([{ term: '普通词', material: '一个普通词语' }])
  })

  it('refuses a meaning that is empty, filtered, cut to the limit, or refused by the guard, and a note the owner blocked meanwhile', async () => {
    const inputs = ['空义梗', '链接梗', '长义梗', '守卫梗', '拦截梗'].flatMap(term => [qq(`${term}一`), qq(`${term}二`), qq(`${term}三`)])
    const guard = { check: async (text: string) => (text.includes('守卫梗') ? { ok: false as const, rule: 'canary', publicReason: '受保护' } : { ok: true as const }) }
    const notesOverride = vi.fn(async (input: { term: string; meaning: string }) => (input.term === '拦截梗' ? 'blocked' as const : 'added' as const))
    const { notes, deps } = await setup({
      guard,
      settings: { meaningChars: 12 },
      propose: ['空义梗', '链接梗', '长义梗', '守卫梗', '拦截梗'].map((term, index) => proposal(term, `${term}一`, { meaning: ['', 'http://a.cn', '这是一个非常非常非常长的解释啊啊啊', '守卫的解释', '拦截的解释'][index] })),
    })
    const stubNotes = {
      notes: () => notes.notes(), blocked: () => notes.blocked(), note: notesOverride,
      touch: (keys: ReadonlySet<string>) => notes.touch(keys),
    }
    const stub = { ...deps, notes: stubNotes as never as NotesStore }
    const { MemeMiner: Miner } = await import('../src/miner.ts')
    const miner = new Miner({ ...stub, settings: { ...stub.settings, maxNew: 5 } })
    const report = await miner.run(inputs, new AbortController().signal)
    expect(report.rejected).toEqual({ meaning_missing: 1, link: 1, guard: 1, removed: 1 })
    expect(report.kept).toBe(1)
    expect(notesOverride).toHaveBeenCalledTimes(2)
    expect(notesOverride.mock.calls.map(call => call[0].meaning)).toEqual(['这是一个非常非常非常长的', '拦截的解释'])
  })

  it('counts a guard that is not mounted under its own name', async () => {
    const { run, gateWarn } = await setup({ guard: undefined, propose: [proposal('海水过滤器', '海水过滤器真的绝了', { meaning: '猜测' })] })
    const report = await run([qq('海水过滤器真的绝了'), qq('今天又是海水过滤器'), qq('海水过滤器笑死我了')])
    expect(report.rejected).toEqual({ guard_unavailable: 1 })
    expect(gateWarn).toHaveBeenCalledTimes(1)
  })

  it('sends the model the likes and the hot-search mark, and takes a term from a hot-search word on its own', async () => {
    const { run, asked, notes } = await setup({
      deps: { hotwatch: { lookup: async () => ({ title: 'x', summary: '资料' }) } as never },
      propose: [proposal('热搜梗', '热搜梗上了热搜')], meaning: { 热搜梗: '热搜上的说法' },
    })
    await run([hot('热搜梗上了热搜'), comment('点赞评论', 8)])
    expect(JSON.parse(asked[0]!.user)).toEqual([{ id: 0, hotSearch: true, text: '热搜梗上了热搜' }, { id: 1, likes: 8, text: '点赞评论' }])
    expect((await stored(notes))['热搜梗']).toMatchObject({ source: 'bili', meaningSource: 'hotwatch' })
  })

  it('keeps only the newest raw responses, and warns instead of failing when it cannot write one', async () => {
    const { run, rawNames, logger } = await setup({
      settings: { rawKept: 2 },
      deps: { hotwatch: { lookup: async () => ({ title: 'x', summary: '资料' }) } as never },
      propose: [proposal('海水过滤器', '海水过滤器真的绝了')], meaning: { 海水过滤器: '解释' },
    })
    const inputs = [qq('海水过滤器真的绝了'), qq('今天又是海水过滤器')]
    await run(inputs)
    await run(inputs)
    expect(await rawNames()).toHaveLength(2)
    const blocked = await setup({ propose: [] })
    await writeFile(blocked.rawDir, 'a file where a directory should be')
    const report = await blocked.run(inputs)
    expect(report.candidates).toBe(0)
    const warned = /^speaking-style: miner could not keep a raw propose response: /u
    expect(blocked.logger.warn).toHaveBeenCalledWith(expect.stringMatching(warned))
    void logger
  })

  it('is busy only while a run is in progress', async () => {
    const { miner, run, model } = await setup({ propose: [] })
    let during = false
    vi.mocked(model).mockImplementationOnce(async () => { during = miner.busy; return { text: '[]', raw: {} } })
    expect(miner.busy).toBe(false)
    await run([qq('海水过滤器真的绝了')])
    expect(during).toBe(true)
    expect(miner.busy).toBe(false)
  })
})
