import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import type { PageState, SnapshotAction } from '../src/browser/session'
import { SNAPSHOT_SOURCE, SNAPSHOT_SOURCE_PLAIN } from '../src/browser/snapshot'
import { actionSpace, trimActionSpace } from '../src/decision/action-space'
import { requestChars } from '../src/decision/typesafe'
import { MAX_ELEMENTS, MAX_REQUEST_CHARS } from '../src/prompts'

/**
 * The elements a page makes clickable with its own script: the second half of the candidate pool,
 * the switch that turns it off, and the four filters every one of them has to pass.
 *
 * The page is declared rather than parsed. This suite runs in node, which has no DOM, so the fake
 * below is a small stand-in for one — and unlike `tests/choices.test.ts`, which asks the real
 * selector string and lets the fake answer it, the native half of the pool here is declared outright
 * (`control: true`): this file is about the deep scan, and the query that finds native controls is
 * already the subject of its own suite. What is *not* stubbed is the script: the same
 * `SNAPSHOT_SOURCE` the browser gets is run through `new Function` against these globals, so the
 * filters, the ordering, the cap and the switch are exercised as written.
 *
 * Two things the fake cannot stand in for, and which only a real browser can settle:
 *  - `getEventListeners` is a console API the debugger injects into one evaluation. Here it is a
 *    stub over the declared listener names, so what is tested is *what the script asks it* and what
 *    it does with the answer, not the browser's own listener map.
 *  - every box is placed by hand, so nothing here tests layout, style resolution or hit testing.
 *    The four filters are tested as arithmetic over rectangles, which is what they are.
 */

interface Box {
  x: number
  y: number
  w: number
  h: number
}

/** A row of the list, 600×40 at the given height: the shape a hotel result row really has. */
const row = (y: number): Box => ({ x: 10, y, w: 600, h: 40 })

interface Spec {
  tag: string
  attrs?: Record<string, string>
  text?: string
  children?: Spec[]
  box?: Box
  /** The page's own computed style says this node, and its subtree, is not shown. */
  hidden?: boolean
  disabled?: boolean
  /** Fields the script reads as properties rather than attributes, for the input in the fixture. */
  value?: string
  readOnly?: boolean
  /** Declared, not parsed: the native control query answers with this node. */
  control?: boolean
  /** Listener names `getEventListeners` reports for this node, when the console API is there. */
  listeners?: string[]
  /**
   * A props object as React leaves it on the element it rendered — `__reactProps$<key>`, or
   * `__reactEventHandlers$<key>` on the older runtime. `onClick` unless the test says otherwise.
   */
  react?: { key?: string; props?: Record<string, unknown> }
}

interface FakeNode {
  nodeType: 1
  tagName: string
  type?: string
  value?: string
  readOnly?: boolean
  isConnected: boolean
  parentElement: FakeNode | null
  childNodes: Array<FakeNode | TextNode>
  innerText: string
  labels: readonly unknown[]
  /** What the console API reports, when it is there; empty for a node with no listeners. */
  bound: Record<string, unknown[]>
  control: boolean
  getAttribute: (name: string) => string | null
  matches: (selector: string) => boolean
  closest: (selector: string) => FakeNode | null
  checkVisibility: (options?: unknown) => boolean
  getBoundingClientRect: () => {
    x: number
    y: number
    width: number
    height: number
    top: number
    bottom: number
    left: number
    right: number
  }
}

interface TextNode {
  nodeType: 3
  textContent: string
}

interface Snapshot {
  text: string
  actions: SnapshotAction[]
  omitted_actions: number
  nested: { frames: number; shadow_roots: number; elements: number }
}

let built: FakeNode[] = []

