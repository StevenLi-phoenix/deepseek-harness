/**
 * `notify_rules` and `notify_rules_forget`: the agent shows the owner the learned rules with the owner's words behind
 * each, and deletes one when the owner asks. Deletion is the owner's alone: a turn a notice, an event, or another
 * Session started, or one that read web, QQ, or mail text, is refused, so words from outside cannot remove a rule.
 */

import type { Context } from '@deepseek-ai/cordis'
import { ERROR_SCHEMA, renderJson } from '@deepseek-ai/dsh-service-kit'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { describeOrigin, turnOrigin } from '@deepseek-ai/dsh-turn-taint/origin'
import type { Rule } from './records.ts'
import type { NotifyLearning } from './service.ts'

/** Tool names. */
export const RULE_TOOLS = ['notify_rules', 'notify_rules_forget'] as const

const RULE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    kind: { type: 'string', required: true },
    decision: { type: 'string', required: true, enum: ['tell', 'brief', 'silent'] },
    since: { type: 'string', required: true },
    evidence: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: { at: { type: 'string', required: true }, quote: { type: 'string', required: true } },
      },
    },
  },
} as const

/** A rule as the tools return it. */
interface PublicRule {
  id: string
  kind: string
  decision: Rule['decision']
  since: string
  evidence: Array<{ at: string; quote: string }>
}

function publicRule(rule: Rule): PublicRule {
  const evidence = rule.evidence.map(item => ({ at: item.at, quote: item.quote }))
  return { id: rule.id, kind: rule.kind, decision: rule.decision, since: rule.since, evidence }
}

/** The message of a failure. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Register both tools.
 * @param ctx - the preset scope's context, with `tools` and the Session registry.
 * @param service - reads `ctx.notifyLearning` at call time; undefined when the root row is not mounted.
 */
export function registerRuleTools(ctx: Context, service: () => NotifyLearning | undefined): void {
  const missing = { error: 'the notification-rule learner is not running; tell the owner it is off' }
  ctx.tools.register(defineTool({
    name: 'notify_rules',
    description: 'List the notification rules learned from how the owner reacted to messages you sent on your own, newest first, each with the owner\'s words behind it. Use it when the owner asks what you learned or why you stayed silent about something.',
    parameters: {},
    output: {
      schema: {
        oneOf: [
          { type: 'object', additionalProperties: false, properties: { revision: { type: 'number', required: true }, rules: { type: 'array', required: true, items: RULE_SCHEMA } } },
          ERROR_SCHEMA,
        ],
      },
      render: renderJson,
    },
    async execute() {
      const learner = service()
      if (learner === undefined) return missing
      try {
        const { revision, rules } = await learner.rules()
        return { revision, rules: rules.map(publicRule) }
      } catch (error: unknown) {
        return { error: messageOf(error) }
      }
    },
    presentCall: () => ({ card: 'generic', title: 'List notification rules', kind: 'read' }),
  }))
  ctx.tools.register(defineTool({
    name: 'notify_rules_forget',
    description: 'Delete one learned notification rule by id when the owner asks you to in their own message. In a turn the owner did not start alone it is refused.',
    parameters: {
      id: { type: 'string', required: true, description: 'Id of the rule, as the rules block or notify_rules shows it (r and six hex digits).' },
    },
    output: {
      schema: { oneOf: [{ type: 'object', additionalProperties: false, properties: { forgot: { ...RULE_SCHEMA, required: true } } }, ERROR_SCHEMA] },
      render: renderJson,
    },
    async execute(args, exec) {
      const learner = service()
      if (learner === undefined) return missing
      const session = exec.agent?.session
      const sessions = ctx.get('sessions')
      const origin = session === undefined
        ? undefined
        : turnOrigin(session, { parent: id => sessions?.get(id as SessionId) })
      if (origin?.clean !== true) {
        ctx.logger.warn('notify-learning: notify_rules_forget %s refused in a turn the owner did not start alone (%s)', args.id, origin === undefined ? 'no Session' : describeOrigin(origin))
        return { error: 'only the owner can delete a rule, in their own message: ask them to tell you which one' }
      }
      try {
        const rule = await learner.forget(args.id)
        return rule === undefined ? { error: `no rule has id ${args.id}; notify_rules lists them` } : { forgot: publicRule(rule) }
      } catch (error: unknown) {
        return { error: messageOf(error) }
      }
    },
    presentCall: args => ({ card: 'generic', title: `Delete notification rule ${args.id}`, kind: 'delete', rawInput: args.id }),
  }))
}
