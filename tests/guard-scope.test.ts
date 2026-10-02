/**
 * An element action is judged by the element, not by the page around it.
 *
 * A page hands out two different identities, and `snapshot.ts` computes them separately:
 * `pageKey()` carries the document, the scroll position and **every safe field's value**
 * (snapshot.ts:80-82), while a node's `guard` carries that node's own state and nothing else
 * (snapshot.ts:83-90). `fresh` asks one of them or the other, and which one decides whether a step
 * goes out — the round of 2026-10-01/02 on 携程 is what says so: the page repainted on nearly every
 * look, seven `TYPE_TEXT` decisions went to one search box, five answers were paid for, and not one
 * keystroke was sent.
 *
 * The frame below is that situation stated as narrowly as it can be: the run observed the page, and
 * between the observation and the step **another** field's value changed (or the page scrolled
 * itself) while the target element was not touched at all. The two halves are asserted apart —
 * the page-level half really moved, the element's own half really did not — so a refusal here cannot
 * be attributed to anything but the page-level component.
 *
 * Nothing here touches a browser. The connection is a stand-in that answers each question the way the
 * page's own script would, from the page's live values, so the same file shows the bug before the
 * change and the fix after it.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { clearAttached } from '../src/browser/attached'
import { clearHeld, setHeldConnector, type HeldSocket } from '../src/browser/held'
import { BrowserSession, type PageState, type SnapshotAction } from '../src/browser/session'

const CDP = 'ws://127.0.0.1:9222/devtools/browser/guard-scope'
const URL = 'https://www.ctrip.com/'
/** The node the decision was aimed at, and a second field the decision never mentioned. */
const TARGET = 7
const OTHER = 8

/**
 * The page-level identity as `snapshot.ts` builds it: the document's stamp, where the page is, how
 * big it is, and one row per safe field carrying that field's value and its own state.
 */
function pageKey(scrollY: number, values: Record<number, string>): unknown[] {
  return [
    4012.5,
    URL,
    0,
    scrollY,
    1120,
    780,
    Object.entries(values).map(([node, value]) => [Number(node), value, false, null, false, false]),
  ]
}

/**
 * One node's own identity as `snapshot.ts` builds it: the number the page minted for that element
 * first, then that element's own state. The number is what makes a replaced node a different
 * element; the rest is what makes a redrawn control a changed one.
 */
function guardOf(id: number, value: string, scope: string): unknown[] {
  return [id, 'textbox', '目的地', value, null, null, false, false, null, null, null, null, null, scope]
}

/** The whole-page marker, as `snapshot.ts` composes it — the element table's semantics included. */
function markerOf(title: string, text: string, fields: unknown[]): unknown[] {
  return [4012.5, URL, 0, 0, 1120, 780, title, text, [], fields]
}

/** The scope text an element carries on the observed page. */
const SCOPE = '目的地 生命科学园 搜索'

/** The page as one run observed it: a field holding 「生命科学园」, and an empty second field. */
function observed(): PageState {
  const field = { node: TARGET, role: 'textbox', label: '目的地', value: '生命科学园', rect: { x: 0, y: 0, w: 10, h: 10 } }
  const actions: SnapshotAction[] = [
    { id: 'e1', kind: 'fill', ...field },
    { id: 'e2', kind: 'click', ...field, label: 'Open 目的地' },
    { id: 'scroll_down', kind: 'scroll', label: 'Scroll down', delta: 560 },
    { id: 'wait', kind: 'wait', label: 'Wait for the page to update' },
  ]
  return {
    url: URL,
    title: '携程旅行网',
    w: 1120,
    h: 780,
    text: '目的地/酒店名称',
    scroll: { y: 0, height: 1000 },
    actions,
    marker: markerOf('携程旅行网', '目的地/酒店名称', pageKey(0, { [TARGET]: '生命科学园', [OTHER]: '' })[6] as unknown[]),
    page_key: pageKey(0, { [TARGET]: '生命科学园', [OTHER]: '' }),
    guards: { [String(TARGET)]: guardOf(TARGET, '生命科学园', SCOPE) },
    omitted_actions: 0,
    fingerprint: 'fp-1',
  }
}

/**
 * One CDP connection, answering each question the way the page's script would answer it right now.
 *
 * `pageKey` and `guard` are the page's live halves, not the observed ones: a test moves them to say
 * what changed on the page, and every answer is composed from them, so nothing here decides what the
 * run is allowed to do. The questions are told apart by their own source, in the order `fresh` and
 * `targetSource` ask them.
 */
class ScriptedConnection implements HeldSocket {
  /** Every expression the run evaluated, so a test can assert what it asked rather than assumed. */
  readonly evaluated: string[] = []
  /** The page-level half, live. */
  pageKey: unknown[]
  /** The node's own half, live — `null` for a node the page no longer has. */
  guard: unknown[] | null
  /** The whole-page marker, live — opaque, compared as the page's own script hands it over. */
  marker: unknown

  constructor(page: PageState) {
    // Assigned rather than copied: a test says what changed on the page by replacing a whole half,
    // never by editing one in place.
    this.pageKey = page.page_key
    this.guard = page.guards[String(TARGET)] as unknown[] | null
    this.marker = page.marker
  }