function build(spec: Spec, parent: FakeNode | null, inheritedHidden = false): FakeNode {
  const attrs = spec.attrs ?? {}
  const box = spec.box ?? { x: 0, y: 0, w: 0, h: 0 }
  const off = inheritedHidden || spec.hidden === true
  const node: FakeNode = {
    nodeType: 1,
    tagName: spec.tag.toUpperCase(),
    isConnected: true,
    parentElement: parent,
    childNodes: [],
    innerText: spec.text ?? '',
    labels: [],
    bound: Object.fromEntries((spec.listeners ?? []).map((name) => [name, [() => {}]])),
    control: spec.control === true,
    getAttribute: (name) => (name in attrs ? attrs[name]! : null),
    // The only pseudo-class the script asks the page about, and the only two attributes it walks
    // ancestors for; the rest of the selector machinery belongs to the native-control suite.
    matches: (selector) => (selector === ':disabled' ? spec.disabled === true : false),
    closest: (selector) => {
      for (let at: FakeNode | null = node; at; at = at.parentElement) {
        const value = (name: string): string | null => at!.getAttribute(name)
        if (selector.includes('[aria-disabled="true"]') && value('aria-disabled') === 'true') return at
        if (selector.includes('[aria-hidden="true"]') && value('aria-hidden') === 'true') return at
        if (selector.includes('[inert]') && value('inert') !== null) return at
      }
      return null
    },
    checkVisibility: () => !off,
    getBoundingClientRect: () => ({
      x: box.x,
      y: box.y,
      width: box.w,
      height: box.h,
      top: box.y,
      bottom: box.y + box.h,
      left: box.x,
      right: box.x + box.w,
    }),
  }
  if (attrs.type !== undefined) node.type = attrs.type
  if (spec.value !== undefined) node.value = spec.value
  if (spec.readOnly !== undefined) node.readOnly = spec.readOnly
  if (spec.react) {
    // Exactly what the requirement asks a fixture to imitate: the props object React 17+ leaves on
    // the element, under the key its own runtime minted.
    const key = spec.react.key ?? '__reactProps$probe'
    ;(node as unknown as Record<string, unknown>)[key] = spec.react.props ?? { onClick() {} }
  }
  if (spec.text !== undefined) node.childNodes.push({ nodeType: 3, textContent: spec.text })
  // Pushed before its children, so the fake's `*` query answers in document order the way the real
  // one does — the deep scan's own order, and the order the cap is applied in, depend on it.
  built.push(node)
  for (const child of spec.children ?? []) node.childNodes.push(build(child, node, off))
  return node
}

/**
 * Run the real in-page script over one declared page.
 *
 * `consoleApi` stands in for `includeCommandLineAPI` on the evaluation: with it, `getEventListeners`
 * is in scope, and each fake node answers with the listeners its spec declares. `deep: false` runs
 * the variant the setting picks when the switch is off.
 */
function page(spec: Spec, options: { deep?: boolean; consoleApi?: boolean } = {}): Snapshot {
  built = []
  const root = build(spec, null)
  const fields = built.filter((node) => ['INPUT', 'TEXTAREA', 'SELECT'].includes(node.tagName))
  const document = {
    body: root,
    title: '酒店列表 · 测试页',
    documentElement: { scrollHeight: 780 },
    getElementById: () => null,
    querySelectorAll: (selector: string) => {
      if (selector === '*') return built
      if (selector === 'input,textarea,select') return fields
      // The native control query is declared, and every other structural query in the script is
      // about frames or shadow roots, which this page has none of.
      return selector === 'iframe' ? [] : built.filter((node) => node.control)
    },
    createTreeWalker: () => ({ nextNode: () => null }),
    createRange: () => ({
      selectNodeContents: () => {},
      getBoundingClientRect: () => ({ width: 0, height: 0, top: 0, bottom: 0, left: 0, right: 0 }),
    }),
  }
  vi.stubGlobal('document', document)
  vi.stubGlobal('window', {})
  vi.stubGlobal('NodeFilter', { SHOW_TEXT: 4, SHOW_ELEMENT: 1 })
  vi.stubGlobal('location', { href: 'https://hotels.test/list' })
  vi.stubGlobal('innerWidth', 1120)
  vi.stubGlobal('innerHeight', 780)
  vi.stubGlobal('scrollX', 0)
  vi.stubGlobal('scrollY', 0)
  vi.stubGlobal('getEventListeners', options.consoleApi ? (el: FakeNode) => el.bound : undefined)
  const source = options.deep === false ? SNAPSHOT_SOURCE_PLAIN : SNAPSHOT_SOURCE
  return new Function(`return ${source}`)() as Snapshot
}

