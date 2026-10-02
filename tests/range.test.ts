import { describe, expect, it } from 'vitest'
import type { SnapshotAction } from '../src/browser/session'
import { actionSpace, type ActionSpace } from '../src/decision/action-space'
import { inRange, narrowToRange, rangeOf, rangeReturners, shapeName } from '../src/range'

/**
 * The two halves of the range rule, on their own: which addresses carry a range, and which controls
 * are worth offering once one has been lost. Both are pure functions over an address and a page's
 * own element table, which is why every judgement call in them is pinned here rather than through a
 * run: what a run does with them is the loop's business (see `./loop.test.ts`).
 */

const button = (id: string, node: number, label: string): SnapshotAction => ({ id, kind: 'click', node, label })
const field = (id: string, node: number, label: string): SnapshotAction => ({
  id,
  kind: 'fill',
  node,
  label,
  value: '',
  role: 'textbox',
})

/** The labels of the elements a table offers as choices, in the page's own order. */
function offeredLabels(space: ActionSpace): string[] {
  const offered = new Set<string>()
  for (const group of Object.values(space.targets)) {
    for (const target of Object.keys(group)) offered.add(target.split(':')[0]!)
  }
  return [...offered]
    .sort((a, b) => Number(a) - Number(b))
    .map((index) => space.elements.find((element) => element.index === index)?.label ?? `[${index}]`)
}

describe('the range an address carries', () => {
  it('is the place plus the parameter names, and nothing else', () => {
    expect(rangeOf('https://hotels.test/list?city=1&landmark=58397117')).toEqual({
      where: 'hotels.test/list',
      keys: ['city', 'landmark'],
    })
  })

  it('reads a shape the same way whatever the order, the values or the encoding', () => {
    // Order does not count, the values are not part of it, a repeated name counts once, and a
    // parameter with nothing after its `=` still has a name — which is all this compares.
    expect(rangeOf('https://hotels.test/list?b=1&a=2&b=3')).toEqual({ where: 'hotels.test/list', keys: ['a', 'b'] })
    expect(rangeOf('https://hotels.test/list?a&b=')).toEqual({ where: 'hotels.test/list', keys: ['a', 'b'] })
    expect(rangeOf('https://hotels.test/list?city=1')).toEqual(rangeOf('https://hotels.test/list?city=999'))
  })

  it('does not see the fragment, the scheme, a trailing slash or the host s case', () => {
    // A site that sends the same list over https, from a host written with capitals, at `/list/`
    // rather than `/list`, and with an anchor on the end, has not sent the run anywhere new.
    expect(rangeOf('http://Hotels.Test/list/?city=1#top')).toEqual({
      where: 'hotels.test/list',
      keys: ['city'],
    })
    expect(rangeOf('https://hotels.test/list?city=1#top')).toEqual(rangeOf('https://hotels.test/list?city=1'))
  })

  it('keeps the path s own case, which is part of where the page is', () => {
    expect(rangeOf('https://hotels.test/List?city=1')?.where).toBe('hotels.test/List')
  })

  it('is nothing at all without parameters, or at the front door', () => {
    // The two ways a run is not in a range yet, and the reason the whole rule stays inert until it
    // really meets one: a bare path says nothing about what is being shown, and a home page that
    // carries a tracking parameter is still a home page.
    expect(rangeOf('https://hotels.test/')).toBeNull()
    expect(rangeOf('https://hotels.test')).toBeNull()
    expect(rangeOf('https://hotels.test/list')).toBeNull()
    expect(rangeOf('https://hotels.test/list?')).toBeNull()
    expect(rangeOf('https://hotels.test/?city=1')).toBeNull()
    expect(rangeOf('https://hotels.test/list?=1')).toBeNull()
  })

  it('is still in range when the values change or a parameter is added', () => {
    const shape = rangeOf('https://hotels.test/list?city=1&landmark=58397117')!

    expect(inRange(shape, 'https://hotels.test/list?city=2&landmark=2501722')).toBe(true)
    expect(inRange(shape, 'https://hotels.test/list?city=1&landmark=58397117&page=2')).toBe(true)
    expect(inRange(shape, 'https://hotels.test/list?city=1&landmark=58397117#reviews')).toBe(true)
  })

  it('is out of range when a name is gone, renamed, or the path has moved on', () => {
    const shape = rangeOf('https://hotels.test/list?city=1&landmark=58397117')!

    // The hotel list of the audit: the sort click came back with the whole city's list.
    expect(inRange(shape, 'https://hotels.test/list?city=1')).toBe(false)
    // A name that looks like the one that was pinned and is not it.
    expect(inRange(shape, 'https://hotels.test/list?cityId=1&landmark=58397117')).toBe(false)
    expect(inRange(shape, 'https://hotels.test/results?city=1&landmark=58397117')).toBe(false)
    expect(inRange(shape, 'https://hotels.test/list')).toBe(false)
    expect(inRange(shape, 'https://other.test/list?city=1&landmark=58397117')).toBe(false)
  })

  it('names a shape the way a sentence about it has to read', () => {
    expect(shapeName(rangeOf('https://hotels.test/list?city=1&landmark=58397117')!)).toBe(
      'hotels.test/list（city、landmark）',
    )
  })
})

