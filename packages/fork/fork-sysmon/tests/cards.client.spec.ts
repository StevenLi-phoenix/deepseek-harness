import { describe, expect, it } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { SysmonSnapshot } from '../src/snapshot.ts'
import {
  clock, cpuCard, formatBytes, formatCelsius, formatDuration, formatPercent, formatWatts, memoryCard, powerCard, statusLine,
  storageRows, usageLevel, type Translate,
} from '../src/client/cards.ts'
import { en, zh } from '../src/client/locales.ts'

const t = makeTranslate(zh) as Translate
const tEn = makeTranslate(en) as Translate
const GiB = 1024 ** 3

/** The Mac mini as dsh-runtime sees it, with macmon installed. */
const SNAPSHOT: SysmonSnapshot = {
  sampledAt: new Date(2026, 9, 23, 6, 5, 9).getTime(),
  uptime: 6 * 86_400 + 21 * 3600 + 5 * 60,
  cpu: { usage: 0.374, cores: 10, load: [2.5, 1.875, 1.2] },
  memory: { total: 17179869184, used: 11585126400, swapTotal: 2147483648, swapUsed: 757071872, approximate: false },
  power: { system: 7.78, cpu: 2.16, gpu: 0.06, ane: 0 },
  temperature: { cpu: 49.6, gpu: 44.8 },
  disks: [
    { mount: '/System/Volumes/Data', label: 'Internal', total: 228 * GiB, used: 209.2 * GiB, free: 18.8 * GiB },
    { mount: '/Volumes/MiniSSD', label: 'MiniSSD', total: 3.6 * 1024 * GiB, used: 0.13 * 1024 * GiB, free: 3.47 * 1024 * GiB },
  ],
  skippedMounts: [],
  sources: { macmon: 'ok' },
}

describe('formatting', () => {
  it('formats sizes in binary units with one decimal below 100', () => {
    expect([0, 512, 1536, 17179869184, 11585126400, 245 * GiB, 4 * 1024 ** 4, 3.62 * 1024 ** 4].map(formatBytes))
      .toEqual(['0 B', '512 B', '1.5 KB', '16 GB', '10.8 GB', '245 GB', '4 TB', '3.6 TB'])
  })

  it('formats percent, watts, degrees, durations, and clock time', () => {
    expect([0.374, 0, 1, 1.4, -0.2].map(formatPercent)).toEqual(['37%', '0%', '100%', '100%', '0%'])
    expect([7.78, 0.06, 0, 25.4, null].map(watts => formatWatts(watts, t))).toEqual(['7.8 W', '0.1 W', '0 W', '25 W', '—'])
    expect([49.6, null].map(celsius => formatCelsius(celsius, t))).toEqual(['50 °C', '—'])
    expect([SNAPSHOT.uptime, 3 * 3600 + 7 * 60, 59, -1].map(seconds => formatDuration(seconds, t)))
      .toEqual(['6 天 21 小时', '3 小时 7 分', '0 分钟', '0 分钟'])
    expect(formatDuration(SNAPSHOT.uptime, tEn)).toBe('6 d 21 h')
    expect(clock(SNAPSHOT.sampledAt)).toBe('06:05:09')
  })

  it('turns bars amber from 85% used and red from 95%', () => {
    expect([0, 0.849, 0.85, 0.949, 0.95, 1].map(usageLevel)).toEqual(['normal', 'normal', 'warn', 'warn', 'critical', 'critical'])
  })
})

