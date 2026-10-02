import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SnapshotAction } from '../src/browser/session'
import { actionSpace, trimActionSpace } from '../src/decision/action-space'
import { askText, answerText, fieldContext, fieldText, type DshChunk, type TextHelperSource } from '../src/decision/text-helper'
import {
  type CorrectedChoice,
  type DecisionContext,
  InvalidDecision,
  buildQuestionnaire,
  choose,
  readDecision,
  requestChars,
  validateChoice,
} from '../src/decision/typesafe'

/** The observed page these tests decide about: two operations on one node, and a dropdown. */
const observed: SnapshotAction[] = [
  { id: 'e1', kind: 'click', node: 1, role: 'button', label: 'Search' },
  { id: 'e2', kind: 'fill', node: 2, role: 'combobox', label: 'Where from?', value: '' },
  { id: 'e3', kind: 'click', node: 2, role: 'combobox', label: 'Open Where from?', value: '' },
  {
    id: 'e4',
    kind: 'select',
    node: 3,
    role: 'combobox',
    label: 'Trip → One way',
    value: 'oneway',
    current_value: 'Round trip',
  },
  { id: 'e5', kind: 'select', node: 3, role: 'combobox', label: 'Trip → Round trip', value: 'roundtrip' },
  { id: 'scroll_down', kind: 'scroll', label: 'Scroll down', delta: 560 },
  { id: 'wait', kind: 'wait', label: 'Wait for the page to update' },
]

const context: DecisionContext = {
  goal: 'Find a one-way flight from Zürich to London',
  page: { url: 'https://example.test/flights', title: 'Flights', text: 'Where from?' },
  history: [],
}

describe('action space', () => {
  it('keeps one index for a node that both types and clicks', () => {
    const space = actionSpace(observed)
    expect(space.elements).toHaveLength(3)
    expect(space.elements[1]).toMatchObject({ index: '2', label: 'Where from?', operations: ['TYPE_TEXT', 'CLICK'] })
    expect(Object.keys(space.targets.CLICK!)).toEqual(['1', '2'])
    expect(Object.keys(space.targets.TYPE_TEXT!)).toEqual(['2'])
  })

  it('mints its own target for each dropdown option', () => {
    const space = actionSpace(observed)
    expect(Object.keys(space.targets.SELECT!)).toEqual(['3:1', '3:2'])
    expect(space.targets.SELECT!['3:2']!.value).toBe('roundtrip')
    // The element shows what is selected now, not the option it would choose.
    expect(space.elements[2]!.value).toBe('Round trip')
    expect(space.elements[2]!.options).toHaveLength(2)
  })

  it('keeps the synthetic operations out of the element table', () => {
    const space = actionSpace(observed)
    expect(Object.keys(space.controls).sort()).toEqual(['SCROLL_DOWN', 'WAIT'])
    expect(space.targets.SCROLL_DOWN).toBeUndefined()
  })
})

/** A page of numbered controls, as the runs that outgrew one request really looked. */
function buttons(count: number, label: (index: number) => string, offset = 0): SnapshotAction[] {
  return Array.from({ length: count }, (_unused, at) => ({
    id: `e${offset + at + 1}`,
    kind: 'click' as const,
    node: offset + at + 1,
    role: 'button',
    label: label(offset + at + 1),
  }))
}

