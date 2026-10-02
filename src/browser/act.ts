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
import type { ActionSpace, TrimmedSpace } from '../decision/action-space'
import { elementIndexOf } from '../decision/action-space'
import type { BrowserPort, PageState, SnapshotAction } from './session'
import { StalePage } from './session'

/** A select that may already have fired its change event; retrying could double-apply it. */
export class ExecutionInterrupted extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ExecutionInterrupted'
  }
}

/**
 * The element the hit test found on top of a target, when it found one.
 *
 * `tag` and `role` are how the page spells the element, and `label` is a short name for it — the
 * words it shows, or the name it carries — cut to 40 characters, so that a whole dialog's text
 * cannot end up inside a sentence about one click. A cover the page gives no role and no name for is
 * still a cover: those two fields go empty rather than the fact being dropped.
 */
export interface Covering {
  tag: string
  role: string
  label: string
  /**
   * The page's own number for that element, and the guard it gave it, when the page could be asked.
   *
   * Absent together rather than guessed at, and the absence has a meaning: a page read before any
   * snapshot (a stand-in document) has no node table to mint a number from, and an element with no
   * number cannot be offered as a candidate to click — so a run meeting one keeps the sentence and
   * nothing else, which is what this did before the two fields existed (see `withCoverActions`).
   */
  node?: number
  guard?: unknown
}

/**
 * The answer to "press this element" when the element is there and pressable in principle, but
 * something else is standing over it, so the press would have landed on that instead.
 *
 * Kept apart from the `null` the same lookup answers for every other kind of refusal — gone,
 * disabled, hidden, off-screen, the wrong kind of control — because only this one has a culprit,
 * and naming a culprit the page never pointed at is worse than saying nothing.
 */
export interface CoveredTarget {
  reason: 'covered'
  covering: Covering
}

/**
 * A target that is on the page and would be clickable, except that another element is over it.
 *
 * A `StalePage` rather than a new kind of failure, so every place that already re-observes the page
 * for a stale target does the same here without changing a line — the run's `catch` in `../loop.ts`
 * is the caller this is written for. What it adds is the one thing a re-observation cannot show:
 * who was in the way.
 */
export class TargetCovered extends StalePage {
  /** What stood over the target, as one short phrase: `DIV(role=dialog)「位置」`. */
  readonly coverNote: string
  /**
   * The element itself, as the hit test found it — the fact `coverNote` only spells out, kept
   * because a run that wants to offer a way out of the cover needs the number the page gave that
   * element and the guard that goes with it (see `Covering` and `withCoverActions`).
   */
  readonly covering: Covering
  constructor(covering: Covering) {
    const note = coverNote(covering)
    super(`目标被${note}盖住了，点击落不到它身上，请重新观察`)
    this.name = 'TargetCovered'
    this.coverNote = note
    this.covering = covering
  }
}

/**
 * What stood over the target, in one phrase: the tag, its role when it has one, and its name when it
 * has one. An element the page would not identify at all is still a cover and is said as one.
 */
function coverNote(covering: Covering): string {
  const named = covering.tag || '页面上的其它元素'
  const what = covering.role ? `${named}(role=${covering.role})` : named
  return covering.label ? `${what}「${covering.label}」` : what
}

/**
 * What the run keeps about one cover: the element that did it as the page named it, the target it
 * stood over, and how many such refusals that same target has cost since the last step that landed.
 *
 * Kept as its own record rather than left inside the sentence the refusal carries, because the two
 * are used for different things: the sentence is a fact the next request is told (`loop.ts` puts it
 * in `state.note`) and the record is the same fact in the form the model can act on — a candidate.
 * The run this was built from (携程 排序, 2026-10) was told what stood over its target on all seven
 * of its attempts and clicked that target on every one of them.
 */
export interface CoverRecord {
  covering: Covering
  /** The target the run could not click through, as the refusal named it. */
  target: string
  /** Covered refusals of that same target since the last step that landed; the first one is `1`. */
  times: number
}

/**
 * How many covered refusals of one target the run waits through before offering the way out.
 *
 * One, the first refusal, because the hit test that produced it is the browser's own answer about
 * the geometry the model was just shown: a cover the page shows there is already evidence, and
 * waiting for a second one would spend one of the seven attempts `MAX_STALE_RETRIES` allows on the
 * very case those attempts exist for. Two would also be two decisions paid for a fact the run
 * already has.
 */
export const COVER_ESCAPE_AFTER = 1

/** What the extra action says it does, in the words the model reads as a candidate. */
export const COVER_ESCAPE_LABEL = '按 Esc 关掉盖在目标上的浮层'

