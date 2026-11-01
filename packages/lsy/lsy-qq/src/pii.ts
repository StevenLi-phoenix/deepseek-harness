/**
 * The filter for a group note: the QQ channel's own memory of what a group talks about. A note describes the group
 * (its topics, slang, mood), never a person, so anything that points at an individual is refused with a reason the
 * model can act on. The filter is conservative on purpose: a refused note costs one rewrite, a kept one is a leak.
 */

/** Longest note, in characters. */
export const MAX_NOTE_CHARS = 40

/** Words that name a school or an organisation. */
const ORGANISATION = /(大学|学院|学校|中学|小学|高中|初中|研究所|研究院|实验室|有限公司|股份|集团|公司|医院|银行|事务所)/
/** A province, a city district, a numbered street, or a building. */
const ADDRESS = /[一-龥]{2,}(省|自治区|特别行政区)|[一-龥]{2,}市[一-龥]{1,}(区|县)|[一-龥]{1,}(路|街|道|巷|弄|大街)(\d|[一二三四五六七八九十百]+号)|小区|公寓|宿舍|[一-龥]+(栋|号楼)/
const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/
/** Five or more digits in a row: a QQ number, a phone number, an ID. */
const LONG_NUMBER = /\d{5,}/

/** The verdict on one note. */
export type NoteVerdict = { ok: true; text: string } | { ok: false; reason: string }

/**
 * Check a note before it is stored.
 * @param text - what the model wants to remember.
 * @param memberNames - names and cards the group's members showed; a note naming one is refused.
 * @returns the cleaned note, or why it was refused.
 */
export function checkNote(text: string, memberNames: readonly string[]): NoteVerdict {
  const note = text.trim()
  if (note === '') return { ok: false, reason: 'the note is empty' }
  if (/[\r\n]/.test(note)) return { ok: false, reason: 'a note is one line' }
  if (Array.from(note).length > MAX_NOTE_CHARS) return { ok: false, reason: `a note is at most ${MAX_NOTE_CHARS} characters` }
  if (LONG_NUMBER.test(note)) return { ok: false, reason: 'it contains a long number (a QQ or phone number); notes describe the group, not people' }
  if (EMAIL.test(note)) return { ok: false, reason: 'it contains an email address' }
  if (note.includes('@')) return { ok: false, reason: 'it mentions someone with @; notes describe the group, not people' }
  if (note.includes('群友#')) return { ok: false, reason: 'it names a member alias; notes describe the group, not people' }
  if (ADDRESS.test(note)) return { ok: false, reason: 'it looks like an address or a place a person lives' }
  if (ORGANISATION.test(note)) return { ok: false, reason: 'it names a school or an organisation' }
  const named = memberNames.find(name => Array.from(name).length >= 2 && note.includes(name))
  if (named !== undefined) return { ok: false, reason: 'it contains the name of a member of the group; notes describe the group, not people' }
  return { ok: true, text: note }
}