describe('element table cap', () => {
  it('leaves a table that already fits exactly as it is', () => {
    const space = actionSpace(observed)
    const trimmed = trimActionSpace(space, context.goal, [])

    expect(trimmed.omitted).toBe(0)
    expect(trimmed.space).toBe(space)
  })

  it('drops the entries with no visible label before it drops a labelled one', () => {
    // Ten controls whose name is only their role, then fifty with a name of their own: five times
    // as many elements as one request may carry.
    const actions = [...buttons(10, () => 'button'), ...buttons(50, (index) => `Option ${index}`, 10)]
    const trimmed = trimActionSpace(actionSpace(actions), 'Find a flight', [])

    expect(trimmed.omitted).toBe(12)
    expect(trimmed.space.elements).toHaveLength(48)
    // The ten stand-in names went first, then the two labelled entries furthest down the page.
    expect(trimmed.space.elements.map((element) => element.index)).toEqual(
      Array.from({ length: 48 }, (_unused, at) => String(at + 11)),
    )
    expect(trimmed.space.elements.every((element) => element.label !== element.role)).toBe(true)
  })

  it('keeps the element the goal names and the element the run just acted on', () => {
    const actions = buttons(60, (index) => (index === 60 ? 'Book flight' : `Option ${index}`))
    const trimmed = trimActionSpace(actionSpace(actions), 'Find a flight', ['57'])
    const kept = new Set(trimmed.space.elements.map((element) => element.index))

    expect(trimmed.omitted).toBe(12)
    expect(kept.has('57')).toBe(true)
    expect(kept.has('60')).toBe(true)
  })

  it('never offers a target for an element it left out, nor an operation with no target', () => {
    const typeable = buttons(10, () => 'textbox', 50).map((action) => ({ ...action, kind: 'fill' as const, value: '' }))
    const trimmed = trimActionSpace(actionSpace([...buttons(50, (index) => `Option ${index}`), ...typeable]), 'Find a flight', [])
    const table = new Set(trimmed.space.elements.map((element) => element.index))

    expect(trimmed.omitted).toBe(12)
    for (const [operation, group] of Object.entries(trimmed.space.targets)) {
      expect(Object.keys(group).length, operation).toBeGreaterThan(0)
      for (const target of Object.keys(group)) expect(table.has(target.split(':')[0]!)).toBe(true)
    }
    expect(trimmed.space.targets.TYPE_TEXT).toBeUndefined()
    expect(Object.keys(trimmed.space.targets.CLICK!)).toHaveLength(48)
  })

  it('keeps the popup candidate the goal names when the list is longer than the table', () => {
    // An autocomplete list of 60 rows is more choices than one request can carry, and every row of
    // it looks the same to the cut: same role, same kind, same length of label. The goal's own words
    // are what separates the row to keep from the 59 it is shown next to.
    const rows: SnapshotAction[] = Array.from({ length: 60 }, (_unused, at) => ({
      id: `e${at + 1}`,
      kind: 'click',
      node: at + 1,
      role: 'option',
      label: at === 41 ? '中关村生命科学园 北京, 中国' : `第 ${at + 1} 号候选项`,
    }))
    const trimmed = trimActionSpace(actionSpace(rows), '在北京的中关村生命科学园附近订一间酒店', [])

    expect(trimmed.omitted).toBe(12)
    expect(trimmed.space.elements).toHaveLength(48)
    const kept = trimmed.space.elements.filter((element) => element.label === '中关村生命科学园 北京, 中国')
    expect(kept).toHaveLength(1)
    // The candidate survives whole: its own click target is in the table with it.
    expect(trimmed.space.targets.CLICK![kept[0]!.index]!.label).toBe('中关村生命科学园 北京, 中国')
  })

  it('cuts a guessed entry before a native one of the same standing, even when the guessed one reads closer to the goal', () => {
    // Two halves of one page: forty-four controls the page declared, and six rows the deep scan
    // guessed at — six, which is the pool's own cap (`browser/snapshot.ts`). A guessed row is made of
    // the page's words, so it can beat a native control on the goal's own words alone, and a slot a
    // guess takes is a slot a declared control loses. What decides first is the standing the run has
    // for keeping an entry at all (the element it just acted on, a name of its own, an operation it
    // supports); at that same standing the page's own control is the survivor, and only then do the
    // goal's words come into it.
    const natives = buttons(44, (index) => `控制 ${index}`)
    const goal = '在北京的中关村生命科学园附近订一间酒店'
    const guesses: SnapshotAction[] = Array.from({ length: 6 }, (_unused, at) => ({
      id: `e${45 + at}`,
      kind: 'click',
      node: 45 + at,
      role: 'button',
      label: `中关村生命科学园 候选 ${at + 1}`,
      guess: 'listener',
    }))
    const trimmed = trimActionSpace(actionSpace([...natives, ...guesses]), goal, [])
    const kept = trimmed.space.elements

    // Two slots short, and both of them guessed rows — the two furthest down, since every guessed row
    // is equally close to the goal. Not one of the page's own controls went.
    expect(trimmed.omitted).toBe(2)
    expect(kept.map((element) => element.index)).toEqual(
      Array.from({ length: 48 }, (_unused, at) => String(at + 1)),
    )
    expect(kept.filter((element) => element.label.startsWith('控制'))).toHaveLength(44)
    expect(kept.filter((element) => element.label.startsWith('中关村')).map((element) => element.label)).toEqual([
      '中关村生命科学园 候选 1',
      '中关村生命科学园 候选 2',
      '中关村生命科学园 候选 3',
      '中关村生命科学园 候选 4',
    ])
    // Every survivor's own click target survives with it.
    expect(Object.keys(trimmed.space.targets.CLICK!).sort((a, b) => Number(a) - Number(b))).toEqual(
      Array.from({ length: 48 }, (_unused, at) => String(at + 1)),
    )
  })

  it('still keeps the guessed element the run has just acted on, because that standing outranks the guess', () => {
    // The rule above is not allowed to weaken the first one: a loop that loses the very target it was
    // working on is a loop that cannot finish, and a site whose rows are all guessed rows is exactly
    // where that would happen. The guessed row the run just acted on is kept, and the slot it takes
    // is one of its own kind's: two other guessed rows are cut instead.
    const natives = buttons(44, (index) => `控制 ${index}`)
    const guesses: SnapshotAction[] = Array.from({ length: 6 }, (_unused, at) => ({
      id: `e${45 + at}`,
      kind: 'click',
      node: 45 + at,
      role: 'button',
      label: `中关村生命科学园 候选 ${at + 1}`,
      guess: 'listener',
    }))
    const trimmed = trimActionSpace(actionSpace([...natives, ...guesses]), '订一间酒店', ['50'])
    const kept = trimmed.space.elements.map((element) => element.index)

    expect(trimmed.omitted).toBe(2)
    // The recent target was the last guessed row on the page, which is what the guess rule alone would
    // have cut first.
    expect(kept).toEqual([...Array.from({ length: 47 }, (_unused, at) => String(at + 1)), '50'])
    expect(trimmed.space.elements.filter((element) => element.label.startsWith('控制'))).toHaveLength(44)
  })
})

