import { describe, expect, it } from 'vitest'
import type { SnapshotAction } from '../src/browser/session'
import { deadEndNote, nextDeadEnds } from '../src/dead-ends'
import { actionSpace, elementIndicesForKeys, withoutElements } from '../src/decision/action-space'
import type { DecisionContext } from '../src/decision/typesafe'
import { buildQuestionnaire } from '../src/decision/typesafe'

/**
 * The dead ends the run keeps out of the questions that offer candidates, and the one thing that has
 * to be true of the request it builds from it: the number is still in the element table and is nowhere
 * among the criteria, in any question.
 *
 * Why this rule exists at all, and why a sentence to the model is not the way to do it, is written
 * down in `src/dead-ends.ts`; these tests pin the judgement itself and the removal it feeds.
 */

describe('dead ends', () => {
  it('marks the element the last step acted on when the screen did not move', () => {
    const next = nextDeadEnds(new Set(), { target: '4', page_changed: false }, 12)
    expect([...next]).toEqual(['4'])
  })

  it('keeps the same element identity when its display index changes', () => {
    const next = nextDeadEnds(new Set(), { target: '9', element_key: 'node:42', page_changed: false }, 12)
    expect([...next]).toEqual(['node:42'])
  })

  it('marks a field that took text and showed nothing for it', () => {
    // A page's address and element table do not move because a value was entered, so a step that
    // typed into a field and changed nothing reads as no change — and that is the point: the field
    // that swallowed the text is the one to set aside for a step.
    const next = nextDeadEnds(new Set(), { target: '2', page_changed: false }, 9)
    expect([...next]).toEqual(['2'])
  })

  it('reads a dropdown option or a key as the element it belongs to', () => {
    // `4:2` is option 2 of element 4 and `4:enter` is a key pressed on element 4; both are element 4,
    // and it is the element that leaves the table, never one of its targets alone.
    expect([...nextDeadEnds(new Set(), { target: '4:2', page_changed: false }, 9)]).toEqual(['4'])
    expect([...nextDeadEnds(new Set(), { target: '4:enter', page_changed: false }, 9)]).toEqual(['4'])
  })

  it('forgets every dead end the moment the screen really moves', () => {
    const before = new Set(['3', '5'])
    expect([...nextDeadEnds(before, { target: '6', page_changed: true }, 12)]).toEqual([])
  })

  it('keeps accumulating for as long as the screen stands still', () => {
    let dead = new Set<string>()
    for (const target of ['1', '2', '3']) dead = nextDeadEnds(dead, { target, page_changed: false }, 20)

    expect([...dead]).toEqual(['1', '2', '3'])
  })

  it('stops taking elements out once only five are left to choose from', () => {
    // Six elements: the first one out leaves exactly five, and the second may not be taken because
    // that would leave four.
    let dead = new Set<string>()
    dead = nextDeadEnds(dead, { target: '1', page_changed: false }, 6)
    dead = nextDeadEnds(dead, { target: '2', page_changed: false }, 6)

    expect([...dead]).toEqual(['1'])
    expect(6 - dead.size).toBe(5)
    // Pressed again, the element already ruled out does not spend any room either.
    expect([...nextDeadEnds(dead, { target: '1', page_changed: false }, 6)]).toEqual(['1'])
  })

  it('touches nothing at all on a table that is already down to five', () => {
    expect([...nextDeadEnds(new Set(), { target: '1', page_changed: false }, 5)]).toEqual([])
    expect([...nextDeadEnds(new Set(), { target: '1', page_changed: false }, 1)]).toEqual([])
    expect([...nextDeadEnds(new Set(), { target: '1', page_changed: false }, 0)]).toEqual([])
  })

  it('says nothing on the first step', () => {
    expect([...nextDeadEnds(new Set(), null, 12)]).toEqual([])
    expect([...nextDeadEnds(new Set(), undefined, 12)]).toEqual([])
  })

  it('says nothing about an element for a step that had no target, and keeps what it knew', () => {
    // WAIT and a scroll act on no element at all, so they neither rule one out nor forget one.
    const afterWait = nextDeadEnds(new Set(['3']), { target: null, page_changed: false }, 12)

    expect([...afterWait]).toEqual(['3'])
  })

  it('takes nothing out on a step whose change was never read back', () => {
    // `page_changed` is null when the screen after the step could not be observed; a run that cannot
    // read the screen has not learned that anything is a dead end.
    expect([...nextDeadEnds(new Set(), { target: '4', page_changed: null }, 12)]).toEqual([])
  })
})

