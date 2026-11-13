/**
 * Pieces the Memory section's cards share: the translate seat, time and id formatting, and the small
 * layout components. All text from the Host is rendered as text, never as markup.
 */

import { useId, type ReactNode } from 'react'
import type { MemoryKey } from './locales.ts'
import css from './Memory.module.css'

/** The translate seat every card formats with. */
export type Translate = (key: MemoryKey, params?: Record<string, string | number>) => string

/** Characters of a Session id the page shows. */
const SESSION_SHOWN = 8

/**
 * A Session id short enough to read.
 * @param id - full Session id.
 */
export function shortSession(id: string): string {
  return id.length > SESSION_SHOWN ? id.slice(0, SESSION_SHOWN) : id
}

/**
 * A history or waiting-write time in the viewer's locale and zone.
 * @param iso - ISO time, or a date.
 */
export function when(iso: string): string {
  const time = new Date(iso)
  return Number.isNaN(time.getTime())
    ? iso
    : time.toLocaleString(undefined, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

/** One titled card. */
export function Card({ title, meta, children, id }: { title: string; meta?: string; children: ReactNode; id?: string }): ReactNode {
  const heading = useId()
  return (
    <section className={css.card} aria-labelledby={heading} {...id === undefined ? {} : { 'data-card': id }}>
      <div className={css.cardHeader}>
        <span id={heading} className={css.cardTitle}>{title}</span>
        {meta === undefined ? null : <span className={css.meta}>{meta}</span>}
      </div>
      {children}
    </section>
  )
}

/** A small label; `warn` marks something that needs the owner's attention. */
export function Tag({ children, tone }: { children: ReactNode; tone?: 'warn' | 'good' | 'bad' | undefined }): ReactNode {
  return <span className={css.tag} data-tone={tone}>{children}</span>
}

/** A button; `busy` shows the action is in flight without moving the layout. */
export function Button(props: {
  children: ReactNode
  onClick: () => void
  kind?: 'primary' | 'danger' | 'quiet'
  disabled?: boolean
  busy?: boolean
  pressed?: boolean
  label?: string
}): ReactNode {
  const { children, onClick, kind = 'quiet', disabled = false, busy = false, pressed, label } = props
  return (
    <button
      type="button"
      className={css.button}
      data-kind={kind}
      data-busy={busy ? '' : undefined}
      disabled={disabled || busy}
      aria-pressed={pressed}
      aria-label={label}
      onClick={onClick}
    >
      {children}
    </button>
  )
}