describe('questionnaire', () => {
  const space = actionSpace(observed)

  it('offers every operation, including the two terminal ones', () => {
    const { operations } = buildQuestionnaire(space, context, 'jev-latest')
    expect(operations).toEqual(['CLICK', 'TYPE_TEXT', 'SELECT', 'SCROLL_DOWN', 'WAIT', 'DONE', 'BLOCKED'])
  })

  it('asks each target question about its own operation only', () => {
    const { request, targetIds } = buildQuestionnaire(space, context, 'jev-latest')
    const questions = request.questions as Record<string, { criteria: Record<string, unknown>; instructions: Record<string, unknown> }>
    expect(Object.keys(questions)).toEqual(['operation', 'click_target', 'type_text_target', 'select_target'])
    expect(Object.keys(questions.click_target!.criteria)).toEqual(['1', '2'])
    expect(Object.keys(questions.select_target!.criteria)).toEqual(['3:1', '3:2'])
    expect(questions.click_target!.instructions.operation).toBe('CLICK')
    expect(targetIds.SELECT).toEqual(['3:1', '3:2'])
  })

  it('shows the state without leaking geometry or node identity', () => {
    const { request } = buildQuestionnaire(space, context, 'jev-latest')
    const state = request.state as { elements: unknown }
    expect(JSON.stringify(state)).not.toContain('rect')
    expect(JSON.stringify(state)).not.toContain('"node"')
  })

  it('never lets the guessed marker reach the request body, byte for byte', () => {
    // The marker the deep scan puts on an element it inferred (`browser/snapshot.ts`) is what a run
    // reviewed afterwards needs to tell a guessed row from a control the page declared, and the step
    // record is where it is kept (`HistoryEntry.guess`). It must not reach the service: the element
    // table is `state.elements` whole, so a field on an entry would change every body this project
    // sends. Two checks, because "a field was not added" and "the bytes are what they always were"
    // are different claims: the same page with the marker stripped builds the same string, and the
    // whole string's hash is the one taken before the marker existed (6505 characters).
    const page: SnapshotAction[] = [
      { id: 'e1', kind: 'click', node: 1, role: 'button', label: 'Search' },
      { id: 'e2', kind: 'fill', node: 2, role: 'combobox', label: 'Where from?', value: '' },
      { id: 'e3', kind: 'click', node: 3, role: 'button', label: '酒店级别 不限', guess: 'listener' },
      { id: 'e4', kind: 'click', node: 4, role: 'button', label: '旅游地图', guess: 'inline' },
    ]
    const stripped = page.map(({ guess, ...rest }) => rest as SnapshotAction)
    const body = (actions: SnapshotAction[]): string =>
      JSON.stringify(buildQuestionnaire(actionSpace(actions), context, 'jev-latest').request)
    const withGuesses = body(page)

    expect(withGuesses).not.toContain('"guess"')
    expect(withGuesses).toBe(body(stripped))
    expect(createHash('sha256').update(withGuesses).digest('hex')).toBe(
      '1fa8398391cf562c565915a9f262c2daa555ce4a22ed78c852d01370a1ea93eb',
    )
  })

  it('carries the run\'s one-off sentence into the request, and nothing when there is none', () => {
    const note = '你上次选的编号在页面里已经找不到了，页面可能自己刷新过，请重新选'
    const said = buildQuestionnaire(space, { ...context, note }, 'jev-latest').request.state as { note?: string }
    expect(said.note).toBe(note)

    const quiet = buildQuestionnaire(space, context, 'jev-latest').request.state as { note?: string }
    expect(quiet.note).toBeUndefined()
  })

  it('asks for visible evidence of the goal before either terminal operation may be chosen', () => {
    // Both used to be one hollow sentence each — "Every requirement is visibly satisfied." — and
    // the audit's finding was exact: the goal's own success markers never reached the criteria the
    // service judged. Each terminal operation is now a statement that can be checked against the
    // page, and the check is the page's own text or element list.
    const { request } = buildQuestionnaire(space, context, 'jev-latest')
    const questions = request.questions as { operation: { criteria: Record<string, string> } }
    expect(questions.operation.criteria.DONE).toBe(
      'Every requirement in the goal is satisfied, and the page itself shows the proof: the names, ' +
        'numbers, dates, prices, distances or confirmation the goal asks for appear in the page text ' +
        'or in the element list. A page that only looks like the right screen is not DONE.',
    )
    expect(questions.operation.criteria.BLOCKED).toBe(
      'No offered operation can move the goal forward: the control this step needs is not on the page, ' +
        'or is disabled or unreachable, and no offered element can change that. Say BLOCKED only when ' +
        'the page shows that, never because a step was already tried.',
    )
    expect(questions.operation.criteria.DONE).toContain('the page itself shows the proof')
    expect(questions.operation.criteria.BLOCKED).toContain('the page shows that')
  })

  it('tells the service when the element table is a selection rather than the whole page', () => {
    const said = buildQuestionnaire(space, { ...context, omittedElements: 12 }, 'jev-latest').request
      .state as { elements_omitted?: number }
    expect(said.elements_omitted).toBe(12)

    const quiet = buildQuestionnaire(space, context, 'jev-latest').request.state as {
      elements_omitted?: number
    }
    expect(quiet.elements_omitted).toBeUndefined()
  })

  it('marks where a long page text was cut, and cuts nothing else', () => {
    const text = 'x'.repeat(6000)
    const note = '这个页面还有别的部分'
    const { request } = buildQuestionnaire(space, { ...context, note, page: { ...context.page, text } }, 'jev-latest')
    const state = request.state as { page: { url: string; title: string; text: string }; note?: string; elements: unknown }

    // The cut is announced where it happened, with how much was left out, so a service reading the
    // text knows it is reading the top of a longer page.
    const [kept, marker] = state.page.text.split('\n')
    expect(kept).toHaveLength(3000)
    expect(marker).toBe('[... page text cut here: 3000 more characters of this page were not sent ...]')
    // Title, URL, the one-off sentence and the element table are sized on their own terms.
    expect(state.page.url).toBe(context.page.url)
    expect(state.page.title).toBe(context.page.title)
    expect(state.note).toBe(note)
    expect(state.elements).toEqual(space.elements)
  })

  it('cuts the audit’s oversized page down to the caps, and marks the text it left out', () => {
    // 97 elements and a 6000-character text is the shape that made a 32,686-character body in the
    // GitHub run of the 2026-10 audit. Cutting the two is arithmetic, and arithmetic is not the
    // guarantee — the caller measures the body it would send and cuts again (see the run loop) — so
    // what is pinned here is that each cap does its own work.
    const actions: SnapshotAction[] = Array.from({ length: 97 }, (_unused, at) => ({
      id: `e${at + 1}`,
      kind: 'click',
      node: at + 1,
      role: 'button',
      label: `Open the settings page for repository number ${at + 1}`,
    }))
    const { space: capped, omitted } = trimActionSpace(
      actionSpace(actions),
      'Open the settings page for repository 7',
      [],
    )
    const { request } = buildQuestionnaire(
      capped,
      { ...context, page: { ...context.page, text: 'y'.repeat(6000) }, omittedElements: omitted },
      'jev-latest',
    )

    expect(omitted).toBe(49)
    expect(capped.elements).toHaveLength(48)
    const state = request.state as { page: { text: string } }
    expect(state.page.text).toContain('page text cut here')
  })

  it('measures the body it would send, so a caller can hold a budget that counting cannot', () => {
    const whole = buildQuestionnaire(space, context, 'jev-latest').request
    expect(requestChars(space, context, 'jev-latest')).toBe(JSON.stringify(whole).length)

    // The measurement follows the request itself rather than an estimate of it: the page text is the
    // term that changes here, and the answer moves by exactly that much.
    const long = { ...context, page: { ...context.page, text: 'y'.repeat(6000) } }
    const cut = buildQuestionnaire(space, long, 'jev-latest').request
    const grown = requestChars(space, long, 'jev-latest')
    const before = (whole.state as { page: { text: string } }).page.text
    const after = (cut.state as { page: { text: string } }).page.text
    expect(grown).toBe(JSON.stringify(cut).length)
    expect(grown - JSON.stringify(whole).length).toBe(JSON.stringify(after).length - JSON.stringify(before).length)
  })
})

