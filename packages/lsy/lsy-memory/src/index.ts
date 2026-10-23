/**
 * Owner memory across Sessions. The Host keeps the entries in one JSONL file and
 * puts them in front of the model itself: the first request of a root Session
 * (and the first after compaction shadows it) carries the memory block, so
 * recall never depends on the model choosing to look. The model reads details
 * and writes through three typed tools whose input the store validates.
 *
 * @module @deepseek-ai/dsh-lsy-memory
 */

import type { Context } from '@deepseek-ai/cordis'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContextFormed } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { CATEGORIES, isCategory, type MemoryEntry } from './entries.ts'
import { renderMemoryBlock } from './render.ts'
import { defaultMemoryFile, MemoryError, MemoryStore } from './store.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'lsy-memory': { kind: 'lsy-memory' } & ContextFormed
  }
}

export { CATEGORIES, CATEGORY_DISPLAY, MAX_TEXT_CHARS, type MemoryCategory, type MemoryDraft, type MemoryEntry } from './entries.ts'
export { parseClaudeExport } from './export.ts'
export { renderMemoryBlock } from './render.ts'
export { defaultMemoryFile, localDate, MAX_ENTRIES, MemoryError, MemoryStore } from './store.ts'
export { runImportCli } from './cli.ts'

/** Plugin name; also the source kind of the memory message. */
export const name = 'lsy-memory'

/** Mounted inside an agent preset's scope, like other tool plugins. */
export const inject = ['tools']

/** Memory file and context budget. */
export interface Config {
  /** Absolute path of the memory file; defaults to `<DSH_HOME>/lsy-memory/memory.jsonl`. */
  file?: string
  /** Cap on the memory block, in bytes. */
  maxBytes?: number
}

/** Schemastery validation for {@link Config}. */
export const Config: z<Config> = z.object({
  file: z.string(),
  maxBytes: z.natural().min(1024).default(65_536),
})

const SEARCH_LIMIT = 20
const SEARCH_LIMIT_MAX = 50

const ENTRY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    category: { type: 'string', required: true, enum: CATEGORIES },
    date: { type: 'string', required: true },
    text: { type: 'string', required: true },
  },
} as const

const ERROR_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    error: { type: 'string', required: true },
    message: { type: 'string', required: true },
  },
} as const

const renderValue = (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }]

const CATEGORY_HELP = 'instructions: how the owner wants you to work; preferences: tastes and opinions; identity: who the owner is, people, school, accounts; career: jobs and applications; projects: what the owner builds or researches.'

/** Whether the memory message is part of what the model currently sees. */
function memoryVisible(session: Session): boolean {
  for (const seq of session.surface.nodes) {
    // oxlint-disable-next-line typescript/no-deprecated -- Same Session history read as agent-instructions.
    const event = session.eventAt(seq)
    if (event?.type === 'user/message' && event.data.source.kind === name) return true
  }
  return false
}

function failure(error: unknown): { error: string; message: string } {
  if (error instanceof MemoryError) return { error: error.code, message: error.message }
  throw error
}

/**
 * Register the memory tools and the pre-step injection.
 * @param ctx - the preset scope's context.
 * @param config - memory file and context budget.
 */
