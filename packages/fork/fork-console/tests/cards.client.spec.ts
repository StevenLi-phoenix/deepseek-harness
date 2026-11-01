import { describe, expect, it } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { SERVICE_IDS, type ServiceCard } from '../src/views.ts'
import { BALANCE_ROUTE, balanceCard, parseBalance } from '../src/client/balance.ts'
import { factLines, statusText } from '../src/client/cards.ts'
import { ago, clock, duration, until, type Translate } from '../src/client/format.ts'
import { de, en, es, fr, ja, pt, ru, zh } from '../src/client/locales.ts'

const t = makeTranslate(zh) as Translate
const tEn = makeTranslate(en) as Translate
const card = (id: ServiceCard['id'], state: string, facts: ServiceCard['facts'] = {}, tone: ServiceCard['tone'] = 'ok'): ServiceCard => ({ id, tone, state, facts })

describe('dictionaries', () => {
  const placeholders = (text: string): string[] => [...text.matchAll(/\{(\w+)\}/gu)].map(match => match[1]!).sort()

  it('give every language the same keys and the same placeholders as the Chinese source', () => {
    for (const [name, dictionary] of Object.entries({ en, ja, es, fr, de, ru, pt })) {
      expect(Object.keys(dictionary).sort(), name).toEqual(Object.keys(zh).sort())
      for (const [key, text] of Object.entries(dictionary)) {
        expect(placeholders(text), `${name} ${key}`).toEqual(placeholders(zh[key as keyof typeof zh]))
        expect(text.trim(), `${name} ${key}`).not.toBe('')
      }
    }
  })

  it('have a title for every service and an error text for every refusal code', () => {
    for (const id of SERVICE_IDS) expect(zh).toHaveProperty(`card.${id}.title`)
    for (const code of ['invalid_request', 'unavailable', 'not_found', 'config_owned', 'duplicate_id', 'invalid_subscription', 'limit_reached', 'start_failed',
      'stop_failed', 'speech_failed', 'speech_off', 'network', 'internal_error']) expect(zh).toHaveProperty(`error.${code}`)
  })
})

describe('statusText', () => {
  it('uses a service\'s own copy for its states and the shared copy for the rest', () => {
    expect(statusText(card('bus', 'limited'), t)).toBe('有订阅触到每小时上限')
    expect(statusText(card('voice', 'tts_down', {}, 'down'), t)).toBe('朗读服务无响应')
    expect(statusText(card('bili', 'absent', {}, 'off'), t)).toBe('未安装')
    expect(statusText(card('qq', 'reconnecting', {}, 'down'), t)).toBe('与 NapCat 断开，正在重连')
    expect(statusText(card('style', 'mounted'), t)).toBe('已安装')
    expect(statusText(card('bili', 'warn', {}, 'warn'), t)).toBe('需要留意')
    expect(statusText(card('qq', 'down', {}, 'down'), t)).toBe('无响应')
    expect(statusText(card('wechat', 'timeout', {}, 'down'), tEn)).toBe('Check timed out')
  })

  it('shows an unknown state as a failed check, never as raw text', () => {
    expect(statusText(card('dsh', 'frobnicated'), t)).toBe('检查出错')
  })
})

