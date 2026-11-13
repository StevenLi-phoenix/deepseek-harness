/**
 * The Claude Code and voice settings section. Claude Code: whether the service account is signed in (file existence only), its
 * live sessions, a stop button for the ones this page's bridge started (asks twice), and a form to start one with a first task.
 * Voice: whether speech and transcription answer, and a preview button that plays one fixed sentence in the browser. The
 * transcription switch is configuration, so it is shown read-only with the patch that turns it on.
 */

import { useEffect, useId, useState, type ReactNode } from 'react'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the settings shell's SlotMap merge (the 'settings.section' entry).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: registers the event-console locale namespace this component's `t` reads.
import type {} from './locales.ts'
import { MAX_TASK_CHARS, type ActionErrorCode, type AgentsAction, type AgentsView, type CcView, type VoiceView } from '../views.ts'
import { ago, clock, type Translate } from './format.ts'
import { POLL_INTERVAL_MS, startPolling, type ResourceState } from './resource.ts'
import css from './Console.module.css'

/** The patch that turns transcription on; a code literal, not copy. */
export const ASR_PATCH = '- id: voice\n  config: { asr: { enabled: true } }'

const NAME = /^[a-z0-9][a-z0-9-]{0,30}$/u

/** How a preview ended. */
export type PreviewOutcome = { readonly ok: true } | { readonly ok: false; readonly code: ActionErrorCode | 'network'; readonly detail?: string | undefined }

/** The section's injected face (slot `inject`). */
export interface AgentsInjected {
  hooks: {
    /** The shared Claude Code and voice store. */
    agents: ObservableSnapshot<ResourceState<AgentsView>>
  }
  /** One refresh; a request in flight is shared. */
  refresh: () => void
  /** One change; resolves true when the Host accepted it. */
  act: (request: AgentsAction) => Promise<boolean>
  /** Clear the notice. */
  dismiss: () => void
  /** Synthesize and play the preview; `onPlaying` fires when sound starts, and the promise settles when it ends or fails. */
  preview: (onPlaying: () => void) => Promise<PreviewOutcome>
  /** Stop a preview that is playing. */
  stopPreview: () => void
}

/** Props delivered by the settings shell. */
export type AgentsProps = PropsRuntime<'settings.section'> & InjectFace<AgentsInjected> & PropsLocale<'event-console'>

function Pill({ tone, children }: { tone: 'ok' | 'warn' | 'down'; children: ReactNode }): ReactNode {
  return <span className={css.pill} data-tone={tone}>{children}</span>
}

function SessionRow({ session, now, t, busy, onStop }: {
  session: CcView['sessions'][number]
  now: number
  t: Translate
  busy: boolean
  onStop: () => void
}): ReactNode {
  const [asking, setAsking] = useState(false)
  const meta = [
    t('agents.cc.pid', { pid: session.pid }),
    session.status === null ? null : t('agents.cc.status', { status: session.status }),
    session.updatedAt === null ? null : ago(session.updatedAt, now, t),
    session.cwd,
  ].filter(entry => entry !== null)
  return (
    <div className={css.row} data-session={session.name} data-busy={busy ? '' : undefined}>
      <div className={css.rowMain}>
        <span className={css.rowTitle}>{session.name}</span>
        <span className={css.meta}>{meta.join(' · ')}</span>
        {session.managed ? null : <span className={css.meta}>{t('agents.cc.external')}</span>}
      </div>
      {session.managed
        ? (
          <div className={css.rowActions}>
            {asking
              ? (
                <span className={css.confirm} role="alertdialog" aria-label={t('agents.cc.stopConfirm', { name: session.name })}>
                  <span>{t('agents.cc.stopConfirm', { name: session.name })}</span>
                  <button type="button" className={css.button} data-kind="danger" onClick={() => { setAsking(false); onStop() }}>{t('agents.cc.stop')}</button>
                  <button type="button" className={css.button} onClick={() => { setAsking(false) }}>{t('common.cancel')}</button>
                </span>
              )
              : <button type="button" className={css.button} data-kind="danger" disabled={busy} onClick={() => { setAsking(true) }}>{t('agents.cc.stop')}</button>}
          </div>
        )
        : null}
    </div>
  )
}

