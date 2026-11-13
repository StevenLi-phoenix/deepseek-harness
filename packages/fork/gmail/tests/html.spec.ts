import { describe, expect, it } from 'vitest'
import { decodeEntities, htmlToText, tidy } from '../src/html.ts'

const MAX = 100_000

describe('HTML entities', () => {
  it('decodes named entities in any case, decimal and hexadecimal references, and leaves unknown names as written', () => {
    expect(decodeEntities('Tom &amp; Jerry &LT;3&gt; &quot;hi&quot; &hellip;&nbsp;&euro;5')).toBe('Tom & Jerry <3> "hi" … €5')
    expect(decodeEntities('&#65;&#x42;&#X43; &#128512;')).toBe('ABC 😀')
    expect(decodeEntities('&bogus; &amp')).toBe('&bogus; &amp')
  })

  it('drops a reference to NUL, a surrogate, or a code point past U+10FFFF', () => {
    expect(decodeEntities('a&#0;b&#xD800;c&#x110000;d')).toBe('abcd')
  })
})

describe('HTML to text', () => {
  it('drops script, style, head, title, and comments with everything inside, in any case', () => {
    const html = '<HTML><Head><Title>Secret title</Title></Head><body><p>Hello</p><SCRIPT type="x">alert(1)</SCRIPT>'
      + '<style>p { color: red }</style><!-- hidden note --><p>World</p><noscript>nojs</noscript><template>t</template></body></HTML>'
    expect(htmlToText(html, MAX)).toBe('Hello\n\nWorld')
  })

  it('keeps an element whose name only starts like a dropped one, and drops the rest after an unclosed block or comment', () => {
    expect(htmlToText('<scripture>Psalm</scripture> <p>kept</p>', MAX)).toBe('Psalm\nkept')
    expect(htmlToText('<p>before</p><style>a{}', MAX)).toBe('before')
    expect(htmlToText('<p>before</p><script>x()</script', MAX)).toBe('before')
    expect(htmlToText('<p>before</p><script', MAX)).toBe('before')
    expect(htmlToText('<p>before</p><!-- never closed <p>after</p>', MAX)).toBe('before')
  })

  it('writes a link\'s address after its text unless the text already is the address', () => {
    const html = '<a href="https://example.com/a?x=1&amp;y=2">the docs</a> · <a href=\'https://example.com/b\'>https://example.com/b</a>'
      + ' · <a href=mailto:ada@example.com>ada@example.com</a> · <a href="mailto:ada@example.com">mailto:ada@example.com</a>'
    expect(htmlToText(html, MAX)).toBe('the docs (https://example.com/a?x=1&y=2) · https://example.com/b · ada@example.com · mailto:ada@example.com')
  })

  it('drops the address of a link that is not http(s) or mailto, and of an anchor without href', () => {
    expect(htmlToText('<a href="javascript:steal()">click</a> <a name="top">top</a> <a href="  ">blank</a>', MAX)).toBe('click top blank')
  })

  it('writes an image\'s alt text in brackets and nothing for an image without one', () => {
    expect(htmlToText('<img src="a.png" alt="Logo &amp; name"><img alt=\'chart\' /><img src="b.png"></img><img alt="  ">', MAX)).toBe('[Logo & name][chart]')
  })

  it('breaks lines at block elements, bullets list items, and spaces table cells', () => {
    const html = '<div>Agenda<br>Items:<ul><li>One</li><li>Two</li></ul></div><table><tr><td>a</td><td>b</td></tr><tr><th>c</th></tr></table>'
    expect(htmlToText(html, MAX)).toBe('Agenda\nItems:\n\n- One\n\n- Two\n\na b\n\nc')
  })

  it('skips markup that is not an element, and stops at a tag that never closes', () => {
    expect(htmlToText('<!DOCTYPE html><? xml ?>1 < 2 and <3>', MAX)).toBe('1')
    expect(htmlToText('plain text &amp; no tags', MAX)).toBe('plain text & no tags')
    expect(htmlToText('<p>kept</p><p unclosed', MAX)).toBe('kept')
  })

  it('reads at most maxInputChars of the source', () => {
    expect(htmlToText(`<p>${'a'.repeat(50)}</p><p>tail</p>`, 20)).toBe('a'.repeat(17))
  })
})

describe('whitespace', () => {
  it('collapses spaces, trims lines, keeps at most one blank line, and joins CRLF and CR line ends', () => {
    expect(tidy('  a \t  b  \r\n\r\n\r\n\r\nc\rd  e  \n\n')).toBe('a b\n\nc\nd e')
  })
})
