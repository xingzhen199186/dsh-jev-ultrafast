import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AdoptResult, BrowserPort, PageState, SnapshotAction } from '../src/browser/session'
import { StalePage } from '../src/browser/session'
import type { ActionSpace } from '../src/decision/action-space'
import type { FieldContext, TextResult } from '../src/decision/text-helper'
import type { Decision, DecisionContext } from '../src/decision/typesafe'
import { InvalidDecision, requestChars } from '../src/decision/typesafe'
import { type TaskDeps, runTask } from '../src/loop'

/**
 * The run loop's stopping rules, tested against a scripted page instead of a real
 * browser: what matters here is when the loop refuses to act, not how a click is
 * delivered.
 */

const button = (id: string, node: number, label: string): SnapshotAction => ({ id, kind: 'click', node, label })
const field = (id: string, node: number, label: string): SnapshotAction => ({
  id,
  kind: 'fill',
  node,
  label,
  value: '',
  role: 'textbox',
})

const actions = [button('e1', 1, 'Search'), field('e2', 2, 'Where from?')]

function pageState(fingerprint: string, overrides: Partial<PageState> = {}): PageState {
  return {
    url: 'https://example.test/',
    title: 'Flights',
    w: 1120,
    h: 780,
    text: 'Where from?',
    scroll: { y: 0, height: 1000 },
    actions,
    marker: fingerprint,
    page_key: [],
    guards: {},
    omitted_actions: 0,
    fingerprint,
    ...overrides,
  }
}

/**
 * A page whose element table keeps cycling, the way a site that redraws itself looks from here:
 * the states come back round instead of the page ever sitting still or going somewhere new. What
 * tells one of these states from another is the table — the state's own control standing among the
 * page's own — because that is what the repeated-action rule reads; the page's text is not what
 * tells these states apart.
 */
function statePage(state: string): PageState {
  return pageState(state, { actions: [...actions, button('e9', 9, state)] })
}

function wheel(count: number, states: string[]): PageState[] {
  return Array.from({ length: count }, (_unused, index) => statePage(states[index % states.length]!))
}

function decisionFor(choice: string, target = '1', confidence = 0.9): Decision {
  // The operation is the one the real decision layer would name for the chosen action, so the
  // sentences the loop writes carry the operation the run really performed.
  const chosen = actions.find((candidate) => candidate.id === choice)
  return {
    choice,
    operation:
      choice === 'DONE' || choice === 'BLOCKED' ? choice : chosen?.kind === 'fill' ? 'TYPE_TEXT' : 'CLICK',
    target: choice === 'DONE' || choice === 'BLOCKED' ? null : target,
    confidence,
    probabilities: { [choice]: confidence },
    operationProbabilities: { [choice]: confidence },
    targetProbabilities: {},
    targetConfidence: null,
    usage: {},
    model: 'fake',
    latencyMs: 5,
  }
}

interface Harness {
  deps: TaskDeps
  seen: {
    observations: number
    executed: SnapshotAction[]
    typedFields: FieldContext[]
    closed: boolean
    decisions: number
    /** Every context a decision was asked with, in order. */
    contexts: DecisionContext[]
    /** Every element table a decision was asked about, in order. */
    spaces: ActionSpace[]
    /** What the loop told the browser about the page it was on when it looked for new tabs. */
    adoptOptions: Array<{ onlyIfSameUrl?: boolean } | undefined>
    /** The browser calls in the order they arrived, so a test can assert on their sequence. */
    calls: string[]
  }
}

function harness(config: {
  pages: PageState[]
  /** Scripted freshness answers; once exhausted the page is considered fresh. */
  fresh?: boolean[]
  choices: string[]
  /** Confidence per decision call, drained one per call; the floor is what the re-ask tests vary. */
  confidences?: number[]
  /**
   * Call ordinals (1-based) that come back with something the run cannot act on, and the sentence the
   * decision layer writes about it. A call named here refuses instead of answering, which is what the
   * service does when its own distribution has no winner.
   */
  unusable?: Record<number, string>
  /** The target key to record for a choice, for the tests that need two different targets. */
  targets?: Record<string, string>
  /** Scripted answers to "did that click open a page?", drained one per step. */
  adopt?: Array<AdoptResult | null>
  typeText?: () => Promise<TextResult>
  execute?: (index: number) => void | Promise<void>
  /** Called before each observation, so a test can make one throw. */
  observe?: (index: number) => void | Promise<void>
}): Harness {
  const seen = {
    observations: 0,
    executed: [] as SnapshotAction[],
    typedFields: [] as FieldContext[],
    closed: false,
    decisions: 0,
    contexts: [] as DecisionContext[],
    spaces: [] as ActionSpace[],
    adoptOptions: [] as Array<{ onlyIfSameUrl?: boolean } | undefined>,
    calls: [] as string[],
  }
  const freshQueue = [...(config.fresh ?? [])]
  let pageIndex = 0
  let executeIndex = 0

  const browser: BrowserPort = {
    async call<T>(): Promise<T> {
      return undefined as T
    },
    async observe(): Promise<PageState> {
      seen.calls.push('observe')
      await config.observe?.(seen.observations)
      seen.observations += 1
      const page = config.pages[Math.min(pageIndex, config.pages.length - 1)]!
      pageIndex += 1
      return page
    },
    async settle(): Promise<void> {
      seen.calls.push('settle')
    },
    async fresh(): Promise<boolean> {
      return freshQueue.length > 0 ? freshQueue.shift()! : true
    },
    noteInput(): void {},
    ...(config.adopt
      ? {
          async adoptNewPage(options?: { onlyIfSameUrl?: boolean }): Promise<AdoptResult | null> {
            seen.adoptOptions.push(options)
            return config.adopt!.shift() ?? null
          },
        }
      : {}),
    async close(): Promise<void> {
      seen.closed = true
    },
  }

  const deps: TaskDeps = {
    open: async () => browser,
    decide: async (_source, space, context) => {
      seen.decisions += 1
      seen.contexts.push(context)
      seen.spaces.push(space)
      const unusable = config.unusable?.[seen.decisions]
      if (unusable) throw new InvalidDecision(unusable)
      const choice = config.choices.shift() ?? 'DONE'
      return decisionFor(choice, config.targets?.[choice], config.confidences?.shift() ?? 0.9)
    },
    typeText: async (_source, context) => {
      seen.typedFields.push(context)
      if (config.typeText) return config.typeText()
      return { text: 'Zürich', model: 'fake-text', latencyMs: 3, usage: {} }
    },
    execute: async (_session, _page, action) => {
      seen.executed.push(action)
      await config.execute?.(executeIndex++)
      return { executed: action.id }
    },
  }
  return { deps, seen }
}

