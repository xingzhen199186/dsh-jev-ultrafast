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

/** Where the wheel lands. Upstream used one fixed point; scroll position is not a target. */
export const WHEEL = { x: 550, y: 650 } as const

/**
 * The keys a field can be driven with, as CDP wants them spelled.
 *
 * They exist because a site's autocomplete list is often plain markup the snapshot cannot
 * name: on 携程 the candidate rows never entered the element table, so the only way to pick
 * one was the keyboard the page itself advertises.
 */
export const PRESS_KEYS: Record<string, { key: string; code: string; windowsVirtualKeyCode: number }> = {
  enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 },
  escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
  tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
  arrowdown: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 },
  arrowup: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 },
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
  const params = { key: spec.key, code: spec.code, windowsVirtualKeyCode: spec.windowsVirtualKeyCode }
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
): Promise<ActResult> {
  if (!(await session.fresh(page, action))) {
    throw new StalePage('页面已经变化，这次决定不能再执行，请重新观察')
  }
  if (action.kind === 'wait') await delay(100)
  const result = await execute(session, action, text)
  session.noteInput(action)
  return result
}

async function execute(session: BrowserPort, action: SnapshotAction, text?: string): Promise<ActResult> {
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
  for (const type of ['mousePressed', 'mouseReleased'] as const) {
    await session.call('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 })
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
    // The click above is what puts the focus on the observed element — a page's own popup
    // list listens for keys on the field it hangs off, not on the document.
    for (const params of keyEvents(String(action.key ?? ''))) {
      await session.call('Input.dispatchKeyEvent', params)
    }
  }
  return { executed: action.id }
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