/** The element-level half of a snapshot: everything the page itself offered, without the two synthetic actions. */
const offered = (state: Snapshot): SnapshotAction[] => state.actions.filter((action) => action.node !== undefined)

/**
 * The measured page, in one fixture: three native controls and every clue the deep scan knows,
 * each with the filter that is supposed to stop it next to the one that is supposed to let it in.
 */
const PAGE: Spec = {
  tag: 'body',
  box: { x: 0, y: 0, w: 1120, h: 780 },
  // The measured false positive: a page's own BODY is the size of the viewport and really does
  // answer that it responds to clicks.
  listeners: ['click'],
  text: '酒店列表',
  children: [
    { tag: 'button', control: true, box: { x: 10, y: 10, w: 80, h: 30 }, text: '搜索' },
    {
      tag: 'input',
      control: true,
      attrs: { type: 'text', placeholder: '目的地' },
      value: '',
      readOnly: false,
      box: { x: 100, y: 10, w: 200, h: 30 },
    },
    { tag: 'a', control: true, attrs: { href: '#' }, box: { x: 320, y: 10, w: 60, h: 30 }, text: '登录' },
    // 1. the props React left on the element, which is how a React 17+ row is seen
    { tag: 'div', box: row(60), text: '酒店 A', react: {} },
    // 2. a listener of the page's own
    { tag: 'div', box: row(120), text: '酒店 B', listeners: ['click'] },
    // ...including one that only `getEventListeners` can see: pointerdown is a click in every way
    // that matters, and `isClickable` itself answers false for it.
    { tag: 'div', box: row(180), text: '酒店 C', listeners: ['pointerdown'] },
    // and its opposite: a handler that is not a click at all
    { tag: 'div', box: row(240), text: '酒店 D', listeners: ['mouseover'] },
    // 3. an inline handler, the clue that still works without the console API
    { tag: 'div', box: row(300), text: '酒店 E', attrs: { onclick: 'go()' } },
    // the three filters that are not the listener test: not shown, not on screen, no name
    { tag: 'div', box: row(360), text: '酒店 F', listeners: ['click'], hidden: true },
    { tag: 'div', box: { x: 10, y: -40, w: 600, h: 40 }, text: '酒店 G', listeners: ['click'] },
    { tag: 'div', box: row(420), listeners: ['click'] },
    {
      // a clickable card holding a real control is left to that control, as a gridcell holding a
      // button already is
      tag: 'div',
      box: row(480),
      text: '预订',
      listeners: ['click'],
      children: [{ tag: 'a', control: true, attrs: { href: '#' }, box: row(480), text: '立即预订' }],
    },
    {
      // two guessed levels nested: the outer one is kept, and the click on it reaches both
      tag: 'div',
      box: row(540),
      text: '外层',
      listeners: ['click'],
      children: [{ tag: 'div', box: { x: 10, y: 540, w: 300, h: 40 }, text: '内层', listeners: ['click'] }],
    },
  ],
}

