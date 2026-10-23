/**
 * macmon (vladkens/macmon, MIT) reads Apple Silicon power, temperature, and
 * memory without sudo. This module runs it with fixed arguments and parses
 * its one JSON line defensively: only finite numbers are taken, everything
 * else is ignored, and nothing it prints is logged or forwarded.
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { MacmonStatus, PowerReading, TemperatureReading } from './snapshot.ts'

/** One sample of 500 ms, then exit. Nothing from a request ever reaches these. */
export const MACMON_ARGS: readonly string[] = ['pipe', '-s', '1', '-i', '500']
/** A sample takes about 600 ms; a stuck run is killed after this. */
export const MACMON_TIMEOUT_MS = 5000
/** One JSON line is about 500 bytes. */
export const MACMON_MAX_BUFFER = 1024 * 1024

/** The `execFile` seam, replaceable in tests. */
export type ExecFile = (
  file: string,
  args: readonly string[],
  options: { readonly timeout: number; readonly maxBuffer: number },
) => Promise<{ readonly stdout: string }>

const execFileAsync = promisify(execFile)

/** Node's `execFile`, promisified: no shell, so arguments are never interpreted. */
export const nodeExecFile: ExecFile = (file, args, options) =>
  execFileAsync(file, [...args], { ...options, encoding: 'utf8', windowsHide: true })

/** Memory as macmon reports it, in bytes. */
export interface MacmonMemory {
  readonly total: number
  readonly used: number
  readonly swapTotal: number | null
  readonly swapUsed: number | null
}

/** The parts of a macmon line this package uses; each is null when the line lacks it. */
export interface MacmonReading {
  readonly power: PowerReading | null
  readonly temperature: TemperatureReading | null
  readonly memory: MacmonMemory | null
}

/** Outcome of one macmon run; `reason` is a fixed phrase, never program output. */
export type MacmonResult =
  | { readonly status: 'ok'; readonly reading: MacmonReading }
  | { readonly status: Exclude<MacmonStatus, 'ok'>; readonly reason: string }

type Fields = Readonly<Record<string, unknown>>

function record(value: unknown): Fields | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Fields : undefined
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** A reading of zero or below means the sensor is absent (macmon reports 0 in virtual machines). */
function positive(value: number | null): number | null {
  return value !== null && value > 0 ? value : null
}

function nonNegative(value: number | null): number | null {
  return value !== null && value >= 0 ? value : null
}

function readPower(line: Fields): PowerReading | null {
  const system = finite(line['sys_power'])
  const cpu = finite(line['cpu_power'])
  const gpu = finite(line['gpu_power'])
  const ane = finite(line['ane_power'])
  const all = finite(line['all_power'])
  // A machine with power sensors always draws something; all zeros is a machine without them.
  if ([system, cpu, gpu, ane, all].every(value => value === null || value <= 0)) return null
  return { system: positive(system), cpu: nonNegative(cpu), gpu: nonNegative(gpu), ane: nonNegative(ane) }
}

function readTemperature(line: Fields): TemperatureReading | null {
  const temp = record(line['temp'])
  if (temp === undefined) return null
  const cpu = positive(finite(temp['cpu_temp_avg']))
  const gpu = positive(finite(temp['gpu_temp_avg']))
  return cpu === null && gpu === null ? null : { cpu, gpu }
}

function readMemory(line: Fields): MacmonMemory | null {
  const memory = record(line['memory'])
  if (memory === undefined) return null
  const total = positive(finite(memory['ram_total']))
  const used = nonNegative(finite(memory['ram_usage']))
  if (total === null || used === null) return null
  return {
    total,
    used: Math.min(used, total),
    swapTotal: nonNegative(finite(memory['swap_total'])),
    swapUsed: nonNegative(finite(memory['swap_usage'])),
  }
}

/**
 * Parse macmon's output.
 * @param stdout - what `macmon pipe` printed; the last non-empty line is the sample.
 * @returns the reading, or undefined when the output is not a macmon sample.
 */
export function parseMacmon(stdout: string): MacmonReading | undefined {
  const last = stdout.split('\n').map(line => line.trim()).filter(line => line !== '').at(-1)
  if (last === undefined) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(last)
  } catch {
    return undefined
  }
  const line = record(parsed)
  if (line === undefined) return undefined
  const known = ['sys_power', 'all_power', 'cpu_power', 'gpu_power'].some(key => finite(line[key]) !== null)
    || finite(record(line['memory'])?.['ram_total']) !== null
  if (!known) return undefined
  return { power: readPower(line), temperature: readTemperature(line), memory: readMemory(line) }
}

/** The failure phrase for an `execFile` rejection. */
function failure(error: unknown): MacmonResult {
  const fields = record(error) ?? {}
  const code = fields['code']
  if (code === 'ENOENT') return { status: 'missing', reason: 'not installed' }
  if (code === 'EACCES') return { status: 'failed', reason: 'not executable' }
  if (fields['killed'] === true || typeof fields['signal'] === 'string') return { status: 'failed', reason: 'timed out' }
  if (code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return { status: 'failed', reason: 'too much output' }
  if (typeof code === 'number') return { status: 'failed', reason: `exit ${code}` }
  return { status: 'failed', reason: 'could not run' }
}

/**
 * Run macmon once. Never rejects.
 * @param exec - the `execFile` seam.
 * @param path - absolute path of the macmon binary.
 * @returns the reading, or why there is none.
 */
export async function runMacmon(exec: ExecFile, path: string): Promise<MacmonResult> {
  let stdout: string
  try {
    ({ stdout } = await exec(path, MACMON_ARGS, { timeout: MACMON_TIMEOUT_MS, maxBuffer: MACMON_MAX_BUFFER }))
  } catch (error) {
    return failure(error)
  }
  const reading = parseMacmon(stdout)
  return reading === undefined ? { status: 'failed', reason: 'unparseable output' } : { status: 'ok', reading }
}
