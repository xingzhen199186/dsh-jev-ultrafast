import { describe, expect, it } from 'vitest'
import { findUrl, normalizeUrl } from '../src/urls'

/**
 * The address inside a sentence, found without a model.
 *
 * Every case here decides whether a typed command starts a run or asks a question instead, so
 * the shapes people actually write are what is pinned: the address first, last, in the middle,
 * wearing Chinese punctuation, or written bare as `example.com`.
 */
describe('finding the address in a sentence', () => {
  it('finds a full address wherever it stands', () => {
    expect(findUrl('https://a.test/x 看看价格')).toEqual({
      url: 'https://a.test/x',
      before: '',
      after: ' 看看价格',
    })
    expect(findUrl('帮我打开 https://a.test/x')).toEqual({
      url: 'https://a.test/x',
      before: '帮我打开 ',
      after: '',
    })
    expect(findUrl('到 https://a.test/x，价格是多少')).toEqual({
      url: 'https://a.test/x',
      before: '到 ',
      after: '，价格是多少',
    })
  })

  it('leaves punctuation that only ends the sentence out of the address', () => {
    expect(findUrl('看 https://a.test/x。')?.url).toBe('https://a.test/x')
    expect(findUrl('看 https://a.test/x,')?.url).toBe('https://a.test/x')
  })

  it('accepts a bare domain and gives it a scheme', () => {
    expect(findUrl('example.com')?.url).toBe('https://example.com')
    expect(findUrl('打开example.com看看')?.url).toBe('https://example.com')
    expect(findUrl('打开 example.com/a?b=1 看看')?.url).toBe('https://example.com/a?b=1')
  })

  it('does not mistake other dotted text for a site', () => {
    expect(findUrl('看看是不是 3.5 折')).toBeNull()
    expect(findUrl('明天10.30开会')).toBeNull()
    expect(findUrl('找到价格并说明是多少')).toBeNull()
  })
})

describe('tightening one reported address', () => {
  it('adds a missing scheme and drops wrapping punctuation', () => {
    expect(normalizeUrl('example.com')).toBe('https://example.com')
    expect(normalizeUrl('  https://a.test/x ')).toBe('https://a.test/x')
    expect(normalizeUrl('"https://a.test/x"')).toBe('https://a.test/x')
    expect(normalizeUrl('HTTP://a.test/x')).toBe('HTTP://a.test/x')
  })

  it('refuses anything that is not a real-looking site', () => {
    expect(normalizeUrl('')).toBeNull()
    expect(normalizeUrl('百度')).toBeNull()
    expect(normalizeUrl('首页')).toBeNull()
    expect(normalizeUrl('https://')).toBeNull()
    expect(normalizeUrl('https://a b')).toBeNull()
  })
})
