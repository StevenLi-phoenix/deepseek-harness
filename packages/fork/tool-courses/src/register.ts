/** Turn a read spec or a write spec into a registered tool: the output shape, the logging, and the failure answer. */

import type { Context } from '@deepseek-ai/cordis'
import type { Courses } from '@deepseek-ai/dsh-courses'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { dataBlock } from './format.ts'
import type { ReadSpec } from './read-tools.ts'
import { errorText, text } from './tool-args.ts'
import type { WriteSpec } from './write-tools.ts'
import { requestId, writeOutcome } from './write-outcome.ts'

/**
 * Register a read tool: its answer is one text block, rendered as untrusted data.
 * @param scoped - the context with the courses service.
 * @param spec - the tool.
 */
export function registerRead(scoped: Context, spec: ReadSpec): void {
  scoped.tools.register(defineTool({
    name: spec.name,
    description: spec.description,
    parameters: spec.parameters,
    output: {
      schema: { type: 'json' },
      render: (_args: unknown, value: unknown) => {
        const record = value as { text?: unknown; error?: unknown }
        const body = typeof record.text === 'string' ? record.text : ''
        return [{ type: 'text' as const, text: typeof record.error === 'string' ? JSON.stringify({ error: record.error }) : dataBlock(body) }]
      },
    },
    async execute(args, exec): Promise<JsonValue> {
      try {
        const answer = await spec.run(args as Record<string, unknown>, exec.signal)
        scoped.logger.info(`tool-courses: ${spec.name} answered ${answer.length} chars`)
        return { text: answer }
      } catch (error: unknown) {
        scoped.logger.warn(`tool-courses: ${spec.name} failed: ${errorText(error)}`)
        return { error: errorText(error) }
      }
    },
    presentCall: args => ({ card: 'generic', title: spec.title(args as Record<string, unknown>), kind: 'read' }),
  }))
}

/**
 * Register a write tool: the request carries a request id, so an identical retry gets the first outcome again.
 * @param scoped - the context with the courses service.
 * @param courses - the courses service.
 * @param spec - the tool.
 */
export function registerWrite(scoped: Context, courses: Courses, spec: WriteSpec): void {
  scoped.tools.register(defineTool({
    name: spec.name,
    description: spec.description,
    parameters: spec.parameters,
    output: { schema: { type: 'json' }, render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }] },
    async execute(args, exec): Promise<JsonValue> {
      try {
        const body = spec.build(args as Record<string, unknown>)
        const given = text((args as Record<string, unknown>)['request_id'])
        const request = given === '' ? requestId(spec.operation, body) : given
        const outcome = writeOutcome(await courses.api.call(spec.operation, { ...body, request_id: request }, exec.signal))
        scoped.logger.info(`tool-courses: ${spec.operation} ${String(body['id'])} (${request}): ${JSON.stringify(outcome)}`)
        return outcome
      } catch (error: unknown) {
        scoped.logger.warn(`tool-courses: ${spec.operation} failed: ${errorText(error)}`)
        return { error: errorText(error) }
      }
    },
    presentCall: args => ({ card: 'generic', title: spec.title(args as Record<string, unknown>), kind: 'edit' }),
  }))
}
