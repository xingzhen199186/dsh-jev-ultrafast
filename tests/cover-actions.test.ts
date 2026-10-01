/**
 * The two ways out of a cover, as the option space sees them.
 *
 * What a run does with a target the page will not be clicked through is decided here rather than in
 * the browser: the refusal itself is measured in `browser/act.ts` (and covered by
 * `covered-target.test.ts`), and what turns it into something the model can choose is the copy of
 * the page built by `withCoverActions`. The one thing that matters for the whole mechanism is that
 * the copy is a copy: the observation the run judges itself by — the address and the element table
 * `repeatedActionState` reads, the guards a freshness check compares — stays exactly what the
 * browser returned.
 */
import { describe, expect, it } from 'vitest'
import type { PageState, SnapshotAction } from '../src/browser/session'
import {
  COVER_ESCAPE_AFTER,
  COVER_ESCAPE_LABEL,
  coverAfter,
  withCoverActions,
  withCoverCandidates,
  type CoverRecord,
} from '../src/browser/act'
import { actionSpace, trimActionSpace } from '../src/decision/action-space'
import { requestChars } from '../src/decision/typesafe'
import { MAX_ELEMENTS, MAX_REQUEST_CHARS } from '../src/prompts'

const target: SnapshotAction = { id: 'e1', kind: 'click', node: 1, label: ' 欢迎度排序' }
const elsewhere: SnapshotAction = { id: 'e2', kind: 'click', node: 2, label: '地点' }

function observed(actions: SnapshotAction[] = [target, elsewhere], guards: Record<string, unknown> = {}): PageState {
  return {
    url: 'https://hotels.ctrip.com/hotels/list?city=1',
    title: '酒店列表',
    w: 1120,
    h: 780,
    text: '欢迎度排序',
    scroll: { y: 0, height: 2000 },
    actions,
    marker: [],
    page_key: [],
    guards,
    omitted_actions: 0,
    fingerprint: 'fp-1',
  }
}

/** The cover of the real run: a dialog named 关闭, in the way of the sort control. */
const cover: CoverRecord = {
  covering: { tag: 'DIV', role: 'dialog', label: '关闭', node: 9, guard: ['guard', 1] },
  target: '1',
  times: 1,
}

