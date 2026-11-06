// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { createStyleStore, type StyleState } from '../src/client/style.ts'
import { cardDiff, StyleSection, type StyleSectionProps } from '../src/client/StyleSection.tsx'
import { zh } from '../src/client/locales.ts'
import type { StylePanel } from '../src/view.ts'

const t = makeTranslate(zh) as StyleSectionProps['t']
const NOW = Date.now()
const ONE = (platform: 'qq' | 'bili') => ({ platform, groups: 1, speakers: 2, days: 1 })

const panel = (over: Partial<StylePanel> = {}): StylePanel => ({
  enabled: true, review: 'optional', limits: { maxActive: 60, maxOwner: 20, maxMemes: 40, maxTraits: 10, cardChars: 600 }, running: false, nextRunAt: NOW + 3_600_000,
  samples: [
    { id: 'o1', source: 'bili', owner: true, status: 'active', addedAt: 'x', prompt: '下期什么时候', reply: '刚剪完', origin: ONE('bili') },
    { id: 'q1', source: 'qq', owner: false, status: 'active', addedAt: 'x', prompt: '周末去哪', reply: '宅着', origin: ONE('qq') },
    { id: 'b1', source: 'bili', owner: false, status: 'active', addedAt: 'x', prompt: '这期好看', reply: '同感', origin: ONE('bili') },
  ],
  parts: { tone: true, memes: true, traits: true, persona: true, miner: true },
  notes: [
    { id: 'm1', kind: 'meme', term: '典中典', meaning: '老套到成了经典', example: '这也太典中典了', source: 'qq', firstSeen: 1, lastSeen: 2 },
    {
      id: 'm2', kind: 'meme', term: '海水过滤器', meaning: '低成本AI海上生存手游广告台词', example: '我已经打捞到海水过滤器了', source: 'bili',
      related: ['电鳗发电机'], meaningSource: 'search', firstSeen: 1, lastSeen: 3,
    },
    { id: 't1', kind: 'trait', term: '嘴硬', example: '才不是呢', source: 'bili', firstSeen: 1, lastSeen: 2 },
  ],
  hot: [{ title: '某某热梗', heat: 90 }],
  cards: [
    { version: 1, card: '傲娇猫娘', author: 'agent', reason: '群里都嘴硬', at: NOW - 7_200_000 },
    { version: 2, card: '傲娇猫娘\n句尾带喵', author: 'owner', reason: 'edited on the Settings page', at: NOW - 3_600_000 },
  ],
  lastRun: {
    at: NOW - 3_600_000, ms: 120, trigger: 'schedule', seen: 62, accepted: 26, added: 15, retired: 3,
    qq: { status: 'ok', groups: 21, messages: 385 }, bili: { status: 'no-token', comments: 0, threads: 0 },
    filtered: { mention: 13, media: 11 }, bySource: { qq: 15 },
  },
  lastMine: {
    at: NOW - 1_800_000, ms: 900, inputs: { qq: 40, comment: 5, hot: 2, web: 9, dropped: 4 }, touched: 1, candidates: 5, kept: 1,
    rejected: { too_common: 1, not_a_meme: 1, mystery_rule: 2 }, llmCalls: 2, searches: 1,
  },
  trend: [{ day: '2026-10-31', answers: 10, withTics: 4, mainAnswers: 8, meanChars: 46 }],
  ...over,
})