function StartForm({ cc, busy, t, onStart }: {
  cc: CcView
  busy: boolean
  t: Translate
  onStart: (name: string, task: string) => Promise<boolean>
}): ReactNode {
  const nameId = useId()
  const taskId = useId()
  const [name, setName] = useState('')
  const [task, setTask] = useState('')
  const [problem, setProblem] = useState<'name' | 'task' | null>(null)
  const full = cc.started.length >= cc.maxSessions
  const submit = (): void => {
    const found = !NAME.test(name) ? 'name' : task.length > MAX_TASK_CHARS ? 'task' : null
    setProblem(found)
    if (found !== null) return
    void onStart(name, task.trim()).then((accepted) => { if (accepted) { setName(''); setTask('') } })
  }
  return (
    <form className={css.form} onSubmit={(event) => { event.preventDefault(); submit() }} noValidate>
      <div className={css.field}>
        <label className={css.label} htmlFor={nameId}>{t('agents.cc.name')}</label>
        <input id={nameId} className={css.input} aria-invalid={problem === 'name'} value={name} autoComplete="off" onChange={(event) => { setName(event.target.value) }} />
        {problem === 'name' ? <span className={css.fieldError} role="alert">{t('agents.cc.err.name')}</span> : null}
      </div>
      <div className={css.field}>
        <label className={css.label} htmlFor={taskId}>{t('agents.cc.task')}</label>
        <textarea id={taskId} className={css.textarea} aria-invalid={problem === 'task'} value={task} onChange={(event) => { setTask(event.target.value) }} />
        {problem === 'task' ? <span className={css.fieldError} role="alert">{t('agents.cc.err.task')}</span> : null}
      </div>
      <div className={css.formActions}>
        <span className={css.hint}>{t('agents.cc.limit', { max: cc.maxSessions, started: cc.started.length })}</span>
        <button type="submit" className={css.button} data-kind="primary" disabled={busy || full}>
          {busy ? t('agents.cc.starting') : t('agents.cc.start')}
        </button>
      </div>
    </form>
  )
}

function ClaudeCodeCard({ cc, now, t, state, act }: { cc: CcView; now: number; t: Translate; state: ResourceState<AgentsView>; act: AgentsInjected['act'] }): ReactNode {
  const loginTone = cc.login === 'full' ? 'ok' : cc.login === 'token' ? 'warn' : 'down'
  return (
    <>
      <div className={css.heading}>
        <span className={css.headingTitle}>{t('agents.cc.title')}</span>
        <Pill tone={loginTone}>{t(`fact.login.${cc.login}`)}</Pill>
      </div>
      <span className={css.hint}>{t('agents.cc.hint')}</span>
      <span className={css.hint}>{t(`agents.cc.login.${cc.login}`)}</span>
      <div className={css.rows}>
        {cc.sessions.length === 0 ? <div className={css.empty}>{t('agents.cc.empty')}</div> : null}
        {cc.sessions.map(session => (
          <SessionRow
            key={`${session.name}-${session.pid}`} session={session} now={now} t={t} busy={state.busy[`cc.stop:${session.name}`] === true}
            onStop={() => { void act({ action: 'cc.stop', name: session.name }) }}
          />
        ))}
      </div>
      <StartForm
        cc={cc} t={t} busy={Object.keys(state.busy).some(key => key.startsWith('cc.start:'))}
        onStart={(name, task) => act({ action: 'cc.start', name, ...task === '' ? {} : { task } })}
      />
    </>
  )
}

function Reach({ enabled, up, t }: { enabled: boolean; up: boolean | null; t: Translate }): ReactNode {
  if (!enabled) return <Pill tone="warn">{t('agents.voice.offState')}</Pill>
  return up === true ? <Pill tone="ok">{t('agents.voice.up')}</Pill> : <Pill tone="down">{t('agents.voice.down')}</Pill>
}

