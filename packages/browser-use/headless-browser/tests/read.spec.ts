/**
 * What one read returns from a page: the page's text cut into character
 * windows, a header naming the window, and a clear failure when a named
 * selector matches nothing or when the document has no body yet.
 */

import { describe, expect, it } from 'vitest'
import { DEFAULT_READ_LIMIT, MAX_READ_FRAMES, MAX_READ_LIMIT, readText, SelectorMissError, type FrameRef, type ReadPage } from '../src/read.ts'

interface FakePage extends ReadPage {
  /** Selectors the read asked for, in order. */
  readonly asked: (string | undefined)[]
}

/** A page reporting one text; `missing` makes every read report nothing, as a body-less document does. */
function pageWith(text: string, options: { missing?: boolean; url?: string } = {}): FakePage {
  const asked: (string | undefined)[] = []
  return {
    asked,
    url: () => options.url ?? 'https://example.com/assignments',
    async innerText(selector) {
      asked.push(selector)
      return options.missing === true ? undefined : text
    },
  }
}

/** A page whose document has no body, so even a whole-page read reports nothing. */
function bodyless(): FakePage {
  return pageWith('', { missing: true })
}

describe('reading page text', () => {
  it('reads the whole body with no selector and one header line', async () => {
    const page = pageWith('第一行 作业\n第二行 作业')
    const result = await readText(page, 't1', {})
    expect(page.asked).toEqual([undefined])
    expect(result).toMatchObject({ text: '第一行 作业\n第二行 作业', total: 13 })
    expect(result.header).toBe('text of t1 (https://example.com/assignments): page 1 of 1, characters 1-13 of 13')
    expect(result.nextOffset).toBeUndefined()
  })

  it('cuts a long text into the default page and carries the next offset', async () => {
    const text = 'x'.repeat(DEFAULT_READ_LIMIT + 1200)
    const result = await readText(pageWith(text), 't1', {})
    expect(result.text).toHaveLength(DEFAULT_READ_LIMIT)
    expect(result.total).toBe(DEFAULT_READ_LIMIT + 1200)
    expect(result.header).toContain(`page 1 of 2, characters 1-${DEFAULT_READ_LIMIT} of ${DEFAULT_READ_LIMIT + 1200}`)
    expect(result.nextOffset).toBe(DEFAULT_READ_LIMIT)
    const next = await readText(pageWith(text), 't1', { offset: DEFAULT_READ_LIMIT })
    expect(next.text).toHaveLength(1200)
    expect(next.header).toContain(`page 2 of 2, characters ${DEFAULT_READ_LIMIT + 1}-${DEFAULT_READ_LIMIT + 1200}`)
    expect(next.nextOffset).toBeUndefined()
  })

  it('answers the exact window at both ends of the text and never runs past it', async () => {
    const page = pageWith('0123456789')
    expect(await readText(page, 't1', { offset: 2, limit: 4 })).toMatchObject({ text: '2345', total: 10, nextOffset: 6 })
    expect(await readText(page, 't1', { offset: 8, limit: 4 })).toMatchObject({ text: '89', total: 10 })
    const atEnd = await readText(page, 't1', { offset: 10, limit: 4 })
    expect(atEnd.text).toBe('')
    expect(atEnd.header).toBe('text of t1 (https://example.com/assignments): page 3 of 3, the text has 10 characters')
    expect(atEnd.nextOffset).toBeUndefined()
    expect(await readText(page, 't1', { offset: 99, limit: 4 })).toEqual(atEnd)
  })

  it('clamps a negative offset and an out-of-range limit into the supported window', async () => {
    expect((await readText(pageWith('abcdef'), 't1', { offset: -5, limit: 2 })).text).toBe('ab')
    expect((await readText(pageWith('abcdef'), 't1', { limit: MAX_READ_LIMIT * 5 })).text).toBe('abcdef')
    const long = 'y'.repeat(MAX_READ_LIMIT + 5)
    expect((await readText(pageWith(long), 't1', { limit: MAX_READ_LIMIT * 2 })).text).toHaveLength(MAX_READ_LIMIT)
    // A zero or negative limit still makes progress, so paging cannot stand still.
    expect((await readText(pageWith('abcdef'), 't1', { limit: 0 })).text).toBe('a')
    expect((await readText(pageWith('abcdef'), 't1', { limit: -3 })).text).toBe('a')
  })

  it('counts and cuts in characters, so a surrogate pair never splits', async () => {
    const page = pageWith('中文😀abc')
    const whole = await readText(page, 't1', {})
    expect(whole.total).toBe(6)
    const first = await readText(page, 't1', { offset: 0, limit: 3 })
    expect(first.text).toBe('中文😀')
    expect(first.nextOffset).toBe(3)
    expect(await readText(page, 't1', { offset: 2, limit: 2 })).toMatchObject({ text: '😀a', nextOffset: 4 })
    expect(await readText(page, 't1', { offset: 5, limit: 2 })).toMatchObject({ text: 'c', total: 6 })
    // A one-character window lands on each character whole, never on half a pair.
    const characters = ['中', '文', '😀', 'a', 'b', 'c']
    for (const [offset, character] of characters.entries()) {
      expect((await readText(page, 't1', { offset, limit: 1 })).text).toBe(character)
    }
  })

  it('reads one element when a selector names it', async () => {
    const page = pageWith('2026-11-20 作文')
    const result = await readText(page, 't2', { selector: '#rows', limit: 4 })
    expect(page.asked).toEqual(['#rows'])
    expect(result).toMatchObject({ text: '2026', total: 13, nextOffset: 4 })
    expect(result.header).toContain('text of t2 (https://example.com/assignments)')
  })

  it('fails with the selector when nothing matches it', async () => {
    const page = pageWith('unused', { missing: true })
    const failure = await readText(page, 't1', { selector: '#missing' }).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(SelectorMissError)
    expect((failure as SelectorMissError).message)
      .toBe('no element matches #missing; check the selector or read the whole page')
  })

  it('keeps a long URL out of the way in the header', async () => {
    const url = `data:text/html;charset=utf-8,${'a'.repeat(400)}`
    const result = await readText(pageWith('rows', { url }), 't1', {})
    expect(result.header.startsWith('text of t1 (data:text/html;charset=utf-8,')).toBe(true)
    expect(result.header).toContain('…): page 1 of 1')
    expect(result.header.length).toBeLessThan(200)
    const short = await readText(pageWith('rows', { url: 'https://example.com/a' }), 't1', {})
    expect(short.header).toBe('text of t1 (https://example.com/a): page 1 of 1, characters 1-4 of 4')
  })

  it('reports an empty page rather than a missing element when the body is empty', async () => {
    const result = await readText(bodyless(), 't1', {})
    expect(result).toMatchObject({ text: '', total: 0 })
    expect(result.header).toBe('text of t1 (https://example.com/assignments): the page has no text')
    expect(result.nextOffset).toBeUndefined()
  })

  it('lists the embedded pages big enough for a form on a whole-page read only', async () => {
    const frames: FrameRef[] = [
      { url: 'https://careers-acme.icims.com/jobs/1/login?in_iframe=1', width: 1264, height: 500 },
      { url: 'https://ads.example.com/pixel', width: 1, height: 1 },
    ]
    const page: ReadPage = { url: () => 'https://jobs.acme.com/jobs/1', innerText: async () => 'Skip Branding', frames: async () => frames }
    expect((await readText(page, 't1', {})).frames).toEqual([frames[0]])
    expect((await readText(page, 't1', { selector: 'main' })).frames).toBeUndefined()
    const many: ReadPage = { ...page, frames: async () => Array.from({ length: 9 }, (_, index) => ({ url: `https://a.example/${String(index)}`, width: 600, height: 400 })) }
    expect((await readText(many, 't1', {})).frames).toHaveLength(MAX_READ_FRAMES)
    expect((await readText(pageWith('text'), 't1', {})).frames).toBeUndefined()
  })
})
