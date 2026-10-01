/**
 * A key is not thrown away because the page repainted around it.
 *
 * The pages that need `PRESS_KEY` are the ones that redraw themselves while they are being
 * worked on — an autocomplete list rebuilt on every keystroke — so the whole-page marker that
 * decides freshness for every other action is the wrong question to ask about a press: on
 * 携程 (2026-10-01) the page changed on nearly every step, which is what left the keyboard as
 * the only move and, under the marker rule, also made it the move most likely to be refused.
 *
 * These checks drive the real `act` over a scripted CDP connection: the whole-page marker is
 * answered as *changed* for the entire run, while the field's own guard still matches. The
 * press has to go out anyway, and the second check pins that the marker really was different —
 * an action that is judged by it is refused in the same conditions.
 *
 * Nothing here touches a browser: the connection is a stand-in that answers the three
 * expressions `act` asks for by their shape, and the tab bookkeeping it needs with empty
 * objects.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { act } from '../src/browser/act'
import { clearAttached } from '../src/browser/attached'
import { clearHeld, setHeldConnector, type HeldSocket } from '../src/browser/held'
import { BrowserSession, StalePage, type PageState, type SnapshotAction } from '../src/browser/session'

const CDP = 'ws://127.0.0.1:9222/devtools/browser/press-key'

/**
 * The page as one run observed it: one editable field, with the five keys it offers. The
 * `actions` are what the snapshot would have minted for that field, ids included.
 */
function observed(): PageState {
  const field = { node: 7, role: 'textbox', label: '目的地', value: '生命科学园', rect: { x: 0, y: 0, w: 10, h: 10 } }
  const keys = ['enter', 'escape', 'tab', 'arrowdown', 'arrowup']
  const actions: SnapshotAction[] = [
    { id: 'e1', kind: 'fill', ...field },
    { id: 'e2', kind: 'click', ...field, label: 'Open 目的地' },
    ...keys.map((key, index) => ({
      id: `e${index + 3}`,
      kind: 'press_key' as const,
      key,
      ...field,
      label: `目的地 → ${key}`,
    })),
    { id: 'wait', kind: 'wait', label: 'Wait for the page to update' },
  ]
  return {
    url: 'https://www.ctrip.com/',
    title: '携程旅行网',
    w: 1120,
    h: 780,
    text: '目的地/酒店名称',
    scroll: { y: 0, height: 1000 },
    actions,
    // The whole-page marker, as the observation recorded it. Every answer the connection gives
    // for the marker differs from this one, which is the "the page moved" case under test.
    marker: ['start', 'https://www.ctrip.com/', 0, 0, 1120, 780, '携程旅行网'],
    page_key: [[1, 'https://www.ctrip.com/', 0, 0, 1120, 780, []]],
    guards: { '7': ['destination-field', 'textbox', '目的地', '生命科学园'] },
    omitted_actions: 0,
    fingerprint: 'fp-1',
  }
}

/**
 * One CDP connection, answering the three expressions `act` sends and remembering the input
 * events it dispatched. The guard and the marker are answered from one place so a test can see
 * which of the two decided the step.
 */
class ScriptedConnection implements HeldSocket {
  /** Every `Input.*` event the run dispatched, in order. */
  readonly dispatched: Array<Record<string, unknown>> = []
  /** Every expression the run evaluated, so a test can assert what it asked. */
  readonly evaluated: string[] = []

  constructor(private readonly page: PageState) {}

  async send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    if (method === 'Target.createTarget') return { targetId: 'target-1' } as T
    if (method === 'Target.attachToTarget') return { sessionId: 'session-1' } as T
    if (method === 'Runtime.evaluate') {
      const expression = String(params?.expression ?? '')
      this.evaluated.push(expression)
      // The target's own guard: the very pair the observation recorded, so it matches. Matched by
      // the page-key call, which is what tells this expression from the target lookup below — that
      // one asks the page for a guard as well, so `c.guard` alone no longer names this question.
      if (expression.includes('c.pageKey')) {
        return { result: { value: [this.page.page_key, this.page.guards['7']] } } as T
      }
      // Where the action is aimed: still connected, still hit-testable.
      if (expression.includes('isConnected')) return { result: { value: { x: 5, y: 6 } } } as T
      // The whole page: answered as different on every call, which is the page under test.
      if (expression.includes('semantics')) {
        return { result: { value: ['later', 'https://www.ctrip.com/', 0, 0, 1120, 780, '重绘后的标题'] } } as T
      }
      return { result: { value: 'complete' } } as T
    }
    if (method === 'Input.dispatchKeyEvent') {
      this.dispatched.push({ ...(params ?? {}) })
      return {} as T
    }
    if (method === 'Input.dispatchMouseEvent') {
      this.dispatched.push({ ...(params ?? {}) })
      return {} as T
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
  const session = await BrowserSession.open('https://www.ctrip.com/', { cdpUrl: CDP, connection: 'daily' })
  return { session, connection, page }
}

afterEach(() => {
  // The holder is module state: a test that left a connection in it would decide the next one.
  clearHeld()
  setHeldConnector(null)
  clearAttached()
})

describe('a key on a page that keeps repainting', () => {
  it('presses it while the whole-page marker has already moved on', async () => {
    const { session, connection, page } = await attached()
    try {
      const enter = page.actions.find((action) => action.kind === 'press_key' && action.key === 'enter')!
      const result = await act(session, page, enter)
      expect(result.executed).toBe(enter.id)
      // Focus first: the page's own candidate list listens on the field, not on the document.
      expect(connection.dispatched.map((event) => event.type)).toEqual([
        'mousePressed',
        'mouseReleased',
        'keyDown',
        'keyUp',
      ])
      expect(connection.dispatched[2]).toMatchObject({
        type: 'keyDown',
        key: 'Enter',
        code: 'Enter',
        windowsVirtualKeyCode: 13,
        nativeVirtualKeyCode: 13,
        text: '\r',
      })
      expect(connection.dispatched[3]).toEqual({ ...connection.dispatched[2], type: 'keyUp' })
      // The guard was asked about rather than the marker, which is what let the press through. The
      // page-key call is the same discriminator the connection answers by: only this question asks
      // for the page key and the target's guard together.
      expect(connection.evaluated.some((expression) => expression.includes('c.pageKey'))).toBe(true)
      expect(connection.evaluated.some((expression) => expression.includes('semantics'))).toBe(false)
    } finally {
      await session.close()
    }
  })

  it('still refuses a step that is judged by that same moved marker', async () => {
    const { session, page } = await attached()
    try {
      const wait = page.actions.find((action) => action.kind === 'wait')!
      await expect(act(session, page, wait)).rejects.toBeInstanceOf(StalePage)
    } finally {
      await session.close()
    }
  })
})