describe('factLines', () => {
  it('shows the build, version, and uptime of the event service, leaving out what is unknown', () => {
    expect(factLines(card('dsh', 'up', { version: '0.2.2', sha: '0a1b2c3d4e', uptime: 90_061 }), t)).toEqual(['版本 0.2.2 · 构建 0a1b2c3d4e · 已运行 1 天 1 小时'])
    expect(factLines(card('dsh', 'up', { version: null, sha: null, uptime: 59 }), t)).toEqual(['已运行 0 分钟'])
  })

  it('summarizes the bus, including a rate limit', () => {
    const facts = { subscriptions: 4, paused: 1, pending: 2, events: 30, batches: 5, limited: 0 }
    expect(factLines(card('bus', 'up', facts), t)).toEqual(['4 个订阅（暂停 1）· 排队 2 · 近 1 小时 30 个事件、5 批'])
    expect(factLines(card('bus', 'limited', { ...facts, limited: 3 }, 'warn'), t)[0]).toContain('被限流 3 次')
    expect(factLines(card('bus', 'absent', {}, 'off'), t)).toEqual([])
  })

  it('summarizes voice, Claude Code, QQ, WeChat, and the model route', () => {
    expect(factLines(card('voice', 'up', { provider: 'feiyu', asr: true, engine: 'whisper' }), t)).toEqual(['朗读 feiyu · 听写 whisper'])
    expect(factLines(card('voice', 'up', { provider: 'feiyu', asr: false, engine: 'funasr' }), t)).toEqual(['朗读 feiyu · 听写关闭'])
    expect(factLines(card('voice', 'tts_off', { asr: false }, 'off'), t)).toEqual([])
    expect(factLines(card('cc', 'up', { sessions: 2, max: 3, login: 'full' }), t)).toEqual(['2 / 3 个会话 · 完整登录'])
    expect(factLines(card('cc', 'disabled', {}, 'off'), t)).toEqual([])
    expect(factLines(card('qq', 'mounted', { groups: 3 }), t)).toEqual(['记录 3 个群'])
    expect(factLines(card('qq', 'up', { groups: 3, account: '12345' }), t)).toEqual(['账号 12345 · 记录 3 个群'])
    expect(factLines(card('qq', 'reconnecting', { attempt: 4 }, 'down'), t)).toEqual(['已失败 4 次'])
    expect(factLines(card('qq', 'down', { detail: 'offline for 12 min' }, 'down'), t)).toEqual(['offline for 12 min'])
    expect(factLines(card('wechat', 'queued', { queued: 2 }, 'warn'), t)).toEqual(['待发 2 条'])
    expect(factLines(card('llm', 'ok', { ready: 2, failed: 0, percent: 41 }), t)).toEqual(['最高已用 41%'])
    expect(factLines(card('llm', 'off', { ready: 0, failed: 0, percent: null }, 'off'), t)).toEqual([])
  })
})

describe('balance card', () => {
  it('summarizes the readings of the balance route', () => {
    expect(BALANCE_ROUTE).toBe('api/fork.balance')
    expect(parseBalance({ readings: [
      { status: 'ready', kind: 'wallets', wallets: [] },
      { status: 'ready', kind: 'quota', windows: [{ percent: 12.4 }, { percent: 40.6 }] },
      { status: 'failed', reason: 'x' },
    ] })).toEqual({ ready: 2, failed: 1, highest: 40.6 })
    expect(() => parseBalance({})).toThrow('unexpected balance answer')
  })

  it('is green when every source reads, amber when one failed, grey with none, and red when the route itself failed', () => {
    expect(balanceCard({ ready: 2, failed: 0, highest: 40.6 }, false)).toMatchObject({ tone: 'ok', state: 'ok', facts: { ready: 2, percent: 41 } })
    expect(balanceCard({ ready: 1, failed: 1, highest: null }, false)).toMatchObject({ tone: 'warn', state: 'warn', facts: { percent: null } })
    expect(balanceCard({ ready: 0, failed: 0, highest: null }, false)).toMatchObject({ tone: 'off', state: 'off' })
    expect(balanceCard(null, false)).toMatchObject({ tone: 'off', state: 'loading' })
    expect(balanceCard(null, true)).toMatchObject({ tone: 'down', state: 'error' })
  })
})

describe('format', () => {
  it('writes relative times and spans', () => {
    const now = new Date(2026, 10, 1, 12, 0, 0).getTime()
    expect([5, 120, 7200, 200_000].map(seconds => ago(now - seconds * 1000, now, t))).toEqual(['5 秒前', '2 分钟前', '2 小时前', '2 天前'])
    expect([10, 3 * 3600, 3 * 86_400].map(seconds => until(now + seconds * 1000, now, tEn))).toEqual(['in 0 min', 'in 3 h', 'in 3 d'])
    expect(until(now - 5000, now, tEn)).toBe('in 0 min')
    expect([59, 3600 + 120, 86_400 * 2 + 3600].map(seconds => duration(seconds, tEn))).toEqual(['0 min', '1 h 2 min', '2 d 1 h'])
    expect(clock(now)).toBe('12:00:00')
  })
})