  async send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    if (method === 'Target.createTarget') return { targetId: 'target-1' } as T
    if (method === 'Target.attachToTarget') return { sessionId: 'session-1' } as T
    if (method === 'Runtime.evaluate') {
      const expression = String(params?.expression ?? '')
      this.evaluated.push(expression)
      // The question as it was asked before the guard was scoped: the whole page key and the node's
      // guard together. Answered from both live halves, which is what let a change anywhere on the
      // page refuse a step aimed at an untouched element.
      if (expression.includes('c.pageKey')) return { result: { value: [this.pageKey, this.guard] } } as T
      // The node's own guard alone — the question the fix asks. `c.guard(c.nodes.get(` is this
      // question and no other: the target lookup below asks for `c.guard(hit)`.
      if (expression.includes('c.guard(c.nodes.get(')) return { result: { value: [this.guard] } } as T
      // The whole page, reduced to its marker.
      if (expression.includes('semantics')) return { result: { value: this.marker } } as T
      // Where the action is aimed: still connected, still hit-testable.
      if (expression.includes('isConnected')) return { result: { value: { x: 5, y: 6 } } } as T
      return { result: { value: 'complete' } } as T
    }
    return {} as T
  }

  onClose(): () => void {
    return () => {}
  }

  close(): void {}
}

/** A session attached over the scripted connection, and the connection it attached over. */
async function attached(): Promise<{ session: BrowserSession; connection: ScriptedConnection; page: PageState }> {
  const page = observed()
  const connection = new ScriptedConnection(page)
  setHeldConnector(async () => connection)
  const session = await BrowserSession.open(URL, { cdpUrl: CDP, connection: 'daily' })
  return { session, connection, page }
}

afterEach(() => {
  // The holder is module state: a test that left a connection in it would decide the next one.
  clearHeld()
  setHeldConnector(null)
  clearAttached()
})

describe('the question an element action is judged by', () => {
  it('lets the step through when only another field on the page changed', async () => {
    const { session, connection, page } = await attached()
    try {
      // Somebody else's field, not the target: the target's own state is left exactly as observed.
      connection.pageKey = pageKey(0, { [TARGET]: '生命科学园', [OTHER]: '北大医疗产业园' })

      // The two halves, told apart on the evidence rather than asserted together: the page-level half
      // really moved, and the element's own half really did not.
      expect(connection.pageKey).not.toEqual(page.page_key)
      expect(connection.guard).toEqual(page.guards[String(TARGET)])

      const fill = page.actions.find((action) => action.kind === 'fill')!
      await expect(session.fresh(page, fill)).resolves.toBe(true)
      // And what it asked was the element's own guard. The page-level question is not asked at all
      // for a step aimed at one element: that question belongs to `scroll`, `wait` and the run's
      // own before-each-step freshness check.
      expect(connection.evaluated.some((expression) => expression.includes('c.guard(c.nodes.get('))).toBe(true)
      expect(connection.evaluated.some((expression) => expression.includes('c.pageKey'))).toBe(false)
    } finally {
      await session.close()
    }
  })

  it('lets the step through when the page scrolled itself under it', async () => {
    const { session, connection, page } = await attached()
    try {
      // A lazy-loaded block arriving above the viewport moves the scroll position without touching
      // the control the step is aimed at.
      connection.pageKey = pageKey(240, { [TARGET]: '生命科学园', [OTHER]: '' })

      expect(connection.pageKey).not.toEqual(page.page_key)
      expect(connection.guard).toEqual(page.guards[String(TARGET)])

      const click = page.actions.find((action) => action.kind === 'click')!
      await expect(session.fresh(page, click)).resolves.toBe(true)
    } finally {
      await session.close()
    }
  })

  it('still refuses a step whose element the page replaced', async () => {
    const { session, connection, page } = await attached()
    try {
      // Same tag, same role, same label, same value — a different element: the page re-rendered the
      // field and minted a new number for it. This is the case the fix must not cost.
      connection.guard = guardOf(12, '生命科学园', SCOPE)

      const fill = page.actions.find((action) => action.kind === 'fill')!
      await expect(session.fresh(page, fill)).resolves.toBe(false)
    } finally {
      await session.close()
    }
  })

  it('still refuses a step whose element changed its own state', async () => {
    const { session, connection, page } = await attached()
    try {
      // The same node, redrawn: what it holds is no longer what the decision was made on.
      connection.guard = guardOf(TARGET, '北大医疗产业园', SCOPE)

      const fill = page.actions.find((action) => action.kind === 'fill')!
      await expect(session.fresh(page, fill)).resolves.toBe(false)
    } finally {
      await session.close()
    }
  })

  it('still refuses a step whose element the page no longer has', async () => {
    const { session, connection, page } = await attached()
    try {
      // A node the page's own table has dropped: the question is answerable and the answer is "not
      // there" — which is a refusal, not a licence.
      connection.guard = null

      const click = page.actions.find((action) => action.kind === 'click')!
      await expect(session.fresh(page, click)).resolves.toBe(false)
    } finally {
      await session.close()
    }
  })

  it('still judges scrolling and waiting by the whole page', async () => {
    const { session, connection, page } = await attached()
    try {
      // Neither is aimed at an element, so the element question cannot be asked about it: the whole
      // page's marker is the honest question, and it is asked here exactly as before.
      connection.marker = markerOf('重绘后的标题', '另一页', pageKey(0, { [TARGET]: '别的', [OTHER]: '' })[6] as unknown[])
      expect(connection.marker).not.toEqual(page.marker)

      const scroll = page.actions.find((action) => action.kind === 'scroll')!
      const wait = page.actions.find((action) => action.kind === 'wait')!
      await expect(session.fresh(page, scroll)).resolves.toBe(false)
      await expect(session.fresh(page, wait)).resolves.toBe(false)

      // And the same question answered with the page unchanged lets both through.
      connection.marker = page.marker
      await expect(session.fresh(page, scroll)).resolves.toBe(true)
      await expect(session.fresh(page, wait)).resolves.toBe(true)
      expect(connection.evaluated.some((expression) => expression.includes('semantics'))).toBe(true)
    } finally {
      await session.close()
    }
  })
})
