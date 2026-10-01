/**
 * A key is sent to the focus the field already has, not clicked into it again.
 *
 * The 携程 run of 2026-10-02 typed "生命科学园" into the destination field, put the candidate list
 * on the page with that text in the box, and then had every key fail to move the list: the press
 * was preceded by a click aimed at the same field, and the list came back with nothing highlighted.
 * A field the run has just typed into is the page's own focus already, so the click is the one part
 * of the press that has to be earned rather than sent — and it is only earned when the element is
 * *not* what the page has focused.
 *
 * These checks drive the real `act` over a scripted CDP connection, the way the freshness checks
 * next door do: the connection answers the expressions `act` sends by their shape, reports whether
 * the observed element is the focus, and remembers every input event that reached it. Nothing here
 * touches a browser. The second half of the file reads the record the press left about the same
 * question: which element, which key, what the page answered, and whether a click was paid for.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { act } from '../src/browser/act'
import { clearAttached } from '../src/browser/attached'
import { clearHeld, setHeldConnector, type HeldSocket } from '../src/browser/held'
import { BrowserSession, type PageState, type SnapshotAction } from '../src/browser/session'

const CDP = 'ws://127.0.0.1:9222/devtools/browser/press-key-focus'

/** How the scripted page answers the one question this file is about. */
type FocusMode = 'focus' | 'elsewhere' | 'missing' | 'throw' | 'exception'

/** The page as one run observed it: one editable field, with the key a candidate list is picked with. */
function observed(): PageState {
  const field = { node: 7, role: 'textbox', label: '目的地', value: '生命科学园', rect: { x: 0, y: 0, w: 10, h: 10 } }
  const actions: SnapshotAction[] = [
    { id: 'e1', kind: 'fill', ...field, value: '' },
    { id: 'e2', kind: 'press_key', key: 'enter', ...field, label: '目的地 → enter' },
  ]
  return {
    url: 'https://www.ctrip.com/',
    title: '携程旅行网',
    w: 1120,
    h: 780,
    text: '目的地/酒店名称',
    scroll: { y: 0, height: 1000 },
    actions,
    marker: ['start', 'https://www.ctrip.com/', 0, 0, 1120, 780, '携程旅行网'],
    page_key: [[1, 'https://www.ctrip.com/', 0, 0, 1120, 780, []]],
    guards: { '7': ['destination-field', 'textbox', '目的地', '生命科学园'] },
    omitted_actions: 0,
    fingerprint: 'fp-1',
  }
}

/**
 * One CDP connection, answering the expressions `act` sends and remembering the input events it
 * dispatched. The guard is answered as the observation recorded it, so freshness lets the press
 * through and the only thing under test is what the press is preceded by.
 */
class ScriptedConnection implements HeldSocket {
  /** Every `Input.*` event the run dispatched, in order. */
  readonly dispatched: Array<Record<string, unknown>> = []
  /** Every expression the run evaluated, so a test can assert that it asked rather than assumed. */
  readonly evaluated: string[] = []