/**
 * The record one covered refusal leaves behind, given what the run already had.
 *
 * The count follows the target rather than the run's steps: the same target refused by the same
 * element again is one target the run cannot get past, while a refusal of a different target — or an
 * element of its own — is a new cover and starts again at one. That is what `times` is for, and
 * `withCoverActions` is the only reader of it.
 */
export function coverAfter(previous: CoverRecord | null, covering: Covering, target: string): CoverRecord {
  const same =
    previous !== null && previous.target === target && previous.covering.node === covering.node
  return { covering, target, times: previous !== null && same ? previous.times + 1 : 1 }
}

/**
 * The page's own table plus, while a cover is still in the way, the two ways out of it: the element
 * the hit test found, offered as a candidate to click, and one press of Escape aimed at that same
 * element.
 *
 * Both are built the way this project already builds them — a click, and the `PRESS_KEY` action the
 * snapshot mints for a key — rather than as a mechanism of their own, so the option space, the
 * question and the executor read them exactly as they read the page's own controls.
 *
 * An element the page already listed is not listed again: only the halves that are missing are
 * added, so a cover the snapshot could name either way is one element with one number. The result
 * is a copy rather than the observation itself, and that is load-bearing: `repeatedActionState` in
 * `../loop.ts` reads the address and the element table of the page the browser returned, so a
 * candidate the run added on its own account must not enter "has this screen changed" — nor the
 * guards a freshness check compares, which is why the cover's own guard is carried across
 * (`Covering.guard`). Nothing to add returns the very object it was given.
 */
export function withCoverActions(page: PageState, cover: CoverRecord | null): PageState {
  const node = cover?.covering.node
  if (!cover || typeof node !== 'number' || cover.times < COVER_ESCAPE_AFTER) return page
  const listed = page.actions.filter((action) => action.node === node)
  const extra: SnapshotAction[] = []
  if (!listed.some((action) => action.kind === 'click')) extra.push(coverClick(cover, node))
  if (!listed.some((action) => action.kind === 'press_key' && String(action.key ?? '').toLowerCase() === 'escape')) {
    extra.push(coverEscape(cover, node))
  }
  if (extra.length === 0) return page
  return {
    ...page,
    actions: [...page.actions, ...extra],
    // The page's own guard for that element wins where the snapshot has one: it was read later than
    // the refusal that carried this one, and it is the state the freshness check must compare.
    guards: { [String(node)]: cover.covering.guard ?? null, ...page.guards },
  }
}

/**
 * The ids the two candidates are minted under — `cover_click` in `coverClick` and `cover_escape` in
 * `coverEscape` below — as the one thing about them a reader outside this module can name them by
 * (see `withCoverCandidates`). No action taken off a page carries one.
 */
const COVER_ACTION_IDS = new Set(['cover_click', 'cover_escape'])

/**
 * The request's table with a cover's own candidates put back, when the cut has just taken them away.
 *
 * `before` is the table the cut was made from: the page's own elements with those two appended to the
 * end of them. That they are appended is the whole reason this exists — the cut runs over the whole
 * table and keeps the head of its own ordering, so an entry at the end loses every tie it cannot win
 * on a label, and the page where a cover matters most is exactly the page whose table is over the cap.
 * The two candidates this mechanism was built for were therefore the first thing a full table threw
 * away, on the one page the run cannot get through without them.
 *
 * So they go back in after the cut rather than before it, and only they: at the number the frame gave
 * that element, so a candidate's number does not depend on whether the cut kept it; with the element's
 * own row when that went with it, because a number the table does not list is a number the model
 * cannot read; and with the count charged for it. That is the deliberate exception — one row above the
 * cap, and much more than the two criteria lines it was expected to cost, which is worth stating
 * plainly: on a table of 48 the exception measured 2,203 characters in the request body rather than
 * ~140, because the escape is what puts the whole `PRESS_KEY` question — its own criterion and the
 * next-step rules that go with every question — into a request that had no press-key candidate at all.
 * Its size being measured rather than assumed is also why `../loop.ts` measures the body with these
 * already in it: a page whose table is already being cut for its own labels gives up a few more
 * entries, instead of a cap that everything else in the run is held to being quietly exceeded.
 *
 * Nothing else comes back. `before` is the table after the earlier rules have had their say, so a
 * candidate the run itself took out (a dead end, see `../dead-ends.ts`) stays out; and with the switch
 * off the run's own candidates were never in the table, so this answers with the table it was given.
 */
