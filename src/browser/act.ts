/**
 * Execute one decision against the page.
 *
 * Ported from jev-ultrafast `jev_ultrafast/browser.py`
 * (https://github.com/browser-use/jev-ultrafast, MIT, Copyright (c) 2026 Browser
 * Use), the `act` branch. Three upstream rules are load-bearing and kept:
 *
 *  1. The target is re-checked for presence, disabled state, visibility,
 *     geometry and occlusion *immediately* before the input — never from the
 *     geometry the model saw.
 *  2. A browser mutation is never retried. A failed click may have fired its
 *     handler; repeating it would double-apply it.
 *  3. The action is logged by the caller before the result is observed.
 */
import type { TraceSink } from '../artifacts'
import type { BrowserPort, PageState, SnapshotAction } from './session'
import { StalePage } from './session'

/** A select that may already have fired its change event; retrying could double-apply it. */
export class ExecutionInterrupted extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ExecutionInterrupted'
  }
}

export interface ActResult {
  /** The id of the action that was executed, for the run log. */
  executed: string
}

/**
 * What the page answered when a press asked which element it had focused.
 *
 * Three values rather than two, because "this element is not the focus" and "the question could
 * not be answered" are different facts about the page and the same decision for the press: only
 * `yes` skips the click, while `no` and `unknown` both fall back to it. Running the two together
 * is what leaves the 携程 question — did the key even reach the field? — unanswerable after the
 * fact, so the trace keeps them apart even though the branch does not need them apart.
 */
export type FocusReading = 'yes' | 'no' | 'unknown'

/** Where the wheel lands. Upstream used one fixed point; scroll position is not a target. */
export const WHEEL = { x: 550, y: 650 } as const

/**
 * The keys a field can be driven with, as CDP wants them spelled.
 *
 * They exist because a site's autocomplete list is often plain markup the snapshot cannot
 * name: on 携程 the candidate rows never entered the element table, so the only way to pick
 * one was the keyboard the page itself advertises.
 *
 * `text` is the character the key contributes, and CDP only types one when the event carries
 * it: of the keys here, exactly Enter (`\r`) and Tab (`\t`) contribute one. Escape and the
 * arrows contribute none, so no `text` is invented for them — an event that carried one would
 * type a character into the page that the reader never asked for. `nativeVirtualKeyCode` is
 * the platform's own code for the key, and upstream (`browser_harness` `helpers.py`, whose
 * `press_key` this table is the port of) sends the same number as `windowsVirtualKeyCode` on
 * every key, which is what keeps the synthetic event reading as a real one to a page that
 * inspects the platform code.
 */
export const PRESS_KEYS: Record<
  string,
  { key: string; code: string; windowsVirtualKeyCode: number; nativeVirtualKeyCode: number; text?: string }
> = {
  enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: '\r' },
  escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 },
  tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9, text: '\t' },
  arrowdown: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40, nativeVirtualKeyCode: 40 },
  arrowup: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38, nativeVirtualKeyCode: 38 },
}

/**
 * The CDP events for one named key: the press and then the release.
 *
 * A name outside the table is refused rather than quietly dropped, because a key that never
 * lands is indistinguishable from a page that ignored the step.
 */
export function keyEvents(name: string): Array<Record<string, unknown>> {
  const spec = PRESS_KEYS[name]
  if (!spec) throw new Error(`不支持的按键：${name || '(未给出)'}；只支持 ${Object.keys(PRESS_KEYS).join('、')}`)
  const params: Record<string, unknown> = {
    key: spec.key,
    code: spec.code,
    windowsVirtualKeyCode: spec.windowsVirtualKeyCode,
    nativeVirtualKeyCode: spec.nativeVirtualKeyCode,
  }
  // The field is left off keys that contribute no character, rather than sent as an empty
  // string: "this key types nothing" and "this key types nothing yet" are not the same event.
  if (spec.text !== undefined) params.text = spec.text
  return [
    { type: 'keyDown', ...params },
    { type: 'keyUp', ...params },
  ]
}

/** Check freshness, execute, and record that a mutation just happened. */
export async function act(
  session: BrowserPort,
  page: PageState,
  action: SnapshotAction,
  text?: string,
  /**
   * The run's own trace channel, the same one the model exchanges are written to. Optional
   * because a run that is not recording has no directory to write into, and because a press
   * is the only action with something here worth saying.
   */
  trace?: TraceSink,
): Promise<ActResult> {
  if (!(await session.fresh(page, action))) {
    throw new StalePage('页面已经变化，这次决定不能再执行，请重新观察')
  }
  if (action.kind === 'wait') await delay(100)
  const result = await execute(session, action, text, trace)
  session.noteInput(action)
  return result
}

