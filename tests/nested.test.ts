import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NestedFacts } from '../src/browser/nested'
import { nestedNote } from '../src/browser/nested'
import { SNAPSHOT_SOURCE } from '../src/browser/snapshot'

/**
 * A page whose content the snapshot cannot reach: a frame or an open shadow root holds it,
 * and the top document is left with almost nothing of its own. What is tested here is the
 * sentence the model and the reader are given — and, for the page side, the counts the
 * script reports.
 */

const facts = (overrides: Partial<NestedFacts> = {}): NestedFacts => ({
  frames: 0,
  frame_url: '',
  shadow_roots: 0,
  elements: 0,
  ...overrides,
})

const WITH_ONE_FRAME =
  '这个页面的主要内容在嵌套的框架里（1 个 iframe），插件看不到里面的内容，所以这里推不动。' +
  '可以试试直接打开里面的地址：https://inside.test/app'

describe('a page the snapshot can only partly see', () => {
  it('says so when a frame holds the content and the top document is nearly empty', () => {
    expect(nestedNote(facts({ frames: 1, frame_url: 'https://inside.test/app' }))).toBe(WITH_ONE_FRAME)
  })

  it('counts every visible frame', () => {
    expect(nestedNote(facts({ frames: 3, frame_url: 'https://inside.test/app' }))).toContain('（3 个 iframe）')
  })

  it('says nothing about a page that has controls of its own', () => {
    expect(nestedNote(facts({ frames: 1, frame_url: 'https://inside.test/app', elements: 12 }))).toBe('')
  })

  it('says nothing about an ordinary page without nested structures', () => {
    expect(nestedNote(facts({ elements: 0 }))).toBe('')
    expect(nestedNote(facts({ elements: 0, frames: 0, shadow_roots: 0 }))).toBe('')
  })

  it('says it for a shadow root the snapshot cannot open', () => {
    // There is no DOM in this suite to attach a shadow root to (see the fake page below and
    // `tests/snapshot.test.ts`: this project runs its tests in node), so the rule itself is
    // driven with the plain shape the page side reports.
    expect(nestedNote(facts({ shadow_roots: 1 }))).toContain('（1 个网页自己封起来的内容块）')
    expect(nestedNote(facts({ shadow_roots: 1 }))).toContain('插件看不到里面的内容')
  })

  it('names both kinds when both are there', () => {
    expect(nestedNote(facts({ frames: 2, shadow_roots: 1 }))).toContain('（2 个 iframe、1 个网页自己封起来的内容块）')
  })

  it('offers no address when the frame has none of its own', () => {
    const note = nestedNote(facts({ frames: 1 }))
    expect(note).toContain('如果知道里面那个页面自己的地址，可以直接打开它再试。')
    expect(note).not.toContain('https://')
  })
  it('says nothing about a page it was told nothing about', () => {
    expect(nestedNote(undefined)).toBe('')
  })
})

/** One element of the fake document: only what the snapshot script touches. */
function element(options: {
  tag: string
  src?: string
  box?: { width: number; height: number }
  visible?: boolean
  shadow?: boolean
}) {
  const width = options.box?.width ?? 0
  const height = options.box?.height ?? 0
  const node = {
    tagName: options.tag,
    isConnected: true,
    get shadowRoot() {
      return options.shadow ? { childElementCount: 1 } : null
    },
    getAttribute: (name: string) => (name === 'src' ? (options.src ?? null) : null),
    closest: () => null,
    checkVisibility: () => options.visible !== false,
    getBoundingClientRect: () => ({ x: 0, y: 0, width, height, bottom: height, top: 0, right: width, left: 0 }),
  }
  return node
}

/**
 * Run the real in-page script against a fake document.
 *
 * `vi.stubGlobal` puts the page's globals on `globalThis`, which is the scope `new Function`
 * evaluates in, so the script runs exactly as written — including the counting added for
 * nested content — without a browser. Only what the script touches is faked; everything else
 * it uses (WeakMap, Map, JSON, Math) is the real thing.
 *
 * `frames` are what the frame query returns; `all` is everything the shadow-root walk sees.
 * The control query returns nothing on purpose: these tests are about the counts, not about
 * the element table the snapshot builds from the same page.
 */
function snapshotOf(nodes: { frames?: unknown[]; all?: unknown[] }): { nested: NestedFacts } {
  const all = nodes.all ?? []
  const walker = (items: unknown[]) => {
    let index = 0
    return { nextNode: () => items[index++] ?? null }
  }
  const document = {
    body: {},
    title: 'Fake page',
    documentElement: { scrollHeight: 780 },
    querySelectorAll: (selector: string) => (selector === 'iframe' ? (nodes.frames ?? []) : []),
    getElementById: () => null,
    // The text walk yields nothing, so the fake page has no text; the element walk yields
    // everything, and the script itself is what filters for hosts with an open shadow root.
    createTreeWalker: (_root: unknown, what: number) => walker(what === 4 ? [] : all),
    createRange: () => ({
      selectNodeContents: () => {},
      getBoundingClientRect: () => ({ width: 0, height: 0, top: 0, bottom: 0, left: 0, right: 0 }),
    }),
  }
  vi.stubGlobal('document', document)
  vi.stubGlobal('window', {})
  vi.stubGlobal('NodeFilter', { SHOW_TEXT: 4, SHOW_ELEMENT: 1 })
  vi.stubGlobal('location', { href: 'https://example.test/outer' })
  vi.stubGlobal('innerWidth', 1120)
  vi.stubGlobal('innerHeight', 780)
  vi.stubGlobal('scrollX', 0)
  vi.stubGlobal('scrollY', 0)
  return new Function(`return ${SNAPSHOT_SOURCE}`)() as { nested: NestedFacts }
}

describe('what the in-page script counts', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('counts the visible frame, keeps its address, and ignores a hidden or empty one', () => {
    const state = snapshotOf({
      frames: [
        element({ tag: 'IFRAME', src: 'https://inside.test/app', box: { width: 600, height: 400 } }),
        element({ tag: 'IFRAME', src: 'https://hidden.test/', box: { width: 600, height: 400 }, visible: false }),
        element({ tag: 'IFRAME', src: 'https://empty.test/', box: { width: 0, height: 0 } }),
      ],
    })

    expect(state.nested).toEqual({
      frames: 1,
      frame_url: 'https://inside.test/app',
      shadow_roots: 0,
      elements: 0,
    })
  })

  it('ignores a frame that has no address of its own', () => {
    const state = snapshotOf({ frames: [element({ tag: 'IFRAME', box: { width: 600, height: 400 } })] })

    expect(state.nested.frames).toBe(1)
    expect(state.nested.frame_url).toBe('')
  })

  it('sees an open shadow root that has something in it, and not one that is empty', () => {
    const state = snapshotOf({
      all: [element({ tag: 'DIV', shadow: true }), element({ tag: 'DIV' })],
    })

    expect(state.nested.shadow_roots).toBe(1)
  })

  it('reports no nested structure at all for an ordinary page', () => {
    const state = snapshotOf({})

    expect(state.nested).toEqual({ frames: 0, frame_url: '', shadow_roots: 0, elements: 0 })
  })

  it('feeds the counts the snapshot reports straight into the sentence', () => {
    // The boundary the two halves meet at: what the page counted is what the sentence is
    // built from, with the frame's own address in it.
    const state = snapshotOf({
      frames: [element({ tag: 'IFRAME', src: 'https://inside.test/app', box: { width: 600, height: 400 } })],
    })

    expect(nestedNote(state.nested)).toBe(WITH_ONE_FRAME)
  })
})
