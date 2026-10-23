import { describe, expect, it, vi } from 'vitest'
import { MACMON_ARGS, MACMON_MAX_BUFFER, MACMON_TIMEOUT_MS, parseMacmon, runMacmon, type ExecFile } from '../src/macmon.ts'

/** A real line from `macmon pipe -s 1 -i 500` on the Mac mini, as dsh-runtime. */
const SAMPLE = JSON.stringify({
  cpu_power: 2.16, gpu_power: 0.06, ane_power: 0, all_power: 2.22, sys_power: 7.78, ram_power: 0,
  cpu_active_ratio: 0.64, gpu_active_ratio: 0.25,
  memory: { ram_total: 17179869184, ram_usage: 11585126400, swap_total: 2147483648, swap_usage: 757071872 },
  temp: { cpu_temp_avg: 49.6, gpu_temp_avg: 44.8 },
  timestamp: '2026-10-23T06:00:00.000Z',
})

describe('parseMacmon', () => {
  it('reads power, temperature, and memory from a real sample', () => {
    expect(parseMacmon(`${SAMPLE}\n`)).toEqual({
      power: { system: 7.78, cpu: 2.16, gpu: 0.06, ane: 0 },
      temperature: { cpu: 49.6, gpu: 44.8 },
      memory: { total: 17179869184, used: 11585126400, swapTotal: 2147483648, swapUsed: 757071872 },
    })
  })

  it('takes the last line when macmon printed more than one', () => {
    const earlier = JSON.stringify({ sys_power: 1, memory: { ram_total: 8, ram_usage: 1 } })
    expect(parseMacmon(`${earlier}\n${SAMPLE}\n\n`)?.power?.system).toBe(7.78)
  })

  it('maps a virtual machine (zero power, null temperatures) to null, never 0', () => {
    const vm = JSON.stringify({
      cpu_power: 0, gpu_power: 0, ane_power: 0, all_power: 0, sys_power: 0,
      memory: { ram_total: 8589934592, ram_usage: 4294967296, swap_total: 0, swap_usage: 0 },
      temp: { cpu_temp_avg: null, gpu_temp_avg: null },
    })
    expect(parseMacmon(vm)).toEqual({
      power: null,
      temperature: null,
      memory: { total: 8589934592, used: 4294967296, swapTotal: 0, swapUsed: 0 },
    })
  })

  it('keeps only finite numbers and ignores everything else', () => {
    const odd = JSON.stringify({
      sys_power: '7.78', cpu_power: 3, gpu_power: -1, ane_power: null, all_power: 3,
      memory: { ram_total: 100, ram_usage: 150, swap_total: 'x' },
      temp: { cpu_temp_avg: 0, gpu_temp_avg: 51 },
      extra: { nested: [1, 2, 3] },
    })
    expect(parseMacmon(odd)).toEqual({
      power: { system: null, cpu: 3, gpu: null, ane: null },
      temperature: { cpu: null, gpu: 51 },
      memory: { total: 100, used: 100, swapTotal: null, swapUsed: null },
    })
  })

  it('rejects output that is not a macmon sample', () => {
    for (const garbage of ['', '\n\n', 'Error: no IOReport', '{"sys_power":', '[1,2]', 'null', '42', '{"hello":"world"}', '{"temp":{"cpu_temp_avg":50}}']) {
      expect(parseMacmon(garbage)).toBeUndefined()
    }
  })
})

describe('runMacmon', () => {
  it('runs the binary with fixed arguments, a deadline, and a buffer cap', async () => {
    const exec = vi.fn<ExecFile>(() => Promise.resolve({ stdout: SAMPLE }))
    const result = await runMacmon(exec, '/Users/dsh-runtime/bin/macmon')
    expect(result.status).toBe('ok')
    expect(exec).toHaveBeenCalledWith('/Users/dsh-runtime/bin/macmon', ['pipe', '-s', '1', '-i', '500'], { timeout: 5000, maxBuffer: 1024 * 1024 })
    expect([MACMON_ARGS, MACMON_TIMEOUT_MS, MACMON_MAX_BUFFER]).toEqual([['pipe', '-s', '1', '-i', '500'], 5000, 1048576])
  })

  it('never rejects: each failure becomes a status and a fixed phrase', async () => {
    const reject = (error: object): ExecFile => () => Promise.reject(Object.assign(new Error('macmon said: secret stderr'), error))
    const outcomes = await Promise.all([
      runMacmon(reject({ code: 'ENOENT' }), '/nope/macmon'),
      runMacmon(reject({ code: 'EACCES' }), '/tmp/macmon'),
      runMacmon(reject({ killed: true, signal: 'SIGTERM' }), '/tmp/macmon'),
      runMacmon(reject({ code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }), '/tmp/macmon'),
      runMacmon(reject({ code: 1 }), '/tmp/macmon'),
      runMacmon(() => Promise.reject(new Error('boom')), '/tmp/macmon'),
      runMacmon(() => Promise.resolve({ stdout: 'not json' }), '/tmp/macmon'),
    ])
    expect(outcomes).toEqual([
      { status: 'missing', reason: 'not installed' },
      { status: 'failed', reason: 'not executable' },
      { status: 'failed', reason: 'timed out' },
      { status: 'failed', reason: 'too much output' },
      { status: 'failed', reason: 'exit 1' },
      { status: 'failed', reason: 'could not run' },
      { status: 'failed', reason: 'unparseable output' },
    ])
    expect(JSON.stringify(outcomes)).not.toContain('secret')
  })
})