async function execute(
  session: BrowserPort,
  action: SnapshotAction,
  text?: string,
  trace?: TraceSink,
): Promise<ActResult> {
  if (action.kind === 'scroll') {
    await session.call('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x: WHEEL.x,
      y: WHEEL.y,
      deltaX: 0,
      deltaY: action.delta ?? 0,
    })
    return { executed: action.id }
  }
  if (action.kind === 'wait') return { executed: action.id }

  if (typeof action.node !== 'number') throw new Error('这个目标不是页面上已经观察到的元素')
  const target = await resolveTarget(session, action)
  if (target === null) {
    if (action.kind === 'select') throw new ExecutionInterrupted('下拉框的执行没有得到确认，重试前请先重新观察')
    throw new StalePage('目标已经变化或被遮挡，请重新观察')
  }
  if (action.kind === 'select') return { executed: action.id }

  const { x, y } = target
  // A key lands on whatever the page itself has focused, and the click is only one way of getting
  // there. On 携程 (2026-10-02) the field the run had just typed into was still that focus, and the
  // click aimed at it again is what brought the candidate list back a moment later with nothing in
  // it highlighted. So a press asks first: a target the page already has focused is pressed where it
  // is, and every other answer — a target that is not the focus, and a question that could not be
  // answered at all — is clicked into it, exactly as this path did before it could ask.
  const focus: FocusReading | null = action.kind === 'press_key' ? await isFocused(session, action) : null
  const clicked = focus !== 'yes'
  if (clicked) {
    for (const type of ['mousePressed', 'mouseReleased'] as const) {
      await session.call('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 })
    }
  }
  // What the branch just decided, written down before the key is dispatched: "the field already had
  // the focus, so no click was sent" and "it did not, so one was" leave the same page behind, and a
  // reader who wants to tell them apart afterwards has nothing on the page to tell them apart with.
  // A press is the only kind of step that reaches here with an answer, so this is the only kind that
  // writes a record; the fields are the branch's own, and nothing off the page goes in.
  if (focus !== null) {
    trace?.write({
      at: Date.now(),
      kind: 'press_key',
      node: action.node,
      key: String(action.key ?? ''),
      focus,
      clicked,
    })
  }
  if (action.kind === 'fill') {
    // Select what is already in the field first, so typing replaces rather than appends.
    const modifiers = process.platform === 'darwin' ? 4 : 2
    await session.call('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 'a',
      code: 'KeyA',
      modifiers,
      commands: ['selectAll'],
    })
    await session.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers })
    await session.call('Input.insertText', { text: text ?? '' })
  }
  if (action.kind === 'press_key') {
    // The key goes to the page rather than to the element, and a page's own popup list listens on
    // the field it hangs off rather than on the document — which is why the focus the check above
    // protects is the thing this press is riding on.
    for (const params of keyEvents(String(action.key ?? ''))) {
      await session.call('Input.dispatchKeyEvent', params)
    }
  }
  return { executed: action.id }
}

/**
 * Whether the observed element is what the page has focused right now — and whether that could be
 * asked at all.
 *
 * Read through the same channel the target itself comes from, and only for a press: a target that
 * is already the focus is pressed where it stands, so the click that used to precede every press
 * — and could land on a wrapper, or take the focus away from the field it was meant to keep it on
 * — is not sent at all.
 *
 * A query that cannot be answered (the element detached, the page mid-navigation, the connection
 * refusing) comes back `unknown` rather than throwing, and does not skip the click: a focus nobody
 * can read is not evidence of one, and the click it falls back to is what this path did before it
 * could ask. `unknown` is kept apart from `no` for whoever reads the run's trace rather than for
 * the branch — the two act alike, and only one of them means the page answered.
 */
async function isFocused(session: BrowserPort, action: SnapshotAction): Promise<FocusReading> {
  try {
    const response = await session.call<{ result?: { value?: unknown }; exceptionDetails?: unknown }>(
      'Runtime.evaluate',
      {
        expression: focusSource(action),
        returnByValue: true,
      },
    )
    // A page that answered with an exception did not answer the question: it is the same "cannot
    // tell" as a connection that refused, and no more evidence of a focus than that.
    if (response.exceptionDetails) return 'unknown'
    const value = response.result?.value
    if (value === true) return 'yes'
    return value === false ? 'no' : 'unknown'
  } catch {
    return 'unknown'
  }
}

/**
 * The same element lookup the target comes from, asked the one question the press cares about.
 *
 * An element that is no longer in the page's own table answers `null` rather than `false`: "not
 * there" is a question that could not be answered, while `false` is the element being there and
 * simply not being the focus. Both are clicked into, and only a trace can tell them apart.
 */
function focusSource(action: SnapshotAction): string {
  return `(action => {
  const e=window.__jevFast?.nodes.get(action.node);
  if (!e) return null;
  return e === document.activeElement;
})(${JSON.stringify(action)})`
}

/**
 * Re-resolve the target against the live document. A native `<select>` is set
 * here, inside the same evaluation that validated it, so nothing can slip in
 * between the check and the change.
 */
async function resolveTarget(session: BrowserPort, action: SnapshotAction): Promise<{ x: number; y: number } | null> {
  const response = await session.call<{
    result?: { value?: { x: number; y: number } | null }
    exceptionDetails?: unknown
  }>('Runtime.evaluate', { expression: targetSource(action), returnByValue: true })
  if (response.exceptionDetails) {
    if (action.kind === 'select') throw new ExecutionInterrupted('下拉框的执行被页面打断，重试前请先重新观察')
    throw new StalePage('页面在取值过程中发生了变化')
  }
  return response.result?.value ?? null
}

function targetSource(action: SnapshotAction): string {
  return `(action => {
  const e=window.__jevFast?.nodes.get(action.node);
  if (!e?.isConnected || e.matches(':disabled') || e.closest('[aria-disabled="true"],[inert]') ||
      !e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})) return null;
  if (action.kind==='fill' && (e.readOnly || e.getAttribute('aria-readonly')==='true')) return null;
  const r=e.getBoundingClientRect(), x=r.x+r.width/2, y=r.y+r.height/2;
  if (!r.width || !r.height || x<0 || y<0 || x>=innerWidth || y>=innerHeight) return null;
  if (!e.contains(document.elementFromPoint(x,y))) return null;
  if (action.kind==='select') {
    if (e.tagName!=='SELECT' || ![...e.options].some(o=>o.value===action.value &&
        !o.disabled && !o.closest('optgroup[disabled]'))) return null;
    e.value=action.value;
    e.dispatchEvent(new Event('input',{bubbles:true}));
    e.dispatchEvent(new Event('change',{bubbles:true}));
  }
  return {x,y};
})(${JSON.stringify(action)})`
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
