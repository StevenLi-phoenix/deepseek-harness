import { describe, expect, it } from 'vitest'
import { keyFromUrl, mixinKey, signQuery } from '../src/wbi.ts'

// The worked example of the bilibili-API-collect WBI page.
const KEYS = { imgKey: '7cd084941338484aae1ad9425b84077c', subKey: '4932caff0ff746eab6f01bf08b70ac45' }

describe('WBI signing', () => {
  it('derives the documented mixin key', () => {
    expect(mixinKey(KEYS)).toBe('ea1db124af3c7062474693fa704f4ff8')
  })

  it('signs the documented vector', () => {
    expect(signQuery({ foo: '114', bar: '514', zab: 1919810 }, KEYS, 1702204169))
      .toBe('bar=514&foo=114&wts=1702204169&zab=1919810&w_rid=8f6f2b5b3d485fe1886cec6a0be8c5d4')
  })

  it('drops the filtered characters and percent-encodes the rest', () => {
    const signed = signQuery({ keyword: "it's (a) test*!", page: 1 }, KEYS, 1)
    expect(signed.startsWith('keyword=its%20a%20test&page=1&wts=1&w_rid=')).toBe(true)
  })

  it('reads the key from a wbi_img URL', () => {
    expect(keyFromUrl('https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png')).toBe(KEYS.imgKey)
    expect(keyFromUrl('https://i0.hdslb.com/bfs/wbi/')).toBeUndefined()
    expect(keyFromUrl(42)).toBeUndefined()
  })
})