describe('the candidates a cover adds', () => {
  it('adds the element that stood over the target, and one press aimed at it', () => {
    const page = observed()
    const view = withCoverActions(page, cover)
    const space = actionSpace(view.actions)

    // The element the page would not be clicked through, numbered after the page's own table, with
    // both operations it now answers to: the click the model may choose, and the press.
    const entry = space.elements.find((element) => element.label === '关闭')!
    expect(space.elements).toHaveLength(3)
    expect(entry).toMatchObject({ index: '3', operations: ['CLICK', 'PRESS_KEY'], role: 'dialog' })
    expect(space.targets.CLICK!['3']).toMatchObject({ kind: 'click', node: 9, label: '关闭' })
    expect(space.targets.PRESS_KEY!['3:escape']).toMatchObject({
      kind: 'press_key',
      key: 'escape',
      node: 9,
      label: COVER_ESCAPE_LABEL,
    })
    // Exactly one press, under exactly one key: a second would be the same choice twice.
    expect(Object.keys(space.targets.PRESS_KEY!)).toEqual(['3:escape'])
    // The page's own candidates are all still there, in their own order and with their own numbers.
    expect(space.elements.slice(0, 2).map((element) => element.label)).toEqual([' 欢迎度排序', '地点'])
    expect(Object.keys(space.targets.CLICK!)).toEqual(['1', '2', '3'])
    // The observation itself is untouched — that is the page the run judges a step by.
    expect(page.actions).toEqual([target, elsewhere])
    expect(page.guards).toEqual({})
    // The guard the freshness check will compare rides with the candidate: the element was never in
    // a snapshot, so nothing else could tell the check it is still the same element.
    expect(view.guards['9']).toEqual(['guard', 1])
  })

  it('does not list an element the page already offered, and adds only the half that is missing', () => {
    const listed: SnapshotAction = { id: 'e9', kind: 'click', node: 9, label: '关闭' }
    const page = observed([target, listed], { '9': ['guard', 9] })
    const view = withCoverActions(page, cover)

    // One element, one number: the click the page listed is not listed again beside it, so the model
    // is not offered two rows for the one thing it has to choose.
    expect(view.actions.filter((action) => action.node === 9 && action.kind === 'click')).toHaveLength(1)
    expect(view.actions.filter((action) => action.node === 9)).toHaveLength(2)
    const space = actionSpace(view.actions)
    expect(space.elements.filter((element) => element.label === '关闭')).toHaveLength(1)
    expect(space.elements.find((element) => element.label === '关闭')!.operations).toEqual(['CLICK', 'PRESS_KEY'])
    // The page's own guard for that element wins where there is one: it was read later than the
    // refusal that carried the other.
    expect(view.guards['9']).toEqual(['guard', 9])
    // Reading the same page twice adds nothing: the second pass is the same table.
    expect(withCoverActions(view, cover).actions).toHaveLength(view.actions.length)
  })

  it('offers nothing until a target has been refused that way', () => {
    const page = observed()
    // The threshold is one refusal, and the first one that reaches the question is already enough —
    // see `COVER_ESCAPE_AFTER` for why waiting for a second would spend the attempts it exists for.
    expect(COVER_ESCAPE_AFTER).toBe(1)
    expect(withCoverActions(page, { ...cover, times: 0 })).toBe(page)
    expect(withCoverActions(page, { ...cover, times: COVER_ESCAPE_AFTER })).not.toBe(page)
  })

  it('counts the refusals of one target, and starts over for another', () => {
    const first = coverAfter(null, cover.covering, '1')
    expect(first.times).toBe(1)
    expect(first.covering).toEqual(cover.covering)
    // The same target, refused by the same element again: one target the run cannot get past.
    expect(coverAfter(first, cover.covering, '1').times).toBe(2)
    // A different target, or a different element over the same one, is a new cover.
    expect(coverAfter(coverAfter(first, cover.covering, '1'), cover.covering, '2').times).toBe(1)
    expect(coverAfter(first, { ...cover.covering, node: 10 }, '1').times).toBe(1)
  })

  it('leaves a page with nothing to answer exactly as it was', () => {
    const page = observed()
    // No cover at all: every request of a run that never met one, and the very object the browser
    // returned rather than a copy of it.
    expect(withCoverActions(page, null)).toBe(page)
    // A refusal from a page with no node table to ask: the sentence is all there is to give, which is
    // the behaviour this had before any of it existed.
    expect(withCoverActions(page, { ...cover, covering: { tag: 'DIV', role: '', label: '位置' } })).toBe(page)
  })

  it('names an element the page gave no name for by nothing at all, and still says what the press does', () => {
    // The rule the sentence follows holds for the candidate too: nothing is invented to fill the
    // page's own gaps. The press carries its own words, which are the action's and not a name.
    const bare: CoverRecord = { covering: { tag: 'SPAN', role: '', label: '', node: 9, guard: null }, target: '1', times: 1 }
    const space = actionSpace(withCoverActions(observed(), bare).actions)

    expect(space.elements[2]).toMatchObject({ index: '3', label: '', operations: ['CLICK', 'PRESS_KEY'] })
    expect(space.targets.PRESS_KEY!['3:escape']!.label).toBe(COVER_ESCAPE_LABEL)
  })
})

/**
 * The same two candidates, against the cut.
 *
 * One request carries a selection of the page's own table whenever that table is over the cap (see
 * `trimActionSpace`), and the two candidates are appended to the *end* of it — so a table that reaches
 * the cap is a table that loses them first, and it is the very page this mechanism was written for: a
 * page that hides a target behind a layer is a page with controls behind that layer. What the run does
 * about it is `withCoverCandidates`, which answers after the cut rather than before it.
 */

/** The page's own controls: enough of them to fill the cap, none of them the element a cover stands on. */
function crowd(count: number): SnapshotAction[] {
  return Array.from({ length: count }, (_unused, at) => ({
    id: `e${at + 1}`,
    kind: 'click' as const,
    node: at + 1,
    label: `Option ${at + 1}`,
  }))
}

/** The cover of that page: a dialog the page never listed, standing over the first control. */
const overlay: CoverRecord = {
  covering: { tag: 'DIV', role: 'dialog', label: '关闭', node: 99, guard: ['guard', 1] },
  target: '1',
  times: 1,
}

const GOAL = 'Find a flight'