describe('answer validation', () => {
  it('accepts a well-formed distribution over exactly the offered choices', () => {
    const answer = { choice: 'b', confidence: 0.6, probabilities: { a: 0.4, b: 0.6 } }
    expect(validateChoice(answer, ['a', 'b']).choice).toBe('b')
  })

  it.each([
    ['a choice we never offered', { choice: 'c', confidence: 0.5, probabilities: { a: 0.5, b: 0.5 } }],
    ['a probability for an unknown choice', { choice: 'a', confidence: 0.5, probabilities: { a: 0.5, b: 0.3, c: 0.2 } }],
    ['a distribution that does not sum to one', { choice: 'a', confidence: 0.5, probabilities: { a: 0.2, b: 0.2 } }],
    ['a confidence outside 0..1', { choice: 'a', confidence: 1.4, probabilities: { a: 0.7, b: 0.3 } }],
    ['a missing answer', undefined],
  ])('refuses %s', (_name, answer) => {
    expect(() => validateChoice(answer, ['a', 'b'])).toThrow(InvalidDecision)
  })

  /**
   * The reading that decides what a run does, and the one the sixth run of 2026-10-02 died for
   * (`run-1790924542952-x19r`): the table is the answer, and a choice that is not its own table's
   * highest is a slip against it rather than an answer nobody can use. That run had five steps and
   * 13 decisions behind it, had already reached the hotel list it was aiming for, named TYPE_TEXT
   * at 0.28 over its own 0.29 CLICK, and ended without taking a single action.
   */
  it('settles on the most probable choice when the service named another one', () => {
    const answer = {
      choice: 'TYPE_TEXT',
      confidence: 0.28,
      probabilities: { CLICK: 0.29, TYPE_TEXT: 0.28, DONE: 0.24, WAIT: 0.19 },
    }
    const heard: CorrectedChoice[] = []
    const settled = validateChoice(
      answer,
      ['CLICK', 'TYPE_TEXT', 'DONE', 'WAIT'],
      '下一步该做哪个操作',
      (corrected) => heard.push(corrected),
    )

    expect(settled.choice).toBe('CLICK')
    // The confidence stays the service's own number rather than the winning choice's probability.
    // That is what keeps this from laundering a weak answer into a confident one: 0.28 is still
    // under the floor, so the loop asks again exactly as it always did.
    expect(settled.confidence).toBe(0.28)
    expect(heard).toEqual([
      {
        question: '下一步该做哪个操作',
        chose: 'TYPE_TEXT',
        choseProbability: 0.28,
        top: 'CLICK',
        topProbability: 0.29,
      },
    ])
  })

  it('corrects nothing, and reports nothing, when the table agrees with the choice', () => {
    const heard: CorrectedChoice[] = []
    const answer = { choice: 'b', confidence: 0.6, probabilities: { a: 0.4, b: 0.6 } }
    const settled = validateChoice(answer, ['a', 'b'], '这一问', (corrected) => heard.push(corrected))

    expect(settled.choice).toBe('b')
    expect(heard).toEqual([])
  })

  it('says what came back when the answer is not an object at all', () => {
    expect(() => validateChoice(undefined, ['a', 'b'], '下一步该做哪个操作')).toThrow(
      '「下一步该做哪个操作」这一问的回答不是一个对象：收到 什么都没有',
    )
  })

  it('lists the options that did not line up', () => {
    const answer = { choice: 'a', confidence: 0.5, probabilities: { a: 0.5, b: 0.3, c: 0.2 } }
    expect(() => validateChoice(answer, ['a', 'b'])).toThrow(
      '概率表覆盖的选项与问题里列出的对不上：问题给了 2 个，回答里是 3 个，多出 c',
    )
  })
})