/**
 * One judgement, two things the run can do with it: take the element out of the candidates, or leave it
 * in and say so. Which of the two happened is part of what the reader is told, because with the removal
 * off saying so is the only thing the judgement does.
 */
describe('what a run says about the dead ends it judged', () => {
  const judged = [
    { step: 2, element: '4', target: '4:enter', label: 'Search' },
    { step: 3, element: '5', target: '5', label: '' },
  ]

  it('says how many were judged, and that they were left in the table', () => {
    expect(deadEndNote(judged, false)).toBe(
      '本次识别到 2 个死路（未排除，仍照原样交给决策服务）：第 2 步的 [4]「Search」、第 3 步的 [5]',
    )
  })

  it('says the same count when they were taken out', () => {
    expect(deadEndNote(judged, true)).toBe(
      '本次识别到 2 个死路（已排除，不再列为候选）：第 2 步的 [4]「Search」、第 3 步的 [5]',
    )
  })

  it('says nothing at all on a run that judged none', () => {
    // An ordinary run must not grow a sentence about a rule that never fired.
    expect(deadEndNote([], false)).toBe('')
    expect(deadEndNote([], true)).toBe('')
  })
})

/**
 * A page where one element carries all four element operations, so a single number can be followed
 * through every copy of the table a request holds: the element list and all four target questions.
 * Nodes are numbered by the page, elements by the code, and node 3 is the element the tests below
 * take out. No label carries a digit, so the index is the only place that number can appear.
 */
const observed: SnapshotAction[] = [
  { id: 'e1', kind: 'click', node: 1, role: 'button', label: 'Search' },
  { id: 'e2', kind: 'click', node: 2, role: 'combobox', label: 'Open Depart' },
  { id: 'e3', kind: 'fill', node: 2, role: 'combobox', label: 'Depart', value: '' },
  { id: 'e4', kind: 'press_key', node: 2, key: 'Enter', label: 'Depart → Enter' },
  { id: 'e5', kind: 'select', node: 2, role: 'combobox', label: 'Cabin → Economy', value: 'economy', current_value: 'Cabin' },
  { id: 'e6', kind: 'click', node: 3, role: 'combobox', label: 'Open Arrive' },
  { id: 'e7', kind: 'fill', node: 3, role: 'combobox', label: 'Arrive', value: '' },
  { id: 'e8', kind: 'press_key', node: 3, key: 'Enter', label: 'Arrive → Enter' },
  { id: 'e9', kind: 'select', node: 3, role: 'combobox', label: 'Cabin → Business', value: 'business', current_value: 'Cabin' },
  { id: 'wait', kind: 'wait', label: 'Wait for the page to update' },
]

const context: DecisionContext = {
  goal: 'Find a one-way flight from Zürich to London',
  page: { url: 'https://example.test/flights', title: 'Flights', text: 'Where from?' },
  history: [],
}

const bodyOf = (excluded: ReadonlySet<string>): string =>
  JSON.stringify(buildQuestionnaire(withoutElements(actionSpace(observed), excluded), context, 'jev-latest').request)