describe('the candidates a cover keeps', () => {
  it('puts both ways out back into a table the cut had filled to its cap', () => {
    const page = observed(crowd(MAX_ELEMENTS))
    const before = actionSpace(withCoverActions(page, overlay).actions)
    // The page's own controls fill the cap, and the cover's row — minted last, so it loses every tie it
    // cannot win on a label — is what the cut takes away: this is the bug, in one table.
    expect(before.elements).toHaveLength(MAX_ELEMENTS + 1)
    expect(before.elements.at(-1)).toMatchObject({ index: String(MAX_ELEMENTS + 1), label: '关闭' })
    const cut = trimActionSpace(before, GOAL, [], MAX_ELEMENTS)
    expect(cut.space.elements).toHaveLength(MAX_ELEMENTS)
    expect(cut.space.elements.some((element) => element.label === '关闭')).toBe(false)
    expect(cut.space.targets.PRESS_KEY).toBeUndefined()
    expect(cut.omitted).toBe(1)

    const kept = withCoverCandidates(cut, before)
    // Both are back, at the number the frame gave that element — the number does not depend on whether
    // the cut kept it — with the row they hang off, and one row above the cap is the whole cost.
    expect(kept.space.elements).toHaveLength(MAX_ELEMENTS + 1)
    expect(kept.space.elements.at(-1)).toMatchObject({
      index: String(MAX_ELEMENTS + 1),
      label: '关闭',
      operations: ['CLICK', 'PRESS_KEY'],
      role: 'dialog',
    })
    expect(kept.space.targets.CLICK![String(MAX_ELEMENTS + 1)]).toMatchObject({ kind: 'click', node: 99, label: '关闭' })
    expect(kept.space.targets.PRESS_KEY![`${MAX_ELEMENTS + 1}:escape`]).toMatchObject({
      kind: 'press_key',
      key: 'escape',
      node: 99,
      label: COVER_ESCAPE_LABEL,
    })
    // The count follows the table rather than the cap: one row is no longer left out.
    expect(kept.omitted).toBe(0)
    // The page's own entries keep their own numbers and their own order, and the table the cut returned
    // is not written through by reading it this way.
    expect(kept.space.elements.slice(0, MAX_ELEMENTS).map((element) => element.index)).toEqual(
      Array.from({ length: MAX_ELEMENTS }, (_unused, at) => String(at + 1)),
    )
    expect(cut.space.elements).toHaveLength(MAX_ELEMENTS)
    expect(cut.omitted).toBe(1)

    // What the exception costs the body the service receives, measured the way the run measures it:
    // 2,203 characters more than the same table without them, and most of it is not the two candidates.
    // The escape is what puts the whole PRESS_KEY question — its criterion and the shared next-step
    // rules — into a request that had no press-key candidate at all; the criterion itself is 62 of it.
    // The bound is deliberately loose: what this pins down is the order of the cost, so that a change
    // making one candidate cost a question of its own is caught rather than discovered in a run.
    const context = { goal: GOAL, page, history: [] }
    const cost = requestChars(kept.space, context, 'jev-latest') - requestChars(cut.space, context, 'jev-latest')
    expect(cost).toBeGreaterThan(2_000)
    expect(cost).toBeLessThan(3_000)
    // And the body is nowhere near the cap the run holds it to, with the exception already in it.
    expect(requestChars(kept.space, context, 'jev-latest')).toBeLessThanOrEqual(MAX_REQUEST_CHARS)
  })

  it('leaves a table that kept the candidates exactly as it was', () => {
    const page = observed()
    const before = actionSpace(withCoverActions(page, overlay).actions)
    const cut = trimActionSpace(before, GOAL, [], MAX_ELEMENTS)

    // Nothing was cut — three entries against a cap of 48 — so there is nothing to put back, and the
    // very table the cut returned is the table the question is built from: the behaviour this had
    // before the cut could reach them at all.
    expect(before.elements).toHaveLength(3)
    expect(cut.omitted).toBe(0)
    expect(withCoverCandidates(cut, before)).toBe(cut)
  })

  it('brings back the row a listed covering element needs, and only the half the run added', () => {
    // The other half of the rule above: the page did list the covering element, so the run added only
    // the half that was missing, and the cut took the row both halves hang off. What comes back is the
    // half that is the run's own; the page's own click was the cut's to take and stays taken.
    const page = observed([...crowd(MAX_ELEMENTS), { id: 'e99', kind: 'click', node: 99, label: '关闭' }])
    const before = actionSpace(withCoverActions(page, overlay).actions)
    const cut = trimActionSpace(before, GOAL, [], MAX_ELEMENTS)
    expect(cut.space.elements).toHaveLength(MAX_ELEMENTS)
    expect(cut.omitted).toBe(1)

    const kept = withCoverCandidates(cut, before)
    expect(kept.space.elements).toHaveLength(MAX_ELEMENTS + 1)
    expect(kept.space.elements.at(-1)).toMatchObject({ index: String(MAX_ELEMENTS + 1), label: '关闭' })
    expect(kept.space.targets.CLICK?.[String(MAX_ELEMENTS + 1)]).toBeUndefined()
    expect(kept.space.targets.PRESS_KEY![`${MAX_ELEMENTS + 1}:escape`]).toMatchObject({ node: 99, key: 'escape' })
    expect(kept.omitted).toBe(0)
  })

  it('is inert for a table the run added nothing of its own to', () => {
    // The switch off is exactly this shape: the refusal is still recorded and still said, but nothing of
    // the run's own ever reaches the table, so the cut's own answer is the answer.
    const page = observed(crowd(MAX_ELEMENTS))
    const before = actionSpace(page.actions)
    const cut = trimActionSpace(before, GOAL, [], MAX_ELEMENTS)
    expect(cut.space.elements).toHaveLength(MAX_ELEMENTS)
    expect(cut.omitted).toBe(0)
    expect(withCoverCandidates(cut, before)).toBe(cut)
  })
})