describe('decision reading', () => {
  const space = actionSpace(observed)
  const questionnaire = buildQuestionnaire(space, context, 'jev-latest')
  /**
   * A well-formed answer to the operation question. It must cover every operation
   * the question offered, including the two synthetic actions and the two
   * terminal ones — the service is never asked a partial question.
   */
  const operation = (choice: string, confidence = 0.8) => {
    const names = ['CLICK', 'TYPE_TEXT', 'SELECT', 'SCROLL_DOWN', 'WAIT', 'DONE', 'BLOCKED']
    const rest = 0.1 / (names.length - 1)
    const probabilities: Record<string, number> = {}
    for (const name of names) probabilities[name] = name === choice ? 0.9 : rest
    return { choice, confidence, probabilities }
  }

  it('maps the winning target index back to an action id', () => {
    const decision = readDecision(
      {
        answers: {
          operation: operation('CLICK'),
          click_target: { choice: '1', confidence: 0.7, probabilities: { '1': 0.7, '2': 0.3 } },
        },
      },
      space,
      questionnaire,
    )
    expect(decision).toMatchObject({ choice: 'e1', operation: 'CLICK', target: '1', confidence: 0.8 })
    expect(decision.probabilities).toEqual({ e1: 0.7, e3: 0.3 })
  })

  it('reads a dropdown option through its own target key', () => {
    const decision = readDecision(
      {
        answers: {
          operation: operation('SELECT', 0.6),
          select_target: { choice: '3:2', confidence: 0.9, probabilities: { '3:1': 0.1, '3:2': 0.9 } },
        },
      },
      space,
      questionnaire,
    )
    expect(decision.choice).toBe('e5')
    expect(decision.operationProbabilities.SELECT).toBe(0.9)
  })

  it('passes the terminal operations straight through', () => {
    const decision = readDecision(
      {
        answers: {
          operation: operation('DONE', 0.95),
        },
      },
      space,
      questionnaire,
    )
    expect(decision.choice).toBe('DONE')
    expect(decision.target).toBeNull()
  })

  it('reads a synthetic operation as its own action', () => {
    const decision = readDecision(
      {
        answers: {
          operation: operation('WAIT', 0.5),
        },
      },
      space,
      questionnaire,
    )
    expect(decision.choice).toBe('wait')
  })

  it('ignores target heads it is not allowed to act on', () => {
    const decision = readDecision(
      {
        answers: {
          operation: operation('CLICK'),
          click_target: { choice: '2', confidence: 0.7, probabilities: { '1': 0.3, '2': 0.7 } },
          select_target: { choice: 'nonsense', confidence: 9, probabilities: {} },
        },
      },
      space,
      questionnaire,
    )
    expect(decision.choice).toBe('e3')
  })

  it('refuses a response with no answers at all', () => {
    expect(() => readDecision({}, space, questionnaire)).toThrow(InvalidDecision)
    expect(() => readDecision({ answers: null }, space, questionnaire)).toThrow(InvalidDecision)
  })

  it('says what came back instead of answers', () => {
    expect(() => readDecision({ error: 'boom' }, space, questionnaire)).toThrow(
      '决策服务没有返回 answers 字段（收到 一个对象（含 error）），没有执行任何动作',
    )
  })

  it('corrects a target answer to the element that held the probability', () => {
    // Target 1 is the Search button, target 2 is the field it would open. The service named 2
    // while 1 held the probability, so 1 is the element the step gets — and the correction names
    // the question it was about, because the operation question is settled by the same rule.
    const heard: CorrectedChoice[] = []
    const decision = readDecision(
      {
        answers: {
          operation: operation('CLICK'),
          click_target: { choice: '2', confidence: 0.3, probabilities: { '1': 0.7, '2': 0.3 } },
        },
      },
      space,
      questionnaire,
      (corrected) => heard.push(corrected),
    )

    expect(decision.target).toBe('1')
    expect(heard).toEqual([
      { question: '用 CLICK 时该选哪个元素', chose: '2', choseProbability: 0.3, top: '1', topProbability: 0.7 },
    ])
  })
})

