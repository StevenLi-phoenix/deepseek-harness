import { describe, expect, it } from 'vitest'
import { LINK, LONG_NUMBER, luhn, MENTION, PATTERN_RULES, scanPatterns } from '../src/patterns.ts'

const rule = (text: string, blockLinks = true): string | undefined => scanPatterns(text, { blockLinks })?.rule

describe('scanPatterns', () => {
  it.each([
    ['联系我 13812345678 谢谢', 'pattern.phone'],
    ['call +86 138-1234-5678', 'pattern.phone'],
    ['reach me at (415) 555-2671 today', 'pattern.phone'],
    ['mail me: someone@example.com', 'pattern.email'],
    ['写信给 someone ＠ example 。 com', 'pattern.email'],
    ['身份证 11010519491231002X', 'pattern.id_number'],
    ['4111 1111 1111 1111', 'pattern.bank_card'],
    ['4012 8888 8888 1881', 'pattern.bank_card'],
    ['群号 123456', 'pattern.long_number'],
    ['他的 uid 是 ８８８８８８', 'pattern.long_number'],
    ['问一下 @某某 吧', 'pattern.mention'],
    ['QQ: abc1234', 'pattern.contact'],
    ['加我微信 wx_abcd', 'pattern.contact'],
    ['打开 https://example.com/a?access_token=abcdef0123456789', 'pattern.url_token'],
    ['住在北京市海淀区', 'pattern.address'],
    ['住在中关村大街12号', 'pattern.address'],
    ['lives at 221 Baker Street', 'pattern.address'],
    ['文件在 /Users/someone/notes.txt', 'pattern.os_path'],
    ['看看 bilibili.com 上的视频', 'pattern.link'],
    ['BV1xx411c7mD', 'pattern.link'],
  ])('refuses %j as %s', (text, expected) => {
    expect(rule(text)).toBe(expected)
  })

  it('lets links through when blockLinks is off, but not a link with a token', () => {
    expect(rule('看看 bilibili.com 上的视频', false)).toBeUndefined()
    expect(rule('打开 https://example.com/a?token=abcdef0123456789', false)).toBe('pattern.url_token')
  })

  it.each([
    "傲娇猫娘，嘴硬心软，句尾爱带'喵'，被夸会否认",
    '今天聊了 QQ 群里的梗，大家都在玩游戏',
    'We talk about the QQ group chats and memes',
    '我知道1个办法，2026 年了',
    '4111 1111 1111 1112 is not a card number',
  ])('passes %j', (text) => {
    // The last sample fails Luhn but is a 16-digit run, so it still trips long_number: asserted separately below.
    if (text.startsWith('4111')) expect(rule(text)).toBe('pattern.long_number')
    else expect(rule(text)).toBeUndefined()
  })

  it('exports the shared regular expressions and the rule names in trial order', () => {
    expect(LINK.test('www.example.org')).toBe(true)
    expect(MENTION.test('a＠b')).toBe(true)
    expect(LONG_NUMBER.test('12345')).toBe(true)
    expect(LONG_NUMBER.test('1234')).toBe(false)
    expect(PATTERN_RULES[0]).toBe('pattern.email')
    expect(PATTERN_RULES.at(-1)).toBe('pattern.link')
  })

  it('checks Luhn', () => {
    expect(luhn('4111111111111111')).toBe(true)
    expect(luhn('4111111111111112')).toBe(false)
    expect(luhn('4012888888881881')).toBe(true)
  })

  it('never puts the match in the reason', () => {
    const hit = scanPatterns('call 13812345678', { blockLinks: true })
    expect(hit?.publicReason).not.toContain('138')
  })
})
