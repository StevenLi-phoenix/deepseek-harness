import { describe, expect, it, vi } from 'vitest'
import type { ExecFile } from '../src/macmon.ts'
import {
  CPU_BASELINE_MAX_AGE_MS, HOMEBREW_MACMON, MIN_FRESH_MS, SystemSampler, cpuTicks, cpuUsage, readDisks,
  type CpuTimes, type FsStats, type Probes,
} from '../src/sampler.ts'

const SAMPLE = JSON.stringify({
  cpu_power: 2.16, gpu_power: 0.06, ane_power: 0, all_power: 2.22, sys_power: 7.78,
  memory: { ram_total: 17179869184, ram_usage: 11585126400, swap_total: 2147483648, swap_usage: 757071872 },
  temp: { cpu_temp_avg: 49.6, gpu_temp_avg: 44.8 },
})

/** `count` identical cores, each with these tick totals. */
function cores(count: number, busy: number, idle: number): CpuTimes[] {
  return Array.from({ length: count }, () => ({ times: { user: busy, nice: 0, sys: 0, idle, irq: 0 } }))
}

const GiB = 1024 ** 3

/** Probes for a 4-core machine whose ticks advance on every `cpus()` call. */
function harness(overrides: Partial<Probes> = {}) {
  let now = 1_000_000
  let busy = 0
  let idle = 0
  const exec = vi.fn<ExecFile>(() => Promise.resolve({ stdout: SAMPLE }))
  const logger = { info: vi.fn<(message: string) => void>(), warn: vi.fn<(message: string) => void>() }
  const probes: Partial<Probes> = {
    exec,
    exists: () => false,
    // Each read advances 250 ms busy and 750 ms idle per core: 25% load.
    cpus: () => { busy += 250; idle += 750; return cores(4, busy, idle) },
    loadavg: () => [1.5, 1.25, 1],
    totalmem: () => 16 * GiB,
    freemem: () => 2 * GiB,
    uptime: () => 90_061,
    statfs: (path: string): FsStats => {
      if (path === '/System/Volumes/Data') return { bsize: 4096, blocks: 59840624, bavail: 4920743 }
      throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' })
    },
    homedir: () => '/Users/dsh-runtime',
    now: () => now,
    ...overrides,
  }
  const advance = (ms: number): void => { now += ms }
  return { probes, exec, logger, advance }
}

describe('cpuUsage', () => {
  it('is the non-idle share of the ticks between two readings', () => {
    const before = cpuTicks(cores(4, 1000, 9000))
    const after = cpuTicks(cores(4, 1250, 9750))
    expect(before).toEqual({ idle: 36000, total: 40000, cores: 4 })
    expect(cpuUsage(before, after)).toBeCloseTo(0.25)
  })

  it('is null on the first sample, after a core count change, or over a window too short to measure', () => {
    const now = cpuTicks(cores(4, 1000, 9000))
    expect(cpuUsage(undefined, now)).toBeNull()
    expect(cpuUsage(cpuTicks(cores(2, 0, 0)), now)).toBeNull()
    // 4 cores need at least 400 ms of ticks between readings.
    expect(cpuUsage(now, cpuTicks(cores(4, 1050, 9040)))).toBeNull()
    expect(cpuUsage(cpuTicks([]), cpuTicks([]))).toBeNull()
  })

  it('stays within 0-1 when counters misbehave', () => {
    expect(cpuUsage(cpuTicks(cores(1, 0, 1000)), cpuTicks(cores(1, 1000, 1000)))).toBe(1)
    expect(cpuUsage(cpuTicks(cores(1, 0, 1000)), cpuTicks(cores(1, 0, 2000)))).toBe(0)
    expect(cpuUsage(cpuTicks(cores(1, 0, 5000)), cpuTicks(cores(1, 2000, 4000)))).toBeNull()
  })
})