describe('decision call', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const source = { endpoint: 'https://decide.example.test/v1/systemone', apiKey: 'test-key', model: 'jev-latest' }
  const space = actionSpace(observed)
  const operation = (choice: string, confidence = 0.8) => {
    const names = ['CLICK', 'TYPE_TEXT', 'SELECT', 'SCROLL_DOWN', 'WAIT', 'DONE', 'BLOCKED']
    const rest = 0.1 / (names.length - 1)
    const probabilities: Record<string, number> = {}
    for (const name of names) probabilities[name] = name === choice ? 0.9 : rest
    return { choice, confidence, probabilities }
  }
  const accepted = {
    answers: {
      operation: operation('CLICK'),
      click_target: { choice: '1', confidence: 0.7, probabilities: { '1': 0.7, '2': 0.3 } },
    },
    model: 'jev-latest-20260101',
    usage: { total_tokens: 120 },
  }
  type Wire = { url: string; init: { method: string; headers: Record<string, string>; body: string } }

  it('posts the questionnaire to the configured endpoint, under the configured model and key', async () => {
    const seen: Wire[] = []
    vi.stubGlobal('fetch', async (url: string, init: Wire['init']) => {
      seen.push({ url, init })
      return new Response(JSON.stringify(accepted))
    })

    const decision = await choose(source, space, context)

    expect(seen).toHaveLength(1)
    expect(seen[0]!.url).toBe(source.endpoint)
    expect(seen[0]!.init.method).toBe('POST')
    expect(seen[0]!.init.headers.authorization).toBe('Bearer test-key')
    expect(seen[0]!.init.headers['content-type']).toBe('application/json')
    // The goal is what the service decides about, so it has to be on the wire.
    expect(seen[0]!.init.body).toContain(context.goal)
    expect(JSON.parse(seen[0]!.init.body).model).toBe('jev-latest')

    expect(decision).toMatchObject({ choice: 'e1', operation: 'CLICK', model: 'jev-latest-20260101' })
    expect(decision.usage).toEqual({ total_tokens: 120 })
  })

  it("reports a refused key in one sentence, with the service's own words and never the key", async () => {
    let calls = 0
    vi.stubGlobal('fetch', async () => {
      calls += 1
      // The service is made to echo the key, which is what the scrub has to survive.
      return new Response('{"error":{"message":"Missing Authentication header for test-key"}}', { status: 401 })
    })
    const error = await choose(source, space, context).catch((thrown: Error) => thrown)
    expect(String(error)).toMatch(/决策服务返回 HTTP 401/)
    expect(String(error)).toContain('服务端原话：')
    expect(String(error)).toContain('Missing Authentication header')
    expect(String(error)).not.toContain('test-key')
    expect(calls).toBe(1)
  })

  /**
   * The value this group is about: a 35-character key of the other door's shape sitting in the
   * OpenRouter cell. Written down once so the assertions can name the fragment they allow.
   */
  const stray = `sk-3130b${'x'.repeat(27)}`
  const origin = { ref: 'OPENROUTER_API_KEY', label: 'OpenRouter', shape: { length: 73, prefix: 'sk-or-v1-' } }

  it('names the cell a refused key came from, and the shape that door expects', async () => {
    vi.stubGlobal('fetch', async () => new Response('{"error":{"message":"Missing Authentication header"}}', { status: 401 }))

    const error = await choose({ ...source, apiKey: stray, keyOrigin: origin }, space, context).catch(
      (thrown: Error) => thrown,
    )
    const said = String(error)
    expect(said).toContain('读到的是 OPENROUTER_API_KEY，长度 35、以 sk-3130b 开头')
    expect(said).toContain('OpenRouter 的钥匙应当是 73 个字符、以 sk-or-v1- 开头')
    expect(said).toContain('请到设置页「决策服务」那一行重贴')

    // With no cell to name there is nothing to add, so the refusal stays exactly as it was.
    const unnamed = await choose(source, space, context).catch((thrown: Error) => thrown)
    expect(String(unnamed)).toMatch(/决策服务返回 HTTP 401/)
    expect(String(unnamed)).not.toContain('读到的是')
  })

  it('shows a fragment of the key and never the whole value', async () => {
    // The service echoes the value back, which is what a message about a key has to survive.
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(JSON.stringify({ error: { message: `Missing Authentication header for ${stray}` } }), {
          status: 401,
        }),
    )

    const said = String(
      await choose({ ...source, apiKey: stray, keyOrigin: origin }, space, context).catch((thrown: Error) => thrown),
    )
    expect(said).toContain(stray.slice(0, 8))
    expect(said).not.toContain(stray.slice(0, 9))
    expect(said).not.toContain(stray)

    // A value short enough to fit inside the fragment is not shown as one: a whole key is a whole
    // key however short it is, so only its length comes back.
    const short = String(
      await choose({ ...source, apiKey: 'abc', keyOrigin: origin }, space, context).catch((thrown: Error) => thrown),
    )
    expect(short).toContain('长度 3')
    expect(short).not.toContain('abc')
  })

  it('adds the key line to nothing but a refusal of the key itself', async () => {
    vi.stubGlobal('fetch', async () => new Response('bad shape', { status: 422 }))
    // Same source, same key, same cell, and the status is what decides: a body the service did
    // not like is not a verdict on the credential, and saying it was would send the reader to
    // re-paste a key that is already right.
    const said = String(
      await choose({ ...source, apiKey: stray, keyOrigin: origin }, space, context).catch((thrown: Error) => thrown),
    )
    expect(said).toMatch(/决策服务返回 HTTP 422/)
    expect(said).not.toContain('读到的是')
    expect(said).not.toContain('sk-3130b')
  })

  it('waits and tries again only for the statuses that mean "later"', async () => {
    let calls = 0
    vi.stubGlobal('fetch', async () => {
      calls += 1
      return calls === 1 ? new Response('slow down', { status: 429 }) : new Response(JSON.stringify(accepted))
    })
    const decision = await choose(source, space, context)
    expect(calls).toBe(2)
    expect(decision.choice).toBe('e1')
  })

  it('hands the raw exchange to the trace, with the credential taken out', async () => {
    const written: Array<Record<string, unknown>> = []
    vi.stubGlobal('fetch', async () =>
      // A service echoing the key back is the case this is really about: an error body is
      // still text from somewhere else, and a key must never surface in a file we wrote.
      new Response(JSON.stringify({ ...accepted, echo: 'your key is test-key' })),
    )

    await choose({ ...source, trace: { write: (record) => written.push(record) } }, space, context)

    expect(written).toHaveLength(1)
    expect(written[0]).toMatchObject({ kind: 'decision', status: 200, attempt: 0, wrapped: false })
    expect(written[0]!.request).toMatchObject({ model: 'jev-latest' })
    expect(JSON.stringify(written[0])).not.toContain('test-key')
    expect(JSON.stringify(written[0])).toContain('***')
  })

  it('records the correction when the answer settled on a choice it did not name', async () => {
    // The record is the only place a corrected step can be seen for what it was: the exchange itself
    // is well-formed, and the decision that comes out names the choice the service did not.
    const written: Array<Record<string, unknown>> = []
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(
          JSON.stringify({
            answers: {
              operation: {
                choice: 'TYPE_TEXT',
                confidence: 0.28,
                probabilities: {
                  CLICK: 0.29,
                  TYPE_TEXT: 0.28,
                  SELECT: 0.01,
                  SCROLL_DOWN: 0.01,
                  WAIT: 0.17,
                  DONE: 0.23,
                  BLOCKED: 0.01,
                },
              },
              click_target: { choice: '1', confidence: 0.7, probabilities: { '1': 0.7, '2': 0.3 } },
            },
          }),
        ),
    )

    const decision = await choose({ ...source, trace: { write: (record) => written.push(record) } }, space, context)

    expect(decision.operation).toBe('CLICK')
    expect(decision.choice).toBe('e1')
    // The exchange first, then the correction — a kind of its own, so nothing about the exchange
    // record changes and a reader can still see what the service actually said.
    expect(written.map((record) => record.kind)).toEqual(['decision', 'corrected'])
    expect(written[1]).toMatchObject({
      kind: 'corrected',
      why: '它的选择和它自己的排名不一致，按排名走了',
      question: '下一步该做哪个操作',
      chose: 'TYPE_TEXT',
      chose_probability: 0.28,
      top: 'CLICK',
      top_probability: 0.29,
    })
  })

  it('sends the flat body first and the wrapped one only after a refusal about shape', async () => {
    const bodies: string[] = []
    vi.stubGlobal('fetch', async (_url: string, init: { body: string }) => {
      bodies.push(init.body)
      return bodies.length === 1
        ? new Response('bad shape', { status: 422 })
        : new Response(JSON.stringify(accepted))
    })

    const decision = await choose({ ...source, wrapFallback: true }, space, context)

    expect(bodies).toHaveLength(2)
    expect(JSON.parse(bodies[0]!).decisionsRequest).toBeUndefined()
    const wrapped = JSON.parse(bodies[1]!) as { decisionsRequest: { model: string; questions: unknown } }
    expect(wrapped.decisionsRequest.model).toBe('jev-latest')
    expect(wrapped.decisionsRequest.questions).toBeDefined()
    expect(decision.choice).toBe('e1')
  })

  it('does not wrap when the door says this endpoint takes the flat body', async () => {
    let calls = 0
    vi.stubGlobal('fetch', async () => {
      calls += 1
      return new Response('bad shape', { status: 422 })
    })
    await expect(choose(source, space, context)).rejects.toThrow(/决策服务返回 HTTP 422/)
    expect(calls).toBe(1)
  })

  it('says that the wrapped retry was already tried when both shapes fail', async () => {
    vi.stubGlobal('fetch', async () => new Response('nope', { status: 400 }))
    await expect(choose({ ...source, wrapFallback: true }, space, context)).rejects.toThrow(/decisionsRequest/)
  })

  it('never reports a decision it did not receive', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('fetch failed')
    })
    await expect(choose(source, space, context)).rejects.toThrow(/连接决策服务失败/)
  })
})

