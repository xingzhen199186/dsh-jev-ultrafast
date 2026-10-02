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
 *
 * A page keeps one cache object for as long as it lives — the id map, the counter and the guard
 * function are all on it — so a test that is about those passes the whole object, and the expression
 * reads and writes it by reference as it would in a browser. Without one the node table is all the
 * expression may find, which is how every other test in this file reads a page.
 */
function evaluate(
  expression: string,
  held: Map<number, unknown>,
  hit: unknown,
  cache?: Record<string, unknown>,
): unknown {
  const document = { elementFromPoint: () => hit }
  const window = { __jevFast: cache ?? { nodes: held } }
  const run = new Function('window', 'document', 'innerWidth', 'innerHeight', `return (${expression})`)
  return run(window, document, 1120, 780)
}

/** Which input event, if any, this page's connection refuses to deliver. */
type Breakage = 'none' | 'press' | 'press-and-release'

/** A connection that answers what `act` sends: the lookup by running it, the input by recording it. */
function sessionOver(
  held: Map<number, unknown>,
  hit: unknown,
  cache?: Record<string, unknown>,
  breakage: Breakage = 'none',
): { port: BrowserPort; dispatched: Array<Record<string, unknown>> } {
  const dispatched: Array<Record<string, unknown>> = []
  const port: BrowserPort = {
    async call<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
      if (method !== 'Runtime.evaluate') {
        dispatched.push({ method, ...(params ?? {}) })
        // Recorded before it fails, which is the point: what this file checks about a broken press is
        // that the release was sent anyway, and a connection that never heard either call cannot say.
        if (breakage !== 'none' && params?.type === 'mousePressed') throw new Error('连接在按下的那一刻断了')
        if (breakage === 'press-and-release' && params?.type === 'mouseReleased') {
          throw new Error('连接在松开的那一刻断了')
        }
        return {} as T
      }
      return { result: { value: evaluate(String(params?.expression ?? ''), held, hit, cache) } } as T
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
async function refusal(
  held: Map<number, unknown>,
  hit: unknown,
  cache?: Record<string, unknown>,
): Promise<unknown> {
  const { port } = sessionOver(held, hit, cache)
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
    // The centre of the element, dispatched as it always was — with the pointer put on it first, so
    // the press has a hover target to land on even though this tab has never seen a mouse event. The
    // move carries the same two numbers the geometry produced; no second coordinate is computed.
    expect(dispatched).toEqual([
      { method: 'Input.dispatchMouseEvent', type: 'mouseMoved', x: 120, y: 110 },
      { method: 'Input.dispatchMouseEvent', type: 'mousePressed', x: 120, y: 110, button: 'left', clickCount: 1 },
      { method: 'Input.dispatchMouseEvent', type: 'mouseReleased', x: 120, y: 110, button: 'left', clickCount: 1 },
    ])
  })

  it('releases the button even though the press is what failed', async () => {
    // A press that throws can still have landed: the page is left holding the button down, and every
    // step after this one inherits a page behaving as if a hand were on it. The compensating release
    // is best effort — sent, its own failure silent — and it must not replace the failure that says
    // this step did not work.
    const { port, dispatched } = sessionOver(nodes(() => true), layer, undefined, 'press')
    const failure = await act(port, page, ACTION).then(
      () => null,
      (error: unknown) => error,
    )

    expect((failure as Error).message).toBe('连接在按下的那一刻断了')
    expect(dispatched.map((event) => event.type)).toEqual(['mouseMoved', 'mousePressed', 'mouseReleased'])
    expect(dispatched.at(-1)).toMatchObject({ type: 'mouseReleased', x: 120, y: 110, button: 'left', clickCount: 1 })
  })

  it('keeps a release that failed from replacing the failure that caused it', async () => {
    // The same page, with the connection gone for the compensating release as well: two failures, and
    // the one the caller is told about is the press. A silent release is what makes that possible.
    const { port, dispatched } = sessionOver(nodes(() => true), layer, undefined, 'press-and-release')
    const failure = await act(port, page, ACTION).then(
      () => null,
      (error: unknown) => error,
    )

    expect((failure as Error).message).toBe('连接在按下的那一刻断了')
    expect(dispatched.map((event) => event.type)).toEqual(['mouseMoved', 'mousePressed', 'mouseReleased'])
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

  it('records the element lookup that found nothing, and which question refused', async () => {
    // The refusal used to leave nothing behind at all: the run re-observed the page, asked again, and
    // stopped seven decisions later on a rule about a target no reader could see the reason for. The
    // record names the site — the element lookup, not the freshness question before it — and the
    // element the decision chose, and its sentence says what was true of the page.
    const written: Array<Record<string, unknown>> = []
    const { port } = sessionOver(new Map(), layer)

    await expect(
      act(port, page, ACTION, undefined, { write: (record) => written.push(record) }),
    ).rejects.toBeInstanceOf(StalePage)

    expect(written).toEqual([
      {
        at: expect.any(Number),
        kind: 'refused',
        where: 'target',
        why: '这个元素在页面上已经找不到或点不动了（元素重查没过），这个动作没发出去',
        operation: 'click',
        node: NODE,
        label: ' 欢迎度排序',
      },
    ])
  })

  it('carries the number the page gave the element in the way, and its guard', async () => {
    // The two fields that turn the sentence into a choice: the element's own number, minted the way
    // the snapshot mints one, and the guard a freshness check compares (see `withCoverActions`).
    const held = nodes(() => false)
    const cache: Record<string, unknown> = {
      nodes: held,
      ids: new WeakMap(),
      next: 1,
      guard: (element: unknown) => ['guard', element],
    }
    const first = (await refusal(held, layer, cache)) as TargetCovered

    expect(first.covering.node).toBe(1)
    expect(first.covering.guard).toEqual(['guard', layer])
    // Minted into the page's own maps, so a later observation of the same element finds the same
    // number rather than a second one — a fresh number every time would name nothing else knows.
    expect((cache.ids as WeakMap<object, number>).get(layer)).toBe(1)
    expect(held.get(1)).toBe(layer)
    expect(((await refusal(held, layer, cache)) as TargetCovered).covering.node).toBe(1)
    // A different element in the way is a different number, and takes the page's next one.
    const other = { tagName: 'SPAN', getAttribute: () => null, innerText: '其它', textContent: '其它' }
    expect(((await refusal(held, other, cache)) as TargetCovered).covering.node).toBe(2)
    expect(held.get(2)).toBe(other)
  })

  it('invents no number for a page that has no table to ask', async () => {
    // The stand-in document every other test in this file uses has no id map and no guard function,
    // and the refusal must not make one up: with no number there is nothing to offer as a candidate,
    // so a run meeting this page keeps the sentence and nothing else.
    const covered = (await refusal(nodes(() => false), layer)) as TargetCovered

    expect(covered.covering.node).toBeUndefined()
    expect('node' in covered.covering).toBe(false)
    expect('guard' in covered.covering).toBe(false)
    expect(covered.coverNote).toBe('DIV(role=dialog)「位置」')
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