describe('elements a page made clickable with its own script', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('offers the native controls first and the guessed ones after them, in page order', () => {
    const state = page(PAGE, { consoleApi: true })
    const space = actionSpace(state.actions)

    expect(space.elements.map((element) => element.label)).toEqual([
      '搜索',
      '输入框',
      '登录',
      '立即预订',
      '酒店 A',
      '酒店 B',
      '酒店 C',
      '酒店 E',
      '外层 内层',
    ])
    // The confirmed block keeps the numbering it always had; the guesses take the tail. That is
    // what makes an unstable guessed row unable to renumber a native control.
    expect(space.elements.map((element) => element.index)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9'])
    const guesses = offered(state).filter((action) => action.guess !== undefined)
    expect(guesses.map((action) => [action.label, action.guess])).toEqual([
      ['酒店 A', 'react0'],
      ['酒店 B', 'listener'],
      ['酒店 C', 'listener'],
      ['酒店 E', 'inline'],
      ['外层 内层', 'listener'],
    ])
    // Every guessed entry is a click and nothing more: nothing about a plain element says it takes
    // text, and the table does not offer what it has not seen.
    expect(guesses.every((action) => action.kind === 'click')).toBe(true)
    expect(space.targets.TYPE_TEXT?.['5']).toBeUndefined()
  })

  it('names a field by what it is when the page gave it only an advertisement', () => {
    // The measured failure: bilibili's search box, whose placeholder was the promoted query
    // 「罗小黑战记二」. Named by it, the table offered 「Open 罗小黑战记二」, the model read that as a
    // page to open, chose it ten times over any real target, and the run stopped. The identity
    // word stands in for the advertisement — and a field the page really did name keeps that name.
    const state = page({
      tag: 'body',
      box: { x: 0, y: 0, w: 1120, h: 780 },
      children: [
        {
          tag: 'input',
          control: true,
          attrs: { type: 'text', placeholder: '罗小黑战记二' },
          value: '',
          readOnly: false,
          box: { x: 10, y: 10, w: 200, h: 30 },
        },
        {
          tag: 'input',
          control: true,
          attrs: { type: 'search', placeholder: '罗小黑战记二' },
          value: '',
          readOnly: false,
          box: { x: 220, y: 10, w: 200, h: 30 },
        },
        {
          tag: 'input',
          control: true,
          attrs: { type: 'text', placeholder: '罗小黑战记二', 'aria-label': '站内搜索' },
          value: '',
          readOnly: false,
          box: { x: 430, y: 10, w: 200, h: 30 },
        },
      ],
    })
    const fields = offered(state).filter((action) => action.kind === 'fill').map((action) => action.label)
    expect(fields).toEqual(['输入框', '搜索框', '站内搜索'])
    // The click and the keys ride the same name, so no action form of the advertisement survives.
    const opens = offered(state)
      .filter((action) => action.kind === 'click')
      .map((action) => action.label)
    expect(opens).toEqual(['Open 输入框', 'Open 搜索框', 'Open 站内搜索'])
    expect(offered(state).some((action) => action.label.includes('罗小黑战记二'))).toBe(false)
  })

  it('leaves out everything the four filters exist to leave out', () => {
    const state = page(PAGE, { consoleApi: true })
    const labels = offered(state).map((action) => action.label)

    // (1) not shown — and it really does carry a click listener
    expect(labels).not.toContain('酒店 F')
    // (2) its centre is above the viewport
    expect(labels).not.toContain('酒店 G')
    // (3) nothing to call it by
    expect(labels).not.toContain('')
    // (4) the element is the whole viewport, which is what the measured BODY false positive was
    expect(state.nested.elements).toBe(offered(state).length)
    expect(state.actions.some((action) => action.label.startsWith('酒店列表'))).toBe(false)
    // and a handler that is not a click is not a click
    expect(labels).not.toContain('酒店 D')
  })

  it('judges the viewport and whole-screen tests at their boundaries, not near them', () => {
    const state = page(
      {
        tag: 'body',
        box: { x: 0, y: 0, w: 1120, h: 780 },
        children: [
          // centre at (0, 0) exactly: kept, because only a centre *outside* the viewport is dropped
          { tag: 'div', box: { x: -50, y: -50, w: 100, h: 100 }, text: '角上', listeners: ['click'] },
          // centre at x = 1120 exactly: dropped, the same way a native control is
          { tag: 'div', box: { x: 1100, y: 100, w: 40, h: 40 }, text: '越过右边', listeners: ['click'] },
          // 1120×615 = 78.8% of the viewport: kept — only 80% and above is a whole screen
          { tag: 'div', box: { x: 0, y: 0, w: 1120, h: 615 }, text: '七成九', listeners: ['click'] },
          // 1120×640 = 82.0%: dropped
          { tag: 'div', box: { x: 0, y: 0, w: 1120, h: 640 }, text: '八成二', listeners: ['click'] },
        ],
      },
      { consoleApi: true },
    )

    expect(offered(state).map((action) => action.label)).toEqual(['角上', '七成九'])
  })

  it('keeps one entry per target when a guessed element wraps a control, or another guess', () => {
    const state = page(PAGE, { consoleApi: true })
    const labels = offered(state).map((action) => action.label)

    // The card's own anchor is the control; the card around it adds nothing a click could reach.
    expect(labels.filter((label) => label.includes('立即预订'))).toEqual(['立即预订'])
    expect(labels.some((label) => label.startsWith('预订'))).toBe(false)
    // Two guesses nested the other way round: the outer one is offered once — named with the words
    // inside it, which is what the page's own naming rule does — and the inner one not at all.
    expect(labels.filter((label) => label.startsWith('外层'))).toEqual(['外层 内层'])
    expect(labels).not.toContain('内层')
  })

  it('offers a node the native query already found exactly once', () => {
    const withListener = (spec: Spec): Spec => ({
      ...spec,
      text: '重复搜索',
      listeners: ['click'],
    })
    const state = page({
      tag: 'body',
      box: { x: 0, y: 0, w: 1120, h: 780 },
      children: [withListener({ tag: 'button', control: true, box: { x: 10, y: 10, w: 80, h: 30 }, text: '搜索' })],
    })

    const entries = offered(state).filter((action) => action.label === '重复搜索')
    expect(entries).toHaveLength(1)
    expect(entries[0]!.guess).toBeUndefined()
  })

  it('caps the guessed pool, so a screen full of clickable rows cannot take the table over', () => {
    const state = page(
      {
        tag: 'body',
        box: { x: 0, y: 0, w: 1120, h: 780 },
        children: Array.from({ length: 20 }, (_unused, index) => ({
          tag: 'div',
          box: { x: 10, y: 10 + index, w: 200, h: 8 },
          text: `可选 ${index + 1}`,
          listeners: ['click'],
        })),
      },
      { consoleApi: true },
    )
    const guesses = offered(state).filter((action) => action.guess !== undefined)

    // Twelve again: twenty candidates are on the page and the pool takes the first twelve it walks
    // into. Six starved a late-page target on 2026-10-04 — bilibili's 排行榜 sidebar sat at guess
    // #11, unreachable — while the request's own ceiling stays guarded by the loop's measured fit,
    // which the caps test below pins.
    expect(guesses).toHaveLength(12)
    expect(guesses.map((action) => action.label)).toEqual(
      Array.from({ length: 12 }, (_unused, index) => `可选 ${index + 1}`),
    )
  })

  it('finds a React handler on the element, and only within three levels above it', () => {
    const under = (wrappers: number, text: string): Spec => {
      let spec: Spec = { tag: 'div', box: row(60 + wrappers * 80), text, listeners: [] }
      for (let at = 0; at < wrappers; at += 1) spec = { tag: 'div', children: [spec] }
      return spec
    }
    const state = page(
      {
        tag: 'body',
        box: { x: 0, y: 0, w: 1120, h: 780 },
        children: [
          // the props on the element itself, under the older runtime's spelling of the same key
          { tag: 'div', box: row(60), text: '自身属性', react: { key: '__reactEventHandlers$probe' } },
          // two elements between the row and its handler: the walk reaches it
          { tag: 'div', react: {}, children: [under(2, '三层之上')] },
          // three between: one level too far, so nothing is offered
          { tag: 'div', react: {}, children: [under(3, '四层之上')] },
          // props that carry no click at all
          { tag: 'div', react: { props: { onFocus() {} } }, children: [under(0, '只有聚焦')] },
        ],
      },
      { consoleApi: true },
    )
    const guesses = offered(state).filter((action) => action.guess !== undefined)

    expect(guesses.map((action) => [action.label, action.guess])).toEqual([
      ['自身属性', 'react0'],
      ['三层之上', 'react3'],
    ])
  })

  it('falls back to the markup when the console API is not there, and still says pointerdown counts', () => {
    // Without `getEventListeners` in scope, only the clues written into the page survive — and the
    // two nodes it was the sole witness for go missing rather than being guessed at.
    const labels = offered(page(PAGE, { consoleApi: false })).map((action) => action.label)

    expect(labels).toContain('酒店 E') // the inline handler
    expect(labels).toContain('酒店 A') // the React props
    expect(labels).not.toContain('酒店 B') // a listener of the page's own
    expect(labels).not.toContain('酒店 C') // pointerdown, which only the listener map knows about
  })

  it('reads the page exactly as before while the deep scan is off', () => {
    const off = page(PAGE, { deep: false, consoleApi: true })
    const on = page(PAGE, { consoleApi: true })

    // Byte for byte: the same entries, the same ids, the same order, the same rectangles. Nothing
    // the native half of the table does depends on the switch.
    expect(off.actions).toEqual(on.actions.filter((action) => action.guess === undefined))
    expect(off.actions.map((action) => action.id)).toEqual([
      'e1',
      'e2',
      'e3',
      'e4',
      'e5',
      'e6',
      'e7',
      'e8',
      'e9',
      'e10',
      'wait',
    ])
    expect(off.actions.map((action) => action.label).slice(0, 4)).toEqual([
      '搜索',
      '输入框',
      'Open 输入框',
      '输入框 → enter',
    ])
    // The whole reading, pinned: the table, the text and the nested counts as characters. This is
    // the script as it was before the deep scan existed, which is what the switch promises to come
    // back to — the pinned value was taken from that script and re-checked against it, so any later
    // drift in the off path is a failure here rather than a quiet change of behaviour.
    const reading = createHash('sha256')
      .update(JSON.stringify({ actions: off.actions, text: off.text, nested: off.nested, omitted_actions: off.omitted_actions }))
      .digest('hex')
    expect(reading).toBe('a709f2415cceb5e14392f54b864238c168f862a1e5f5b44b9e36949228751fc2')
  })

  it('holds the element and request caps with both halves in one table', () => {
    const label = '一个相当长的中文标签'.repeat(20)
    const state = page(
      {
        tag: 'body',
        box: { x: 0, y: 0, w: 1120, h: 780 },
        children: [
          ...Array.from({ length: 55 }, (_unused, index) => ({
            tag: 'button' as const,
            control: true,
            box: { x: 10, y: 10, w: 60, h: 20 },
            text: `控制 ${index + 1} ${label}`,
          })),
          ...Array.from({ length: 15 }, (_unused, index) => ({
            tag: 'div' as const,
            box: { x: 100, y: 100, w: 200, h: 40 },
            text: `可选 ${index + 1} ${label}`,
            listeners: ['click'],
          })),
        ],
      },
      { consoleApi: true },
    )
    const space = actionSpace(state.actions)
    // Fifty-five declarations and the pool's full twelve guessed rows, not the fifteen the page offers: the
    // pool is capped inside the snapshot (`browser/snapshot.ts`), before anything else sees the table.
    expect(space.elements).toHaveLength(67)

    // What the loop does, in the same order and with the same arithmetic: the cap first, then the
    // request body measured and the table cut again a few entries at a time until it fits.
    const context = {
      goal: '订一间房',
      page: { url: 'https://hotels.test/list', title: '酒店列表', text: 'x'.repeat(3000) } as unknown as PageState,
      history: [],
    }
    let limit = MAX_ELEMENTS
    let trimmed = trimActionSpace(space, context.goal, [], limit)
    // At the element cap the guessed block is what goes: a guessed row is cut before a declaration of
    // the same standing, and these two halves have the same standing.
    expect(trimmed.space.elements.every((element) => element.label.startsWith('控制'))).toBe(true)
    while (limit > 1 && requestChars(trimmed.space, context, 'jev-latest') > MAX_REQUEST_CHARS) {
      limit -= 4
      trimmed = trimActionSpace(space, context.goal, [], limit)
    }

    expect(trimmed.space.elements.length).toBeLessThanOrEqual(MAX_ELEMENTS)
    expect(trimmed.space.elements.length).toBeGreaterThan(0)
    expect(requestChars(trimmed.space, context, 'jev-latest')).toBeLessThanOrEqual(MAX_REQUEST_CHARS)
    expect(MAX_REQUEST_CHARS).toBe(20_000)
    // The body really did overshoot on the page's own long labels, so the second cut ran — and what it
    // took, at equal standing, is the guessed block: no declaration is cut before a guess.
    expect(limit).toBeLessThan(MAX_ELEMENTS)
    expect(trimmed.space.elements.every((element) => element.label.startsWith('控制'))).toBe(true)
  })
})
