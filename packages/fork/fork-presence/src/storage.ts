/** Durable presence state: the latest Focus signal, the button in force, and the window the owner set in Settings. */
import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'

const inputsSchema = z.object({
  focus: z.object({
    asleep: z.boolean(),
    at: z.number(),
    since: z.number().optional(),
    heartbeatAt: z.number().optional(),
  }).strict().optional(),
  manual: z.object({ asleep: z.boolean(), at: z.number(), until: z.number().optional() }).strict().optional(),
}).strict()

const clock = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/u)

const windowSchema = z.object({ enabled: z.boolean(), start: clock, end: clock }).strict()

/** The latest inputs; one row, key `owner`. */
export type InputsRecord = z.infer<typeof inputsSchema>
/** The window set in Settings; one row, key `window`, which replaces the configured default. */
export type WindowRecord = z.infer<typeof windowSchema>

/** Presence storage: `inputs` keyed `owner`, `window` keyed `window`. */
export const presenceDomain = defineDomain({
  name: 'fork_presence',
  version: 1,
  tables: {
    inputs: domainTable<string, InputsRecord>(inputsSchema),
    window: domainTable<string, WindowRecord>(windowSchema),
  },
})