  constructor(
    private readonly page: PageState,
    private readonly focus: FocusMode,
  ) {}

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
      // The whole-page marker, answered exactly as the observation recorded it: a fill is judged by
      // it rather than by the field's own guard. Asked before the target lookup below, whose source
      // carries the same `isConnected` this whole snapshot does.
      if (expression.includes('semantics')) return { result: { value: this.page.marker } } as T
      // Where the action is aimed: still connected, still hit-testable.
      if (expression.includes('isConnected')) return { result: { value: { x: 5, y: 6 } } } as T
      // Whether that element is what the page has focused — the question this file varies.
      if (expression.includes('document.activeElement')) {
        if (this.focus === 'throw') throw new Error('the connection went away')
        if (this.focus === 'exception') return { exceptionDetails: { text: 'the page refused' } } as T
        // The element the expression asked about is not in the page's own table any more.
        if (this.focus === 'missing') return { result: { value: null } } as T
        return { result: { value: this.focus === 'focus' } } as T
      }
      return { result: { value: 'complete' } } as T
    }
    if (method === 'Input.dispatchKeyEvent' || method === 'Input.dispatchMouseEvent') {
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

/**
 * The run's own trace channel, kept in memory.
 *
 * A press writes what it asked the page and what it did with the answer, and nothing on the page
 * keeps that afterwards — which is the whole reason the record exists (see `src/browser/act.ts`).
 * The sink is the same interface the model exchanges are written through; the test only needs to
 * hold what it was handed.
 */
class ScriptedTrace {
  readonly records: Array<Record<string, unknown>> = []

  write(record: Record<string, unknown>): void {
    this.records.push(record)
  }
}

/** A session attached over the scripted connection, and the connection it attached over. */
async function attached(focus: FocusMode): Promise<{
  session: BrowserSession
  connection: ScriptedConnection
  page: PageState
  enter: SnapshotAction
}> {
  // The holder is module state and hands the same live socket back to the same address, so a test
  // that opens more than once has to let go of the last one first — otherwise it would be driving
  // the previous connection and asserting on an empty one of its own.
  clearHeld()
  clearAttached()
  const page = observed()
  const connection = new ScriptedConnection(page, focus)
  setHeldConnector(async () => connection)
  const session = await BrowserSession.open('https://www.ctrip.com/', { cdpUrl: CDP, connection: 'daily' })
  return { session, connection, page, enter: page.actions.find((action) => action.kind === 'press_key')! }
}

afterEach(() => {
  // The holder is module state: a test that left a connection in it would decide the next one.
  clearHeld()
  setHeldConnector(null)
  clearAttached()
})

describe('a key on a field the page has already focused', () => {
  it('asks the page which element is focused instead of assuming it is not', async () => {
    const { session, connection, page, enter } = await attached('focus')
    try {
      const result = await act(session, page, enter)

      expect(result.executed).toBe(enter.id)
      // The key alone: no press, no release, nothing that could move the focus or close the list.
      expect(connection.dispatched.map((event) => event.type)).toEqual(['keyDown', 'keyUp'])
      expect(connection.dispatched[0]).toMatchObject({
        type: 'keyDown',
        key: 'Enter',
        code: 'Enter',
        windowsVirtualKeyCode: 13,
        nativeVirtualKeyCode: 13,
        text: '\r',
      })
      expect(connection.dispatched[1]).toEqual({ ...connection.dispatched[0], type: 'keyUp' })
      // The page was asked, over its own channel, rather than the focus being inferred.
      expect(connection.evaluated.some((expression) => expression.includes('document.activeElement'))).toBe(true)
    } finally {
      await session.close()
    }
  })

  it('clicks a field that is not the focus, so the key still lands on it', async () => {
    const { session, connection, page, enter } = await attached('elsewhere')
    try {
      await act(session, page, enter)

      expect(connection.dispatched.map((event) => event.type)).toEqual([
        'mousePressed',
        'mouseReleased',
        'keyDown',
        'keyUp',
      ])
      expect(connection.dispatched[0]).toMatchObject({ x: 5, y: 6, button: 'left', clickCount: 1 })
    } finally {
      await session.close()
    }
  })

  it('treats a focus it cannot read as no focus, and presses anyway', async () => {
    // A query that fails is not evidence that the field is focused: the click is the fallback this
    // path had before it could ask, and a step that needs a key must not fail over the question.
    for (const how of ['throw', 'exception'] as const) {
      const { session, connection, page, enter } = await attached(how)
      try {
        const result = await act(session, page, enter)

        expect(result.executed).toBe(enter.id)
        expect(connection.dispatched.map((event) => event.type)).toEqual([
          'mousePressed',
          'mouseReleased',
          'keyDown',
          'keyUp',
        ])
      } finally {
        await session.close()
      }
    }
  })

  it('still clicks before a field is typed into, where the focus is what the value needs', async () => {
    // The focus check belongs to the press alone: a fill clicks, selects what is there and inserts
    // the text, and none of that changes because the field happened to be focused already.
    const { session, connection, page } = await attached('focus')
    try {
      const fill = page.actions.find((action) => action.kind === 'fill')!
      await act(session, page, fill, '生命科学园')

      expect(connection.dispatched.map((event) => event.type)).toEqual([
        'mousePressed',
        'mouseReleased',
        'keyDown',
        'keyUp',
      ])
      expect(connection.evaluated.some((expression) => expression.includes('document.activeElement'))).toBe(false)
    } finally {
      await session.close()
    }
  })
})

/**
 * What the branch leaves behind for a reader who was not there.
 *
 * The click and the key leave the same page behind whichever way the branch went, so "did the key
 * reach the field at all?" cannot be answered from the page afterwards. These checks are about the
 * trace record alone: which element, which key, what the page answered about the focus, and
 * whether the press paid for a click on the way in.
 */
describe('the record a press leaves about the focus it asked for', () => {
  it('says the target already had the focus, and that no click was sent for it', async () => {
    const { session, page, enter } = await attached('focus')
    const trace = new ScriptedTrace()
    try {
      await act(session, page, enter, undefined, trace)

      expect(trace.records).toEqual([
        { at: expect.any(Number), kind: 'press_key', node: 7, key: 'enter', focus: 'yes', clicked: false },
      ])
    } finally {
      await session.close()
    }
  })

  it('says the focus was somewhere else, and that a click was sent for it', async () => {
    const { session, page, enter } = await attached('elsewhere')
    const trace = new ScriptedTrace()
    try {
      await act(session, page, enter, undefined, trace)

      expect(trace.records).toHaveLength(1)
      expect(trace.records[0]).toMatchObject({ kind: 'press_key', node: 7, key: 'enter', focus: 'no', clicked: true })
    } finally {
      await session.close()
    }
  })

  it('says the question could not be answered, rather than that the target is not the focus', async () => {
    // The three ways the question goes unanswered, and the one thing they share: the record says
    // `unknown`, which is what keeps them out of the same bucket as a real `no`. The click still
    // happens for all three — the fallback is what this path did before it could ask.
    for (const how of ['throw', 'exception', 'missing'] as const) {
      const { session, page, enter } = await attached(how)
      const trace = new ScriptedTrace()
      try {
        await act(session, page, enter, undefined, trace)

        expect(trace.records).toHaveLength(1)
        expect(trace.records[0]).toMatchObject({
          kind: 'press_key',
          node: 7,
          key: 'enter',
          focus: 'unknown',
          clicked: true,
        })
      } finally {
        await session.close()
      }
    }
  })

  it('writes no such record for an action that is not a press', async () => {
    const { session, page } = await attached('focus')
    const trace = new ScriptedTrace()
    try {
      const fill = page.actions.find((action) => action.kind === 'fill')!
      await act(session, page, fill, '生命科学园', trace)

      expect(trace.records).toEqual([])
    } finally {
      await session.close()
    }
  })
})
