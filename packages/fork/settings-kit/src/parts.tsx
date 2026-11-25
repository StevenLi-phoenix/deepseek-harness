/**
 * The markup the fork's Settings sections share. Each part takes the calling section's own CSS module, so every
 * section keeps its stylesheet; the class names each part reads are listed on it. No part carries copy of its own.
 */

import { useId, type ComponentPropsWithoutRef, type ReactNode } from 'react'
import type { StatusKey, StatusLine } from './status.ts'

/** A section's compiled CSS module: class name to hashed class. */
export type SectionClasses = Readonly<Record<string, string>>

/**
 * The status line at the head of a section: the dot in the line's tone and its text, then `children`.
 * @param props - the section's classes (`header`, `status`, `dot`), the line, and what follows it in the header.
 * @returns the header.
 */
export function StatusHeader({ css, line, children }: { css: SectionClasses; line: StatusLine; children?: ReactNode }): ReactNode {
  return (
    <div className={css.header}>
      <span className={css.status} role="status">
        <span className={css.dot} data-tone={line.tone} aria-hidden="true" />
        {line.text}
      </span>
      {children}
    </div>
  )
}

/**
 * A titled card, labelled by its title.
 * @param props - the section's classes (`card`, `cardHeader`, `cardTitle`, `meta`), the title, an optional note beside it,
 *   classes that replace `card` on the card itself, the body, and any other attribute of the card element.
 * @returns the card.
 */
export function Card({ css, title, meta, className, children, ...attributes }: {
  css: SectionClasses
  title: string
  meta?: string | undefined
  className?: string | undefined
  children: ReactNode
} & Omit<ComponentPropsWithoutRef<'section'>, 'aria-labelledby' | 'children' | 'className' | 'title'>): ReactNode {
  const id = useId()
  return (
    <section {...attributes} className={className ?? css.card} aria-labelledby={id}>
      <div className={css.cardHeader}>
        <span id={id} className={css.cardTitle}>{title}</span>
        {meta === undefined ? null : <span className={css.meta}>{meta}</span>}
      </div>
      {children}
    </section>
  )
}

/**
 * A section before its first answer: the loading line, or the failed line once a read failed, then `children`.
 * @param props - the section's classes (`section`, `status`), its label, whether the last read failed, translate, and
 *   what follows the line (such as the All settings card).
 * @returns the section.
 */
export function PendingSection({ css, label, stale, t, children }: {
  css: SectionClasses
  label: string
  stale: boolean
  t: (key: Extract<StatusKey, 'status.failed' | 'status.loading'>) => string
  children?: ReactNode
}): ReactNode {
  return (
    <section className={css.section} aria-label={label}>
      <span className={css.status} role="status">{stale ? t('status.failed') : t('status.loading')}</span>
      {children}
    </section>
  )
}
