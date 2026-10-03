import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SnapshotAction } from '../src/browser/session'
import { SNAPSHOT_SOURCE } from '../src/browser/snapshot'
import { actionSpace } from '../src/decision/action-space'

/**
 * The choices a popup shows — the autocomplete list 携程 hangs under 「目的地/酒店名称」 — as the
 * markup they stand for:
 *
 *   <input id="destination" placeholder="目的地/酒店名称">
 *   <div class="dropdown">
 *     <ul role="listbox">
 *       <li data-value="BJX"><span>生命科学园地铁站</span><span>北京, 中国</span></li>
 *       <li data-value="ZGC"><span>中关村生命科学园</span><span>北京, 中国</span></li>
 *       <li data-value="PKX" style="top:-60px"><span>大兴国际机场</span></li>   ← above the viewport
 *       <li data-index="9"></li>                                                ← nothing to read
 *       <li data-value="WRAP"><a href="#">被链接包住的候选</a></li>              ← its anchor is listed
 *     </ul>
 *   </div>
 *   <ul class="suggestions">                       ← no role, no data-*: only aria-selected names it
 *     <li aria-selected="true"><span>中关村生命科学园</span></li>
 *     <li><span>上海虹桥火车站</span></li>          ← a plain row: no shape names it, it stays out
 *   </ul>
 *   <div role="option" data-value="PEK">首都国际机场</div>
 *   <div class="popup" style="display:none">        ← the same list, kept for later
 *     <ul role="listbox"><li data-value="hidden"><span>不该出现的隐藏候选</span></li></ul>
 *   </div>
 *
 * The page is declared as the nodes above because this suite runs in node, which has no DOM. What
 * is *not* restated by hand is the selector: the fake document is asked with the very string the
 * script builds (`document.querySelectorAll(selector)`) and answers with a small match over the
 * declared attributes, so the shapes the script asks for are the subject of the test rather than
 * its assumption.
 */

interface Box {
  x: number
  y: number
  w: number
  h: number
}

/** One node of the fake page: the tags, attributes and box the fixture declares. */
interface Spec {
  tag: string
  attrs?: Record<string, string>
  text?: string
  children?: Spec[]
  /** The box the page lays it out in. Absent means 0×0, which no element passes. */
  box?: Box
  /** What the page's own computed style says; a hidden popup is `display:none`. */
  shown?: boolean
  type?: string
  value?: string
  readOnly?: boolean
}

/** A row of the popup, 280×36, at the given height on the page. */
const row = (y: number): Box => ({ x: 110, y, w: 280, h: 36 })

const FIXTURE: Spec = {
  tag: 'body',
  children: [
    {
      tag: 'input',
      attrs: { id: 'destination', placeholder: '目的地/酒店名称' },
      type: 'text',
      value: '',
      readOnly: false,
      box: { x: 110, y: 40, w: 280, h: 36 },
    },
    {
      tag: 'div',
      attrs: { class: 'dropdown' },
      children: [
        {
          tag: 'ul',
          attrs: { role: 'listbox' },
          children: [
            {
              tag: 'li',
              attrs: { 'data-value': 'BJX' },
              box: row(140),
              children: [{ tag: 'span', text: '生命科学园地铁站' }, { tag: 'span', text: '北京, 中国' }],
            },
            {
              tag: 'li',
              attrs: { 'data-value': 'ZGC' },
              box: row(180),
              children: [{ tag: 'span', text: '中关村生命科学园' }, { tag: 'span', text: '北京, 中国' }],
            },
            {
              tag: 'li',
              attrs: { 'data-value': 'PKX' },
              box: { x: 110, y: -60, w: 280, h: 36 },
              children: [{ tag: 'span', text: '大兴国际机场' }],
            },
            { tag: 'li', attrs: { 'data-index': '9' }, box: row(220) },
            {
              tag: 'li',
              attrs: { 'data-value': 'WRAP' },
              box: row(260),
              children: [{ tag: 'a', attrs: { href: '#' }, box: row(260), text: '被链接包住的候选' }],
            },
          ],
        },
      ],
    },
    {
      tag: 'ul',
      attrs: { class: 'suggestions' },
      children: [
        {
          tag: 'li',
          attrs: { 'aria-selected': 'true' },
          box: row(320),
          children: [{ tag: 'span', text: '中关村生命科学园' }],
        },
        { tag: 'li', box: row(360), text: '上海虹桥火车站' },
      ],
    },
    { tag: 'div', attrs: { role: 'option', 'data-value': 'PEK' }, box: row(400), text: '首都国际机场' },
    {
      tag: 'div',
      attrs: { class: 'popup', style: 'display:none' },
      shown: false,
      children: [
        {
          tag: 'ul',
          attrs: { role: 'listbox' },
          children: [{ tag: 'li', attrs: { 'data-value': 'hidden' }, box: row(440), text: '不该出现的隐藏候选' }],
        },
      ],
    },
  ],
}