describe('the controls that could bring a lost range back', () => {
  const list = [
    button('e1', 1, '排序：价格从低到高'),
    field('e2', 2, '目的地'),
    button('e3', 3, 'Search'),
    button('e4', 4, 'Google'),
    button('e5', 5, '返回'),
    button('e6', 6, '重置筛选'),
    button('e7', 7, '清除筛选'),
    button('e8', 8, '加入收藏'),
  ]

  it('keeps what can be typed into, what sits beside it, and what names the way back', () => {
    // The field itself, the button next to it (a magnifier is often labelled by nothing), the search
    // button, and the three controls whose own words mean "reset what is being looked at".
    expect([...rangeReturners(actionSpace(list))].sort()).toEqual(['1', '2', '3', '5', '6', '7'])
  })

  it('matches the Latin words whole, and the Han ones as they are written', () => {
    // `go` inside `Google` is not a search control, and `回` inside `返回` is how it is spelled.
    expect(rangeReturners(actionSpace(list)).has('4')).toBe(false)
    const words = actionSpace([button('e1', 1, 'Go'), button('e2', 2, 'Go back to top')])
    expect([...rangeReturners(words)]).toEqual(['1', '2'])
  })

  it('keeps a Han label that merely contains one of those words', () => {
    // The price of reading Chinese as it is written: `查看地图` is kept because it contains `查`, and
    // `回答问题` because it contains `回`. Erring wide is deliberate — a control kept by mistake
    // costs one candidate, and one dropped by mistake costs the way back — and the floor below means
    // an over-wide pick is the only kind of miss this rule cannot produce.
    const loose = actionSpace([button('e1', 1, '查看地图'), button('e2', 2, '回答问题')])
    expect([...rangeReturners(loose)].sort()).toEqual(['1', '2'])
  })

  it('keeps the submit button beside every field, not only the search box', () => {
    // Which field is a search box cannot be told from the label alone — `请输入目的地` and `写下你的
    // 评论` are the same shape of string — so every typeable control brings its neighbours.
    const form = actionSpace([button('e1', 1, '确定'), field('e2', 2, '写下你的评论'), button('e3', 3, '取消')])
    expect([...rangeReturners(form)].sort()).toEqual(['1', '2', '3'])
  })
})