const decision = { endpoint: 'https://decisions.test/v1', apiKey: 'k', model: 'jev-latest' }
const text = { baseUrl: 'https://text.test/v1', apiKey: 'k', model: 'small', reasoning: 'none' as const }

function run(
  deps: TaskDeps,
  extra: { maxSteps?: number; signal?: AbortSignal; expect?: string[]; record?: boolean; screenshots?: boolean } = {},
) {
  return runTask({ goal: 'Find a flight', startUrl: 'https://example.test/', decision, text, deps, ...extra })
}

describe('run loop', () => {
  it('runs actions until the decision says DONE', async () => {
    const h = harness({
      pages: [pageState('f0'), pageState('f1'), pageState('f2')],
      choices: ['e1', 'e2', 'DONE'],
    })
    const result = await run(h.deps)

    expect(result.status).toBe('done')
    expect(result.reason).toBe('')
    expect(result.steps).toBe(2)
    expect(result.decisions).toBe(3)
    expect(h.seen.executed.map((action) => action.id)).toEqual(['e1', 'e2'])
    expect(result.history.map((entry) => entry.action)).toEqual(['Search', 'Where from?'])
    expect(result.history[0]).toMatchObject({ step: 1, page_changed: true, operation: 'CLICK', probability: 0.9 })
    expect(result.page).toMatchObject({ title: 'Flights' })
    expect(result.elements.length).toBeGreaterThan(0)
    expect(h.seen.closed).toBe(true)
  })

  it('lets the page a step changed finish painting before it looks again', async () => {
    const h = harness({
      pages: [pageState('f0'), pageState('f1')],
      choices: ['e1', 'DONE'],
    })

    const result = await run(h.deps)

    // The order is the fix: the observation used to follow the step immediately, so a page still
    // painting its results was read as a finished one (Baidu, 2026-09-30 — the run returned a
    // search whose results had not arrived yet).
    expect(h.seen.calls.slice(0, 3)).toEqual(['observe', 'settle', 'observe'])
    expect(result.status).toBe('done')
  })

  it('keeps a step that already ran when the page then refuses to be observed', async () => {
    const h = harness({
      pages: [pageState('f0'), pageState('f1')],
      choices: ['e1'],
      // The click lands; the observation that follows it blows up.
      observe: (index) => {
        if (index === 1) throw new Error('页面一直不收敛')
      },
    })
    const result = await run(h.deps)

    expect(h.seen.executed.map((action) => action.id)).toEqual(['e1'])
    expect(result.status).toBe('failed')
    // The step survived the failed observation, carrying the URL it was on when it ran.
    expect(result.steps).toBe(1)
    expect(result.history[0]).toMatchObject({
      step: 1,
      action: 'Search',
      url: 'https://example.test/',
      page_changed: null,
    })
  })

  it('keeps a DONE the finished page supports', async () => {
    const h = harness({
      pages: [pageState('f0'), pageState('f1', { text: '预订成功，确认号 AB-1234' }), pageState('f1')],
      choices: ['e1', 'DONE'],
    })
    const result = await run(h.deps, { expect: ['AB-1234', '!没有结果'] })

    expect(result.status).toBe('done')
    expect(result.verification).toMatchObject({ checked: true, passed: true })
    expect(result.verification.note).toContain('核验通过')
  })

  it('takes back a DONE the finished page does not support', async () => {
    const h = harness({
      pages: [pageState('f0'), pageState('f1'), pageState('f1')],
      choices: ['e1', 'DONE'],
    })
    const result = await run(h.deps, { expect: ['预订成功'] })

    // The page the model called finished says "Where from?" and nothing about a booking, so
    // the run is reported as unfinished rather than as done.
    expect(result.status).toBe('blocked')
    expect(result.reason).toContain('核验未通过')
    expect(result.reason).toContain('预订成功')
    expect(result.verification).toMatchObject({ checked: true, passed: false })
  })

  it('does not call an unchecked run verified', async () => {
    const h = harness({ pages: [pageState('f0'), pageState('f1')], choices: ['e1', 'DONE'] })
    const result = await run(h.deps)

    expect(result.status).toBe('done')
    expect(result.verification.checked).toBe(false)
    expect(result.verification.note).toContain('未经核实')
  })

  it('will not accept a terminal answer for a page that has moved on', async () => {
    const h = harness({
      pages: [pageState('f0'), pageState('f1'), pageState('f1')],
      // decision check, then the terminal check says the page moved, then it settles
      fresh: [true, true, false, true, true],
      choices: ['e1', 'DONE', 'DONE'],
    })
    const result = await run(h.deps)

    expect(result.status).toBe('done')
    expect(result.decisions).toBe(3)
    expect(h.seen.observations).toBe(3)
  })

  it('re-observes instead of acting on a page that changed, without paying twice for the same value', async () => {
    const h = harness({
      pages: [pageState('f0'), pageState('f1'), pageState('f2')],
      choices: ['e2', 'e2', 'DONE'],
      execute: (index) => {
        if (index === 0) throw new StalePage('目标已经变化或被遮挡，请重新观察')
      },
    })
    const result = await run(h.deps)

    expect(result.status).toBe('done')
    expect(result.steps).toBe(1)
    expect(result.decisions).toBe(3)
    expect(h.seen.executed.map((action) => action.id)).toEqual(['e2', 'e2'])
    expect(h.seen.typedFields).toHaveLength(1)
    expect(result.history[0]).toMatchObject({ text: 'Zürich', text_helper: 'fake-text', kind: 'fill' })
    expect(result.textCalls).toHaveLength(1)
  })

  it('stops after three steps that changed nothing', async () => {
    const h = harness({
      pages: [pageState('same')],
      choices: ['e1', 'e1', 'e1', 'e1'],
    })
    const result = await run(h.deps)

    expect(result.status).toBe('blocked')
    expect(result.reason).toMatch(/连续 3 步/)
    expect(result.steps).toBe(3)
  })

  it('stops when one target keeps bringing back page states the run has already shown', async () => {
    // Three states in a wheel: the first three steps are new, and from the fourth on every step
    // shows a state the run has already shown. That is the shape of the 携程 loop (2026-10-01),
    // where the page cycled through the same few states for 60 steps and changed on almost every
    // one — so the rule above, which counts steps that changed nothing at all, never fired.
    const h = harness({
      pages: [pageState('f0'), ...wheel(12, ['f1', 'f2', 'f3'])],
      choices: Array.from({ length: 12 }, () => 'e1'),
    })
    const result = await run(h.deps)

    expect(result.status).toBe('blocked')
    // Nine, not eight: the window ending at step 8 still holds the first appearance of f3.
    expect(result.steps).toBe(9)
    expect(h.seen.executed).toHaveLength(9)
    expect(result.reason).toBe(
      '同一个动作连着做了 6 次、页面只是在几个老样子之间打转，先停下——它卡在这个动作上了：CLICK 目标 1「Search」',
    )
  })

  it('does not stop when a state the run has never shown turns up inside the window', async () => {
    const h = harness({
      // The wheel runs seven steps, then one state nothing has shown before, then the wheel again.
      pages: [pageState('f0'), ...wheel(7, ['f1', 'f2', 'f3']), statePage('f4'), ...wheel(6, ['f1', 'f2', 'f3'])],
      choices: Array.from({ length: 20 }, () => 'e1'),
    })
    const result = await run(h.deps)

    // Without the new state at step 8 the window would have closed six replays in, at step 9.
    // The intruder holds it open until it has fallen out of it, so the run stops at step 14.
    expect(result.status).toBe('blocked')
    expect(result.steps).toBe(14)
    expect(result.reason).toContain('连着做了 6 次')
  })

  it('does not stop while the steps keep changing target, however old the states they bring back', async () => {
    const h = harness({
      pages: [pageState('f0'), ...wheel(16, ['f1', 'f2', 'f3'])],
      choices: [...Array.from({ length: 14 }, (_unused, index) => (index % 2 === 0 ? 'e1' : 'e2')), 'DONE'],
      targets: { e1: '1', e2: '2' },
    })
    const result = await run(h.deps)

    // Six steps in a row only count when they are aimed at one and the same target: a run that
    // moves between two controls is doing something, even on a page that redraws constantly.
    expect(result.status).toBe('done')
    expect(result.steps).toBe(14)
  })

  it('says how many times it repeated the action, and writes it into the run trace', async () => {
    const h = harness({
      pages: [pageState('f0'), ...wheel(12, ['f1', 'f2', 'f3'])],
      choices: Array.from({ length: 12 }, () => 'e2'),
      targets: { e2: '2' },
    })
    const result = await run(h.deps, { record: true })

    try {
      expect(result.reason).toBe(
        '同一个动作连着做了 6 次、页面只是在几个老样子之间打转，先停下——它卡在这个动作上了：TYPE_TEXT 目标 2「Where from?」',
      )
      const trace = readFileSync(join(result.recordDir, 'trace.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
      // The last word of the trace carries the same facts, so the file explains the stop on its
      // own: which action, which target, and how many times it went round.
      expect(trace[trace.length - 1]).toMatchObject({
        kind: 'run',
        status: 'blocked',
        steps: 9,
        stuck_on: { operation: 'TYPE_TEXT', target: '2', action: 'Where from?', times: 6 },
      })
    } finally {
      rmSync(result.recordDir, { recursive: true, force: true })
    }
  })

  it('stops a repeated action even when the page text changes on every step', async () => {
    // The 携程 home page of 2026-10: the banner carousel rewrote the body on every paint, so the
    // page's text — and with it the whole-page fingerprint — was a different string on every step,
    // while the screen a reader would call "the same screen" never moved: the controls and the
    // address stayed put. Judged on the text, the run came back to a state it had never shown 31
    // times in a row and this rule never fired. Judged on the element table and the address, the
    // window closes on the sixth step, which is what it was written to stop on.
    const frames = Array.from({ length: 12 }, (_unused, index) =>
      pageState(`t${index + 1}`, { text: `广告轮播第 ${index + 1} 帧` }),
    )
    const h = harness({
      pages: [pageState('t0'), ...frames],
      choices: Array.from({ length: 12 }, () => 'e1'),
    })
    const result = await run(h.deps)

    expect(result.status).toBe('blocked')
    expect(result.steps).toBe(6)
    expect(result.reason).toBe(
      '同一个动作连着做了 6 次、页面只是在几个老样子之间打转，先停下——它卡在这个动作上了：CLICK 目标 1「Search」',
    )
    // The step's own report is untouched by the narrower state: the whole-page fingerprint really
    // did move, and that is still what `page_changed` says.
    expect(result.history[0]).toMatchObject({ page_changed: true })
  })

  it('does not stop when the element table keeps producing a state the run has not shown', async () => {
    // A list really being worked through: every step brings a table the run has not seen, so
    // nothing is a replay and the window never closes, though the same control is used each time.
    const h = harness({
      pages: [
        pageState('f0'),
        ...Array.from({ length: 9 }, (_unused, index) =>
          pageState(`f${index + 1}`, { actions: [...actions, button('e9', 9, `Option ${index + 1}`)] }),
        ),
      ],
      choices: [...Array.from({ length: 9 }, () => 'e1'), 'DONE'],
    })
    const result = await run(h.deps)

    expect(result.status).toBe('done')
    expect(result.steps).toBe(9)
  })

  it('does not stop when only the address keeps changing', async () => {
    // The same controls on every screen, but a different address each time: the run is moving
    // through pages a reader would also call different screens, so nothing is a replay.
    const h = harness({
      pages: [
        pageState('f0'),
        ...Array.from({ length: 9 }, (_unused, index) =>
          pageState(`f${index + 1}`, { url: `https://example.test/page-${index + 1}` }),
        ),
      ],
      choices: [...Array.from({ length: 9 }, () => 'e1'), 'DONE'],
    })
    const result = await run(h.deps)

    expect(result.status).toBe('done')
    expect(result.steps).toBe(9)
  })

  it('stops on the sixth repeat and not on the fifth', async () => {
    // The threshold, pinned where it has always been: five repeats are still allowed to be a slow
    // run, the sixth is the run going round in circles. The screens are the carousel's — only the
    // text moves — which is exactly the page that used to hold this rule off for good.
    const frames = (count: number): PageState[] =>
      Array.from({ length: count }, (_unused, index) =>
        pageState(`t${index + 1}`, { text: `广告轮播第 ${index + 1} 帧` }),
      )

    const five = await run(
      harness({
        pages: [pageState('t0'), ...frames(5)],
        choices: [...Array.from({ length: 5 }, () => 'e1'), 'DONE'],
      }).deps,
    )
    expect(five.status).toBe('done')
    expect(five.reason).toBe('')
    expect(five.steps).toBe(5)

    const six = await run(
      harness({ pages: [pageState('t0'), ...frames(6)], choices: Array.from({ length: 6 }, () => 'e1') }).deps,
    )
    expect(six.status).toBe('blocked')
    expect(six.steps).toBe(6)
    expect(six.reason).toContain('同一个动作连着做了 6 次')
  })

  it('leaves the other stopping reasons alone on a screen that looks the same on every look', async () => {
    // Two looks whose text differs and whose element table and address do not: the repeated-action
    // rule reads that as one state from the first look on, which is where it could have swallowed a
    // reason that is not its own. Neither an unsure answer nor a pair of disagreeing ones is that
    // rule's business, so each still gets the sentence it always got.
    const looks = (): PageState[] => [pageState('t0'), pageState('t1', { text: '广告轮播的另一帧' })]

    const disagreeing = await run(harness({ pages: looks(), choices: ['e1', 'e2'], confidences: [0.2, 0.6] }).deps)
    expect(disagreeing.status).toBe('blocked')
    expect(disagreeing.reason).toBe('决策服务两次给的答案不一样（第一次把握低于 0.5），先停下')
    expect(disagreeing.steps).toBe(0)
    expect(disagreeing.reasks).toHaveLength(1)

    const unsure = await run(
      harness({ pages: looks(), choices: ['e1', 'e1', 'DONE'], confidences: [0.3, 0.42, 0.9] }).deps,
    )
    expect(unsure.status).toBe('done')
    expect(unsure.steps).toBe(1)
    expect(unsure.reasks).toEqual([
      {
        step: 1,
        reason: 'low-confidence',
        agreed: true,
        first: { choice: 'e1', confidence: 0.3, probabilities: { e1: 0.3 } },
        second: { choice: 'e1', confidence: 0.42, probabilities: { e1: 0.42 } },
      },
    ])
  })

  it('stops at the action budget without asking for another decision to act on', async () => {
    const h = harness({
      pages: [pageState('f0'), pageState('f1'), pageState('f2'), pageState('f3')],
      choices: ['e1', 'e1', 'e1'],
    })
    const result = await run(h.deps, { maxSteps: 1 })

    expect(result.status).toBe('blocked')
    expect(result.reason).toMatch(/动作上限（1 步）/)
    expect(result.steps).toBe(1)
    expect(result.decisions).toBe(2)
  })

  it('stops at the model-call budget, which a repeatedly stale field can reach on its own', async () => {
    const h = harness({
      pages: Array.from({ length: 10 }, (_unused, index) => pageState(`f${index}`)),
      // Each cycle decides to type, then finds the page changed before the input,
      // so it consumes a decision and executes nothing.
      fresh: [true, false, true, false, true, false, true, false],
      choices: ['e2', 'e2', 'e2', 'e2', 'e2'],
    })
    const result = await run(h.deps, { maxSteps: 2 })

    expect(result.status).toBe('blocked')
    expect(result.reason).toMatch(/模型调用上限（4 次）/)
    expect(result.decisions).toBe(4)
    expect(result.steps).toBe(0)
    expect(h.seen.typedFields).toHaveLength(0)
    expect(h.seen.executed).toHaveLength(0)
  })

  it('fails the run when a field value cannot be produced', async () => {
    const h = harness({
      pages: [pageState('f0')],
      choices: ['e2'],
      typeText: async () => {
        throw new Error('文本模型没有返回可用的字段值，什么都没有输入')
      },
    })
    const result = await run(h.deps)

    expect(result.status).toBe('failed')
    expect(result.reason).toMatch(/什么都没有输入/)
    expect(h.seen.executed).toHaveLength(0)
    expect(h.seen.closed).toBe(true)
  })

  it('fails the run when no browser can be opened', async () => {
    const h = harness({ pages: [pageState('f0')], choices: [] })
    const result = await run({
      ...h.deps,
      open: async () => {
        throw new Error('没有找到可用的浏览器调试端口')
      },
    })

    expect(result.status).toBe('failed')
    expect(result.reason).toMatch(/没有找到可用的浏览器调试端口/)
    expect(result.page).toBeNull()
    expect(result.elements).toEqual([])
  })

  it('observes the page again and asks again when the chosen number is not in it', async () => {
    // The page redrew under the answer — a banner, a popup, a countdown — so the number the
    // model named is gone. That is the page's doing, not evidence that the task cannot be
    // done: the run looks again, says so in one sentence, and lets the model choose again.
    const h = harness({
      pages: [pageState('f0'), pageState('f1'), pageState('f2')],
      choices: ['e99', 'e1', 'DONE'],
    })
    const result = await run(h.deps)

    expect(result.status).toBe('done')
    expect(result.steps).toBe(1)
    // The retry costs a decision like any other: no extra allowance was invented for it.
    expect(result.decisions).toBe(3)
    expect(h.seen.executed.map((action) => action.id)).toEqual(['e1'])
    // The sentence rides exactly one request: the one asked after the miss.
    expect(h.seen.contexts[1]?.note).toBe('你上次选的编号在页面里已经找不到了，页面可能自己刷新过，请重新选')
    expect(h.seen.contexts[0]?.note).toBeUndefined()
    expect(h.seen.contexts[2]?.note).toBeUndefined()
  })

  it('stops with a sentence the reader can understand when the number keeps missing', async () => {
    // Two in a row, with a fresh observation in between each time, means the answer and the
    // page are out of step by construction; further rounds would only spend the budget.
    const h = harness({ pages: [pageState('f0')], choices: ['e99', 'e99', 'e99', 'e99'] })
    const result = await run(h.deps)

    expect(result.status).toBe('failed')
    expect(result.reason).toBe('页面在你选的元素前后自己刷新了，连续 3 次都没对上，这次先停下')
    expect(result.decisions).toBe(3)
    expect(h.seen.executed).toHaveLength(0)
    expect(h.seen.closed).toBe(true)
  })

  it('tells the model when the page content sits where the snapshot cannot reach', async () => {
    // The top document offered nothing and holds one frame: the sentence is what keeps the
    // model from reading the page as simply empty.
    const nested = { frames: 1, frame_url: 'https://inside.test/app', shadow_roots: 0, elements: 0 }
    const h = harness({ pages: [pageState('f0', { nested })], choices: ['DONE'] })
    const result = await run(h.deps)

    expect(h.seen.contexts[0]?.note).toBe(
      '这个页面的主要内容在嵌套的框架里（1 个 iframe），插件看不到里面的内容，所以这里推不动。' +
        '可以试试直接打开里面的地址：https://inside.test/app',
    )
    // And the same sentence is on the result, which is where the reader reads it.
    expect(result.pageNote).toBe(h.seen.contexts[0]?.note)
  })

  it('says nothing about a page the snapshot could see in full', async () => {
    const h = harness({ pages: [pageState('f0')], choices: ['DONE'] })
    const result = await run(h.deps)

    expect(result.pageNote).toBe('')
    expect(h.seen.contexts[0]?.note).toBeUndefined()
  })

  it('stops before spending anything when the caller has already cancelled', async () => {
    const h = harness({ pages: [pageState('f0')], choices: ['e1'] })
    const controller = new AbortController()
    controller.abort()
    const result = await run(h.deps, { signal: controller.signal })

    expect(result.status).toBe('blocked')
    expect(result.reason).toBe('任务已被取消')
    expect(result.decisions).toBe(0)
    expect(result.steps).toBe(0)
    expect(h.seen.observations).toBe(1)
  })

  it('reports progress while it runs', async () => {
    const events: string[] = []
    const h = harness({
      pages: [pageState('f0'), pageState('f1'), pageState('f2')],
      choices: ['e1', 'DONE'],
    })
    const result = await runTask({
      goal: 'Find a flight',
      startUrl: 'https://example.test/',
      decision,
      text,
      deps: h.deps,
      onEvent: (event) => events.push(event.type),
    })

    expect(result.status).toBe('done')
    expect(events).toEqual(['observed', 'decided', 'executed', 'decided', 'finished'])
  })

  it('hands the browser settings, chosen browser included, straight to the opener', async () => {
    // The tool passes the settings through untouched, so this is what decides which of two
    // running browsers a task drives: the one the settings page names, not the one that
    // happened to start first.
    const h = harness({ pages: [pageState('f0')], choices: ['DONE'] })
    const browser = { cdpUrl: 'http://127.0.0.1:9222', userDataDir: 'C:\\profile', preferredKind: 'edge' as const }
    let handed: unknown
    const result = await runTask({
      goal: 'Find a flight',
      startUrl: 'https://example.test/',
      browser,
      decision,
      text,
      deps: {
        ...h.deps,
        open: async (_url, options) => {
          handed = options
          return h.deps.open(_url, options)
        },
      },
    })

    expect(result.status).toBe('done')
    expect(handed).toEqual(browser)
  })

  it('follows the tab a click opened when this tab stayed on its address', async () => {
    // The step's effect is in the new tab, so the run moves there: the pages are
    // scripted so the action leaves this page on the same address (f0 → f0) and the
    // observation after following reads the second page.
    const second = pageState('f2', { url: 'https://example.test/second', title: 'Second page', text: 'the page' })
    const h = harness({
      pages: [pageState('f0'), pageState('f0'), second],
      choices: ['e1', 'DONE'],
      // As the browser really reports it: the tab is there with its address before it
      // has a title, so the entry that says which page the run moved onto gets its name
      // from the observation made after arriving.
      adopt: [{ adopted: { url: second.url, title: '' }, appeared: [{ url: second.url, title: '' }] }],
    })
    const result = await run(h.deps)

    expect(result.status).toBe('done')
    expect(h.seen.adoptOptions).toEqual([{ onlyIfSameUrl: true }])
    expect(result.follows).toEqual([
      { step: 1, adopted: { url: second.url, title: 'Second page' }, appeared: [{ url: second.url, title: '' }] },
    ])
    // The step counts as a change, because the run's page really did change — which is
    // what keeps the stuck detector from calling a followed click "nothing happened".
    expect(result.history[0]).toMatchObject({ step: 1, page_changed: true })
    expect(result.page).toMatchObject({ url: second.url, title: 'Second page' })
  })

  it('stays put when this tab navigated, and still reports the tab that appeared', async () => {
    // A site that navigates *and* opens a popup: the effect is on the page in hand, so
    // following the popup would hand the run to whatever else the site opened.
    const popup = { url: 'https://ads.test/popup', title: 'Popup' }
    const moved = pageState('f1', { url: 'https://example.test/next' })
    const h = harness({
      pages: [pageState('f0'), moved, pageState('f2')],
      choices: ['e1', 'DONE'],
      adopt: [{ adopted: null, appeared: [popup] }],
    })
    const result = await run(h.deps)

    expect(result.status).toBe('done')
    expect(h.seen.adoptOptions).toEqual([{ onlyIfSameUrl: false }])
    expect(result.follows).toEqual([{ step: 1, adopted: null, appeared: [popup] }])
    expect(result.page).toMatchObject({ url: 'https://example.test/next' })
  })

  it('says a new window was opened rather than claiming the page did not change', async () => {
    // Three steps that leave the page alone, each opening a window the run cannot use
    // (a browser-internal page is the real case). The old wording, "the page did not
    // change", was true and useless: it hid that the clicks were landing somewhere.
    const external = { url: 'chrome://newtab/', title: '' }
    const h = harness({
      pages: [pageState('f0'), pageState('f0'), pageState('f0'), pageState('f0')],
      choices: ['e1', 'e1', 'e1'],
      adopt: [
        { adopted: null, appeared: [external] },
        { adopted: null, appeared: [external] },
        { adopted: null, appeared: [external] },
      ],
    })
    const result = await run(h.deps)

    expect(result.status).toBe('blocked')
    expect(result.reason).toContain('连续 3 步当前页面没有任何变化，已停止')
    expect(result.reason).toContain('其中 3 步点开了新窗口，但没有跟过去')
  })

  it('records a run only when asked to, and leaves nothing behind otherwise', async () => {
    // The loop stays a pure function of its inputs by default: the tool asks for a record,
    // a test does not, and that difference is what keeps this suite free of temp files.
    const quiet = await run(harness({ pages: [pageState('f0'), pageState('f0')], choices: ['e1', 'DONE'] }).deps)
    expect(quiet.recordDir).toBe('')

    const h = harness({
      pages: [pageState('f0', { screenshot: 'aGVsbG8=' }), pageState('f1', { screenshot: 'd29ybGQ=' })],
      choices: ['e1', 'DONE'],
    })
    const recorded = await run(h.deps, { record: true, screenshots: true })
    try {
      // One frame before the first action and one after it, in the order they happened, each
      // named by the step it belongs to.
      const manifest = JSON.parse(readFileSync(join(recorded.recordDir, 'frames.json'), 'utf8'))
      expect(manifest.frames).toHaveLength(2)
      expect(manifest.frames[0]).toMatchObject({ file: 'step-000-start.jpg', step: 0, action: 'start', at_ms: 0 })
      expect(manifest.frames[1]).toMatchObject({ file: 'step-001-click.jpg', step: 1, action: 'click' })
      expect(readFileSync(join(recorded.recordDir, 'frames', manifest.frames[0].file), 'utf8')).toBe('hello')
      expect(readFileSync(join(recorded.recordDir, 'frames', manifest.frames[1].file), 'utf8')).toBe('world')

      // The fake decision layer writes no exchanges, so the trace holds exactly the run's
      // own last word — which is what a reader needs to make sense of the rest of it.
      const trace = readFileSync(join(recorded.recordDir, 'trace.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
      expect(trace).toHaveLength(1)
      expect(trace[0]).toMatchObject({ kind: 'run', status: 'done', steps: 1 })
    } finally {
      rmSync(recorded.recordDir, { recursive: true, force: true })
    }
  })

  it('hands the run s own trace sink to the action, so a step can write down what only it knows', async () => {
    // A press is the one step with something to say that the page does not keep afterwards —
    // whether the field already had the focus, so whether a click was paid for on the way in. The
    // record itself belongs to the executor (see `browser/act.ts`); what is checked here is only
    // that the loop hands its sink over, because a sink nobody receives is a trace with the line
    // missing, and every executor-level check would still pass.
    const h = harness({ pages: [pageState('f0'), pageState('f1')], choices: ['e1', 'DONE'] })
    const own = h.deps.execute
    let handed: unknown
    h.deps.execute = async (session, page, action, text, trace) => {
      handed = trace
      trace?.write({ at: 1, kind: 'press_key', node: action.node, key: 'enter', focus: 'yes', clicked: false })
      return own(session, page, action, text, trace)
    }
    const result = await run(h.deps, { record: true })

    try {
      expect(handed).toBeDefined()
      const trace = readFileSync(join(result.recordDir, 'trace.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
      expect(trace.filter((record) => record.kind === 'press_key')).toEqual([
        { at: 1, kind: 'press_key', node: 1, key: 'enter', focus: 'yes', clicked: false },
      ])
    } finally {
      rmSync(result.recordDir, { recursive: true, force: true })
    }
  })

  it('takes the screen after a step whose action threw, without changing the failure', async () => {
    // A step that threw is the one a reader most wants to look at, and no observation of its
    // aftermath exists yet: the ordinary path never reached the line that takes one. The run
    // still fails for the action's own reason — the picture is evidence, not a verdict.
    const h = harness({
      pages: [pageState('f0', { screenshot: 'aGVsbG8=' }), pageState('f1', { screenshot: 'd29ybGQ=' })],
      choices: ['e1', 'DONE'],
      execute: () => {
        throw new Error('点击没落地')
      },
    })
    const result = await run(h.deps, { record: true, screenshots: true })
    try {
      expect(result.status).toBe('failed')
      expect(result.reason).toBe('点击没落地')

      const manifest = JSON.parse(readFileSync(join(result.recordDir, 'frames.json'), 'utf8'))
      expect(manifest.frames.map((frame: { file: string }) => frame.file)).toEqual([
        'step-000-start.jpg',
        'step-001-click.jpg',
      ])
      expect(manifest.frames[1]).toMatchObject({ step: 1, action: 'click' })
      expect(readFileSync(join(result.recordDir, 'frames', 'step-001-click.jpg'), 'utf8')).toBe('world')
    } finally {
      rmSync(result.recordDir, { recursive: true, force: true })
    }
  })

  it('keeps the failure of the action itself when the screen after it cannot be read', async () => {
    // The observation taken for that last frame is the one that fails, which is the state a page
    // that will not settle leaves the run in. One failure must not be replaced by the failure of
    // reporting it: the reader gets the action's own sentence and the frames that did land.
    const h = harness({
      pages: [pageState('f0', { screenshot: 'aGVsbG8=' }), pageState('f1', { screenshot: 'd29ybGQ=' })],
      choices: ['e1', 'DONE'],
      execute: () => {
        throw new Error('点击没落地')
      },
      observe: (index) => {
        if (index === 1) throw new Error('页面读不出来')
      },
    })
    const result = await run(h.deps, { record: true, screenshots: true })
    try {
      expect(result.status).toBe('failed')
      expect(result.reason).toBe('点击没落地')

      const manifest = JSON.parse(readFileSync(join(result.recordDir, 'frames.json'), 'utf8'))
      expect(manifest.frames.map((frame: { file: string }) => frame.file)).toEqual(['step-000-start.jpg'])
    } finally {
      rmSync(result.recordDir, { recursive: true, force: true })
    }
  })

  it('sends a table cut to the cap, and says how many elements it left out', async () => {
    // 60 numbered controls is the shape of the GitHub run in the 2026-10 audit, where the table
    // grew from 14 elements to 97 inside one run until the service's two best answers sat within
    // 0.05 of each other. What is sent is a selection; the run's own table is not cut.
    const crowd = Array.from({ length: 60 }, (_unused, at) => button(`e${at + 1}`, at + 1, `Option ${at + 1}`))
    const h = harness({ pages: [pageState('f0', { actions: crowd, text: 'y'.repeat(4000) })], choices: ['DONE'] })
    const result = await run(h.deps)

    expect(result.status).toBe('done')
    expect(h.seen.spaces[0]!.elements).toHaveLength(48)
    expect(h.seen.contexts[0]!.omittedElements).toBe(12)
    expect(result.elements).toHaveLength(60)
    // Reported back for the reader: what the last request carried, what it left out, and that the
    // page's own text was longer than one request may hold.
    expect(result.sentElements).toBe(48)
    expect(result.omittedElements).toBe(12)
    expect(result.textCut).toBe(4000 - 3000)
  })

  it('says nothing about a table that fits', async () => {
    const h = harness({ pages: [pageState('f0')], choices: ['DONE'] })
    const result = await run(h.deps)

    expect(h.seen.contexts[0]!.omittedElements).toBeUndefined()
    // Nothing was cut, so there is nothing to report: the ordinary run says nothing about size.
    expect(result.sentElements).toBe(2)
    expect(result.omittedElements).toBe(0)
    expect(result.textCut).toBe(0)
  })

  it('cuts the table below the cap when the page itself would still overshoot the request budget', async () => {
    // Long labels and a value on every control are what counting cannot see: 97 such elements
    // measured 26,650 characters once the table was cut to 48. The body the service receives is the
    // thing that has to fit, so the run measures it and cuts the table again.
    const heavy = Array.from({ length: 97 }, (_unused, at) => ({
      id: `e${at + 1}`,
      kind: 'click' as const,
      node: at + 1,
      role: 'button',
      label:
        `Open the settings page for repository number ${at + 1} and then select the branch called ` +
        `feature/very-long-branch-name-${at + 1}`,
      value: `repository-${at + 1}-current-value-that-the-page-reports`,
    }))
    const h = harness({ pages: [pageState('f0', { actions: heavy })], choices: ['DONE'] })
    const result = await run(h.deps)

    expect(result.status).toBe('done')
    const [space, asked] = [h.seen.spaces[0]!, h.seen.contexts[0]!]
    expect(space.elements.length).toBeLessThan(48)
    expect(asked.omittedElements).toBe(97 - space.elements.length)
    // Measured from exactly what the run handed the decision layer.
    expect(requestChars(space, asked, decision.model)).toBeLessThanOrEqual(20_000)
  })

  it('asks the same question again when the service says it is unsure, and executes two answers that agree', async () => {
    const h = harness({
      pages: [pageState('f0'), pageState('f1')],
      choices: ['e1', 'e1', 'DONE'],
      confidences: [0.3, 0.42, 0.9],
    })
    const result = await run(h.deps)

    expect(result.status).toBe('done')
    expect(result.steps).toBe(1)
    // The second question is a decision like any other, and the only extra one this step costs.
    expect(result.decisions).toBe(3)
    expect(h.seen.executed.map((action) => action.id)).toEqual(['e1'])
    // The same question means the same page, the same table and the same one-off sentence.
    expect(h.seen.spaces[1]).toBe(h.seen.spaces[0])
    expect(h.seen.contexts[1]).toEqual(h.seen.contexts[0])
    expect(result.reasks).toEqual([
      {
        step: 1,
        reason: 'low-confidence',
        agreed: true,
        first: { choice: 'e1', confidence: 0.3, probabilities: { e1: 0.3 } },
        second: { choice: 'e1', confidence: 0.42, probabilities: { e1: 0.42 } },
      },
    ])
  })

  it('stops when the two answers disagree, and keeps what each one said', async () => {
    const h = harness({
      pages: [pageState('f0')],
      choices: ['e1', 'e2', 'DONE'],
      confidences: [0.2, 0.6],
    })
    const result = await run(h.deps)

    expect(result.status).toBe('blocked')
    expect(result.reason).toBe('决策服务两次给的答案不一样（第一次把握低于 0.5），先停下')
    expect(result.steps).toBe(0)
    expect(result.decisions).toBe(2)
    expect(h.seen.executed).toHaveLength(0)
    expect(result.reasks).toEqual([
      {
        step: 1,
        reason: 'low-confidence',
        agreed: false,
        first: { choice: 'e1', confidence: 0.2, probabilities: { e1: 0.2 } },
        second: { choice: 'e2', confidence: 0.6, probabilities: { e2: 0.6 } },
      },
    ])
  })

  /**
   * The two sentences the decision layer writes for an answer the run cannot act on, kept verbatim
   * from `./decision/typesafe` and from the 携程 run of 2026-10-02 whose trace carries the first one.
   */
  const UNUSABLE_MISMATCH =
    '决策服务返回了无法执行的结果，没有执行任何动作：「下一步该做哪个操作」它选的是 WAIT（概率 0.35），' +
    '但概率最高的是 CLICK（概率 0.36）——这一问它自己没拿定主意'
  const UNUSABLE_MISSING =
    '决策服务返回了无法执行的结果，没有执行任何动作：「下一步该做哪个操作」这一问没有给出可用的概率表：收到 什么都没有'

  it('asks again when the answer cannot be acted on, and runs the second one', async () => {
    // The run of 2026-10-02 stopped on the first sentence above: the service named WAIT at 0.35 over
    // its own 0.36 CLICK, and the step threw instead of spending one more question on it. An answer
    // that cannot be read is the same "ask once more" as an unsure one, and the step runs on what
    // comes back — here the answer it could not get the first time.
    const h = harness({
      pages: [pageState('f0'), pageState('f1')],
      choices: ['e1', 'DONE'],
      unusable: { 1: UNUSABLE_MISMATCH },
    })
    const result = await run(h.deps)

    expect(result.status).toBe('done')
    expect(result.steps).toBe(1)
    // The refused asking plus the two that answered: an unusable answer is paid for like any other.
    expect(result.decisions).toBe(3)
    expect(h.seen.executed.map((action) => action.id)).toEqual(['e1'])
    expect(result.reasks).toEqual([
      {
        step: 1,
        reason: 'unusable',
        agreed: false,
        first: null,
        second: { choice: 'e1', confidence: 0.9, probabilities: { e1: 0.9 } },
        unusable: { first: UNUSABLE_MISMATCH },
      },
    ])
  })

  it('stops when both askings of one step cannot be acted on, and keeps both sentences', async () => {
    const h = harness({
      pages: [pageState('f0')],
      choices: [],
      unusable: { 1: UNUSABLE_MISMATCH, 2: UNUSABLE_MISSING },
    })
    const result = await run(h.deps)

    expect(result.status).toBe('blocked')
    // The decision layer's own sentence, the one that names what the service chose, that choice's
    // probability and the one that beat it. It is the whole reason the run stopped, and no action
    // was taken on either asking.
    expect(result.reason).toBe(UNUSABLE_MISSING)
    expect(result.steps).toBe(0)
    expect(result.decisions).toBe(2)
    expect(h.seen.executed).toHaveLength(0)
    expect(result.reasks).toEqual([
      {
        step: 1,
        reason: 'unusable',
        agreed: false,
        first: null,
        second: null,
        unusable: { first: UNUSABLE_MISMATCH, second: UNUSABLE_MISSING },
      },
    ])
  })

  it('stops on the service’s own sentence when the second asking is the unusable one', async () => {
    // One extra question per step, whichever of the two askings is the one that cannot be read: an
    // unsure answer that is then answered with a refusal ends the step rather than earning a third.
    const h = harness({
      pages: [pageState('f0')],
      choices: ['e1'],
      confidences: [0.3],
      unusable: { 2: UNUSABLE_MISMATCH },
    })
    const result = await run(h.deps)

    expect(result.status).toBe('blocked')
    expect(result.reason).toBe(UNUSABLE_MISMATCH)
    expect(result.decisions).toBe(2)
    expect(result.reasks).toEqual([
      {
        step: 1,
        reason: 'low-confidence',
        agreed: false,
        first: { choice: 'e1', confidence: 0.3, probabilities: { e1: 0.3 } },
        second: null,
        unusable: { second: UNUSABLE_MISMATCH },
      },
    ])
  })

  it('does not spend a question the model-call budget cannot afford, even on an unusable answer', async () => {
    const h = harness({
      pages: [pageState('f0'), pageState('f1')],
      // The first answer's field goes stale, so it costs a decision and no step; the next answer is
      // the one that cannot be read, and the budget is exactly one decision short of asking again.
      fresh: [true, false],
      choices: ['e2'],
      unusable: { 2: UNUSABLE_MISMATCH },
    })
    const result = await run(h.deps, { maxSteps: 1 })

    expect(result.status).toBe('blocked')
    expect(result.reason).toBe('达到本次运行的模型调用上限（2 次），已停止')
    expect(result.decisions).toBe(2)
    expect(result.reasks).toEqual([])
    expect(h.seen.executed).toHaveLength(0)
  })

  it('does not ask again once the step budget is spent, even on an unusable answer', async () => {
    const h = harness({
      pages: [pageState('f0'), pageState('f1'), pageState('f2')],
      choices: ['e1', 'e1'],
      unusable: { 3: UNUSABLE_MISMATCH },
    })
    const result = await run(h.deps, { maxSteps: 2 })

    expect(result.status).toBe('blocked')
    expect(result.reason).toBe('达到本次运行的动作上限（2 步），已停止')
    expect(result.steps).toBe(2)
    expect(result.decisions).toBe(3)
    expect(result.reasks).toEqual([])
  })

  it('says the same thing whether or not the second answer was sure', async () => {
    // The sentence is about the first answer's confidence because the second one may well be
    // certain — certain and different is the case it exists for. Two unsure answers get the same
    // sentence rather than a second wording to keep in step.
    for (const [second, confident] of [
      [0.6, true],
      [0.3, false],
    ] as Array<[number, boolean]>) {
      const h = harness({
        pages: [pageState('f0')],
        choices: ['e1', 'e2'],
        confidences: [0.2, second],
      })
      const result = await run(h.deps)

      expect(result.status).toBe('blocked')
      expect(result.reason).toBe('决策服务两次给的答案不一样（第一次把握低于 0.5），先停下')
      expect(result.reasks[0]).toMatchObject({ agreed: false, second: { confidence: second } })
      expect(confident ? second >= 0.5 : second < 0.5).toBe(true)
    }
  })

  it('stops when the two answers name one operation but a different element', async () => {
    // Two answers that agree about what to do and disagree about where to do it are the same
    // jitter the re-ask exists for: the two best elements sat 0.01–0.05 apart in the audit.
    const two = [button('e1', 1, 'Search'), button('e9', 9, 'Search again')]
    const h = harness({
      pages: [pageState('f0', { actions: two })],
      choices: ['e1', 'e9'],
      targets: { e1: '1', e9: '2' },
      confidences: [0.3, 0.4],
    })
    const result = await run(h.deps)

    expect(result.status).toBe('blocked')
    expect(result.reason).toBe('决策服务两次给的答案不一样（第一次把握低于 0.5），先停下')
    expect(result.reasks[0]).toMatchObject({ agreed: false, first: { choice: 'e1' }, second: { choice: 'e9' } })
  })

  it('keeps a single answer that is at or above the floor', async () => {
    // 0.5 is the floor itself, and the floor is not below itself.
    const h = harness({
      pages: [pageState('f0'), pageState('f1')],
      choices: ['e1', 'DONE'],
      confidences: [0.5, 0.9],
    })
    const result = await run(h.deps)

    expect(result.status).toBe('done')
    expect(result.decisions).toBe(2)
    expect(result.reasks).toEqual([])
  })

  it('asks at most one extra question per step, however unsure both answers are', async () => {
    const h = harness({
      pages: [pageState('f0'), pageState('f1'), pageState('f2')],
      choices: ['e1', 'e1', 'DONE', 'DONE'],
      confidences: [0.1, 0.2, 0.3, 0.4],
    })
    const result = await run(h.deps)

    expect(result.status).toBe('done')
    expect(result.steps).toBe(1)
    // Two questions for the step and two for the terminal answer: the second unsure answer is
    // acted on rather than asked about a third time.
    expect(result.decisions).toBe(4)
    expect(result.reasks).toHaveLength(2)
    expect(result.reasks.every((record) => record.agreed)).toBe(true)
  })

  it('does not spend a question the model-call budget cannot afford', async () => {
    const h = harness({
      pages: [pageState('f0'), pageState('f1')],
      // The sure answer's field goes stale, so it costs a decision and no step; the next answer is
      // unsure, and the budget is exactly one decision short of a second question.
      fresh: [true, false, true, false],
      choices: ['e2', 'e2'],
      confidences: [0.9, 0.3],
    })
    const result = await run(h.deps, { maxSteps: 1 })

    expect(result.status).toBe('blocked')
    expect(result.reason).toBe('达到本次运行的模型调用上限（2 次），已停止')
    expect(result.decisions).toBe(2)
    expect(result.reasks).toEqual([])
    expect(h.seen.executed).toHaveLength(0)
  })

  it('does not ask again once the step budget is spent', async () => {
    const h = harness({
      pages: [pageState('f0'), pageState('f1'), pageState('f2'), pageState('f3')],
      choices: ['e1', 'e1', 'e1', 'e1'],
      confidences: [0.9, 0.9, 0.9, 0.3],
    })
    const result = await run(h.deps, { maxSteps: 3 })

    expect(result.status).toBe('blocked')
    expect(result.reason).toBe('达到本次运行的动作上限（3 步），已停止')
    expect(result.steps).toBe(3)
    expect(result.decisions).toBe(4)
    expect(result.reasks).toEqual([])
  })

  it('writes both answers into the run trace', async () => {
    const h = harness({ pages: [pageState('f0')], choices: ['e1', 'e2'], confidences: [0.2, 0.6] })
    const result = await run(h.deps, { record: true })
    try {
      const trace = readFileSync(join(result.recordDir, 'trace.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
      expect(trace[trace.length - 1]).toMatchObject({
        kind: 'run',
        status: 'blocked',
        reasks: [
          {
            step: 1,
            agreed: false,
            first: { choice: 'e1', confidence: 0.2 },
            second: { choice: 'e2', confidence: 0.6 },
          },
        ],
      })
    } finally {
      rmSync(result.recordDir, { recursive: true, force: true })
    }
  })
})