describe('cards', () => {
  it('builds the CPU card, and says it is measuring without a usage yet', () => {
    expect(cpuCard(SNAPSHOT, t)).toEqual({ value: '37%', meter: { ratio: 0.374, level: 'normal' }, cores: '10 核', details: ['负载 2.50 / 1.88 / 1.20'] })
    expect(cpuCard({ ...SNAPSHOT, cpu: { ...SNAPSHOT.cpu, usage: null } }, t))
      .toMatchObject({ value: '—', meter: null, details: ['正在测量', '负载 2.50 / 1.88 / 1.20'] })
  })

  it('builds the Memory card with swap, colours it by use, and flags an approximate reading', () => {
    expect(memoryCard(SNAPSHOT, t)).toEqual({
      value: '10.8 GB', total: '/ 16 GB', meter: { ratio: 11585126400 / 17179869184, level: 'normal' }, details: ['交换 722 MB / 2 GB'],
    })
    const full = { ...SNAPSHOT, memory: { ...SNAPSHOT.memory, used: 16.5 * GiB } }
    expect(memoryCard(full, t).meter?.level).toBe('critical')
    const approximate = { ...SNAPSHOT, memory: { total: 16 * GiB, used: 15.8 * GiB, swapTotal: null, swapUsed: null, approximate: true } }
    expect(memoryCard(approximate, t)).toMatchObject({ meter: { level: 'normal' }, details: ['近似值：没有 macmon，按空闲页估算'] })
    const empty = { ...SNAPSHOT, memory: { ...SNAPSHOT.memory, total: 0, swapTotal: 0 } }
    expect(memoryCard(empty, t)).toMatchObject({ meter: null, details: [] })
  })

  it('builds the Power card, or says why there is no reading instead of showing zeros', () => {
    expect(powerCard(SNAPSHOT, t)).toEqual({ value: '7.8 W', details: ['CPU 2.2 W · GPU 0.1 W · ANE 0 W', 'CPU 50 °C · GPU 45 °C'], notice: null })
    expect(powerCard({ ...SNAPSHOT, power: null, temperature: null, sources: { macmon: 'missing' } }, t))
      .toEqual({ value: null, details: [], notice: { kind: 'missing', text: '安装 macmon 后显示功耗与温度：' } })
    expect(powerCard({ ...SNAPSHOT, power: null, temperature: null, sources: { macmon: 'failed' } }, tEn).notice)
      .toEqual({ kind: 'failed', text: 'macmon gave no reading this time; power and temperature are unavailable.' })
    expect(powerCard({ ...SNAPSHOT, power: null, temperature: { cpu: 40, gpu: null } }, t))
      .toEqual({ value: null, details: ['CPU 40 °C · GPU —'], notice: { kind: 'unsupported', text: '这台机器没有功耗传感器。' } })
    expect(powerCard({ ...SNAPSHOT, power: { system: null, cpu: 1, gpu: 0, ane: null }, temperature: null }, t))
      .toMatchObject({ value: '—', details: ['CPU 1 W · GPU 0 W · ANE —'] })
  })

  it('builds one Storage row per volume with its threshold colour, then the skipped mounts', () => {
    const rows = storageRows({ ...SNAPSHOT, skippedMounts: [{ mount: '/Volumes/Backup', label: 'Backup', reason: 'not found' }] }, t)
    expect(rows).toEqual([
      {
        key: '/System/Volumes/Data', label: 'Internal', mount: '/System/Volumes/Data', percent: '92%',
        meter: { ratio: 209.2 / 228, level: 'warn' }, details: ['已用 209 GB / 228 GB', '剩余 18.8 GB'],
      },
      {
        key: '/Volumes/MiniSSD', label: 'MiniSSD', mount: '/Volumes/MiniSSD', percent: '4%',
        meter: { ratio: 0.13 / 3.6, level: 'normal' }, details: ['已用 133 GB / 3.6 TB', '剩余 3.5 TB'],
      },
      { key: '/Volumes/Backup', label: 'Backup', mount: '/Volumes/Backup', percent: '', meter: null, details: ['读不到（未挂载）'] },
    ])
    const full = { ...SNAPSHOT, disks: [{ mount: '/', label: 'Root', total: 100, used: 96, free: 4 }] }
    expect(storageRows(full, t)[0]?.meter?.level).toBe('critical')
    expect(storageRows({ ...SNAPSHOT, disks: [{ mount: '/', label: 'Root', total: 0, used: 0, free: 0 }] }, t)[0]?.percent).toBe('0%')
  })

  it('says whether the reading is live, stale, or not there yet', () => {
    const base = { snapshot: null, checkedAt: null, stale: false, refreshing: true }
    expect(statusLine(base, t)).toEqual({ text: '正在读取…', tone: 'loading' })
    expect(statusLine({ ...base, stale: true }, t)).toEqual({ text: '暂时读不到系统状态，稍后自动重试。', tone: 'stale' })
    expect(statusLine({ ...base, snapshot: SNAPSHOT }, t)).toEqual({ text: '06:05:09 更新', tone: 'live' })
    expect(statusLine({ ...base, snapshot: SNAPSHOT, stale: true }, tEn)).toEqual({ text: 'Not refreshing · showing 06:05:09', tone: 'stale' })
  })
})