describe('readDisks', () => {
  it('maps statfs blocks to bytes, used plus free equals total, and skips mounts it cannot read', () => {
    const errors: Record<string, string> = { '/Volumes/Gone': 'ENOENT', '/Volumes/Locked': 'EACCES', '/Volumes/Odd': 'EIO' }
    const statfs = (path: string): FsStats => {
      if (path === '/Volumes/Empty') return { bsize: 4096, blocks: 0, bavail: 0 }
      const code = errors[path]
      if (code !== undefined) throw Object.assign(new Error(code), { code })
      return { bsize: 4096, blocks: 1000, bavail: 250 }
    }
    const mounts = ['/Volumes/Gone', '/System/Volumes/Data', '/Volumes/Locked', '/Volumes/Odd', '/Volumes/Empty']
      .map(mount => ({ mount, label: mount.split('/').at(-1) ?? mount }))
    expect(readDisks(mounts, statfs)).toEqual({
      disks: [{ mount: '/System/Volumes/Data', label: 'Data', total: 4_096_000, used: 3_072_000, free: 1_024_000 }],
      skipped: [
        { mount: '/Volumes/Gone', label: 'Gone', reason: 'not found' },
        { mount: '/Volumes/Locked', label: 'Locked', reason: 'not permitted' },
        { mount: '/Volumes/Odd', label: 'Odd', reason: 'unreadable' },
        { mount: '/Volumes/Empty', label: 'Empty', reason: 'unreadable' },
      ],
    })
  })
})

