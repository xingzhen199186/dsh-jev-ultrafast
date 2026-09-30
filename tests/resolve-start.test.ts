import { describe, expect, it } from 'vitest'

/**
 * Where a sentence with no address in it starts.
 *
 * This reads the sentence and nothing else: the names it knows, or a search engine. It used to ask
 * the text model first, which is why the tests here no longer mock one — there is no call to mock,
 * and that is the point (a settings problem can no longer cost a reader their run).
 */

const { namedSite, resolveStart, SEARCH_START } = await import('../src/resolve-start')

describe('reading the starting point out of a sentence', () => {
  it('keeps the reader’s own sentence as the goal and only picks the address', () => {
    expect(resolveStart('  查一下明天北京的天气  ')).toEqual({
      url: SEARCH_START,
      goal: '查一下明天北京的天气',
    })
  })

  it('reads a site the sentence names itself', () => {
    expect(namedSite('百度一下人生副本')).toBe('https://www.baidu.com')
    expect(namedSite('上知乎看看这个问题')).toBe('https://www.zhihu.com')
    expect(namedSite('B站搜一下这个视频')).toBe('https://www.bilibili.com')
    expect(namedSite('查一下明天北京的天气')).toBeNull()
    expect(resolveStart('百度一下人生副本')).toEqual({
      url: 'https://www.baidu.com',
      goal: '百度一下人生副本',
    })
  })

  it('starts at a search engine when the sentence names no site', () => {
    expect(resolveStart('把那件事办了')).toEqual({ url: SEARCH_START, goal: '把那件事办了' })
  })
})
