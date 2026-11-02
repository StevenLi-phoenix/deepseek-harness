/**
 * What a box says about itself: the tone of its service's overview card, its name, and its one-line job. Pure lookups over the
 * overview's cards and the dictionary, so the box, the detail card, and the lists of neighbours read the same words.
 */

import type { ServiceCard, Tone } from '../views.ts'
import type { Translate } from './format.ts'
import type { FlowNode } from './flow-model.ts'

/** What a box shows: its service's tone, `off` while nothing is read, `none` for a box nobody probes. */
export type BoxTone = Tone | 'none'

/** The overview's cards by service id. */
export type Cards = ReadonlyMap<string, ServiceCard>

/**
 * The tone a box is drawn in.
 * @param node - the box.
 * @param cards - the overview's cards.
 * @returns the card's tone, `off` when the card has not been read, `none` when the box has no service.
 */
export function toneOf(node: FlowNode, cards: Cards): BoxTone {
  if (node.service === undefined) return 'none'
  return cards.get(node.service)?.tone ?? 'off'
}

/**
 * The card a box shows a status line from. Only a box with a service of its own has one; boxes inside the event service would
 * all repeat "running".
 * @param node - the box.
 * @param cards - the overview's cards.
 * @returns the card, or undefined.
 */
export function ownCard(node: FlowNode, cards: Cards): ServiceCard | undefined {
  return node.service === undefined || node.service === 'dsh' ? undefined : cards.get(node.service)
}

/**
 * The name of a box: its own title, else the dictionary's.
 * @param node - the box.
 * @param t - the translator.
 * @returns the name.
 */
export function titleOf(node: FlowNode, t: Translate): string {
  return node.title ?? t(`flow.node.${node.id}` as never)
}

/**
 * What a box does, in a sentence. A box with a title of its own has none.
 * @param node - the box.
 * @param t - the translator.
 * @returns the sentence, or undefined.
 */
export function noteOf(node: FlowNode, t: Translate): string | undefined {
  return node.title === undefined ? t(`flow.node.${node.id}.desc` as never) : undefined
}
