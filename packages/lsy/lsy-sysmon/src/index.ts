/**
 * System status plugin, node half: `GET /api/lsy.sysmon` answers the Host
 * machine's CPU, memory, power, temperature, and disk usage per volume for the
 * browser half's Settings section. The route sits under `/api`, so the
 * connection's sign-in check guards it. Power, temperature, and exact memory
 * come from macmon, run with fixed arguments; nothing from a request reaches
 * a command. Snapshots are cached and shared while in flight, so open pages
 * cost at most one sample per `cacheMs`.
 */

import { isAbsolute } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { DEFAULT_MOUNTS, SystemSampler, type SysmonMount } from './sampler.ts'
import { SYSMON_PATH } from './snapshot.ts'

export type { SysmonMount } from './sampler.ts'

/** Plugin configuration. */
export interface Config {
  /** Absolute path of the macmon binary (power, temperature, memory); unset tries `<home>/bin/macmon`, then `/opt/homebrew/bin/macmon`. */
  macmonPath?: string
  /** Volumes to show, in order; a mount that cannot be read is skipped and reported. */
  mounts: SysmonMount[]
  /** How long a snapshot is served from cache, in milliseconds. */
  cacheMs: number
}

/** Configuration schema. */
export const Config: z<Config> = z.object({
  macmonPath: z.string(),
  mounts: z.array(z.object({
    mount: z.string(),
    label: z.string(),
  })).default(DEFAULT_MOUNTS.map(mount => ({ ...mount }))),
  cacheMs: z.natural().default(2000),
})

/** Required Host services. */
export const inject = ['connection']

/** The slice of the connection service this plugin uses. */
interface SysmonConnection {
  readonly fetch: {
    register(route: {
      readonly path: string
      readonly methods: readonly 'GET'[]
      readonly requestBody: 'buffered'
      readonly fetch: (request: Request) => Promise<Response>
    }): () => Promise<void>
  }
}

/**
 * Register the system status route.
 * @param ctx - Host context with the connection service.
 * @param config - resolved configuration.
 */
export function apply(ctx: Context, config: Config): void {
  if (config.macmonPath !== undefined && !isAbsolute(config.macmonPath)) throw new Error('lsy-sysmon: macmonPath must be an absolute path')
  for (const { mount } of config.mounts) {
    if (!isAbsolute(mount)) throw new Error(`lsy-sysmon: mount ${JSON.stringify(mount)} must be an absolute path`)
  }
  const sampler = new SystemSampler({
    macmonPath: config.macmonPath,
    mounts: config.mounts,
    cacheMs: config.cacheMs,
    logger: ctx.logger,
  })
  const connection = Reflect.get(ctx, 'connection') as SysmonConnection
  ctx.effect(() => connection.fetch.register({
    path: SYSMON_PATH,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const fresh = new URL(request.url).searchParams.get('fresh') === '1'
      return Response.json(await sampler.read(fresh), { headers: { 'cache-control': 'no-store' } })
    },
  }), 'lsy-sysmon: /api/lsy.sysmon')
}