export function apply(ctx: Context, config: Config): void {
  const store = new MemoryStore(config.file ?? defaultMemoryFile())
  const maxBytes = config.maxBytes ?? 65_536

  ctx.on('agent/pre-step', async ({ agent, messages, step, signal }, next): Promise<PreStepDecision> => {
    const decision = await next()
    // Subagents work for the root agent, which already has the memory; an empty first
    // step owns no request, so the block waits for the next one.
    if (decision.kind === 'reject' || signal.aborted
      || agent.session.header.origin === 'subagent'
      || (step === 1 && decision.messages.length === 0)
      || memoryVisible(agent.session)) return decision
    let entries: MemoryEntry[]
    try {
      entries = await store.list()
    } catch (error: unknown) {
      ctx.logger.warn('memory not loaded for session %s: %s', agent.session.id, error instanceof Error ? error.message : String(error))
      return decision
    }
    const text = renderMemoryBlock(entries, maxBytes)
    if (text === undefined) return decision
    ctx.logger.info('memory block (%d entries, %d bytes) entered session %s', entries.length, Buffer.byteLength(text), agent.session.id)
    const block = createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: name, form: 'instructions' },
    })
    // Right after the claimed batch, like workspace instructions: the prompt comes first.
    const lastClaimed = decision.messages.findLastIndex(message => messages.includes(message))
    return { ...decision, messages: decision.messages.toSpliced(lastClaimed + 1, 0, block) }
  })

  ctx.tools.register(defineTool({
    name: 'memory_search',
    description: [
      'Search your memory of the owner and get full entries.',
      'Matches entries containing any of the whitespace-separated terms, case-insensitively, most matching terms first; an entry id also matches.',
      'Entries mix Chinese and English, so include terms in both when unsure. An empty query with a category lists that category, newest first.',
    ].join(' '),
    parameters: {
      query: { type: 'string', required: true, description: 'Terms to look for, e.g. "roommate 室友 lease".' },
      category: { type: 'string', enum: CATEGORIES, description: `Only this category. ${CATEGORY_HELP}` },
      limit: { type: 'number', description: `Most entries returned; default ${String(SEARCH_LIMIT)}, at most ${String(SEARCH_LIMIT_MAX)}.` },
    },
    output: {
      schema: {
        oneOf: [
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              entries: { type: 'array', required: true, items: ENTRY_SCHEMA },
              more: { type: 'number', required: true },
            },
          },
          ERROR_SCHEMA,
        ],
      },
      render: renderValue,
    },
    async execute(args) {
      const limit = Math.min(SEARCH_LIMIT_MAX, Math.max(1, Math.floor(args.limit ?? SEARCH_LIMIT)))
      const category = isCategory(args.category) ? args.category : undefined
      try {
        return await store.search(args.query, { ...category === undefined ? {} : { category }, limit })
      } catch (error: unknown) {
        return failure(error)
      }
    },
    presentCall: args => ({ card: 'generic', title: `Search memory: ${args.query}`, kind: 'search', rawInput: args.query }),
  }))

  ctx.tools.register(defineTool({
    name: 'memory_save',
    description: [
      'Remember one fact about the owner across sessions, or correct an entry by passing its id.',
      'Use it when the owner asks you to remember something, states a lasting preference or rule, or corrects something you remembered.',
      'Write one self-contained sentence in the owner\'s language; do not save secrets, one-off task details, or what is already remembered. The host stamps the date.',
    ].join(' '),
    parameters: {
      text: { type: 'string', required: true, description: 'The fact, one line, at most 2000 characters.' },
      category: { type: 'string', required: true, enum: CATEGORIES, description: CATEGORY_HELP },
      id: { type: 'string', description: 'Id of the entry to replace, as the memory block or memory_search shows it; omit to add a new entry.' },
    },
    output: {
      schema: {
        oneOf: [
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              outcome: { type: 'string', required: true, enum: ['added', 'replaced', 'unchanged'] },
              entry: { ...ENTRY_SCHEMA, required: true },
            },
          },
          ERROR_SCHEMA,
        ],
      },
      render: renderValue,
    },
    async execute(args) {
      try {
        const result = await store.save(args)
        ctx.logger.info('memory %s %s (%s, %d chars)', result.outcome, result.entry.id, result.entry.category, result.entry.text.length)
        return { outcome: result.outcome, entry: result.entry }
      } catch (error: unknown) {
        return failure(error)
      }
    },
    presentCall: args => ({ card: 'generic', title: args.id === undefined ? 'Remember' : `Update memory ${args.id}`, kind: 'edit', rawInput: args.text }),
  }))

  ctx.tools.register(defineTool({
    name: 'memory_forget',
    description: 'Delete one memory entry by id, when the owner asks you to forget it or it is no longer true. To correct an entry instead, use memory_save with its id.',
    parameters: {
      id: { type: 'string', required: true, description: 'Id of the entry, as the memory block or memory_search shows it.' },
    },
    output: {
      schema: {
        oneOf: [
          {
            type: 'object',
            additionalProperties: false,
            properties: { forgot: { ...ENTRY_SCHEMA, required: true } },
          },
          ERROR_SCHEMA,
        ],
      },
      render: renderValue,
    },
    async execute(args) {
      try {
        const entry = await store.forget(args.id)
        ctx.logger.info('memory forgot %s (%s)', entry.id, entry.category)
        return { forgot: entry }
      } catch (error: unknown) {
        return failure(error)
      }
    },
    presentCall: args => ({ card: 'generic', title: `Forget memory ${args.id}`, kind: 'delete', rawInput: args.id }),
  }))
}