function mount(state: Partial<StyleState>) {
  const store = createStyleStore()
  store.update((draft) => { Object.assign(draft, state) })
  const refresh = vi.fn()
  const edit = vi.fn((_: unknown) => Promise.resolve(true))
  const collect = vi.fn()
  const renderFactorySlot = vi.fn((_name: string, _props: object) => <div data-testid="plugin-config" />)
  const props = {
    close: () => {}, useStyle: bindSnapshotSelector(store), refresh, edit, collect, renderFactorySlot, t,
  } as StyleSectionProps
  const view = render(<StyleSection {...props} />)
  return { store, refresh, edit, collect, renderFactorySlot, view }
}

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('StyleSection', () => {
  it('reads on opening and polls while open', () => {
    vi.useFakeTimers()
    const { refresh, view } = mount({})
    expect(screen.getByRole('status').textContent).toBe('正在读取…')
    expect(refresh).toHaveBeenCalledTimes(1)
    act(() => { vi.advanceTimersByTime(5000) })
    expect(refresh).toHaveBeenCalledTimes(2)
    view.unmount()
    act(() => { vi.advanceTimersByTime(60_000) })
    expect(refresh).toHaveBeenCalledTimes(2)
  })

  it('shows the verdict, the card, traits, memes from both sources, tone samples, the last run, and the trend', () => {
    mount({ panel: panel(), checkedAt: NOW })
    expect(screen.getByRole('heading', { name: '7 条风格数据在塑造 DSH 的说话方式' })).toBeTruthy()
    expect(screen.getByText('人设卡')).toBeTruthy()
    expect(screen.getAllByText(/第 2 版 · 你改的/u).length).toBeGreaterThan(0)
    expect(screen.getByText('性格（1/10）')).toBeTruthy()
    expect(screen.getByText('热梗（3）')).toBeTruthy()
    expect(screen.getByText('圈内黑话')).toBeTruthy()
    expect(screen.getByText('全网热梗（HotWatch，补充）')).toBeTruthy()
    expect(screen.getByText('QQ · 例：这也太典中典了')).toBeTruthy()
    expect(screen.getByText('语气样本（3）')).toBeTruthy()
    expect(screen.getByText('B站 · 猫灯手写')).toBeTruthy()
    expect(screen.getByText(/看了 62 段对话，通过 26，新增 15/u)).toBeTruthy()
    expect(screen.getByText('缺少 bili-svc 的读取令牌')).toBeTruthy()
    expect(screen.getByText('@ 了人 13')).toBeTruthy()
    expect(screen.getByText(/4\/10 带套话/u)).toBeTruthy()
    // The revision history shows what each version changed.
    expect(screen.getByText(/\+ 句尾带喵/u)).toBeTruthy()
  })

  it('shows where a meme was read and where its meaning came from, with its family', () => {
    mount({ panel: panel(), checkedAt: NOW })
    expect(screen.getByText('B站 · 释义来源：搜索 · 例：我已经打捞到海水过滤器了 · 相关：电鳗发电机')).toBeTruthy()
  })

  it('shows what the meme miner read and refused, by rule, and the All settings card at the foot', () => {
    const { renderFactorySlot } = mount({ panel: panel(), checkedAt: NOW })
    expect(screen.getByText('热梗挖掘')).toBeTruthy()
    expect(screen.getByText(/新增 1，刷新 1，提议 5，模型 2 次，搜索 1 次/u)).toBeTruthy()
    expect(screen.getByText('QQ 40 · 评论 5 · 热搜 2 · 网页 9 · 因个人信息丢掉 4')).toBeTruthy()
    expect(screen.getByText('太常见的词 1')).toBeTruthy()
    expect(screen.getByText('只是普通词 1')).toBeTruthy()
    // A rule without a label shows under its own name.
    expect(screen.getByText('mystery_rule 2')).toBeTruthy()
    expect(renderFactorySlot).toHaveBeenCalledWith('settings.plugin-config', {
      entries: ['lsy-style'], exclude: ['mode', 'block', 'tools', 'dir', 'ticsFile'],
    })
    expect(document.querySelector('section')?.lastElementChild).toBe(screen.getByTestId('plugin-config'))
  })

  it('says why the miner did nothing, and that it never ran', () => {
    mount({ panel: panel({ lastMine: { at: NOW, ms: 1, inputs: { qq: 0, comment: 0, hot: 0, web: 0, dropped: 0 }, touched: 0, candidates: 0, kept: 0, rejected: {}, llmCalls: 0, searches: 0, skipped: 'no_model' } }), checkedAt: NOW })
    expect(screen.getByText(/没有可用的模型/u)).toBeTruthy()
    cleanup()
    const parts = { tone: true, memes: true, traits: true, persona: true, miner: false }
    mount({ panel: panel({ lastMine: null, parts }), checkedAt: NOW })
    expect(screen.getByText('还没跑过')).toBeTruthy()
    expect(screen.getByText('热梗挖掘 （已关闭）')).toBeTruthy()
  })

  it('deletes a past card version from the history with one tap, never the current one', () => {
    const { edit } = mount({ panel: panel(), checkedAt: NOW })
    expect(screen.queryByRole('button', { name: '从历史删除第 2 版' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '从历史删除第 1 版' }))
    expect(edit).toHaveBeenCalledWith({ op: 'deleteVersion', version: 1 })
  })

  it('deletes a meme or a trait, and blocks a HotWatch title, with one tap', () => {
    const { edit } = mount({ panel: panel(), checkedAt: NOW })
    fireEvent.click(screen.getByRole('button', { name: '删掉：典中典' }))
    expect(edit).toHaveBeenCalledWith({ op: 'remove', id: 'm1' })
    fireEvent.click(screen.getByRole('button', { name: '删掉：嘴硬' }))
    expect(edit).toHaveBeenCalledWith({ op: 'remove', id: 't1' })
    fireEvent.click(screen.getByRole('button', { name: '删掉：某某热梗' }))
    expect(edit).toHaveBeenCalledWith({ op: 'block', term: '某某热梗' })
  })

  it('edits, deletes, and rolls back the persona card', async () => {
    const { edit } = mount({ panel: panel(), checkedAt: NOW })
    fireEvent.click(screen.getByRole('button', { name: '编辑' }))
    const box = screen.getByRole('textbox', { name: '人设卡' }) as HTMLTextAreaElement
    expect(box.value).toBe('傲娇猫娘\n句尾带喵')
    expect(box.maxLength).toBe(600)
    fireEvent.change(box, { target: { value: '嘴硬心软的猫' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '保存' })) })
    expect(edit).toHaveBeenCalledWith({ op: 'card', card: '嘴硬心软的猫' })
    expect(screen.queryByRole('textbox')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '删除' }))
    expect(edit).toHaveBeenCalledWith({ op: 'card', card: '' })
    fireEvent.click(screen.getByRole('button', { name: '回滚到这版' }))
    expect(edit).toHaveBeenCalledWith({ op: 'rollback', version: 1 })
  })

  it('deletes a sample with one tap and starts a run', () => {
    const { edit, collect } = mount({ panel: panel(), checkedAt: NOW })
    fireEvent.click(screen.getByRole('button', { name: '删掉：周末去哪 → 宅着' }))
    expect(edit).toHaveBeenCalledWith({ op: 'remove', id: 'q1' })
    fireEvent.click(screen.getByRole('button', { name: '立即收集' }))
    expect(collect).toHaveBeenCalledTimes(1)
  })

  it('offers keep and delete for pending samples under review required', () => {
    const { edit } = mount({ panel: panel({ review: 'required', samples: [{ id: 'w1', source: 'qq', owner: false, status: 'pending', addedAt: 'x', prompt: '在吗', reply: '在', origin: ONE('qq') }] }), checkedAt: NOW })
    expect(screen.getByText('待审核（1）')).toBeTruthy()
    expect(screen.getByText('新片段要你点「留」才生效')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '留下：在吗 → 在' }))
    expect(edit).toHaveBeenCalledWith({ op: 'keep', id: 'w1' })
  })

  it('says when the block is off, and when an edit failed', () => {
    mount({ panel: panel({ enabled: false }), checkedAt: NOW, error: 'not_found' })
    expect(screen.getByRole('heading', { name: '已关闭：没有 agent 看得到这些人格数据' })).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toBe('这条已经不在了。')
    expect(screen.getByRole('button', { name: '立即收集' }).hasAttribute('disabled')).toBe(true)
  })

  it('shows a quiet failure while nothing has loaded and the last read failed', () => {
    mount({ stale: true })
    expect(screen.getByRole('status').textContent).toBe('暂时读不到，稍后自动重试。')
  })

  it('shows an empty, switched-off, stale page with its empty states', () => {
    const parts = { tone: false, memes: false, traits: false, persona: false, miner: false }
    mount({
      panel: panel({
        parts, samples: [], notes: [], hot: [], cards: [], lastRun: null, lastMine: null, nextRunAt: null, trend: [], running: true,
      }),
      stale: true,
    })
    const section = screen.getByRole('region', { name: '说话风格' })
    expect(section.hasAttribute('data-stale')).toBe(true)
    expect(screen.getByRole('status').textContent).toMatch(/^未能刷新 · 显示 \d{2}-\d{2} \d{2}:\d{2} 的数据$/u)
    expect(screen.getByRole('heading', { name: '还没有片段' })).toBeTruthy()
    expect(screen.getByText('人设卡 （已关闭）')).toBeTruthy()
    expect(screen.getByText('还没有人设卡。')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '删除' })).toBeNull()
    expect(screen.queryByText(/修订历史/u)).toBeNull()
    expect(screen.getByText('性格（0/10） （已关闭）')).toBeTruthy()
    expect(screen.getByText('热梗（0） （已关闭）')).toBeTruthy()
    expect(screen.getByText('语气样本（0） （已关闭）')).toBeTruthy()
    expect(screen.getAllByText('还没有')).toHaveLength(3)
    expect(screen.getByText('还没收集过')).toBeTruthy()
    expect(screen.getByText('已停止')).toBeTruthy()
    expect(screen.getByText('还没有数据')).toBeTruthy()
    expect(screen.queryByText('筛掉的')).toBeNull()
    const collecting = screen.getByRole('button', { name: '收集中…' })
    expect(collecting.hasAttribute('disabled')).toBe(true)
  })

  it('stamps a live page that never recorded a check time with the current time', () => {
    mount({ panel: panel(), checkedAt: null })
    expect(screen.getByRole('status').textContent).toMatch(/\d{2}-\d{2} \d{2}:\d{2} 更新$/u)
  })

  it('shows a stale page with its data and a stale dot', () => {
    mount({ panel: panel(), checkedAt: NOW, stale: true })
    expect(screen.getByRole('status').textContent).toMatch(/^未能刷新 · 显示 /u)
    expect(document.querySelector('[data-tone="stale"]')).not.toBeNull()
    expect(document.querySelector('[data-tone="live"]')).toBeNull()
  })

  it('shows a sample without a prompt by its reply alone', () => {
    const { edit } = mount({ panel: panel({ samples: [{ id: 'r1', source: 'bili', owner: true, status: 'active', addedAt: 'x', reply: '直接说话', origin: ONE('bili') }] }), checkedAt: NOW })
    expect(screen.getByText('B站 · 猫灯手写')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '删掉：直接说话' }))
    expect(edit).toHaveBeenCalledWith({ op: 'remove', id: 'r1' })
  })

  it('lists memes without HotWatch titles, and HotWatch titles without memes, each under its own subhead', () => {
    const notes = panel().notes
    mount({ panel: panel({ hot: [] }), checkedAt: NOW })
    expect(screen.getByText('圈内黑话')).toBeTruthy()
    expect(screen.queryByText('全网热梗（HotWatch，补充）')).toBeNull()
    cleanup()
    mount({ panel: panel({ notes: notes.filter(note => note.kind === 'trait') }), checkedAt: NOW })
    expect(screen.queryByText('圈内黑话')).toBeNull()
    expect(screen.getByText('全网热梗（HotWatch，补充）')).toBeTruthy()
    expect(screen.getByText('热梗（1）')).toBeTruthy()
  })

  it('reports what the observers did when they were off, unreachable, or read nothing', () => {
    const run = panel().lastRun!
    mount({
      panel: panel({ lastRun: { ...run, qq: { status: 'unavailable', groups: 0, messages: 0 }, bili: { status: 'unavailable', comments: 0, threads: 0, error: '超时' } } }),
      checkedAt: NOW,
    })
    expect(screen.getByText('QQ 观察器没在运行')).toBeTruthy()
    expect(screen.getByText('读取失败：超时')).toBeTruthy()
    cleanup()
    mount({ panel: panel({ lastRun: { ...run, qq: { status: 'off', groups: 0, messages: 0 }, bili: { status: 'unavailable', comments: 0, threads: 0 } } }), checkedAt: NOW })
    expect(screen.getByText('读取失败：')).toBeTruthy()
    expect(screen.getByText('关闭')).toBeTruthy()
    cleanup()
    mount({ panel: panel({ lastRun: { ...run, bili: { status: 'ok', comments: 9, threads: 4 } } }), checkedAt: NOW })
    expect(screen.getByText('9 条评论，读了 4 个楼')).toBeTruthy()
  })

  it('names every kind of failed edit, and falls back to the invalid-input text for an unknown one', () => {
    const expected: Array<[string, string]> = [
      ['network', '没连上，改动没有保存。'],
      ['current_version', '当前版本不能从历史里删。'],
      ['invalid_input', '内容不合要求（空的或太长）。'],
      ['something_new', '内容不合要求（空的或太长）。'],
    ]
    for (const [error, text] of expected) {
      mount({ panel: panel(), checkedAt: NOW, error })
      expect(screen.getByRole('alert').textContent).toBe(text)
      cleanup()
    }
  })

  it('shows a day without answers as an empty bar with no length', () => {
    mount({ panel: panel({ trend: [{ day: '2026-11-01', answers: 0, withTics: 0, mainAnswers: 0, meanChars: null }] }), checkedAt: NOW })
    expect(screen.getByText('0/0 带套话')).toBeTruthy()
    expect(screen.queryByText(/平均 \d+ 字/u)).toBeNull()
    expect((document.querySelector('[style*="width"]') as HTMLElement).style.width).toBe('0%')
  })

  it('shows what each card version changed, including lines it removed and a deletion', () => {
    mount({
      panel: panel({
        cards: [
          { version: 1, card: '甲\n乙', author: 'agent', reason: '初稿', at: NOW - 3000 },
          { version: 2, card: '甲\n丙', author: 'owner', reason: '改一行', at: NOW - 2000 },
          { version: 3, card: '', author: 'owner', reason: '删了', at: NOW - 1000 },
        ],
      }),
      checkedAt: NOW,
    })
    const diffs = [...document.querySelectorAll('pre')].map(node => node.textContent)
    expect(diffs).toEqual(['− （删除）', '− 乙\n+ 丙', '+ 甲\n+ 乙'])
    expect(screen.getByText('还没有人设卡。')).toBeTruthy()
  })

  it('cancels a card edit without saving, and keeps the draft when the Host refuses it', async () => {
    const { edit } = mount({ panel: panel(), checkedAt: NOW })
    fireEvent.click(screen.getByRole('button', { name: '编辑' }))
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(edit).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '编辑' }))
    edit.mockResolvedValueOnce(false)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '保存' })) })
    expect(edit).toHaveBeenCalledWith({ op: 'card', card: '傲娇猫娘\n句尾带喵' })
    expect(screen.getByRole('textbox', { name: '人设卡' })).toBeTruthy()
  })

  it('starts a blank card draft when there is no card yet', () => {
    mount({ panel: panel({ cards: [] }), checkedAt: NOW })
    fireEvent.click(screen.getByRole('button', { name: '编辑' }))
    expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: '人设卡' }).value).toBe('')
  })
})

describe('cardDiff', () => {
  it('lists removed lines before added ones, and treats an empty card as no lines', () => {
    expect(cardDiff('甲\n乙', '甲\n丙')).toEqual([{ sign: '−', line: '乙' }, { sign: '+', line: '丙' }])
    expect(cardDiff('甲\n乙', '')).toEqual([{ sign: '−', line: '甲' }, { sign: '−', line: '乙' }])
    expect(cardDiff('', '甲')).toEqual([{ sign: '+', line: '甲' }])
  })
})