export function withCoverCandidates(cut: TrimmedSpace, before: ActionSpace): TrimmedSpace {
  // Read off `before` rather than rebuilt from the cover record: what belongs here is the very half
  // that was missing — `withCoverActions` adds a click only where the page listed none — and the
  // operation a target key belongs to is the table's own arrangement rather than something to restate.
  const back: Array<{ operation: string; target: string; action: SnapshotAction }> = []
  for (const [operation, group] of Object.entries(before.targets)) {
    for (const [target, action] of Object.entries(group)) {
      if (!COVER_ACTION_IDS.has(action.id)) continue
      // The very object, not an equal one: the cut keeps the actions it was handed.
      if (cut.space.targets[operation]?.[target] === action) continue
      back.push({ operation, target, action })
    }
  }
  if (back.length === 0) return cut

  const index = elementIndexOf(back[0].target)
  const elements = [...cut.space.elements]
  let restored = 0
  if (!elements.some((element) => element.index === index)) {
    // A candidate whose element the frame cannot name is one the model cannot be given: the number
    // would be a number the table does not list, so nothing is invented to fill it.
    const row = before.elements.find((element) => element.index === index)
    if (!row) return cut
    elements.push(row)
    // Back where the frame had it: the table reads in its own order, whatever the cut took out of it.
    elements.sort((left, right) => Number(left.index) - Number(right.index))
    restored = 1
  }
  // A copy of the table rather than the table itself: the space a caller measured, reported or kept is
  // not written through by this.
  const targets: Record<string, Record<string, SnapshotAction>> = {}
  for (const [operation, group] of Object.entries(cut.space.targets)) targets[operation] = { ...group }
  for (const entry of back) (targets[entry.operation] ??= {})[entry.target] = entry.action
  // An element that comes back is one the table no longer leaves out.
  return { space: { elements, targets, controls: cut.space.controls }, omitted: cut.omitted - restored }
}

/** The element that stood over the target, as one more click the model may choose. */
function coverClick(cover: CoverRecord, node: number): SnapshotAction {
  return {
    id: 'cover_click',
    kind: 'click',
    node,
    // The page's own words for it, and nothing where the page gave none — the same rule the
    // sentence follows, so an element with no name is offered as one with no name.
    label: cover.covering.label,
    ...(cover.covering.role ? { role: cover.covering.role } : {}),
  }
}

/**
 * One press of Escape aimed at that element, which is how a page's own overlay listens: the key
 * goes to the page after the click into the element it hangs off, exactly as every other press in
 * this project does (`execute` below).
 */