describe('text helper', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const source = { baseUrl: 'https://api.deepseek.com/v1', apiKey: 'test-key', model: 'deepseek-chat', reasoning: 'none' as const }
  const field = observed[1]!
  const build = () => fieldContext(context.goal, field, context.page, context.history)

  it('shows the helper the field, the goal and the recent actions', () => {
    expect(build()).toEqual({
      goal: context.goal,
      field: { label: 'Where from?', role: 'combobox', value: '' },
      page: { title: 'Flights', text: 'Where from?' },
      recent_actions: [],
    })
  })

  it('never types anything without a credential', async () => {
    await expect(fieldText({ ...source, apiKey: '' }, build())).rejects.toThrow(/密钥/)
  })

  it('accepts exactly one non-empty string', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({
      choices: [{ message: { content: '{"text":"Zürich"}' } }],
      usage: { total_tokens: 31 },
    })))
    const result = await fieldText(source, build())
    expect(result.text).toBe('Zürich')
    expect(result.usage).toEqual({ total_tokens: 31 })
  })

  it.each([
    ['prose instead of JSON', 'Zürich'],
    ['an empty value', '{"text":""}'],
    ['a null value', '{"text":null}'],
    ['extra keys', '{"text":"Zürich","note":"guessed"}'],
    ['an over-long value', `{"text":"${'x'.repeat(2001)}"}`],
  ])('types nothing when the helper returns %s', async (_name, content) => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ choices: [{ message: { content } }] })))
    await expect(fieldText(source, build())).rejects.toThrow(/什么都没有输入/)
  })

  it('gives the model room that cannot be the reason it failed', async () => {
    // The cap only ever stops a runaway or cuts a real answer off, and on a route where the model
    // thinks first the thinking shares this budget: a tight cap is how "it said nothing" happens.
    let sent: Record<string, unknown> = {}
    vi.stubGlobal('fetch', async (_url: unknown, init: { body?: string }) => {
      sent = JSON.parse(String(init.body)) as Record<string, unknown>
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"text":"Zürich"}' } }] }))
    })
    await fieldText(source, build())
    expect(Number(sent.max_tokens)).toBe(393_216)
  })

  it('asks again with the limit the refusal names, when it names one', async () => {
    const sent: number[] = []
    let calls = 0
    vi.stubGlobal('fetch', async (_url: unknown, init: { body?: string }) => {
      calls += 1
      sent.push(Number((JSON.parse(String(init.body)) as { max_tokens?: unknown }).max_tokens))
      return calls === 1
        ? new Response(
            JSON.stringify({ error: { message: 'max_tokens: 393216 > 8192, which is the maximum allowed' } }),
            { status: 400 },
          )
        : new Response(JSON.stringify({ choices: [{ message: { content: '{"text":"Zürich"}' } }] }))
    })
    const result = await fieldText(source, build())
    expect(result.text).toBe('Zürich')
    expect(calls).toBe(2)
    expect(sent[0]).toBe(393_216)
    expect(sent[1]).toBe(8192)
  })

  it('asks again with its own small ceiling when the refusal names no limit', async () => {
    // The sentence this reads is the helper's own wrapper, so it carries "HTTP 400" as well as the
    // vendor's words: the retry must not mistake a status code for the route's own limit.
    const sent: number[] = []
    let calls = 0
    vi.stubGlobal('fetch', async (_url: unknown, init: { body?: string }) => {
      calls += 1
      sent.push(Number((JSON.parse(String(init.body)) as { max_tokens?: unknown }).max_tokens))
      return calls === 1
        ? new Response(JSON.stringify({ error: { message: 'max_tokens is too large' } }), { status: 400 })
        : new Response(JSON.stringify({ choices: [{ message: { content: '{"text":"Zürich"}' } }] }))
    })
    await fieldText(source, build())
    expect(calls).toBe(2)
    expect(sent[1]).toBe(8192)
  })

  it('waits out a busy text model instead of giving up', async () => {
    let calls = 0
    vi.stubGlobal('fetch', async () => {
      calls += 1
      return calls === 1
        ? new Response('slow down', { status: 503 })
        : new Response(JSON.stringify({ choices: [{ message: { content: '{"text":"Zürich"}' } }] }))
    })
    const result = await fieldText(source, build())
    expect(calls).toBe(2)
    expect(result.text).toBe('Zürich')
  })

  it('does not retry a refusal that will not change', async () => {
    let calls = 0
    vi.stubGlobal('fetch', async () => {
      calls += 1
      return new Response('bad request', { status: 400 })
    })
    await expect(fieldText(source, build())).rejects.toThrow(/HTTP 400/)
    expect(calls).toBe(1)
  })

  it('hands the text exchange to the trace as well', async () => {
    const written: Array<Record<string, unknown>> = []
    vi.stubGlobal('fetch', async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: '{"text":"Zürich"}' } }] })),
    )

    await fieldText({ ...source, trace: { write: (record) => written.push(record) } }, build())

    expect(written).toHaveLength(1)
    expect(written[0]).toMatchObject({ kind: 'text', door: 'preset', status: 200 })
    expect(JSON.stringify(written[0]!.request)).toContain('Where from?')
    expect(JSON.stringify(written[0])).not.toContain('test-key')
  })

  it('keeps DeepSeek reasoning off when asked to', async () => {
    let body: Record<string, unknown> = {}
    vi.stubGlobal('fetch', async (_url: string, init: { body: string }) => {
      body = JSON.parse(init.body) as Record<string, unknown>
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"text":"Zürich"}' } }] }))
    })
    await fieldText(source, build())
    expect(body.reasoning).toEqual({ enabled: false })
    expect(body.response_format).toEqual({ type: 'json_object' })
    expect(body.messages).toHaveLength(2)
  })
})