function VoiceCard({ voice, t, preview, stopPreview }: { voice: VoiceView; t: Translate; preview: AgentsInjected['preview']; stopPreview: () => void }): ReactNode {
  const [phase, setPhase] = useState<'idle' | 'loading' | 'playing'>('idle')
  const [failure, setFailure] = useState<Extract<PreviewOutcome, { ok: false }> | null>(null)
  useEffect(() => stopPreview, [stopPreview])
  const play = (): void => {
    setFailure(null)
    setPhase('loading')
    void preview(() => { setPhase('playing') }).then((outcome) => {
      setPhase('idle')
      if (!outcome.ok) setFailure(outcome)
    })
  }
  return (
    <>
      <div className={css.heading}>
        <span className={css.headingTitle}>{t('agents.voice.title')}</span>
      </div>
      <div className={css.rows}>
        <div className={css.row}>
          <div className={css.rowMain}>
            <span className={css.rowTitle}>{t('agents.voice.tts')}</span>
            <span className={css.meta}>{t('agents.voice.ttsLine', { provider: voice.provider, format: voice.format })}</span>
          </div>
          <div className={css.rowActions}>
            <Reach enabled={voice.ttsEnabled} up={voice.ttsUp} t={t} />
            <button type="button" className={css.button} disabled={!voice.ttsEnabled || phase !== 'idle'} onClick={play}>
              {phase === 'loading' ? t('agents.voice.previewing') : phase === 'playing' ? t('agents.voice.playing') : t('agents.voice.preview')}
            </button>
          </div>
        </div>
        <div className={css.row}>
          <div className={css.rowMain}>
            <span className={css.rowTitle}>{t('agents.voice.asr')}</span>
            <span className={css.meta}>{voice.asrEnabled ? voice.engine : t('agents.voice.offState')}</span>
          </div>
          <div className={css.rowActions}>
            <Reach enabled={voice.asrEnabled} up={voice.asrUp} t={t} />
          </div>
        </div>
      </div>
      {failure === null
        ? null
        : <div className={css.notice} role="alert"><span>{t(`error.${failure.code}`)}{failure.detail === undefined ? '' : ` (${failure.detail})`}</span></div>}
      <span className={css.hint}>{t('agents.voice.previewHint', { chars: voice.previewChars })}</span>
      {voice.asrEnabled
        ? null
        : (
          <>
            <span className={css.hint}>{t('agents.voice.asrHint')}</span>
            <code className={css.code}>{ASR_PATCH}</code>
          </>
        )}
    </>
  )
}

/**
 * Render the Claude Code and voice section.
 * @param props - the store hook, callbacks, and copy.
 * @returns the section.
 */
export function AgentsSection({ useAgents, refresh, act, dismiss, preview, stopPreview, t }: AgentsProps): ReactNode {
  const state = useAgents(value => value)
  useEffect(() => startPolling(refresh, POLL_INTERVAL_MS), [refresh])

  const translate = t as Translate
  const view = state.data
  const tone = state.checkedAt === null ? 'loading' : state.stale ? 'stale' : 'live'
  const text = state.checkedAt === null
    ? translate('status.loading')
    : view === null
      ? translate('status.failed')
      : state.stale ? translate('status.stale', { time: clock(view.checkedAt) }) : translate('status.live', { time: clock(view.checkedAt) })
  const failure = state.notice
  return (
    <section className={css.section} aria-label={translate('title.agents')} data-stale={state.stale ? '' : undefined}>
      <div className={css.header}>
        <span className={css.status} role="status">
          <span className={css.dot} data-tone={tone} aria-hidden="true" />
          {text}
        </span>
      </div>
      {failure === null
        ? null
        : (
          <div className={css.notice} role="alert">
            <span>{translate(`error.${failure.code}`)}{failure.detail === undefined ? '' : ` (${failure.detail})`}</span>
            <button type="button" className={css.button} onClick={dismiss}>{translate('common.dismiss')}</button>
          </div>
        )}
      {view === null
        ? null
        : (
          <>
            {view.cc === null
              ? <><div className={css.heading}><span className={css.headingTitle}>{translate('agents.cc.title')}</span></div><div className={css.rows}><div className={css.empty}>{translate('agents.cc.off')}</div></div></>
              : <ClaudeCodeCard cc={view.cc} now={state.checkedAt ?? 0} t={translate} state={state} act={act} />}
            {view.voice === null
              ? <><div className={css.heading}><span className={css.headingTitle}>{translate('agents.voice.title')}</span></div><div className={css.rows}><div className={css.empty}>{translate('agents.voice.off')}</div></div></>
              : <VoiceCard voice={view.voice} t={translate} preview={preview} stopPreview={stopPreview} />}
          </>
        )}
    </section>
  )
}