describe('the table a request is built from', () => {
  it('maps a stable node identity to its current display index', () => {
    const reordered = actionSpace([
      { id: 'e9', kind: 'click', node: 9, role: 'button', label: 'Other' },
      { id: 'e3', kind: 'click', node: 3, role: 'combobox', label: 'Arrive' },
    ])
    expect([...elementIndicesForKeys(reordered, new Set(['node:3']))]).toEqual(['2'])
    expect(Object.keys(withoutElements(reordered, new Set(['node:3'])).targets.CLICK!)).toEqual(['1'])
  })

  it('takes the element out of every operation and leaves the element list whole', () => {
    const live = withoutElements(actionSpace(observed), new Set(['3']))

    expect(live.elements.map((element) => element.index)).toEqual(['1', '2', '3'])
    expect(Object.keys(live.targets.CLICK!)).toEqual(['1', '2'])
    expect(Object.keys(live.targets.TYPE_TEXT!)).toEqual(['2'])
    expect(Object.keys(live.targets.PRESS_KEY!)).toEqual(['2:enter'])
    expect(Object.keys(live.targets.SELECT!)).toEqual(['2:1'])
    expect(Object.keys(live.controls)).toEqual(['WAIT'])
  })

  it('does not offer an operation whose every candidate went with the element', () => {
    // Node 2 removed from the page, so element 2 is the only one that can be typed into, pressed a
    // key on or selected from: taking it out of the questions has to take those three questions with
    // it rather than leave questions with no choices in them. The element itself is still listed.
    const only = actionSpace(observed.filter((action) => action.node !== 2))
    const live = withoutElements(only, new Set(['2']))

    expect(live.elements.map((element) => element.index)).toEqual(['1', '2'])
    expect(Object.keys(live.targets.CLICK!)).toEqual(['1'])
    expect(live.targets.TYPE_TEXT).toBeUndefined()
    expect(live.targets.PRESS_KEY).toBeUndefined()
    expect(live.targets.SELECT).toBeUndefined()
  })

  it('leaves the table it was given untouched when there is nothing to take out', () => {
    const space = actionSpace(observed)

    expect(withoutElements(space, new Set())).toBe(space)
    expect(withoutElements(space, new Set(['99']))).toBe(space)
  })

  it('keeps the number in the element list and leaves it in no question at all', () => {
    // What the number looks like when it is still offered, so the assertions below are known to be
    // about this page rather than passing on a request that never had it.
    const whole = bodyOf(new Set())
    expect(whole).toContain('"index":"3"')
    expect(whole).toMatch(/"3":\s*\{/)
    expect(whole).toMatch(/"3:enter":\s*\{/)
    expect(whole).toMatch(/"3:1":\s*\{/)

    const { request } = buildQuestionnaire(withoutElements(actionSpace(observed), new Set(['3'])), context, 'jev-latest')
    const body = JSON.stringify(request)

    // The element list is the page's own, so the number is still in it — once, where it belongs...
    const table = (request.state as { elements: Array<{ index: string }> }).elements
    expect(table.map((element) => element.index)).toEqual(['1', '2', '3'])
    expect(body.split('"index":"3"')).toHaveLength(2)
    // ...and nowhere else as a key: a criterion is written `"3":` or `"3:enter":`, and no entry in
    // the element table ever writes one, so the whole body may be searched as one string.
    expect(body).not.toMatch(/"3(:[^"]*)?"\s*:/)
    // Read one by one as well, so a failure says which question still offers it.
    const questions = request.questions as Record<string, { criteria: Record<string, unknown> }>
    expect(Object.keys(questions)).toEqual([
      'operation',
      'click_target',
      'type_text_target',
      'press_key_target',
      'select_target',
    ])
    for (const [name, question] of Object.entries(questions)) {
      if (name === 'operation') continue
      for (const key of Object.keys(question.criteria)) {
        expect(key === '3' || key.startsWith('3:'), `${name} still offers ${key}`).toBe(false)
      }
    }
    // And then the questions as one string, where the labels only a candidate carried are gone too.
    const questionText = JSON.stringify(request.questions)
    expect(questionText).not.toMatch(/"3(:[^"]*)?"\s*:/)
    expect(questionText).not.toContain('Open Arrive')
    expect(questionText).not.toContain('Cabin → Business')
    expect(questionText).not.toContain('Arrive → Enter')
    // The labels do stay where the element table carries them, so the check above is about the
    // questions rather than about the page being gone.
    expect(body).toContain('Open Arrive')
  })
})