type TextNode = { nodeType: 3; textContent: string }

interface FakeNode {
  nodeType: 1
  tagName: string
  type?: string
  value?: string
  readOnly?: boolean
  isContentEditable?: boolean
  isConnected: boolean
  parentElement: FakeNode | null
  childNodes: Array<FakeNode | TextNode>
  innerText: string
  getAttribute: (name: string) => string | null
  matches: (selector: string) => boolean
  closest: (selector: string) => FakeNode | null
  querySelector: (selector: string) => FakeNode | null
  checkVisibility: () => boolean
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

let built: FakeNode[] = []

function build(spec: Spec, parent: FakeNode | null, hidden = false): FakeNode {
  const attrs = spec.attrs ?? {}
  const box = spec.box ?? { x: 0, y: 0, w: 0, h: 0 }
  // `checkVisibility` answers for the element's own box, so a row inside a `display:none` popup is
  // not visible either: the page's hidden-ness is inherited down the tree, not declared per node.
  const off = hidden || spec.shown === false
  const node: FakeNode = {
    nodeType: 1,
    tagName: spec.tag.toUpperCase(),
    isConnected: true,
    parentElement: parent,
    childNodes: [],
    innerText: spec.text ?? '',
    getAttribute: (name) => (name in attrs ? attrs[name]! : null),
    matches: (selector) => matches(node, selector),
    closest: (selector) => closest(node, selector),
    querySelector: (selector) => descendants(node).find((child) => matches(child, selector)) ?? null,
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
  // Only what the fixture declares exists on the node: the script asks some questions with
  // `'value' in e`, and a property that is merely absent must stay absent.
  if (spec.type !== undefined) node.type = spec.type
  if (spec.value !== undefined) node.value = spec.value
  if (spec.readOnly !== undefined) node.readOnly = spec.readOnly
  if (spec.text !== undefined) node.childNodes.push({ nodeType: 3, textContent: spec.text })
  for (const child of spec.children ?? []) node.childNodes.push(build(child, node, off))
  built.push(node)
  return node
}

function descendants(node: FakeNode): FakeNode[] {
  return node.childNodes.flatMap((child) =>
    child.nodeType === 3 ? [] : [child as FakeNode, ...descendants(child as FakeNode)],
  )
}

/** A step of a selector alternative: an optional tag name and the attributes written after it. */
interface Step {
  tag: string | null
  attrs: Array<[string, string | null]>
}

function parseSteps(alternative: string): Step[] {
  return alternative
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => ({
      tag: /^[a-z]+/i.exec(part)?.[0]?.toLowerCase() ?? null,
      attrs: [...part.matchAll(/\[([\w-]+)(?:="([^"]*)")?\]/g)].map((found) => [found[1]!, found[2] ?? null] as [string, string | null]),
    }))
}

function matchStep(node: FakeNode, step: Step): boolean {
  if (step.tag !== null && node.tagName.toLowerCase() !== step.tag) return false
  return step.attrs.every(([name, value]) => {
    const actual = node.getAttribute(name)
    return actual !== null && (value === null || actual === value)
  })
}

/**
 * A comma-separated list of descendant chains, which is the whole of the syntax the snapshot asks
 * with — `:disabled` is the one pseudo-class in it, and is left to the fixture to report as false.
 */
function matches(node: FakeNode, selector: string): boolean {
  if (selector === ':disabled') return false
  return selector.split(',').some((alternative) => {
    const steps = parseSteps(alternative.trim())
    if (steps.length === 0 || !matchStep(node, steps[steps.length - 1]!)) return false
    let at = steps.length - 2
    let ancestor = node.parentElement
    while (at >= 0) {
      while (ancestor && !matchStep(ancestor, steps[at]!)) ancestor = ancestor.parentElement
      if (!ancestor) return false
      ancestor = ancestor.parentElement
      at -= 1
    }
    return true
  })
}

function closest(node: FakeNode | null, selector: string): FakeNode | null {
  for (let at = node; at; at = at.parentElement) if (matches(at, selector)) return at
  return null
}

/**
 * Run the real in-page script over the fixture and hand back what it saw.
 *
 * `vi.stubGlobal` puts the page's globals where `new Function` looks for them, so the script runs
 * exactly as written — the same device `tests/nested.test.ts` uses — and the text walk yields
 * nothing because this test is about the element table the same page builds.
 */
function popupState(): { text: string; actions: SnapshotAction[] } {
  built = []
  const page = build(FIXTURE, null)
  const walker = (items: unknown[]) => {
    let at = 0
    return { nextNode: () => items[at++] ?? null }
  }
  const document = {
    body: page,
    title: '携程 · 酒店搜索',
    documentElement: { scrollHeight: 780 },
    querySelectorAll: (selector: string) => built.filter((node) => matches(node, selector)),
    getElementById: () => null,
    // Both walks yield nothing: this page's visible text and its shadow roots are not the subject
    // here, only the element table built from the control query above.
    createTreeWalker: () => walker([]),
    createRange: () => ({
      selectNodeContents: () => {},
      getBoundingClientRect: () => ({ width: 0, height: 0, top: 0, bottom: 0, left: 0, right: 0 }),
    }),
  }
  vi.stubGlobal('document', document)
  vi.stubGlobal('window', {})
  vi.stubGlobal('NodeFilter', { SHOW_TEXT: 4, SHOW_ELEMENT: 1 })
  vi.stubGlobal('location', { href: 'https://hotels.ctrip.com/hotels/list' })
  vi.stubGlobal('innerWidth', 1120)
  vi.stubGlobal('innerHeight', 780)
  vi.stubGlobal('scrollX', 0)
  vi.stubGlobal('scrollY', 0)
  return new Function(`return ${SNAPSHOT_SOURCE}`)() as { text: string; actions: SnapshotAction[] }
}

describe('the choices a popup offers', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('lists every candidate row the page is showing, with its text as the label and a click', () => {
    const space = actionSpace(popupState().actions)

    expect(space.elements.map((element) => element.label)).toEqual([
      '输入框',
      '生命科学园地铁站 北京, 中国',
      '中关村生命科学园 北京, 中国',
      '被链接包住的候选',
      '中关村生命科学园',
      '首都国际机场',
    ])

    const candidate = space.elements[1]!
    expect(candidate).toMatchObject({ role: 'option', operations: ['CLICK'] })
    expect(space.targets.CLICK![candidate.index]!.kind).toBe('click')
    expect(space.targets.CLICK![candidate.index]!.label).toBe('生命科学园地铁站 北京, 中国')
    // A row is only ever somewhere to click: no key press and nothing to type is offered for it.
    expect(space.targets.TYPE_TEXT?.[candidate.index]).toBeUndefined()
    expect(Object.keys(space.targets.PRESS_KEY ?? {}).filter((key) => key.startsWith(candidate.index))).toEqual([])
  })

  it('names a row the page only marks as selected, and one that carries a role already', () => {
    const space = actionSpace(popupState().actions)
    const selected = space.elements.find((element) => element.label === '中关村生命科学园')!

    // The row with no role at all, named by `aria-selected`, and the row the page itself marks
    // `role="option"`, read the same way by the model.
    expect(selected).toMatchObject({ role: 'option', operations: ['CLICK'] })
    expect(space.targets.CLICK![selected.index]!.label).toBe('中关村生命科学园')
    expect(space.elements.find((element) => element.label === '首都国际机场')).toMatchObject({
      role: 'option',
      operations: ['CLICK'],
    })
  })

  it('leaves out the same structure while the page is not showing it', () => {
    const space = actionSpace(popupState().actions)
    const labels = space.elements.map((element) => element.label)

    // `display:none`: the list the page keeps for later never reaches the table.
    expect(labels).not.toContain('不该出现的隐藏候选')
    // A row scrolled above the viewport is not a target anything can be clicked on.
    expect(labels).not.toContain('大兴国际机场')
    // A plain `<li>` with no role, no selection and no data-* value is not a choice the page names,
    // and a row with nothing to read is not one either.
    expect(labels).not.toContain('上海虹桥火车站')
    // The row wrapped around an anchor is left to its anchor rather than added a second time.
    expect(labels.filter((label) => label === '被链接包住的候选')).toHaveLength(1)
    expect(space.elements.find((element) => element.label === '被链接包住的候选')).toMatchObject({
      role: 'link',
    })
  })
})
