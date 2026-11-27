/** What the learner writes: the rules block the model reads, and the owner's notice of a change. */

import type { Decision, Evidence, Rule } from './records.ts'

const OPEN = '<system-reminder>'
const CLOSE = '</system-reminder>'

/** The block's first line names its revision, so a Session that shows the current block is not given it again. */
export const REVISION_TAG = /^<system-reminder>\nNotification rules, revision (\d+):/u

/** What each decision tells the model to do. */
const DECISION_TEXT: Readonly<Record<Decision, string>> = {
  tell: 'tell the owner; do not drop it as routine',
  brief: 'tell the owner in one short sentence',
  silent: 'answer NO_REPLY unless it needs the owner to act',
}

/** Each decision in the owner's words. */
const DECISION_ZH: Readonly<Record<Decision, string>> = {
  tell: '照常告诉你',
  brief: '一句话带过',
  silent: '不用告诉你',
}

/** Text that cannot close the block early. */
function inert(text: string): string {
  return text.replaceAll(CLOSE, '<\\/system-reminder>')
}

/**
 * The rules block for a turn a notice, reminder, watch, monitor, or another Session started.
 * @param revision - the rules' revision.
 * @param rules - the rules, newest first.
 * @param tools - whether the Session has `notify_rules` and `notify_rules_forget`.
 * @returns the block; undefined when there is no rule.
 */
export function renderRulesBlock(revision: number, rules: readonly Rule[], tools: boolean): string | undefined {
  if (rules.length === 0) return undefined
  return [
    OPEN,
    `Notification rules, revision ${String(revision)}: learned from how the owner reacted to earlier messages you sent on your own. Apply them whenever a notice, reminder, watch, monitor, or another Session (not the owner) starts a turn and you decide what the owner hears; a later block replaces this one.`,
    ...rules.map(rule => `- (${rule.id}) ${inert(rule.kind)} → ${rule.decision}: ${DECISION_TEXT[rule.decision]}`),
    'Each rule comes from the owner\'s own words in at least two separate exchanges. No rule silences a warning about money, security, an account, or a deadline within a day: tell those.',
    ...tools ? ['notify_rules shows the owner\'s words behind each rule; notify_rules_forget deletes one when the owner asks in their own message.'] : [],
    CLOSE,
  ].join('\n')
}

/** `11/27「这种别发了」`, in the owner's zone. */
function quoted(item: Evidence, timeZone: string): string {
  const day = new Intl.DateTimeFormat('en-US', { timeZone, month: 'numeric', day: 'numeric' }).format(new Date(item.at))
  return `${day}「${item.quote}」`
}

/** One rule as the owner reads it. */
function ruleLine(rule: Rule, timeZone: string): string {
  return `「${rule.kind}」→ ${DECISION_ZH[rule.decision]}（${rule.evidence.map(item => quoted(item, timeZone)).join('、')}）`
}

/**
 * The owner's notice of what a pass, or the owner's own deletion, changed.
 * @param added - rules learned.
 * @param removed - rules replaced, dropped by the cap, or deleted.
 * @param timeZone - zone of the quotes' days.
 * @returns the title and body; undefined when nothing changed.
 */
export function changeNotice(
  added: readonly Rule[], removed: readonly Rule[], timeZone: string,
): { title: string; body: string } | undefined {
  if (added.length === 0 && removed.length === 0) return undefined
  const replaced = new Set(added.map(rule => rule.kind.toLowerCase()))
  const lines = [
    ...added.map(rule => `新规则：${ruleLine(rule, timeZone)}`),
    ...removed.filter(rule => !replaced.has(rule.kind.toLowerCase())).map(rule => `不再用：「${rule.kind}」→ ${DECISION_ZH[rule.decision]}`),
  ]
  return {
    title: '主动消息的规则有变化',
    body: `${lines.join('\n')}\n\n这是从你对我主动发的消息的回复里学到的。不对的话直接说删掉哪条。`,
  }
}
