/**
 * The header control that replaces the upstream hover catalog: a plain button that says how many
 * subagents run ("1 个在跑") or how many exist (an icon and a number), and opens the Sidebar page.
 * Both counts cover the whole tree, nested subagents included. It never opens a menu.
 */
import { useMemo } from 'react'
import { IconUsersOutlineRegular, StateDot, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import { NO_COUNTS, catalogOf, indexTree, totalOf, type PanelSources } from './model.ts'
import css from './SubagentToggle.module.css'

/** Business action the registration supplies. */
export interface ToggleInjected {
  /** Show the Sidebar page of this Session, or hide the Sidebar when the page is already in front. */
  toggle: (sessionId: SessionId) => void
}

/** Full props of the header control. */
export type SubagentToggleProps =
  PropsRuntime<'conversation.session.header.actions'> & InjectFace<ToggleInjected> & PropsLocale<'fork.subagents'>

/**
 * The header control of a root Session; child Sessions keep the upstream breadcrumb switcher.
 * @param props - Session standard props, the toggle action, and the translator.
 * @returns the control, or nothing without subagents.
 */
export function SubagentToggle(props: SubagentToggleProps) {
  const addressedChild = props.useSession(snapshot => snapshot.subagent !== null)
  const listedChild = props.useSessions(state => state.byId[props.sessionId]?.origin === 'subagent')
  if (addressedChild || listedChild) return null
  return <RootToggle {...props} />
}

/** Count the whole subagent tree and draw the button. */
function RootToggle({ sessionId, useSessions, useSessionStatus, toggle, t }: SubagentToggleProps) {
  const projections = useSessions(state => state.projectionsBySession)
  const summaries = useSessions(state => state.byId)
  const statuses = useSessionStatus(value => value)
  const sources = useMemo<PanelSources>(() => ({ projections, summaries, statuses }), [projections, summaries, statuses])
  const catalog = catalogOf(sources, sessionId)
  const counts = useMemo(() => indexTree(sources, sessionId).below.get(sessionId) ?? NO_COUNTS, [sources, sessionId])
  const total = totalOf(counts)
  if (total === 0 && catalog.state !== 'error') return null
  const running = counts.running
  const label = running > 0
    ? t('toggle.aria.running', { count: running, total })
    : t('toggle.aria.idle', { total })
  return (
    <Tooltip label={label} delayMs={500} portal side="bottom">
      <button
        type="button"
        className={css.toggle}
        data-running={running > 0 || undefined}
        aria-label={label}
        data-fork-subagents-toggle=""
        onClick={() => { toggle(sessionId) }}
      >
        <span className={css.glyph} aria-hidden>
          {running > 0 ? <StateDot state="ongoing" /> : <IconUsersOutlineRegular size={14} />}
        </span>
        <span className={css.text}>{running > 0 ? t('toggle.running', { count: running }) : t('toggle.idle', { count: total })}</span>
      </button>
    </Tooltip>
  )
}