describe('SystemSampler', () => {
  const MOUNTS = [{ mount: '/System/Volumes/Data', label: 'Internal' }, { mount: '/Volumes/MiniSSD', label: 'MiniSSD' }]

  it('samples every source into one snapshot', async () => {
    const { probes, logger } = harness()
    const sampler = new SystemSampler({ mounts: MOUNTS, cacheMs: 2000, logger, probes })
    expect(await sampler.sample()).toEqual({
      sampledAt: 1_000_000,
      uptime: 90_061,
      // The first sample measures across its own macmon run.
      cpu: { usage: 0.25, cores: 4, load: [1.5, 1.25, 1] },
      memory: { total: 17179869184, used: 11585126400, swapTotal: 2147483648, swapUsed: 757071872, approximate: false },
      power: { system: 7.78, cpu: 2.16, gpu: 0.06, ane: 0 },
      temperature: { cpu: 49.6, gpu: 44.8 },
      disks: [{ mount: '/System/Volumes/Data', label: 'Internal', total: 59840624 * 4096, used: (59840624 - 4920743) * 4096, free: 4920743 * 4096 }],
      skippedMounts: [{ mount: '/Volumes/MiniSSD', label: 'MiniSSD', reason: 'not found' }],
      sources: { macmon: 'ok' },
    })
    expect(logger.warn).toHaveBeenCalledWith('lsy-sysmon: /Volumes/MiniSSD skipped (not found)')
  })

  it('measures CPU from the previous sample while it is recent', async () => {
    let calls = 0
    const ticks = [cores(2, 0, 0), cores(2, 0, 0), cores(2, 200, 200), cores(2, 500, 500), cores(2, 500, 500), cores(2, 500, 500)]
    const { probes, logger, advance } = harness({ cpus: () => ticks[Math.min(calls++, ticks.length - 1)]! })
    // No macmon: its run is instant, so a sample has no window of its own.
    const missing = Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })
    const sampler = new SystemSampler({ mounts: [], cacheMs: 2000, logger, probes: { ...probes, exec: () => Promise.reject(missing) } })
    expect((await sampler.sample()).cpu.usage).toBeNull()
    advance(5000)
    // Previous sample (0/0) to this one's end (500/500 per core): half busy.
    expect((await sampler.sample()).cpu.usage).toBeCloseTo(0.5)
    advance(CPU_BASELINE_MAX_AGE_MS + 1)
    // Too old a baseline: this sample's own instant window is all there is.
    expect((await sampler.sample()).cpu.usage).toBeNull()
  })

  it('falls back to Node memory, marked approximate, and null power without macmon; logs the state once', async () => {
    const { probes, logger } = harness()
    const missing = Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })
    const exec = vi.fn<ExecFile>(() => Promise.reject(missing))
    const sampler = new SystemSampler({ mounts: [], cacheMs: 0, logger, probes: { ...probes, exec } })
    const first = await sampler.sample()
    await sampler.sample()
    expect(first).toMatchObject({
      memory: { total: 16 * GiB, used: 14 * GiB, swapTotal: null, swapUsed: null, approximate: true },
      power: null,
      temperature: null,
      sources: { macmon: 'missing' },
    })
    expect(exec).toHaveBeenCalledWith(HOMEBREW_MACMON, expect.any(Array), expect.any(Object))
    expect(logger.info.mock.calls.map(call => call[0])).toEqual([
      `lsy-sysmon: macmon not found at ${HOMEBREW_MACMON}; power and temperature are not shown (brew install macmon)`,
    ])
    exec.mockResolvedValueOnce({ stdout: 'garbage' })
    expect((await sampler.sample()).sources.macmon).toBe('failed')
    expect(logger.warn).toHaveBeenLastCalledWith(`lsy-sysmon: macmon at ${HOMEBREW_MACMON} gave no reading (unparseable output); power and temperature are not shown`)
    exec.mockResolvedValueOnce({ stdout: SAMPLE })
    expect((await sampler.sample()).sources.macmon).toBe('ok')
    expect(logger.info).toHaveBeenLastCalledWith(`lsy-sysmon: macmon at ${HOMEBREW_MACMON} reads again`)
  })

  it('never rejects, even when every probe throws', async () => {
    const boom = (): never => { throw new Error('probe failed') }
    const { logger } = harness()
    const sampler = new SystemSampler({
      mounts: [{ mount: '/', label: 'Root' }],
      cacheMs: 0,
      logger,
      probes: {
        exec: boom, exists: boom, cpus: boom, loadavg: boom, totalmem: boom, freemem: boom, uptime: boom, statfs: boom, homedir: boom,
        now: () => 5,
      },
    })
    expect(await sampler.sample()).toEqual({
      sampledAt: 5,
      uptime: 0,
      cpu: { usage: null, cores: 0, load: [0, 0, 0] },
      memory: { total: 0, used: 0, swapTotal: null, swapUsed: null, approximate: true },
      power: null,
      temperature: null,
      disks: [],
      skippedMounts: [{ mount: '/', label: 'Root', reason: 'unreadable' }],
      sources: { macmon: 'failed' },
    })
  })

  it('prefers the configured macmon, then the one in the home bin, then Homebrew', () => {
    const { probes, logger } = harness()
    const at = (exists: boolean, macmonPath?: string) => new SystemSampler({
      macmonPath, mounts: [], cacheMs: 0, logger, probes: { ...probes, exists: path => exists && path === '/Users/dsh-runtime/bin/macmon' },
    }).macmonPath()
    expect(at(true)).toBe('/Users/dsh-runtime/bin/macmon')
    expect(at(false)).toBe(HOMEBREW_MACMON)
    expect(at(true, '/opt/tools/macmon')).toBe('/opt/tools/macmon')
  })

  it('serves a cached snapshot, shares a sample in flight, and lets fresh requests through at most every 2 s', async () => {
    const { probes, exec, logger, advance } = harness()
    const sampler = new SystemSampler({ mounts: [], cacheMs: 10_000, logger, probes })
    const [a, b] = await Promise.all([sampler.read(), sampler.read()])
    expect(a).toBe(b)
    expect(exec).toHaveBeenCalledTimes(1)
    advance(MIN_FRESH_MS - 1)
    expect(await sampler.read(true)).toBe(a)
    expect(exec).toHaveBeenCalledTimes(1)
    advance(1)
    const fresh = await sampler.read(true)
    expect(fresh).not.toBe(a)
    expect(exec).toHaveBeenCalledTimes(2)
    advance(9_999)
    expect(await sampler.read()).toBe(fresh)
    advance(1)
    await sampler.read()
    expect(exec).toHaveBeenCalledTimes(3)
  })
})
