/**
 * The System status settings section: four cards over the Host's latest
 * snapshot (CPU, Memory, Power, and a full-width Storage card with one bar per
 * volume). It polls while mounted, which the settings shell does only while
 * the section is the open one, and pauses while the page is hidden. A failed
 * refresh keeps the last reading and says so quietly in the status line.
 */

import { Card, startPolling, StatusHeader } from '@deepseek-ai/dsh-settings-kit/client'
import { useEffect, type ReactNode } from 'react'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsLocale, PropsRenderFactories, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the settings shell's SlotMap merge (the 'settings.section' entry).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: declares the 'settings.plugin-config' factory this section renders at its foot.
import type {} from '@deepseek-ai/dsh-plugin-config/client'
// Type-only: registers the sysmon locale namespace this component's `t` reads.
import type {} from './locales.ts'
import {
  INSTALL_MACMON, cpuCard, formatDuration, memoryCard, powerCard, statusLine, storageRows, type Meter, type Translate,
} from './cards.ts'
import { POLL_INTERVAL_MS, type SysmonState } from './sysmon.ts'
import css from './SystemStatus.module.css'

/** The section's injected face (slot `inject`). */
export interface SystemStatusInjected {
  hooks: {
    /** The shared system status store. */
    sysmon: ObservableSnapshot<SysmonState>
  }
  /** One refresh; a request in flight is shared. */
  refresh: () => void
}

/** The plugin entries whose every setting the page lists under the status cards. */
const CONFIG_ENTRIES = ['sysmon'] as const

/** Props delivered by the settings shell. */
export type SystemStatusProps = PropsRuntime<'settings.section'> & InjectFace<SystemStatusInjected> & PropsLocale<'sysmon'>
  & Partial<PropsRenderFactories>

const LEVEL_CLASS = { normal: '', warn: css.warn, critical: css.critical } as const

function Bar({ meter, label }: { meter: Meter | null; label: string }): ReactNode {
  const percent = meter === null ? 0 : Math.round(meter.ratio * 100)
  return (
    <span className={css.track} role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
      {meter === null ? null : <span className={[css.fill, LEVEL_CLASS[meter.level]].filter(Boolean).join(' ')} style={{ width: `${percent}%` }} />}
    </span>
  )
}

function Details({ lines }: { lines: readonly string[] }): ReactNode {
  return lines.length === 0 ? null : <div className={css.details}>{lines.map(line => <span key={line}>{line}</span>)}</div>
}

/**
 * Render the System status section.
 * @param props - the store hook, refresh callback, and copy.
 * @returns the section.
 */
export function SystemStatusSection({ useSysmon, refresh, renderFactorySlot, t }: SystemStatusProps): ReactNode {
  const state = useSysmon(value => value)
  useEffect(() => startPolling(refresh, POLL_INTERVAL_MS), [refresh])

  const translate = t as Translate
  const status = statusLine(state, translate)
  const { snapshot } = state
  const cpu = snapshot === null ? undefined : cpuCard(snapshot, translate)
  const memory = snapshot === null ? undefined : memoryCard(snapshot, translate)
  const power = snapshot === null ? undefined : powerCard(snapshot, translate)
  const disks = snapshot === null ? [] : storageRows(snapshot, translate)
  return (
    <section className={css.section} aria-label={translate('title')} data-stale={state.stale ? '' : undefined}>
      <StatusHeader css={css} line={status}>
        {snapshot === null ? null : <span className={css.uptime}>{translate('uptime', { duration: formatDuration(snapshot.uptime, translate) })}</span>}
      </StatusHeader>
      {cpu === undefined || memory === undefined || power === undefined
        ? null
        : (
          <div className={css.grid}>
            <Card css={css} title={translate('cpu.title')} meta={cpu.cores}>
              <span className={css.value}>{cpu.value}</span>
              <Bar meter={cpu.meter} label={translate('cpu.title')} />
              <Details lines={cpu.details} />
            </Card>
            <Card css={css} title={translate('memory.title')}>
              <span className={css.value}>
                {memory.value}
                <span className={css.unit}>{memory.total}</span>
              </span>
              <Bar meter={memory.meter} label={translate('memory.title')} />
              <Details lines={memory.details} />
            </Card>
            <Card css={css} title={translate('power.title')} {...power.value === null ? {} : { meta: translate('power.system') }}>
              {power.value === null ? null : <span className={css.value}>{power.value}</span>}
              {power.notice === null
                ? null
                : (
                  <div className={css.notice} data-notice={power.notice.kind}>
                    <span>{power.notice.text}</span>
                    {power.notice.kind === 'missing' ? <code className={css.command}>{INSTALL_MACMON}</code> : null}
                  </div>
                )}
              <Details lines={power.details} />
            </Card>
            {disks.length === 0
              ? null
              : (
                <Card css={css} className={`${css.card} ${css.wide}`} title={translate('storage.title')}>
                  {disks.map(row => (
                    <div key={row.key} className={css.volume} data-mount={row.mount}>
                      <div className={css.volumeHeader}>
                        <span className={css.volumeName}>
                          {row.label}
                          <span className={css.mount}>{row.mount}</span>
                        </span>
                        <span className={css.percent}>{row.percent}</span>
                      </div>
                      {row.meter === null ? null : <Bar meter={row.meter} label={row.label} />}
                      <Details lines={row.details} />
                    </div>
                  ))}
                </Card>
              )}
          </div>
        )}
      {renderFactorySlot?.('settings.plugin-config', { entries: CONFIG_ENTRIES })}
    </section>
  )
}