function coverEscape(cover: CoverRecord, node: number): SnapshotAction {
  return {
    id: 'cover_escape',
    kind: 'press_key',
    key: 'escape',
    node,
    label: COVER_ESCAPE_LABEL,
    ...(cover.covering.role ? { role: cover.covering.role } : {}),
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
    // Written down, not only thrown: this refusal sends the run back to look again, and the trace is
    // the only place that says afterwards why the step did not happen. Which question refused is on
    // `where`, and it is the question `fresh` really asked — an element action is judged by the
    // target's own guard, and only `scroll` and `wait`, which are aimed at no element, by the
    // whole-page marker. The element the action named goes on the record rather than staying
    // implicit in the action the decision chose.
    const aimed = action.kind !== 'scroll' && action.kind !== 'wait'
    trace?.write({
      at: Date.now(),
      kind: 'refused',
      where: aimed ? 'guard' : 'marker',
      why: aimed
        ? '决定瞄准的那个元素已经不是原来那个了（它自己的状态变了），这个动作没发出去'
        : '决定看到的那一页已经不是现在这一页了（整页指纹变了），这个动作没发出去',
      operation: action.kind,
      node: typeof action.node === 'number' ? action.node : null,
      label: action.label,
    })
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
    // The second question a step can fail, and the same treatment as the freshness question above:
    // the element the decision named is no longer there to be acted on, which is a fact about the
    // page that the next observation cannot recover once the page has moved on again.
    trace?.write({
      at: Date.now(),
      kind: 'refused',
      where: 'target',
      why: '这个元素在页面上已经找不到或点不动了（元素重查没过），这个动作没发出去',
      operation: action.kind,
      node: action.node,
      label: action.label,
    })
    if (action.kind === 'select') throw new ExecutionInterrupted('下拉框的执行没有得到确认，重试前请先重新观察')
    throw new StalePage('目标已经变化或被遮挡，请重新观察')
  }
  if ('reason' in target) {
    // The element is there and in view; what kept the press off it is something standing on top.
    // Said with the tag, the role and a short name of whatever that was, because "it is covered"
    // on its own leaves the reader nothing on the page to look at.
    throw new TargetCovered(target.covering)
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
    // A press alone is not a click. The sibling implementation (`dsh-browser`, which drives an
    // Electron view) puts the pointer on the target before pressing, because Chromium routes a
    // synthesised press to the control the view is *currently* hovering rather than to whatever sits
    // at the coordinates: a view that has never received a mouse event has no hover target, and there
    // the first press of a fresh tab went nowhere while CDP still answered success. Every click this
    // plugin sends is a fresh tab's first one, so the pointer goes in first — aimed at the same x/y
    // the in-place geometry just produced, with no second coordinate computed here.
    //
    // Measured on our own path (raw CDP, Edge, 2026-10-02), the first click of a fresh tab landed
    // without this move as well: four runs of the new browser-layer tests below passed with the move
    // commented out, and the move is not what was observed to rescue anything here. What it buys is
    // the hover state a real pointer would have left behind — which is what a control that reveals
    // itself on hover is waiting for — and it is the line those tests would show as missing if this
    // path ever did start losing first clicks.
    await session.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
    // The press may land late, or not at all, and the connection that failed may be the only reason
    // the call did not answer. Either way a release is owed: a button the run left held down is a
    // page that goes on behaving as if a hand were still on it, which every later step inherits. The
    // compensating release is best effort — not awaited, its own failure silent — because what must
    // survive is the failure being reported here, not a second one replacing it.
    const release = (): void => {
      void session.call('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x,
        y,
        button: 'left',
        clickCount: 1,
      }).catch(() => {})
    }
    try {
      await session.call('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
      await session.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
    } catch (error) {
      release()
      throw error
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
 *
 * Three answers rather than two, because "this number is not a pressable element any more" and
 * "this number is exactly where it was, with something else over it" are different facts about the
 * page, and only the second one has an element to name.
 */
async function resolveTarget(
  session: BrowserPort,
  action: SnapshotAction,
): Promise<{ x: number; y: number } | CoveredTarget | null> {
  const response = await session.call<{
    result?: { value?: { x: number; y: number } | CoveredTarget | null }
    exceptionDetails?: unknown
  }>('Runtime.evaluate', { expression: targetSource(action), returnByValue: true })
  if (response.exceptionDetails) {
    if (action.kind === 'select') throw new ExecutionInterrupted('下拉框的执行被页面打断，重试前请先重新观察')
    throw new StalePage('页面在取值过程中发生了变化')
  }
  return response.result?.value ?? null
}

/**
 * The lookup that both validates a target and answers where its centre is.
 *
 * The last check is the one worth telling apart from all the others: every refusal above it says
 * the element cannot be pressed on its own account, while the hit test says the element is fine and
 * the page has put something else over it — the same geometry the model was shown, the same element
 * still on the page, and a press that would land on a different element entirely. The words and the
 * name of whatever that is go back with the refusal, since nothing the run observes next will show
 * the model that this is what happened. A point no element answers for is a refusal like the rest
 * and not a cover: there is an element to name only when the point has one on it.
 */
function targetSource(action: SnapshotAction): string {
  return `(action => {
  const e=window.__jevFast?.nodes.get(action.node);
  if (!e?.isConnected || e.matches(':disabled') || e.closest('[aria-disabled="true"],[inert]') ||
      !e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})) return null;
  if (action.kind==='fill' && (e.readOnly || e.getAttribute('aria-readonly')==='true')) return null;
  const r=e.getBoundingClientRect(), x=r.x+r.width/2, y=r.y+r.height/2;
  if (!r.width || !r.height || x<0 || y<0 || x>=innerWidth || y>=innerHeight) return null;
  const hit=document.elementFromPoint(x,y);
  if (!hit) return null;
  if (!e.contains(hit)) {
    const seen=(hit?.innerText||hit?.textContent||'').replace(/\\s+/g,' ').trim();
    // The number and the guard of the element in the way, minted the way the snapshot mints them:
    // the same counter and the same two maps it keeps on the page, so the element the run names
    // here is the same element a later observation gives the same number to, and the guard is the
    // one a freshness check will compare against. A page with no such table (a stand-in document)
    // answers with neither field rather than with an invented number.
    const c=window.__jevFast;
    let node=null;
    if (c?.ids) { if (!c.ids.has(hit)) c.ids.set(hit,c.next++); node=c.ids.get(hit); c.nodes.set(node,hit); }
    return {reason:'covered',covering:{tag:hit?.tagName||'',role:hit?.getAttribute('role')||'',
      label:(seen||hit?.getAttribute('aria-label')||'').slice(0,40),
      ...(node===null ? {} : {node,guard:typeof c?.guard==='function' ? c.guard(hit) : null})}};
  }
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