/**
 * The other door: DSH's own model service, which never throws at the caller. Everything a
 * failed or truncated call has to say arrives as one `finish` reason, so the reader's sentence
 * is only as useful as what this block keeps.
 */
describe('the DSH door of the text helper', () => {
  const dshSource = (chunks: DshChunk[], seen?: Array<Record<string, unknown>>): TextHelperSource => ({
    baseUrl: '',
    apiKey: '',
    model: 'deepseek-flash',
    reasoning: 'none',
    dsh: {
      provider: 'opencode-go-new',
      stream: async function* (options) {
        seen?.push(options as unknown as Record<string, unknown>)
        for (const chunk of chunks) yield chunk
      },
    },
  })

  const ask = (chunks: DshChunk[], seen?: Array<Record<string, unknown>>) =>
    askText(dshSource(chunks, seen), 'system', 'user')

  it('reads the answer out of the streamed text', async () => {
    const answer = await ask([{ type: 'text-delta', text: '{"url":"https://www.baidu.com"}' }])
    expect(answer.content).toBe('{"url":"https://www.baidu.com"}')
  })

  it('never invents a reasoning setting for the route, because a wrong one fails the whole call', async () => {
    const seen: Array<Record<string, unknown>> = []
    await ask([{ type: 'text-delta', text: '{}' }], seen)
    expect(seen[0]).toMatchObject({ provider: 'opencode-go-new', model: 'deepseek-flash' })
    expect(seen[0]).not.toHaveProperty('reasoningEffort')
  })

  it('sends the question itself unchanged, however reasoning is set', async () => {
    const seen: Array<Record<string, unknown>> = []
    const source = { ...dshSource([{ type: 'text-delta', text: '{}' }], seen), reasoning: 'auto' as const }
    await askText(source, 'system', 'user')
    expect(seen[0]).toMatchObject({ system: 'system', user: 'user' })
    expect(seen[0]).not.toHaveProperty('reasoningEffort')
  })

  it.each([
    ['the route itself failed', [{ type: 'finish', reason: { kind: 'error', failure: { message: 'model not found' } } }], /失败（error/],
    ['the output budget ran out', [{ type: 'finish', reason: { kind: 'max-tokens' } }], /额度/],
    ['only thinking came back', [{ type: 'reasoning-delta', text: '想想' }, { type: 'finish', reason: { kind: 'stop' } }], /思考/],
    ['nothing came back at all', [{ type: 'finish', reason: { kind: 'stop' } }], /没有返回可用的字段值/],
  ])('says what happened when %s', async (_name, chunks, pattern) => {
    await expect(ask(chunks as DshChunk[])).rejects.toThrow(pattern)
  })

  it('records what the stream said, so a failure can be read back later', async () => {
    const written: Array<Record<string, unknown>> = []
    const source = {
      ...dshSource([{ type: 'reasoning-delta', text: '想想' }, { type: 'finish', reason: { kind: 'max-tokens' } }]),
      trace: { write: (record: Record<string, unknown>) => written.push(record) },
    }
    await expect(askText(source, 'system', 'user')).rejects.toThrow()
    expect(written[0]).toMatchObject({ kind: 'text', door: 'dsh', ok: false, finish: 'max-tokens', reasoning_chars: 2 })
  })
})

/**
 * The one question that has to bring back a sentence rather than a choice: what the run found.
 *
 * The decision model answers with a choice and its probabilities and writes nothing, so this is the
 * only way a run can say what it saw. Its rules are the field door's, with one deliberate exception —
 * no length cap, because a list read off a page is a real answer — and its failures are the silent
 * ones the loop swallows (see `loop.test.ts`).
 */
describe('the answer the run is asked for at the end', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const source = { baseUrl: 'https://api.deepseek.com/v1', apiKey: 'test-key', model: 'deepseek-chat', reasoning: 'none' as const }
  const context = {
    goal: '读出携程第一页的酒店名称和评分',
    page: { title: '酒店列表', text: '北京国际饭店 4.8 分，共 2318 条点评' },
  }

  it('asks its own question, with the goal and the page in it, and takes the sentence whole', async () => {
    let body: { messages?: Array<{ role: string; content: string }> } = {}
    vi.stubGlobal('fetch', async (_url: string, init: { body: string }) => {
      body = JSON.parse(init.body) as typeof body
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"text":"北京国际饭店，4.8 分，2318 条点评。"}' } }],
          usage: { total_tokens: 64 },
        }),
      )
    })

    const result = await answerText(source, context)

    expect(result.text).toBe('北京国际饭店，4.8 分，2318 条点评。')
    expect(result.model).toBe('deepseek-chat')
    expect(result.usage).toEqual({ total_tokens: 64 })
    // The question is this one, not the field door's, and what it is shown is the goal and the
    // page the run stopped on — a sentence about any other page is not an answer to anything.
    expect(body.messages?.[0]?.content).toContain('one key, text')
    expect(body.messages?.[1]?.content).toContain(context.goal)
    expect(body.messages?.[1]?.content).toContain('北京国际饭店 4.8 分')
  })

  it.each([
    ['prose instead of JSON', '北京国际饭店，4.8 分'],
    ['an empty sentence', '{"text":""}'],
    ['whitespace only', '{"text":"   "}'],
    ['a null sentence', '{"text":null}'],
    ['extra keys', '{"text":"北京国际饭店","steps":"点了两下"}'],
  ])('answers nothing when the model returns %s', async (_name, content) => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ choices: [{ message: { content } }] })))
    await expect(answerText(source, context)).rejects.toThrow(/没有给出可用的结论/)
  })

  it('takes a long answer, because a list read off a page is an answer', async () => {
    // The field door refuses anything over 2000 characters; this one must not, or a goal that asked
    // for twenty hotels comes back as "the model said nothing".
    const long = '酒店'.repeat(1500)
    vi.stubGlobal('fetch', async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ text: long }) } }] })),
    )
    await expect(answerText(source, context)).resolves.toMatchObject({ text: long })
  })
})
