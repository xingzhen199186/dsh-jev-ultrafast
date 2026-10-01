/**
 * A target that is on the page and cannot be clicked through, and what the run says about it.
 *
 * The case a real trace left silent: the element is in the viewport, enabled and visible, and the
 * hit test at its centre lands on something else — a layer drawn over the field the decision chose,
 * which is what a "position" box's popup does to the control underneath it. Everything upstream of
 * the browser's own `elementFromPoint` runs here for real: the expression `act` sends is parsed and
 * executed against a stand-in document, so a template that lost an escape backslash fails in this
 * file rather than turning into a plain `StalePage` in a real browser, and the reading it produces is
 * followed through to the sentence the caller sees.
 *
 * What this cannot check is what a real browser paints on top of what — a stand-in hit test is the
 * one answer it supplies. That is the browser-layer integration test's job (`JEV_BROWSER=1`), which
 * drives the fixture's `#covered-wrap` + `#veil` through a real Chromium.
 */
import { describe, expect, it } from 'vitest'
import { TargetCovered, act } from '../src/browser/act'
import { StalePage, type BrowserPort, type PageState, type SnapshotAction } from '../src/browser/session'

/** The number the decision chose, which is what the lookup is asked about. */
const NODE = 7
const ACTION: SnapshotAction = { id: 'e1', kind: 'click', node: NODE, label: ' 欢迎度排序' }

const page: PageState = {
  url: 'https://example.test/',
  title: 'Flights',
  w: 1120,
  h: 780,
  text: '欢迎度排序',
  scroll: { y: 0, height: 1000 },
  actions: [ACTION],
  marker: [],
  page_key: [],
  guards: {},
  omitted_actions: 0,
  fingerprint: 'fp-1',
}

/**
 * The element the lookup is asked about, answering the seven questions the expression asks it.
 * `contains` is the hit test's verdict, which is the one thing a stand-in has to decide.
 */
function targetNode(contains: (hit: unknown) => boolean): Record<string, unknown> {
  return {
    isConnected: true,
    matches: () => false,
    closest: () => null,
    checkVisibility: () => true,
    getBoundingClientRect: () => ({ x: 100, y: 100, width: 40, height: 20 }),
    contains,
    tagName: 'BUTTON',
    getAttribute: () => null,
    dispatchEvent: () => true,
  }
}

/** A layer of the page's own standing over the target: a dialog whose words are 位置. */
const layer = {
  tagName: 'DIV',
  getAttribute: (name: string) => (name === 'role' ? 'dialog' : null),
  innerText: '位置',
  textContent: '位置',
}

/** The pages the tab has handed out, by node, for the expression to look up. */
function nodes(contains: (hit: unknown) => boolean): Map<number, unknown> {
  return new Map([[NODE, targetNode(contains)]])
}

/**
 * Run the expression `act` sent the way the page would. `window`, `document`, `innerWidth` and
 * `innerHeight` are the only globals the expression names, and the document's hit test is the only
 * one whose answer is supplied rather than computed.
 */
function evaluate(expression: string, held: Map<number, unknown>, hit: unknown): unknown {
  const document = { elementFromPoint: () => hit }
  const window = { __jevFast: { nodes: held } }
  const run = new Function('window', 'document', 'innerWidth', 'innerHeight', `return (${expression})`)
  return run(window, document, 1120, 780)
}

/** A connection that answers what `act` sends: the lookup by running it, the input by recording it. */
function sessionOver(
  held: Map<number, unknown>,
  hit: unknown,
): { port: BrowserPort; dispatched: Array<Record<string, unknown>> } {
  const dispatched: Array<Record<string, unknown>> = []
  const port: BrowserPort = {
    async call<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
      if (method !== 'Runtime.evaluate') {
        dispatched.push({ method, ...(params ?? {}) })
        return {} as T
      }
      return { result: { value: evaluate(String(params?.expression ?? ''), held, hit) } } as T
    },
    async observe(): Promise<PageState> {
      throw new Error('这个替身不观察页面')
    },
    async fresh(): Promise<boolean> {
      return true
    },
    noteInput(): void {},
    async close(): Promise<void> {},
  }
  return { port, dispatched }
}

/** The refusal `act` makes, or `null` when it made none. */
async function refusal(held: Map<number, unknown>, hit: unknown): Promise<unknown> {
  const { port } = sessionOver(held, hit)
  return act(port, page, ACTION).then(
    () => null,
    (error: unknown) => error,
  )
}

describe('a target something else is standing over', () => {
  it('refuses it as a covered target and names the element in the way', async () => {
    const taken = await refusal(nodes(() => false), layer)

    expect(taken).toBeInstanceOf(TargetCovered)
    // Still a stale page, so every caller that already re-observes the page for one — the run's own
    // `catch` included — keeps working without changing a line.
    expect(taken).toBeInstanceOf(StalePage)
    const covered = taken as TargetCovered
    expect(covered.coverNote).toBe('DIV(role=dialog)「位置」')
    expect(covered.message).toBe('目标被DIV(role=dialog)「位置」盖住了，点击落不到它身上，请重新观察')
  })

  it('leaves an ordinary target exactly as it was', async () => {
    const { port, dispatched } = sessionOver(nodes(() => true), layer)
    const result = await act(port, page, ACTION)

    expect(result.executed).toBe('e1')
    // The centre of the element, dispatched as it always was: the new answer is not in the way of a
    // target nothing is standing over.
    expect(dispatched).toEqual([
      { method: 'Input.dispatchMouseEvent', type: 'mousePressed', x: 120, y: 110, button: 'left', clickCount: 1 },
      { method: 'Input.dispatchMouseEvent', type: 'mouseReleased', x: 120, y: 110, button: 'left', clickCount: 1 },
    ])
  })

  it('keeps a number the page does not have a plain stale page', async () => {
    // The distinction the sentence depends on: nothing was found, so there is no element to name and
    // the refusal stays the one it was. A cover invented here would put the page's furniture in the
    // sentence as the culprit.
    const taken = await refusal(new Map(), layer)

    expect(taken).toBeInstanceOf(StalePage)
    expect(taken).not.toBeInstanceOf(TargetCovered)
    expect((taken as Error).message).toBe('目标已经变化或被遮挡，请重新观察')
  })

  it('names what it can and nothing more', async () => {
    // The words the layer shows, cut to forty characters...
    const long = { ...layer, innerText: '北'.repeat(60), textContent: '北'.repeat(60) }
    expect(((await refusal(nodes(() => false), long)) as TargetCovered).coverNote).toBe(
      `DIV(role=dialog)「${'北'.repeat(40)}」`,
    )
    // ...the name it carries when it shows no words at all...
    const labelled = {
      tagName: 'SPAN',
      getAttribute: (name: string) => (name === 'aria-label' ? '关闭浮层' : null),
      innerText: '',
      textContent: '',
    }
    expect(((await refusal(nodes(() => false), labelled)) as TargetCovered).coverNote).toBe(
      'SPAN「关闭浮层」',
    )
    // ...and its tag alone when the page gives neither, with no role and no name invented for it.
    const bare = { tagName: 'SPAN', getAttribute: () => null, innerText: '', textContent: '' }
    expect(((await refusal(nodes(() => false), bare)) as TargetCovered).coverNote).toBe('SPAN')
  })
})