describe('narrowing a table to those controls', () => {
  const list = [
    button('e1', 1, '排序：价格从低到高'),
    field('e2', 2, '目的地'),
    button('e3', 3, 'Search'),
    button('e4', 4, 'Google'),
    button('e5', 5, '返回'),
    button('e6', 6, '重置筛选'),
    button('e7', 7, '清除筛选'),
    button('e8', 8, '加入收藏'),
  ]

  it('offers the ways back and nothing else, and leaves every entry in place', () => {
    const whole = actionSpace(list)
    const narrowed = narrowToRange(whole, whole, 'Find a hotel', [])

    expect(narrowed.rescued).toBe(false)
    expect(narrowed.picked).toBe(6)
    expect(offeredLabels(narrowed.space)).toEqual([
      '排序：价格从低到高',
      '目的地',
      'Search',
      '返回',
      '重置筛选',
      '清除筛选',
    ])
    // The page's own structure is untouched: only the choices go, which is what `withoutElements`
    // does and why the model still reads the screen from the same table.
    expect(narrowed.space.elements.map((element) => element.label)).toEqual(list.map((action) => action.label))
  })

  it('leaves a page alone when it does not offer more than the floor to begin with', () => {
    // Four elements, two of them ways back: the floor is what the page can offer, four, so the two
    // missing choices are put straight back and the table is the page's own. A run on a page this
    // small is a run this rule has nothing to say about.
    const whole = actionSpace([
      button('e1', 1, '价格从低到高'),
      button('e2', 2, '评分优先'),
      button('e3', 3, '展开筛选'),
      field('e4', 4, '目的地'),
    ])
    const narrowed = narrowToRange(whole, whole, 'Find a hotel', [])

    expect(narrowed.rescued).toBe(true)
    expect(narrowed.picked).toBe(2)
    expect(narrowed.offered).toBe(4)
    expect(offeredLabels(narrowed.space)).toEqual(['价格从低到高', '评分优先', '展开筛选', '目的地'])
  })

  it('meets the floor with the most relevant elements of the page', () => {
    // Two ways back out of eight, so three of the missing six go back in — by the ordering
    // `trimActionSpace` already uses, which is the page's own order once nothing is closer to the
    // goal's words than anything else — and the floor stops it there rather than putting back five.
    const whole = actionSpace([
      button('e1', 1, '价格从低到高'),
      button('e2', 2, '评分优先'),
      button('e3', 3, '加入收藏'),
      button('e4', 4, '分享'),
      button('e5', 5, '地图模式'),
      button('e6', 6, '服务设施'),
      button('e7', 7, '展开筛选'),
      field('e8', 8, '目的地'),
    ])
    const narrowed = narrowToRange(whole, whole, 'Find a hotel', [])

    expect(narrowed.rescued).toBe(true)
    expect(narrowed.picked).toBe(2)
    expect(narrowed.offered).toBe(5)
    expect(offeredLabels(narrowed.space)).toEqual([
      '价格从低到高',
      '评分优先',
      '加入收藏',
      '展开筛选',
      '目的地',
    ])
  })

  it('gives the element the run has just acted on the first place the floor puts back', () => {
    // `trimActionSpace`'s own first rule: whatever the run has just acted on is the first survivor of
    // a cut. The floor inherits it rather than inventing a second idea of relevance, so the element
    // the last step touched comes back and the one that would have taken its place does not.
    const whole = actionSpace([
      button('e1', 1, '价格从低到高'),
      button('e2', 2, '评分优先'),
      button('e3', 3, '加入收藏'),
      button('e4', 4, '分享'),
      button('e5', 5, '地图模式'),
      button('e6', 6, '服务设施'),
      button('e7', 7, '展开筛选'),
      button('e8', 8, '问一问'),
      button('e9', 9, '回到顶部'),
      field('e10', 10, '目的地'),
    ])

    const actedOn = narrowToRange(whole, whole, 'Find a hotel', ['6'])
    const cold = narrowToRange(whole, whole, 'Find a hotel', [])

    expect(offeredLabels(actedOn.space)).toContain('服务设施')
    expect(offeredLabels(actedOn.space)).not.toContain('加入收藏')
    expect(offeredLabels(cold.space)).toContain('加入收藏')
    expect(offeredLabels(cold.space)).not.toContain('服务设施')
  })
})
