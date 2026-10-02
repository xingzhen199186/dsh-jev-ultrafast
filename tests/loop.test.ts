import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AdoptResult, BrowserPort, PageState, SnapshotAction, SnapshotOptions } from '../src/browser/session'
import { StalePage } from '../src/browser/session'
import { COVER_ESCAPE_LABEL, TargetCovered } from '../src/browser/act'
import type { Config as ConfigShape } from '../src/config'
import type { ControlModel } from '../src/control/control-model'
import { actionSpace, type ActionSpace } from '../src/decision/action-space'
import type { FieldContext, TextResult } from '../src/decision/text-helper'
import type { Decision, DecisionContext } from '../src/decision/typesafe'
import { InvalidDecision, buildQuestionnaire, requestChars } from '../src/decision/typesafe'
import { Config } from '../src/index'
import { type TaskDeps, runTask } from '../src/loop'
import { MAX_ELEMENTS } from '../src/prompts'
import { readSettings } from '../src/run-setup'

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

/**
 * The target keys one request offered a press of Escape under: the extra action a covered refusal
 * puts in the options, read off the question rather than off the action list behind it.
 */
function escapeTargets(space: ActionSpace): string[] {
  return Object.entries(space.targets.PRESS_KEY ?? {})
    .filter(([, action]) => String(action.key).toLowerCase() === 'escape')
    .map(([key]) => key)
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
    adoptOptions: Array<{ onlyIfSameUrl?: boolean; aimedAt?: string } | undefined>
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
    adoptOptions: [] as Array<{ onlyIfSameUrl?: boolean; aimedAt?: string } | undefined>,
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
          async adoptNewPage(options?: { onlyIfSameUrl?: boolean; aimedAt?: string }): Promise<AdoptResult | null> {
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
  extra: {
    maxSteps?: number
    signal?: AbortSignal
    expect?: string[]
    record?: boolean
    screenshots?: boolean
    /** Whether a judged dead end is taken out of the candidates. Off, as the settings page ships it. */
    excludeDeadEndElements?: boolean
    /** Whether a script-made clickable is offered as a candidate. On, as the settings page ships it. */
    guessClickableElements?: boolean
    /** Whether a cover is answered as a candidate rather than only as a sentence. On, as it ships. */
    dismissCoveredTarget?: boolean
    /** Whether a step that opened new windows is told what it was aiming at. On, as the page ships it. */
    preferRelevantTab?: boolean
    /** The control layer's own model and allowance; left out, which is what every run did before. */
    control?: { model: ControlModel; cap: number }
  } = {},
) {
  return runTask({ goal: 'Find a flight', startUrl: 'https://example.test/', decision, text, deps, ...extra })
}

describe('run loop', () => {
  it('runs actions until the decision says DONE', async () => {
    const h = harness({
      // The screen the first step lands on is a different screen by the same test the stopping
      // rules use — the address — so the step really is reported as a change.
      pages: [pageState('f0'), pageState('f1', { url: 'https://example.test/results' }), pageState('f2')],
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

  it('reuses the paid value when only the page around the field changed', async () => {
    // The key is the field, not the page it happens to stand on. A page whose own blocks rewrite
    // themselves between two looks handed the run a different text every time, and a key that
    // carried that text paid the text model again for the field it had already answered — on 携程
    // (2026-10-02), five calls for one search box and four of them the same answer.
    const h = harness({
      pages: [
        pageState('f0', { text: 'Where from? 推荐：酒店 A ¥320' }),
        pageState('f1', { text: 'Where from? 推荐：酒店 B ¥410、酒店 C ¥260' }),
        pageState('f2', { text: 'Where from? 推荐：酒店 A ¥320' }),
      ],
      choices: ['e2', 'e2', 'DONE'],
      execute: (index) => {
        if (index === 0) throw new StalePage('目标已经变化或被遮挡，请重新观察')
      },
    })
    const result = await run(h.deps)

    expect(result.status).toBe('done')
    expect(result.steps).toBe(1)
    // Two attempts at the same field, with the page's own text rewritten in between, and one bill.
    expect(h.seen.executed.map((action) => action.id)).toEqual(['e2', 'e2'])
    expect(h.seen.typedFields).toHaveLength(1)
    expect(result.textCalls).toHaveLength(1)
  })

  it('pays again when the field itself is a different field', async () => {
    // The other half of that key: a control that is not the one the value was generated for must be
    // asked about on its own. Here the page hands back a control at the same number with different
    // words, which is what a replaced control looks like from here.
    const h = harness({
      pages: [
        pageState('f0'),
        pageState('f1', { actions: [button('e1', 1, 'Search'), field('e2', 2, 'Where to?')] }),
        pageState('f2'),
      ],
      choices: ['e2', 'e2', 'DONE'],
      execute: (index) => {
        if (index === 0) throw new StalePage('目标已经变化或被遮挡，请重新观察')
      },
    })
    const result = await run(h.deps)

    expect(result.status).toBe('done')
    expect(result.steps).toBe(1)
    expect(h.seen.executed.map((action) => action.label)).toEqual(['Where from?', 'Where to?'])
    expect(h.seen.typedFields).toHaveLength(2)
    expect(result.textCalls).toHaveLength(2)
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

  it('uses the browser node identity when the same elements change display order', async () => {
    const first = pageState('f0')
    const second = pageState('f1')
    second.actions = second.actions.map((action) => ({ ...action, label: action.label })).reverse()
    const h = harness({ pages: [first, second, second], choices: ['e1', 'DONE'] })
    const result = await run(h.deps)
    expect(result.status).toBe('done')
    expect(result.history[0]?.page_changed).toBe(false)
  })

  it('counts a repeated loop when the same node receives different display indices', async () => {
    const first = pageState('f0')
    const cycle = ['f1', 'f2', 'f3'].map((state, index) =>
      pageState(state, {
        actions: [
          ...Array.from({ length: index + 1 }, (_unused, extra) => button(`x${state}${extra}`, 90 + extra, `Other ${state}`)),
          ...actions,
        ],
      }),
    )
    const h = harness({
      pages: [first, ...Array.from({ length: 4 }, () => cycle).flat()],
      choices: Array.from({ length: 12 }, () => 'e1'),
    })
    const result = await run(h.deps)
    expect(result.status).toBe('blocked')
    expect(result.steps).toBe(9)
    expect(result.reason).toContain('同一个动作连着做了 6 次')
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

  it('reads a page whose text churns under a carousel as one screen, and says so to the service', async () => {
    // The 携程 home page of 2026-10: the banner carousel rewrote the body on every paint, so the
    // page's text — and with it the whole-page fingerprint — was a different string on every step,
    // while the screen a reader would call "the same screen" never moved: the controls and the
    // address stayed put. The step report, judged on that text, said `true` on every step, which
    // told the decision service that the click it had chosen was making progress while nothing
    // moved — and that is how the run came to click one and the same field 31 times. Judged on the
    // element table and the address, no step here is a change, and that is what the service is told.
    const frames = Array.from({ length: 12 }, (_unused, index) =>
      pageState(`t${index + 1}`, { text: `广告轮播第 ${index + 1} 帧` }),
    )
    const h = harness({
      pages: [pageState('t0'), ...frames],
      choices: Array.from({ length: 12 }, () => 'e1'),
    })
    const result = await run(h.deps)

    // Read back from the requests themselves, not only from the run's own history: the fact the
    // service is given is the one this change is about. Every step of this run is a step the service
    // was told nothing had moved on, though the page text was a new string every time.
    expect(h.seen.contexts[1]?.history[0]).toMatchObject({ page_changed: false })
    expect(result.history.map((entry) => entry.page_changed)).toEqual([false, false, false])
    // Three steps with nothing moving is the run's own stop, and this page — which the run kept
    // coming back to without ever leaving it — is now seen for what it is.
    expect(result.status).toBe('blocked')
    expect(result.steps).toBe(3)
    expect(result.reason).toBe('连续 3 步当前页面没有任何变化，已停止')
  })

  it('keeps a dead end in the table while the removal is off, and writes the judgement down anyway', async () => {
    // The default, and the reason it is the default: the step showed nothing, but that is a weaker
    // thing to know than "this element can never matter". So the run judges it, reports it, and takes
    // nothing away — every request is the page's own table down to the byte, exactly as it was before
    // the removal existed. The same page under the switch is the test below.
    const crowd = [
      ...actions,
      ...Array.from({ length: 5 }, (_unused, at) => button(`e${at + 3}`, at + 3, `Option ${at + 1}`)),
    ]
    const frames = Array.from({ length: 4 }, (_unused, index) =>
      pageState(`t${index + 1}`, { text: `广告轮播第 ${index + 1} 帧`, actions: crowd }),
    )
    const h = harness({ pages: [pageState('t0', { actions: crowd }), ...frames], choices: ['e1', 'e1', 'e1'] })
    const result = await run(h.deps, { record: true })

    try {
      expect(result.status).toBe('blocked')
      expect(result.history.map((entry) => entry.page_changed)).toEqual([false, false, false])

      // The element is still offered, in the element list and in the question that asks about it.
      const offered = h.seen.spaces[1]!
      expect(offered.elements.map((element) => element.index)).toEqual(['1', '2', '3', '4', '5', '6', '7'])
      expect(offered.targets.CLICK!['1']).toBeDefined()
      // Snapshot-style: the request the run built is the one the page's own table builds from the very
      // same context. Nothing was removed, and no criterion was rewritten to say something was.
      const body = (space: ActionSpace, context: DecisionContext): string =>
        JSON.stringify(buildQuestionnaire(space, context, decision.model).request)
      expect(body(offered, h.seen.contexts[1]!)).toBe(body(actionSpace(crowd), h.seen.contexts[1]!))
      expect(body(offered, h.seen.contexts[1]!)).toContain('"index":"1"')
      // And nothing pretends the page was a selection: nothing was left out.
      expect(h.seen.contexts[1]!.omittedElements).toBeUndefined()
      expect(result.omittedElements).toBe(0)

      // The judgement itself is still made, and reported in the run's own result...
      expect(result.deadEndsExcluded).toBe(false)
      expect(result.deadEnds).toEqual([{ step: 1, element: '1', target: '1', label: 'Search' }])
      // ...and written into the trace the run leaves behind, which is where it can be reviewed later.
      const trace = readFileSync(join(result.recordDir, 'trace.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
      expect(trace[trace.length - 1]).toMatchObject({
        kind: 'run',
        status: 'blocked',
        dead_ends: [{ step: 1, element: '1', target: '1', label: 'Search' }],
        dead_ends_excluded: false,
      })
    } finally {
      rmSync(result.recordDir, { recursive: true, force: true })
    }
  })

  it('takes a dead end out of the next request when the removal is on', async () => {
    // The same carousel, on a page with enough elements to leave the floor room: the click moved
    // nothing a reader would call the screen — the controls and the address stood still while the
    // page rewrote its own text — so the element the step acted on comes out of the questions the
    // next request is built from. The model is not told to avoid it; it is simply not offered it, and
    // the run does not steer what it picks instead. The element table itself is untouched: the page's
    // own structure is what the model reads the screen from, and only the question decides what is
    // chosen (see `withoutElements`).
    const crowd = [
      ...actions,
      ...Array.from({ length: 5 }, (_unused, at) => button(`e${at + 3}`, at + 3, `Option ${at + 1}`)),
    ]
    const frames = Array.from({ length: 4 }, (_unused, index) =>
      pageState(`t${index + 1}`, { text: `广告轮播第 ${index + 1} 帧`, actions: crowd }),
    )
    const h = harness({ pages: [pageState('t0', { actions: crowd }), ...frames], choices: ['e1', 'e1', 'e1'] })
    const result = await run(h.deps, { excludeDeadEndElements: true })

    expect(result.status).toBe('blocked')
    expect(result.history.map((entry) => entry.page_changed)).toEqual([false, false, false])
    // Every request carries the page's own table, whole — first request and all the ones after the step.
    const whole = ['1', '2', '3', '4', '5', '6', '7']
    expect(h.seen.spaces[0]!.elements.map((element) => element.index)).toEqual(whole)
    expect(h.seen.spaces[1]!.elements.map((element) => element.index)).toEqual(whole)
    expect(h.seen.spaces[2]!.elements.map((element) => element.index)).toEqual(whole)
    // What changed is the question: element 1 is nowhere among the candidates, and the rest are.
    expect(h.seen.spaces[1]!.targets.CLICK!['1']).toBeUndefined()
    expect(h.seen.spaces[2]!.targets.CLICK!['1']).toBeUndefined()
    expect(Object.keys(h.seen.spaces[2]!.targets.CLICK!)).toEqual(['3', '4', '5', '6', '7'])
    // Read back the way the run read it: the number is in the table and in no criterion, so the body
    // the service receives names it exactly once, where it describes the page rather than the choice.
    const { request } = buildQuestionnaire(h.seen.spaces[2]!, h.seen.contexts[2]!, decision.model)
    expect(JSON.stringify(request)).toContain('"index":"1"')
    expect(JSON.stringify(request.questions)).not.toMatch(/"1(:[^"]*)?"\s*:/)
    // And the exclusion is not counted as elements left out: nothing left the table, so the service is
    // not told it is reading a selection, and what the run reports still adds up to the page's own two
    // numbers — sent plus omitted.
    expect(h.seen.contexts[2]!.omittedElements).toBeUndefined()
    expect(result.omittedElements).toBe(0)
    expect(result.sentElements + result.omittedElements).toBe(whole.length)
    expect(result.elements.map((element) => element.index)).toContain('1')
  })

  it('sets aside a field that took the text and showed nothing for it, on purpose', async () => {
    // Typing into a field does not move a page's address or its element table, so a step that entered
    // a value and changed nothing reads as no change like any other — and that is wanted: the field
    // that swallowed the text is the one to set aside for a step. Here it is the only field on the
    // page, so the operation it was offered under leaves the questions with it.
    const crowd = [
      ...actions,
      ...Array.from({ length: 5 }, (_unused, at) => button(`e${at + 3}`, at + 3, `Option ${at + 1}`)),
    ]
    const h = harness({
      pages: [pageState('f0', { actions: crowd }), pageState('f1', { actions: crowd })],
      choices: ['e2', 'e2', 'e2'],
      targets: { e2: '2' },
    })
    const result = await run(h.deps, { excludeDeadEndElements: true })

    expect(result.history.map((entry) => entry.page_changed)).toEqual([false, false, false])
    // Set aside for a step, not forbidden: the element is still in the table the next request carries,
    // and only the one question that offered it went with the candidate.
    expect(h.seen.spaces[0]!.elements.map((element) => element.index)).toContain('2')
    expect(h.seen.spaces[1]!.elements.map((element) => element.index)).toContain('2')
    expect(h.seen.spaces[1]!.targets.TYPE_TEXT).toBeUndefined()
    // The page still offers it, and the model already answered.
    expect(h.seen.executed.map((action) => action.id)).toEqual(['e2', 'e2', 'e2'])
    // The judgement that took it away is reported as well, not only acted on.
    expect(result.deadEndsExcluded).toBe(true)
    expect(result.deadEnds).toEqual([{ step: 1, element: '2', target: '2', label: 'Where from?' }])
  })

  it('carries the switch from the settings read into the run it starts', async () => {
    // The wire between the two ends, in one test: the config field as the settings page saves it,
    // `readSettings` as the tool and the inspector read it, and the run's own option. A switch that no
    // longer reaches the loop would otherwise pass a test at each end and fail on the wire between them.
    const resolveConfig = (input: Record<string, unknown>): ConfigShape =>
      (Config as unknown as (data: unknown) => ConfigShape)(input)
    expect(readSettings(resolveConfig({})).excludeDeadEndElements).toBe(false)
    const settings = readSettings(resolveConfig({ excludeDeadEndElements: true }))
    expect(settings.excludeDeadEndElements).toBe(true)

    const crowd = [
      ...actions,
      ...Array.from({ length: 5 }, (_unused, at) => button(`e${at + 3}`, at + 3, `Option ${at + 1}`)),
    ]
    const frames = Array.from({ length: 4 }, (_unused, index) =>
      pageState(`t${index + 1}`, { text: `广告轮播第 ${index + 1} 帧`, actions: crowd }),
    )
    const h = harness({ pages: [pageState('t0', { actions: crowd }), ...frames], choices: ['e1', 'e1', 'e1'] })
    const result = await run(h.deps, { excludeDeadEndElements: settings.excludeDeadEndElements })

    expect(result.deadEndsExcluded).toBe(true)
    expect(h.seen.spaces[1]!.elements.map((element) => element.index)).toEqual(['1', '2', '3', '4', '5', '6', '7'])
    expect(h.seen.spaces[1]!.targets.CLICK!['1']).toBeUndefined()
  })

  it('carries the deep-scan switch from the settings read into the run it starts', async () => {
    // The same wire as the switch above, for the switch that widens the table: the config field as
    // the settings page saves it, `readSettings` as the tool and the inspector read it, and the run's
    // own option, all the way to the third argument of the opener that owns the injected script.
    const resolveConfig = (input: Record<string, unknown>): ConfigShape =>
      (Config as unknown as (data: unknown) => ConfigShape)(input)
    // On by default: what it adds is the browser's own answer to "does this node respond to a click",
    // not a guess of ours, so a page's script-made buttons work without anyone finding a setting.
    expect(readSettings(resolveConfig({})).guessClickableElements).toBe(true)
    const settings = readSettings(resolveConfig({ guessClickableElements: false }))
    expect(settings.guessClickableElements).toBe(false)

    const opened: Array<SnapshotOptions | undefined> = []
    const h = harness({ pages: [pageState('f0')], choices: ['DONE', 'DONE'] })
    const deps: TaskDeps = {
      ...h.deps,
      open: async (_url, _options, snapshot) => {
        opened.push(snapshot)
        return h.deps.open('')
      },
    }
    await run(deps, { guessClickableElements: settings.guessClickableElements })
    await run(deps, { guessClickableElements: readSettings(resolveConfig({})).guessClickableElements })

    expect(opened).toEqual([{ guessClickableElements: false }, { guessClickableElements: true }])
  })

  it('carries the tab-choice switch from the settings read into what the browser is told', async () => {
    // The same wire as the two switches above, for the switch that decides how a step picks between
    // the windows a click opened: the config field as the settings page saves it, `readSettings` as
    // the tool and the inspector read it, and what `adoptNewPage` is actually handed. Off has to mean
    // the browser is told nothing new — that, and not a second rule that agrees with the first, is
    // what makes this switch the old behaviour on the dot.
    const resolveConfig = (input: Record<string, unknown>): ConfigShape =>
      (Config as unknown as (data: unknown) => ConfigShape)(input)
    // On by default: what it replaces is "the last page the browser lists", which is what handed a run
    // to an ad page, so it works without anyone having to find the setting first.
    expect(readSettings(resolveConfig({})).preferRelevantTab).toBe(true)
    expect(readSettings(resolveConfig({ preferRelevantTab: false })).preferRelevantTab).toBe(false)

    const pages = [pageState('f0'), pageState('f0')]
    const off = harness({ pages, choices: ['e1', 'DONE'], adopt: [null] })
    await run(off.deps, { preferRelevantTab: false })
    expect(off.seen.adoptOptions).toEqual([{ onlyIfSameUrl: true }])

    const on = harness({ pages, choices: ['e1', 'DONE'], adopt: [null] })
    await run(on.deps, { preferRelevantTab: readSettings(resolveConfig({})).preferRelevantTab })
    // The element the step acted on, and the goal: what the look is chosen by when it finds more than
    // one page worth moving onto.
    expect(on.seen.adoptOptions).toEqual([{ onlyIfSameUrl: true, aimedAt: 'Search Find a flight' }])
  })

  it('counts a step as a change when the element table moves, the text standing still', async () => {
    // The other half of the same test: the screen the run landed on offers a control the page it
    // came from did not, and the table is what says so — the page's own text never moved.
    const h = harness({
      pages: [pageState('f0'), pageState('f1', { actions: [...actions, button('e9', 9, 'Saved searches')] })],
      choices: ['e1', 'DONE'],
    })
    const result = await run(h.deps)

    expect(result.status).toBe('done')
    expect(result.steps).toBe(1)
    expect(result.history[0]).toMatchObject({ page_changed: true })
    expect(h.seen.contexts[1]?.history[0]).toMatchObject({ page_changed: true })
  })

  it('counts a step as a change when only the address moves, the table standing still', async () => {
    const h = harness({
      pages: [pageState('f0'), pageState('f1', { url: 'https://example.test/next' })],
      choices: ['e1', 'DONE'],
    })
    const result = await run(h.deps)

    expect(result.status).toBe('done')
    expect(result.history[0]).toMatchObject({ page_changed: true, url: 'https://example.test/next' })
    expect(h.seen.contexts[1]?.history[0]).toMatchObject({ page_changed: true })
  })

  it('reads a churning guessed element as the page standing still, the native controls standing still too', async () => {
    // The scene the commit that widened the table used as its counter-example, kept for what it
    // measured and given the opposite expectation. "Did the screen move?" is the address plus the
    // native controls, so a guessed row rewriting its own words cannot move it: the same two native
    // controls and the same address on every screen, the guessed row the only thing that changes.
    // Read the old way — with the guessed entries inside `repeatedActionState` — every step counted as
    // a change, the three-in-a-row brake never saw three quiet steps, and the run went on to spend its
    // whole budget; that is the regression this expectation is written against.
    const guessed = (label: string): SnapshotAction => ({
      id: 'e10',
      kind: 'click',
      node: 10,
      label,
      guess: 'listener',
    })
    const churn = (label: string): PageState => pageState('f', { actions: [...actions, guessed(label)] })
    const quiet = harness({ pages: [pageState('f')], choices: ['e1', 'e1', 'e1', 'e1'] })
    const noisy = harness({
      pages: [churn('酒店 A'), churn('酒店 B'), churn('酒店 C'), churn('酒店 D'), churn('酒店 E')],
      // One choice more than the step budget, because the budget is read after a decision: the run
      // has to be given something to do on the step it is not allowed to take.
      choices: ['e1', 'e1', 'e1', 'e1', 'e1'],
    })

    const stopped = await run(quiet.deps)
    expect(stopped.status).toBe('blocked')
    expect(stopped.reason).toMatch(/连续 3 步/)

    // The budget is left generous on purpose below: the brake, not the budget, is what stops this run
    // now, and the guessed row that churns is what used to hold the brake off.
    const longer = await run(noisy.deps, { maxSteps: 4 })
    expect(longer.history.map((entry) => entry.page_changed)).toEqual([false, false, false])
    expect(longer.steps).toBe(3)
    expect(longer.reason).toBe('连续 3 步当前页面没有任何变化，已停止')
    expect(noisy.seen.executed).toHaveLength(3)
  })

  it('still reads a change in the native controls as the page changing with a guessed row beside them', async () => {
    // The other half of the same judgement, so the exclusion cannot be read as "the table no longer
    // counts": the guessed row is the same on both screens and the address stands still, and the one
    // thing that moved is a native control the second screen added.
    const guessed = (): SnapshotAction => ({
      id: 'e10',
      kind: 'click',
      node: 10,
      label: '酒店 A',
      guess: 'listener',
    })
    const h = harness({
      pages: [
        pageState('f0', { actions: [...actions, guessed()] }),
        pageState('f1', { actions: [...actions, guessed(), button('e9', 9, 'Saved searches')] }),
      ],
      choices: ['e1', 'DONE'],
    })
    const result = await run(h.deps)

    expect(result.status).toBe('done')
    expect(result.history[0]).toMatchObject({ page_changed: true })
    expect(h.seen.contexts[1]?.history[0]).toMatchObject({ page_changed: true })
  })

  it('leaves the native entries with the numbers and the order they had when guessed rows join the table', async () => {
    // The guessed block is appended after the native controls and the numbers are minted from that
    // order (`actionSpace`), so widening the table cannot renumber a native control — the property
    // the churn above relies on, checked at the table the decision is asked about rather than in the
    // snapshot alone.
    const guessed = (node: number, label: string): SnapshotAction => ({
      id: `e${node}`,
      kind: 'click',
      node,
      label,
      guess: 'react0',
    })
    const native = harness({ pages: [pageState('f0')], choices: ['DONE'] })
    const widened = harness({
      pages: [pageState('f0', { actions: [...actions, guessed(10, '酒店 A'), guessed(11, '酒店 B')] })],
      choices: ['DONE'],
    })
    await run(native.deps)
    await run(widened.deps)

    const shape = (space: ActionSpace): Array<[string, string, string[]]> =>
      space.elements.map((element) => [element.index, element.label, element.operations])
    expect(shape(widened.seen.spaces[0]!).slice(0, actions.length)).toEqual(shape(native.seen.spaces[0]!))
    // The guessed rows take the tail and nothing more: two entries more than the page without them.
    expect(widened.seen.spaces[0]!.elements).toHaveLength(actions.length + 2)
    expect(widened.seen.spaces[0]!.targets.CLICK!['3']?.id).toBe('e10')
    expect(widened.seen.spaces[0]!.targets.CLICK!['4']?.id).toBe('e11')
  })

  it('leaves a run whose table carries no guessed entry the run it always was', async () => {
    // The switch's off position is the reading every page had before the deep scan, and the filter is
    // the only thing this change touches: with no guessed entry in the table it removes nothing, so
    // the step report is the record it always was. The two runs below are the same scripted scene read
    // with and without the deep scan, which is the difference the switch is for.
    const pages = [pageState('f0'), pageState('f1'), pageState('f2'), pageState('f3')]
    const off = harness({ pages, choices: ['e1', 'e1', 'e1', 'e1'] })
    const on = harness({ pages, choices: ['e1', 'e1', 'e1', 'e1'] })
    const without = await run(off.deps, { guessClickableElements: false })
    const withScan = await run(on.deps, { guessClickableElements: true })

    const report = (history: typeof without.history) =>
      history.map((entry) => ({
        step: entry.step,
        action: entry.action,
        kind: entry.kind,
        target: entry.target,
        page_changed: entry.page_changed,
        url: entry.url,
      }))
    expect(report(without.history)).toEqual(report(withScan.history))
    expect(without.reason).toBe(withScan.reason)
    expect(without.steps).toBe(withScan.steps)
    expect(without.steps).toBe(3)
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

  it('stops on the sixth repeat in the window and not on the fifth', async () => {
    // The threshold, pinned where it has always been: five repeats are still allowed to be a slow run,
    // the sixth is the run going round in circles. The address stands still and the text churns under
    // the carousel, while the table cycles between two states a reader can tell apart — so every step
    // really does move the page, which is the page that used to hold this rule off for good. The step
    // report is a change on every step here, so the rule below, which counts steps that changed
    // nothing, never fires: the stop is this rule's own.
    const frames = (count: number): PageState[] =>
      Array.from({ length: count }, (_unused, index) =>
        pageState(`t${index + 1}`, {
          text: `广告轮播第 ${index + 1} 帧`,
          actions: [...actions, button('e9', 9, index % 2 === 0 ? 'Page one' : 'Page two')],
        }),
      )

    // Seven frames: the sixth step's window holds five replays of states already shown, which is
    // still allowed, and the run ends on the answer it was given.
    const fiveRepeats = await run(
      harness({
        pages: [pageState('t0'), ...frames(7)],
        choices: [...Array.from({ length: 7 }, () => 'e1'), 'DONE'],
      }).deps,
    )
    expect(fiveRepeats.status).toBe('done')
    expect(fiveRepeats.reason).toBe('')
    expect(fiveRepeats.steps).toBe(7)

    // Eight frames: the window is six replays wide and one and the same control was used for all of
    // them, so the run stops on the sentence this rule has always written.
    const sixRepeats = await run(
      harness({ pages: [pageState('t0'), ...frames(8)], choices: Array.from({ length: 8 }, () => 'e1') }).deps,
    )
    expect(sixRepeats.status).toBe('blocked')
    expect(sixRepeats.steps).toBe(8)
    expect(sixRepeats.reason).toContain('同一个动作连着做了 6 次')
  })

  it('leaves the other stopping reasons alone on a screen that looks the same on every look', async () => {
    // Two looks whose text differs and whose element table and address do not: the repeated-action
    // rule reads that as one state from the first look on, which is where it could have swallowed a
    // reason that is not its own. Neither an unsure answer nor a pair of disagreeing ones is that
    // rule's business, so each still gets the sentence it always got.
    const looks = (): PageState[] => [pageState('t0'), pageState('t1', { text: '广告轮播的另一帧' })]

    const disagreeing = await run(harness({ pages: looks(), choices: ['e1', 'e2'], confidences: [0.2, 0.6] }).deps)
    expect(disagreeing.status).toBe('blocked')
    expect(disagreeing.reason).toBe('决策服务两次给的操作不一样（第一次把握低于 0.5），先停下')
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
    // The evidence this branch has is only that the chosen number is not in the table it was
    // given; a page that redrew and an answer that named a number never there look the same from
    // here, so the sentence says what was seen and keeps the cause a possibility.
    expect(result.reason).toBe('你选的编号在页面里找不到，页面可能自己刷新过，连续 3 次都没对上，这次先停下')
    expect(result.reason).not.toContain('页面自己刷新了')
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
    expect(h.seen.adoptOptions).toEqual([{ onlyIfSameUrl: true, aimedAt: 'Search Find a flight' }])
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
    expect(h.seen.adoptOptions).toEqual([{ onlyIfSameUrl: false, aimedAt: 'Search Find a flight' }])
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

  it('writes the windows a step opened, and whether the run followed one, into the trace', async () => {
    // The gap two real diagnoses were stuck on: the click lands in a window this page never
    // mentions, so the page the run is reading says nothing at all about where the effect went. The
    // step line in the conversation said it; the trace, which is what a finished run is read back
    // from, did not. Two steps, one of each kind: a popup while this tab navigated (the run stays
    // put and leaves the popup behind), then a tab it does move onto.
    const popup = { url: 'https://ads.test/popup', title: 'Popup' }
    const second = pageState('f3', { url: 'https://example.test/second', title: 'Second page', text: 'the page' })
    const h = harness({
      pages: [
        pageState('f0'),
        pageState('f1', { url: 'https://example.test/next' }),
        pageState('f2', { url: 'https://example.test/next' }),
        second,
      ],
      choices: ['e1', 'e1', 'DONE'],
      adopt: [
        { adopted: null, appeared: [popup] },
        { adopted: { url: second.url, title: '' }, appeared: [{ url: second.url, title: '' }] },
      ],
    })
    const result = await run(h.deps, { record: true })

    try {
      const trace = readFileSync(join(result.recordDir, 'trace.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
      // The two kinds of step are told apart by value rather than by wording: the page left open in
      // the browser against `null`, and the page the run moved onto against its own address.
      expect(trace.filter((record) => record.kind === 'follow')).toEqual([
        { at: expect.any(Number), kind: 'follow', step: 1, new_tabs: [popup.url], followed_tab: null },
        { at: expect.any(Number), kind: 'follow', step: 2, new_tabs: [second.url], followed_tab: second.url },
      ])
      // And the run's last word counts what was left behind, so one line answers "did this run keep
      // opening windows it never went to?" without reading the step records back.
      expect(trace[trace.length - 1]).toMatchObject({ kind: 'run', status: 'done', unfollowed_tabs: 1 })
    } finally {
      rmSync(result.recordDir, { recursive: true, force: true })
    }
  })

  it('scrubs the addresses a step opened, the way every other trace write does', async () => {
    // An address is where a credential hides, and a page that appears can be the login callback that
    // holds one (`?code=…`). The step record is a bare write with no request body to be made safe on
    // the way past, so it goes through `recordable` like every other trace write, and what has to be
    // in the file is the address with that parameter blanked. The raw text is read as well as the
    // parsed record, because a credential in the file is a credential whatever shape it is in.
    const popup = { url: 'https://ads.test/cb?code=abc123&state=keep', title: 'Popup' }
    const h = harness({
      pages: [pageState('f0'), pageState('f1', { url: 'https://example.test/next' })],
      choices: ['e1', 'DONE'],
      adopt: [{ adopted: null, appeared: [popup] }],
    })
    const result = await run(h.deps, { record: true })

    try {
      const written = readFileSync(join(result.recordDir, 'trace.jsonl'), 'utf8')
      const follow = written
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
        .find((record) => record.kind === 'follow')
      expect(follow).toMatchObject({
        kind: 'follow',
        step: 1,
        new_tabs: ['https://ads.test/cb?code=REDACTED&state=keep'],
        followed_tab: null,
      })
      expect(written).not.toContain('abc123')
    } finally {
      rmSync(result.recordDir, { recursive: true, force: true })
    }
  })

  it('scrubs a failure sentence of the address it carries, the way every other trace write does', async () => {
    // `reason` is what a failed run stopped for, and another party's words ride inside it:
    // `decision/typesafe.ts` puts the server's reply into its sentence and `decision/text-helper.ts`
    // the vendor's message, so an address — and an address is where a credential hides — can arrive
    // there. The run record is a bare write with no request or response body to be made safe on the
    // way past, so the whole record goes through `recordable`, like the step record above.
    const h = harness({
      pages: [pageState('f0')],
      choices: ['e1'],
      execute: () => {
        throw new Error('文本模型返回 HTTP 401（服务端原话：https://vendor.test/auth?token=abc123&state=keep）')
      },
    })
    const result = await run(h.deps, { record: true })

    try {
      // The sentence the run reports is the failure's own, word for word: this is about the file,
      // not about the report the caller gets.
      expect(result.reason).toBe(
        '文本模型返回 HTTP 401（服务端原话：https://vendor.test/auth?token=abc123&state=keep）',
      )

      const written = readFileSync(join(result.recordDir, 'trace.jsonl'), 'utf8')
      const run1 = written
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
        .find((record) => record.kind === 'run')
      expect(run1).toMatchObject({ kind: 'run', status: 'failed' })
      expect(run1.reason).toBe(
        '文本模型返回 HTTP 401（服务端原话：https://vendor.test/auth?token=REDACTED&state=keep）',
      )
      // Read as raw text as well as parsed, because a credential in the file is a credential
      // whatever shape it is in.
      expect(written).not.toContain('abc123')
    } finally {
      rmSync(result.recordDir, { recursive: true, force: true })
    }
  })

  it('scrubs the page s own words out of a dead end the run judged', async () => {
    // The other text of the run record the plugin did not write is the page's: a dead end is kept
    // with what the element was called when it was judged, and a link's label is often the address
    // it points at. A page that appears can be the login callback whose address holds the code that
    // proves the login (`?code=…`) — the same address the step record above carries. The report the
    // run hands back keeps the page's own words; the file is the copy made safe.
    const link = button('e1', 1, 'https://site.test/cb?code=abc123&state=keep')
    const crowd = [
      link,
      ...Array.from({ length: 5 }, (_unused, at) => button(`e${at + 2}`, at + 2, `Option ${at + 1}`)),
    ]
    const h = harness({
      // The same address and the same table on every look: the click moved nothing, which is what
      // makes the element a dead end, and three such steps are the run's own stop.
      pages: Array.from({ length: 4 }, (_unused, index) => pageState(`t${index}`, { actions: crowd })),
      choices: ['e1', 'e1', 'e1'],
    })
    const result = await run(h.deps, { record: true })

    try {
      expect(result.deadEnds).toEqual([
        { step: 1, element: '1', target: '1', label: 'https://site.test/cb?code=abc123&state=keep' },
      ])

      const written = readFileSync(join(result.recordDir, 'trace.jsonl'), 'utf8')
      const run1 = written
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
        .find((record) => record.kind === 'run')
      expect(run1.dead_ends).toEqual([
        { step: 1, element: '1', target: '1', label: 'https://site.test/cb?code=REDACTED&state=keep' },
      ])
      expect(written).not.toContain('abc123')
    } finally {
      rmSync(result.recordDir, { recursive: true, force: true })
    }
  })

  it('scrubs the page s own words out of the action the run got stuck on', async () => {
    // The same wording in the other field the run record takes from the page: `stuck_on.action` is
    // the label of the element the run kept repeating. It is a bare write like the dead end record
    // above, so the whole record goes through `recordable`.
    const link = button('e1', 1, 'https://site.test/cb?code=abc123&state=keep')
    const crowd = [
      link,
      ...Array.from({ length: 5 }, (_unused, at) => button(`e${at + 2}`, at + 2, `Option ${at + 1}`)),
    ]
    const states = ['w1', 'w2', 'w3']
    const h = harness({
      // A page that keeps coming round to the states it has already shown, the way the run this
      // rule was written for did, with the link standing at the number the run keeps choosing.
      pages: [
        pageState('t0', { actions: crowd }),
        ...Array.from({ length: 12 }, (_unused, index) =>
          pageState(states[index % 3]!, { actions: [...crowd, button('e9', 9, states[index % 3]!)] }),
        ),
      ],
      choices: Array.from({ length: 12 }, () => 'e1'),
    })
    const result = await run(h.deps, { record: true })

    try {
      expect(result.status).toBe('blocked')

      const written = readFileSync(join(result.recordDir, 'trace.jsonl'), 'utf8')
      const run1 = written
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
        .find((record) => record.kind === 'run')
      expect(run1.stuck_on).toEqual({
        operation: 'CLICK',
        target: '1',
        action: 'https://site.test/cb?code=REDACTED&state=keep',
        times: 6,
      })
      // The sentence beside it quotes the same label, so it is covered by the same pass.
      expect(String(run1.reason)).toContain('https://site.test/cb?code=REDACTED&state=keep')
      expect(written).not.toContain('abc123')
    } finally {
      rmSync(result.recordDir, { recursive: true, force: true })
    }
  })

  it('leaves the trace of a run that opened no window exactly as it was', async () => {
    // Nothing was opened, so nothing is written: the field is absent rather than `null`, which keeps
    // a trace from before this change readable by the same reader as one from after it.
    const h = harness({
      pages: [
        pageState('f0'),
        pageState('f1', { url: 'https://example.test/results' }),
        pageState('f2', { url: 'https://example.test/results/2' }),
      ],
      choices: ['e1', 'e1', 'DONE'],
      // Asked on every step, as it is in a real run, and nothing to report either way: once by
      // staying silent, once by answering with an empty list.
      adopt: [null, { adopted: null, appeared: [] }],
    })
    const result = await run(h.deps, { record: true })

    try {
      const trace = readFileSync(join(result.recordDir, 'trace.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
      // The whole file, key by key: the run's own last word and nothing else.
      expect(trace).toEqual([
        {
          at: expect.any(Number),
          kind: 'run',
          status: 'done',
          reason: '',
          steps: 2,
          decisions: 3,
          elapsed_ms: expect.any(Number),
        },
      ])
    } finally {
      rmSync(result.recordDir, { recursive: true, force: true })
    }
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

  it('still asks again when the answer it settled on is itself under the floor', async () => {
    // Settling which choice is executed does not make the answer confident, and nothing here is
    // allowed to. These are the sixth run of 2026-10-02's own numbers: 0.29 was the highest of its
    // own table and 0.28 was what the service called its confidence, both under the floor the
    // re-ask has always used — so the step is asked again rather than executed for being top of
    // its own ranking.
    const h = harness({
      pages: [pageState('f0'), pageState('f1')],
      choices: ['e1', 'e1', 'DONE'],
      confidences: [0.29, 0.55, 0.9],
    })
    const result = await run(h.deps)

    expect(result.status).toBe('done')
    expect(result.steps).toBe(1)
    // The refused asking, the second asking and the finish: the weak answer bought a question, not a step.
    expect(result.decisions).toBe(3)
    expect(h.seen.executed.map((action) => action.id)).toEqual(['e1'])
    expect(result.reasks).toEqual([
      {
        step: 1,
        reason: 'low-confidence',
        agreed: true,
        first: { choice: 'e1', confidence: 0.29, probabilities: { e1: 0.29 } },
        second: { choice: 'e1', confidence: 0.55, probabilities: { e1: 0.55 } },
      },
    ])
  })

  it('stops when the two answers name different operations, whatever element each one picked', async () => {
    // A disagreement about what to do is the one this rule still stops on: no rule below can settle
    // "click this" against "type into that", so the run keeps its sentence and spends no step. The
    // two answers here name `e1` and `e2`, which are a click and a fill — different operations.
    const h = harness({
      pages: [pageState('f0')],
      choices: ['e1', 'e2', 'DONE'],
      confidences: [0.2, 0.6],
    })
    const result = await run(h.deps)

    expect(result.status).toBe('blocked')
    expect(result.reason).toBe('决策服务两次给的操作不一样（第一次把握低于 0.5），先停下')
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

  it('stops on two different operations when the second answer is sure', async () => {
    // The sentence is about the first answer's confidence because the second one may well be
    // certain — certain and different is the case it exists for. The two answers here are a click and
    // a fill, so they disagree about the operation, and the second one came back at 0.6: somebody
    // does stand behind an operation other than the one the run was about to take, and that stops.
    const h = harness({
      pages: [pageState('f0')],
      choices: ['e1', 'e2'],
      confidences: [0.2, 0.6],
    })
    const result = await run(h.deps)

    expect(result.status).toBe('blocked')
    expect(result.reason).toBe('决策服务两次给的操作不一样（第一次把握低于 0.5），先停下')
    expect(result.steps).toBe(0)
    expect(result.decisions).toBe(2)
    expect(h.seen.executed).toHaveLength(0)
    expect(result.reasks[0]).toMatchObject({ agreed: false, second: { confidence: 0.6 } })
  })

  it('asks again instead of stopping when both answers that disagree are under the floor', async () => {
    // Two weak answers are not the disagreement the sentence above is for: nobody stood behind either
    // operation, so both are discarded rather than judged, the page is looked at again and the
    // question is asked again — the answer at 0.9 is the one that stands. (2026-10-02, one 携程 task:
    // a WAIT at 0.28 against a CLICK at 0.20 stopped a run at its ninth decision, and a CLICK at 0.29
    // against another operation stopped a second run the same way after it had already reached the
    // hotel list it was aiming for.)
    const h = harness({
      pages: [pageState('f0'), pageState('f1'), pageState('f2')],
      choices: ['e1', 'e2', 'e1', 'DONE'],
      confidences: [0.2, 0.3, 0.9, 0.9],
    })
    const result = await run(h.deps)

    expect(result.status).toBe('done')
    expect(result.reason).toBe('')
    // The pair that swung, the answer that stood, and the terminal one.
    expect(result.decisions).toBe(4)
    expect(result.steps).toBe(1)
    expect(h.seen.executed.map((action) => action.id)).toEqual(['e1'])
    // Looked at again rather than asked the same question against the same screen: the starting look,
    // the one the retry bought, and the one the step landed on.
    expect(h.seen.observations).toBe(3)
    // What the run was shown is still written down, as for every re-ask.
    expect(result.reasks).toEqual([
      {
        step: 1,
        reason: 'low-confidence',
        agreed: false,
        first: { choice: 'e1', confidence: 0.2, probabilities: { e1: 0.2 } },
        second: { choice: 'e2', confidence: 0.3, probabilities: { e2: 0.3 } },
      },
    ])
  })

  it('stops on the sentence it always used once the looks that buy no step are spent', async () => {
    // The swing is worth asking about again, not for ever: every look it buys comes out of the one
    // count `MAX_STALE_RETRIES` bounds — six retries allowed and the seventh is the stop, as for a
    // refused execution — and the run that keeps swinging ends on the sentence this branch always
    // ended on. Nothing is executed and no step is recorded.
    const h = harness({
      pages: [pageState('f0')],
      choices: Array.from({ length: 2 * 7 }, (_unused, at) => (at % 2 === 0 ? 'e1' : 'e2')),
      confidences: Array.from({ length: 2 * 7 }, (_unused, at) => (at % 2 === 0 ? 0.2 : 0.3)),
    })
    const result = await run(h.deps)

    expect(result.status).toBe('blocked')
    expect(result.reason).toBe('决策服务两次给的操作不一样（第一次把握低于 0.5），先停下')
    expect(result.steps).toBe(0)
    expect(result.decisions).toBe(2 * 7)
    expect(h.seen.executed).toHaveLength(0)
    expect(result.reasks).toHaveLength(7)
  })

  it('runs the first answer when the two answers name one operation and a different element', async () => {
    // Two answers that agree about what to do and disagree about where to do it are the jitter the
    // re-ask exists for — the two best elements sat 0.01–0.05 apart in the audit — so the step is
    // taken on the first answer, the one the run was about to act on before it asked again, and the
    // run goes on. The 携程 home page of 2026-10 is where this was measured: there the two answers
    // named the search button and the search field itself, both under the floor, and stopping on that
    // difference voided a 60-step run at its third step.
    const two = [button('e1', 1, 'Search'), button('e9', 9, 'Search again')]
    const h = harness({
      pages: [pageState('f0', { actions: two }), pageState('f1')],
      choices: ['e1', 'e9', 'DONE'],
      targets: { e1: '1', e9: '2' },
      confidences: [0.3, 0.4, 0.9],
    })
    const result = await run(h.deps)

    expect(result.status).toBe('done')
    expect(result.steps).toBe(1)
    // The first answer's element, never the second's: `choice` is the action id the loop executes.
    expect(h.seen.executed.map((action) => action.id)).toEqual(['e1'])
    expect(result.history[0]).toMatchObject({ target: '1', confidence: 0.3, operation: 'CLICK' })
    // What each asking said is still recorded, with `agreed: false` — the record is about what the
    // service said, and it did not say the same choice twice.
    expect(result.reasks).toEqual([
      {
        step: 1,
        reason: 'low-confidence',
        agreed: false,
        first: { choice: 'e1', confidence: 0.3, probabilities: { e1: 0.3 } },
        second: { choice: 'e9', confidence: 0.4, probabilities: { e9: 0.4 } },
      },
    ])
  })

  it('runs the first answer even when the second one is sure, as long as the operation is the same', async () => {
    // The sentence this rule used to stop on said the second answer may well be sure, and certain and
    // different was the case it was written for. Certain and different about a *target* is still the
    // same operation, so the run acts and lets the cheaper brakes judge it.
    const two = [button('e1', 1, 'Search'), button('e9', 9, 'Search again')]
    const h = harness({
      pages: [pageState('f0', { actions: two }), pageState('f1')],
      choices: ['e1', 'e9', 'DONE'],
      targets: { e1: '1', e9: '2' },
      confidences: [0.2, 0.95, 0.9],
    })
    const result = await run(h.deps)

    expect(result.status).toBe('done')
    expect(h.seen.executed.map((action) => action.id)).toEqual(['e1'])
    expect(result.reasks[0]).toMatchObject({ agreed: false, second: { confidence: 0.95 } })
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
      // A different address on every look, so each step is a change and the budget is what stops
      // this run rather than the rule that counts steps that changed nothing.
      pages: ['f0', 'f1', 'f2', 'f3'].map((id, index) =>
        pageState(id, { url: `https://example.test/page-${index}` }),
      ),
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

  it('keeps the guessed marker in the step record and the run trace, and out of the request', async () => {
    // One row the deep scan guessed at (`browser/snapshot.ts`) and one control the page declared. The
    // marker cannot ride on the element table, because that table is the request body whole, so a run
    // that acted on a guessed row has to say so somewhere else: the step record says it per step, and
    // the run's last word lists the steps that acted on one. The 携程 diagnosis of 2026-10 needed
    // exactly this and had to infer it instead — the trace showed only a table that had grown by seven
    // entries at its tail, and nothing in it said which of the 47 the snapshot had guessed.
    const guessedRow: SnapshotAction = { id: 'e9', kind: 'click', node: 9, label: '酒店 A', guess: 'listener' }
    const h = harness({
      pages: [
        pageState('f0', { actions: [...actions, guessedRow] }),
        pageState('f1', { url: 'https://example.test/results' }),
      ],
      choices: ['e9', 'e1', 'DONE'],
      targets: { e9: '3' },
    })
    const result = await run(h.deps, { record: true })
    try {
      // The step record: the clue on the step that acted on the guessed row, `null` on the ordinary one.
      expect(result.history.map((entry) => `${entry.action}:${entry.guess}`)).toEqual(['酒店 A:listener', 'Search:null'])
      // The request the service was given, as the whole string: the marker is not in it.
      const [space, asked] = [h.seen.spaces[0]!, h.seen.contexts[0]!]
      expect(JSON.stringify(buildQuestionnaire(space, asked, decision.model).request)).not.toContain('"guess"')
      const trace = readFileSync(join(result.recordDir, 'trace.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
      expect(trace[trace.length - 1]).toMatchObject({
        kind: 'run',
        status: 'done',
        guessed_steps: [{ step: 1, target: '3', action: '酒店 A', guess: 'listener' }],
      })
    } finally {
      rmSync(result.recordDir, { recursive: true, force: true })
    }
  })

  it('writes no guessed marker at all when every step was on a control the page declared', async () => {
    // The ordinary run's last word has to stay what it always was: a run with nothing guessed in it
    // writes no `guessed_steps` at all, the way it writes no `stuck_on` or `dead_ends`.
    const h = harness({ pages: [pageState('f0'), pageState('f1')], choices: ['e1', 'DONE'] })
    const result = await run(h.deps, { record: true })
    try {
      expect(result.history.map((entry) => entry.guess)).toEqual([null])
      const last = readFileSync(join(result.recordDir, 'trace.jsonl'), 'utf8').trim().split('\n').pop()!
      expect(last).not.toContain('guessed_steps')
    } finally {
      rmSync(result.recordDir, { recursive: true, force: true })
    }
  })
})

/**
 * The bound on retries that bought no step.
 *
 * Three things re-observe the page and ask again without recording a step: a terminal answer the
 * page has moved out from under, a field that is stale the moment before it is typed into, and an
 * action the page refused to execute (`StalePage`, thrown by `browser/act.ts`). Each pays for a
 * fresh decision from the run's own budget, so what these check is that the three of them are one
 * bounded count rather than an unbounded one, that the bound does not kill the legitimate retries
 * the 2026-10 run was full of, and that it clears the moment a step really is recorded.
 */
describe('retries that buy no step', () => {
  it('retries a step the page refused four times without stopping, as a page repainting under it does', async () => {
    // The first step of the run this bound was written for was refused four times before its input
    // went through. That is an ordinary page repainting under a live run, and it has to stay
    // allowed: a bound of two would have killed it, which is why the number is six.
    const h = harness({
      pages: [pageState('f0'), pageState('f1')],
      choices: [...Array.from({ length: 5 }, () => 'e1'), 'DONE'],
      execute: (index) => {
        if (index < 4) throw new StalePage('目标已经变化或被遮挡，请重新观察')
      },
    })
    const result = await run(h.deps)

    expect(result.status).toBe('done')
    expect(result.reason).toBe('')
    expect(result.steps).toBe(1)
    expect(result.decisions).toBe(6)
    // Four refusals and the attempt that landed: five calls went to the executor, and only the
    // last of them recorded a step.
    expect(h.seen.executed).toHaveLength(5)
  })

  it('allows six refusals on one target, and starts the count over after a step is recorded', async () => {
    // Ten refusals in one run and the run still moves: four before the first step goes through and
    // six before the second, both inside the allowance. What is bounded is refusals that bought no
    // step, not refusals in a run — so the recorded step clears the count, and without that the
    // seventh refusal overall would have stopped a run that was in fact making progress.
    const h = harness({
      pages: [
        pageState('f0'),
        pageState('f1', { url: 'https://example.test/one' }),
        pageState('f2', { url: 'https://example.test/two' }),
      ],
      choices: [...Array.from({ length: 12 }, () => 'e1'), 'DONE'],
      execute: (index) => {
        // Four refusals before the first step lands and six before the second: the attempts that go
        // through are the fifth and the twelfth.
        if (index !== 4 && index !== 11) throw new StalePage('目标已经变化或被遮挡，请重新观察')
      },
    })
    const result = await run(h.deps)

    expect(result.status).toBe('done')
    expect(result.reason).toBe('')
    expect(result.steps).toBe(2)
    expect(result.decisions).toBe(13)
    expect(h.seen.executed).toHaveLength(12)
  })

  it('stops on the seventh refusal that bought no step, and names the target it could not get past', async () => {
    const h = harness({
      pages: [pageState('f0')],
      choices: Array.from({ length: 10 }, () => 'e1'),
      execute: () => {
        throw new StalePage('目标已经变化或被遮挡，请重新观察')
      },
    })
    const result = await run(h.deps)

    expect(result.status).toBe('blocked')
    // The element the run could not get past, named the way the repeated-action stop names the
    // action it was stuck on: the operation, the number the decision chose, and the page's label
    // for it. Six refusals were allowed and the seventh is the stop. Nothing here says the page was
    // changing — it was not, and the run's own record of this round says so: what failed was the
    // execution, seven times over, so that is what the sentence says.
    expect(result.reason).toBe(
      '在你要执行的目标上连着试了 7 次，每次重新看过都没能执行，先停下——' +
        '它卡在这个目标上了：CLICK 目标 1「Search」',
    )
    // A refusal with nothing standing on the target still has the one thing to say it can prove: the
    // page it decided on is not the page in front of it. It goes into the next request's note, and
    // into the one after that for as long as the refusals last — the seventh ends the run before its
    // own note would have been sent.
    const refusedNote = '上一个动作没能执行：决定看到的那一页已经不是现在这一页了，请按现在这一页重新选'
    expect(h.seen.contexts[0]?.note).toBeUndefined()
    expect(h.seen.contexts.slice(1).map((context) => context.note)).toEqual(
      Array.from({ length: 6 }, () => refusedNote),
    )
    // Seven decisions and nothing recorded: the run stops on its own rule, not on the model-call
    // budget the diagnosis found the old unbounded retry burning through.
    expect(result.decisions).toBe(7)
    expect(result.steps).toBe(0)
  })

  it('does not report a refused step as executed', async () => {
    // `executed` is what the panel lists, what the CLI prints as "第 N 步" and what the inspector's
    // index counts. A refusal is none of those: nothing went out, no step was recorded, and the run
    // only looked at the page again. The step that does land is still reported, once.
    const events: string[] = []
    const h = harness({
      pages: [pageState('f0'), pageState('f1'), pageState('f2')],
      choices: ['e1', 'e1', 'DONE'],
      execute: (index) => {
        if (index === 0) throw new StalePage('目标已经变化或被遮挡，请重新观察')
      },
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
    expect(result.steps).toBe(1)
    expect(h.seen.executed).toHaveLength(2)
    expect(events).toEqual(['observed', 'decided', 'decided', 'executed', 'decided', 'finished'])
  })

  it('tells the next request what was standing over a target the page would not be clicked through', async () => {
    // The one refusal a fresh observation cannot explain: the next screen has the same element, the
    // same number and the same hit test, so the sentence the page left behind is the only new fact
    // there is to give the model. It reaches the next question as that question's note — and it is
    // only a fact: nothing here presses a key, clicks the gap or scrolls, which is what the browser
    // call list below is asserting.
    const covered = new TargetCovered({ tag: 'DIV', role: 'dialog', label: '位置' })
    const h = harness({
      pages: [pageState('f0'), pageState('f0')],
      choices: ['e1', 'DONE'],
      execute: (index) => {
        if (index === 0) throw covered
      },
    })
    const result = await run(h.deps)

    expect(result.status).toBe('done')
    expect(h.seen.contexts[0]?.note).toBeUndefined()
    expect(h.seen.contexts[1]?.note).toBe('目标被DIV(role=dialog)「位置」盖住了，点击落不到它身上，请重新观察')
    expect(h.seen.contexts[1]?.note).toBe(covered.message)
    expect(h.seen.calls).toEqual(['observe', 'observe'])
    // The refusal cost a decision and no step, exactly as every other refused execution does.
    expect(result.decisions).toBe(2)
    expect(result.steps).toBe(0)
  })

  it('names what was standing over the target in the sentence the run stops on', async () => {
    // The same count as a refusal with nothing to add, and the one thing that refusal does have to
    // add: who was in the way, in the words the page itself gave. The stop sentence has to read as
    // one sentence with it and as one without it, so the covered case is written out verbatim too.
    const h = harness({
      pages: [pageState('f0')],
      choices: Array.from({ length: 10 }, () => 'e1'),
      execute: () => {
        throw new TargetCovered({ tag: 'DIV', role: 'dialog', label: '位置' })
      },
    })
    const result = await run(h.deps)

    expect(result.status).toBe('blocked')
    expect(result.reason).toBe(
      '在你要执行的目标上连着试了 7 次，每次重新看过都没能执行，' +
        '这次是目标被DIV(role=dialog)「位置」盖住了，' +
        '先停下——它卡在这个目标上了：CLICK 目标 1「Search」',
    )
    expect(result.decisions).toBe(7)
    expect(result.steps).toBe(0)
  })

  it('says a cover with no role and no name by its tag alone', async () => {
    // What the page gives is what the sentence uses: a tag always, a role only when the element
    // declares one, a name only when it has one. Nothing is invented to fill the gaps.
    expect(new TargetCovered({ tag: 'SPAN', role: '', label: '' }).coverNote).toBe('SPAN')
    expect(new TargetCovered({ tag: 'DIV', role: 'dialog', label: '位置' }).coverNote).toBe(
      'DIV(role=dialog)「位置」',
    )
    expect(new TargetCovered({ tag: 'SPAN', role: '', label: '' }).message).toBe(
      '目标被SPAN盖住了，点击落不到它身上，请重新观察',
    )
  })

  it('offers the element standing in the way as a candidate, and one press aimed at it', async () => {
    // The fact the sentence above carries, in the form the model can act on: an element it can click
    // and one key it can press, both in the question's own options. The refusal is what puts them
    // there — the same refusal that used to spend seven decisions on the same blocked target — and
    // the first one is enough, because the hit test behind it is the browser's own answer.
    const blocked = new TargetCovered({ tag: 'DIV', role: 'dialog', label: '位置', node: 9, guard: ['g'] })
    const h = harness({
      pages: [pageState('f0'), pageState('f0'), pageState('f0', { url: 'https://example.test/after' })],
      choices: ['e1', 'cover_escape', 'DONE'],
      execute: (index) => {
        if (index === 0) throw blocked
      },
    })
    const result = await run(h.deps)

    // The first request is the page's own table: nothing has been refused yet.
    expect(h.seen.spaces[0]!.elements.map((element) => element.label)).toEqual(['Search', 'Where from?'])
    expect(escapeTargets(h.seen.spaces[0]!)).toEqual([])
    // The second is that same table plus the way out: the element the hit test found, numbered where
    // the table ends, and one press of Escape aimed at it.
    const second = h.seen.spaces[1]!
    expect(second.elements.map((element) => element.label)).toEqual(['Search', 'Where from?', '位置'])
    expect(second.targets.CLICK!['3']).toMatchObject({ kind: 'click', node: 9, label: '位置' })
    expect(escapeTargets(second)).toEqual(['3:escape'])
    expect(second.targets.PRESS_KEY!['3:escape']!.label).toBe(COVER_ESCAPE_LABEL)
    // The sentence is not replaced by the choice: the next request still carries it as its one note.
    expect(h.seen.contexts[1]?.note).toBe(blocked.message)
    // And the choice is executable, not a number the run cannot find: it is looked up in the table
    // the answer was given, so a model that picks the way out gets it pressed.
    expect(h.seen.executed.map((action) => action.id)).toEqual(['e1', 'cover_escape'])
    expect(result.status).toBe('done')
    expect(result.steps).toBe(1)
  })

  it('offers a covering element the page already listed, once, with the press beside it', async () => {
    // The other half of the same rule: an element the snapshot could name is already a candidate, so
    // what is added is the half the page would not have offered. One element, one number — a second
    // entry for the same node would be two rows the model could choose between for one thing.
    const blocked = new TargetCovered({ tag: 'DIV', role: 'dialog', label: '位置', node: 9, guard: ['g'] })
    const same = (): PageState => pageState('f0', { actions: [...actions, button('e9', 9, '关闭')] })
    const h = harness({
      pages: [same(), same(), pageState('f1', { url: 'https://example.test/after' })],
      choices: ['e1', 'e9', 'DONE'],
      execute: (index) => {
        if (index === 0) throw blocked
      },
    })
    const result = await run(h.deps)

    const second = h.seen.spaces[1]!
    expect(second.elements.map((element) => element.label)).toEqual(['Search', 'Where from?', '关闭'])
    // The candidate is the page's own action for that element, not a second one of ours.
    expect(second.targets.CLICK!['3']).toMatchObject({ id: 'e9', kind: 'click', node: 9, label: '关闭' })
    expect(escapeTargets(second)).toEqual(['3:escape'])
    expect(h.seen.executed.map((action) => action.id)).toEqual(['e1', 'e9'])
    expect(result.status).toBe('done')
  })

  it('does not let the way out of a cover count as the page changing', async () => {
    // The screen after the step is the screen before it, to the address and the element table. Were a
    // candidate the run added on its own account part of what `repeatedActionState` reads, the two
    // would differ and this step would report a change the page never made — the judgement the
    // "three steps changed nothing" brake and the dead-end rule both rest on.
    const blocked = new TargetCovered({ tag: 'DIV', role: 'dialog', label: '位置', node: 9, guard: ['g'] })
    const same = (): PageState => pageState('f0', { actions: [...actions] })
    const h = harness({
      pages: [same(), same(), same()],
      choices: ['e1', 'e1', 'DONE'],
      execute: (index) => {
        if (index === 0) throw blocked
      },
    })
    const result = await run(h.deps)

    expect(h.seen.spaces[1]!.elements).toHaveLength(3)
    expect(result.history).toHaveLength(1)
    expect(result.history[0]).toMatchObject({ page_changed: false, choice: 'e1', action: 'Search' })
  })

  it('is one switch away from the behaviour it replaced, wording and all', async () => {
    // The same scripted refusal with the switch off has to read exactly as it read before any of this
    // existed: the page's own table — compared whole, not field by field — and the sentence, and no
    // candidate of the run's own anywhere in the request.
    const blocked = new TargetCovered({ tag: 'DIV', role: 'dialog', label: '位置', node: 9, guard: ['g'] })
    const same = (): PageState => pageState('f0', { actions: [...actions] })
    const h = harness({
      pages: [same(), same(), same()],
      choices: ['e1', 'DONE'],
      execute: (index) => {
        if (index === 0) throw blocked
      },
    })
    const result = await run(h.deps, { dismissCoveredTarget: false })

    expect(JSON.stringify(h.seen.spaces[1])).toBe(JSON.stringify(actionSpace(same().actions)))
    expect(h.seen.contexts[1]?.note).toBe(blocked.message)
    expect(h.seen.executed.map((action) => action.id)).toEqual(['e1'])
    expect(result.status).toBe('done')
    expect(result.reason).toBe('')
  })

  it('carries the cover switch from the settings read into the run it starts', async () => {
    // The same wire the two switches above are tested on: the config field as the settings page saves
    // it, `readSettings` as the tool and the inspector read it, and the run's own option.
    const resolveConfig = (input: Record<string, unknown>): ConfigShape =>
      (Config as unknown as (data: unknown) => ConfigShape)(input)
    expect(readSettings(resolveConfig({})).dismissCoveredTarget).toBe(true)
    expect(readSettings(resolveConfig({ dismissCoveredTarget: false })).dismissCoveredTarget).toBe(false)

    const blocked = new TargetCovered({ tag: 'DIV', role: 'dialog', label: '位置', node: 9, guard: ['g'] })
    const same = (): PageState => pageState('f0', { actions: [...actions] })
    const scripted = (): Harness =>
      harness({
        pages: [same(), same(), same()],
        choices: ['e1', 'DONE'],
        execute: (index) => {
          if (index === 0) throw blocked
        },
      })

    const off = scripted()
    await run(off.deps, { dismissCoveredTarget: readSettings(resolveConfig({ dismissCoveredTarget: false })).dismissCoveredTarget })
    const shipped = scripted()
    await run(shipped.deps, { dismissCoveredTarget: readSettings(resolveConfig({})).dismissCoveredTarget })

    expect(escapeTargets(off.seen.spaces[1]!)).toEqual([])
    expect(escapeTargets(shipped.seen.spaces[1]!)).toEqual(['3:escape'])
  })

  it('offers the way out of a cover on a page whose table is already cut to its cap', async () => {
    // The page this mechanism exists for is also the page that reaches the cap: the hotel list of the
    // 2026-10 run offered 49 entries and the cut sent 44 of them. The two candidates are appended to the
    // page's own table, so on a table like that they were what the cut took first — on the one page the
    // run cannot get through without them. They are put back after the cut (see `withCoverCandidates`),
    // and what that costs the cap is one row.
    const crowd = Array.from({ length: 60 }, (_unused, at) => button(`e${at + 1}`, at + 1, `Option ${at + 1}`))
    const blocked = new TargetCovered({ tag: 'DIV', role: 'dialog', label: '位置', node: 99, guard: ['g'] })
    const scripted = (choices: string[]): Harness =>
      harness({
        pages: [pageState('f0', { actions: crowd }), pageState('f0', { actions: crowd }), pageState('f0', { actions: crowd })],
        choices,
        execute: (index) => {
          if (index === 0) throw blocked
        },
      })

    const shipped = scripted(['e1', 'cover_escape', 'DONE'])
    const result = await run(shipped.deps)
    const second = shipped.seen.spaces[1]!
    // The page's own 60 controls fill a table of MAX_ELEMENTS, and the covering element joins them: the
    // cap, plus the one row the exception is worth. Its number is the frame's own, not the table's.
    const at = String(crowd.length + 1)
    expect(second.elements).toHaveLength(MAX_ELEMENTS + 1)
    expect(second.elements.at(-1)).toMatchObject({ index: at, label: '位置', operations: ['CLICK', 'PRESS_KEY'], role: 'dialog' })
    expect(second.targets.CLICK![at]).toMatchObject({ kind: 'click', node: 99, label: '位置' })
    expect(escapeTargets(second)).toEqual([`${at}:escape`])
    // The service is told what it is reading: 61 entries were there, 49 of them are in front of it.
    // (`sentElements` in the run's own report is the last request's, and the run has moved on by then.)
    expect(shipped.seen.contexts[1]!.omittedElements).toBe(crowd.length - MAX_ELEMENTS)
    // The cap on the body holds with the two extra lines inside it, measured from exactly what the run
    // handed the decision layer.
    expect(requestChars(second, shipped.seen.contexts[1]!, decision.model)).toBeLessThanOrEqual(20_000)
    // And it is a choice the run can execute, on a screen it has not moved on from: the table gained a
    // row of the run's own, which is not the page changing.
    expect(shipped.seen.executed.map((action) => action.id)).toEqual(['e1', 'cover_escape'])
    expect(result.history[0]).toMatchObject({ page_changed: false, choice: 'cover_escape', action: COVER_ESCAPE_LABEL })
    expect(result.status).toBe('done')

    // One switch away from the behaviour it replaced, on the same page and with the same refusal: the
    // table the cap cut, nothing of the run's own in it, and the very table the first request carried.
    const off = scripted(['e1', 'DONE'])
    await run(off.deps, { dismissCoveredTarget: false })
    expect(off.seen.spaces[0]!.elements).toHaveLength(MAX_ELEMENTS)
    expect(JSON.stringify(off.seen.spaces[1])).toBe(JSON.stringify(off.seen.spaces[0]))
    expect(escapeTargets(off.seen.spaces[1]!)).toEqual([])
  })

  it('cuts the table a few entries further rather than let a cover eat the request budget', async () => {
    // Long labels are the shape counting cannot see: 97 such controls measured 26,650 characters once
    // the table was cut to the cap, which is why the body itself is measured and the table cut again.
    // The cover's two lines are part of that measurement, so what gives is the table and not the cap.
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
    const blocked = new TargetCovered({ tag: 'DIV', role: 'dialog', label: '位置', node: 999, guard: ['g'] })
    const h = harness({
      pages: [pageState('f0', { actions: heavy }), pageState('f0', { actions: heavy }), pageState('f0', { actions: heavy })],
      choices: ['e1', 'cover_escape', 'DONE'],
      execute: (index) => {
        if (index === 0) throw blocked
      },
    })
    const result = await run(h.deps)

    const [space, asked] = [h.seen.spaces[1]!, h.seen.contexts[1]!]
    expect(result.status).toBe('done')
    // The cut had already gone below the cap for the page's own labels, and both ways out are in the
    // table it settled on — one row above that cut, and never more than the cap plus one.
    expect(space.elements.length).toBeLessThan(MAX_ELEMENTS + 1)
    expect(space.elements.at(-1)).toMatchObject({ index: String(heavy.length + 1), label: '位置' })
    expect(space.targets.CLICK![String(heavy.length + 1)]).toMatchObject({ node: 999, label: '位置' })
    expect(escapeTargets(space)).toEqual([`${heavy.length + 1}:escape`])
    // Measured from exactly what the run handed the decision layer.
    expect(requestChars(space, asked, decision.model)).toBeLessThanOrEqual(20_000)
  })

  it('counts a terminal answer refused by a moved page and an action refused by the page in one count', async () => {
    // The two paths that re-observe without a step, alternating: a terminal answer the page has
    // moved out from under (`DONE` before it is believed) and an action the page will not execute.
    // Three of one path and four of the other make seven refusals, and the run stops on the seventh.
    // That is the point of the test: with a count per path, neither side would have reached six and
    // this run would have gone on burning decisions until the budget, which is the bug.
    const h = harness({
      pages: [pageState('f0'), pageState('f1')],
      choices: ['DONE', 'e1', 'DONE', 'e1', 'DONE', 'e1', 'e1'],
      // One freshness check before each decision, plus one before each terminal answer. The `false`
      // entries are the three moved pages those terminal answers came back on; every other check
      // passes, so the run never gets lost on a target it was never given.
      fresh: [true, false, true, true, false, true, true, false, true, true],
      execute: () => {
        throw new StalePage('目标已经变化或被遮挡，请重新观察')
      },
    })
    const result = await run(h.deps)

    expect(result.status).toBe('blocked')
    expect(result.reason).toContain('连着试了 7 次')
    // The seventh refusal is one of the action's, so the target it names is that action's own.
    expect(result.reason).toContain('目标 1「Search」')
    expect(result.decisions).toBe(7)
    expect(result.steps).toBe(0)
    expect(h.seen.executed).toHaveLength(4)
  })

  it('leaves the runs that never get refused exactly as they were, wording included', async () => {
    // The rule only ever fires on a retry, so a run that never retries has to read exactly as it
    // did before the rule existed: the same numbers, the same empty sentence for DONE, and the same
    // neighbouring blocked sentence, which is not this rule's to rewrite.
    const ordinary = await run(
      harness({
        pages: [pageState('f0'), pageState('f1', { url: 'https://example.test/one' })],
        choices: ['e1', 'DONE'],
      }).deps,
    )
    expect(ordinary.status).toBe('done')
    expect(ordinary.reason).toBe('')
    expect(ordinary.steps).toBe(1)
    expect(ordinary.decisions).toBe(2)

    const still = await run(harness({ pages: [pageState('same')], choices: ['e1', 'e1', 'e1', 'e1'] }).deps)
    expect(still.status).toBe('blocked')
    expect(still.reason).toBe('连续 3 步当前页面没有任何变化，已停止')
    expect(still.steps).toBe(3)
  })

  describe('the checklist the control model writes', () => {
    /**
     * A scripted control model: it answers with exactly what the test says, it keeps every question
     * it was asked, and it never touches the network — which is what lets these four tests run in
     * milliseconds and still say how often the layer was reached at all.
     */
    function controlModel(reply: string | Error): { model: ControlModel; asked: string[] } {
      const asked: string[] = []
      return {
        asked,
        model: {
          async call({ user }) {
            asked.push(user)
            if (reply instanceof Error) throw reply
            return reply
          },
        },
      }
    }

    /** One plan with a single locally decidable flag: the kind the prompt asks for first. */
    const planFor = (say: string, value: string): string =>
      JSON.stringify({ goal: 'g', checks: [{ id: 'u', say, kind: 'url-contains', value }] })

    const traceOf = (dir: string): Array<Record<string, unknown>> =>
      readFileSync(join(dir, 'trace.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Record<string, unknown>)

    it('asks nobody, and writes nothing, when the run is handed no control model', async () => {
      // Off is the absence of the model on the run: nothing is built, nothing is called, and the
      // trace is the trace every run left before any of this existed — its last word and no more.
      // (Which switch fills that option in is the settings' business; here it is deliberately
      // never handed over, and the model built for it stays untouched.)
      const never = controlModel('{"checks":[]}')
      const off = harness({ pages: [pageState('f0'), pageState('f1')], choices: ['e1', 'DONE'] })
      const plain = await run(off.deps, { record: true })

      expect(plain.status).toBe('done')
      expect(never.asked).toEqual([])
      expect(traceOf(plain.recordDir)).toEqual([expect.objectContaining({ kind: 'run', status: 'done' })])

      // The other half of the same switch, one option away: handed the model, the run asks it once.
      const on = harness({ pages: [pageState('f0'), pageState('f1')], choices: ['e1', 'DONE'] })
      await run(on.deps, { control: { model: never.model, cap: 12 } })
      expect(never.asked).toHaveLength(1)

      rmSync(plain.recordDir, { recursive: true, force: true })
    })

    it('writes one line when an address drops the landmark the run was pinned to', async () => {
      // The sixth run of 2026-10-02 (run-1790924542952-x19r) reached `landmark=58397117` and then
      // lost it, and nothing in its trace said so: the parameter is simply gone from the address and
      // the page it is looking at reads like any other hotel list. The pin comes from the first
      // address that carries one, the loss is what gets written — and the run itself is untouched:
      // the same two questions, the same one executed step, the same finish.
      const control = controlModel(planFor('地址里一直在酒店站内', 'hotels.test'))
      const h = harness({
        pages: [
          pageState('f0', { url: 'https://hotels.test/list?city=1&landmark=58397117' }),
          pageState('f1', { url: 'https://hotels.test/list?cityId=1&old=1' }),
        ],
        choices: ['e1', 'DONE'],
      })
      const result = await run(h.deps, { record: true, control: { model: control.model, cap: 12 } })

      expect(result.status).toBe('done')
      expect(result.steps).toBe(1)
      expect(result.decisions).toBe(2)
      expect(h.seen.executed.map((action) => action.id)).toEqual(['e1'])
      expect(traceOf(result.recordDir).filter((record) => 'landmark' in record)).toEqual([
        {
          at: expect.any(Number),
          kind: 'control',
          error: '地标从地址里掉了，钉住的是 58397117，现在这一步的地址是 https://hotels.test/list?cityId=1&old=1',
          landmark: '58397117',
          url: 'https://hotels.test/list?cityId=1&old=1',
        },
      ])

      rmSync(result.recordDir, { recursive: true, force: true })
    })

    it('writes no line for a run that never meets a landmark, and none either when the layer is off', async () => {
      // Two ways of having nothing to report. A run whose addresses never carry `landmark=` is the
      // ordinary case and has to stay ordinary: its control lines are the checklist's own and no
      // more — which is also the setting this ships with, so a run that never asked for the layer
      // cannot grow a line here at all.
      const control = controlModel(planFor('地址里一直在酒店站内', 'hotels.test'))
      const never = harness({ pages: [pageState('f0'), pageState('f1')], choices: ['e1', 'DONE'] })
      const plain = await run(never.deps, { record: true, control: { model: control.model, cap: 12 } })

      expect(plain.status).toBe('done')
      expect(traceOf(plain.recordDir).filter((record) => 'landmark' in record)).toEqual([])
      rmSync(plain.recordDir, { recursive: true, force: true })

      // The same pages with the layer off: the trace is the one every run left before any of this
      // existed, landmark or not.
      const off = harness({
        pages: [
          pageState('f0', { url: 'https://hotels.test/list?city=1&landmark=58397117' }),
          pageState('f1', { url: 'https://hotels.test/list?cityId=1&old=1' }),
        ],
        choices: ['e1', 'DONE'],
      })
      const quiet = await run(off.deps, { record: true })

      expect(quiet.status).toBe('done')
      expect(traceOf(quiet.recordDir)).toEqual([expect.objectContaining({ kind: 'run', status: 'done' })])
      rmSync(quiet.recordDir, { recursive: true, force: true })
    })

    it('writes it again only after an address has carried a landmark back', async () => {
      // The edge rather than the step: this run loses the landmark, is brought back to it, and loses
      // it a second time. Addresses without it in a row would still be one event; these are two, and
      // each record says which address the run was on when it happened.
      const control = controlModel(planFor('地址里一直在酒店站内', 'hotels.test'))
      const h = harness({
        pages: [
          pageState('f0', { url: 'https://hotels.test/list?city=1&landmark=58397117' }),
          pageState('f1', { url: 'https://hotels.test/list?cityId=1' }),
          pageState('f2', { url: 'https://hotels.test/list?city=1&landmark=58397117&page=2' }),
          pageState('f3', { url: 'https://hotels.test/list?cityId=1&old=1' }),
        ],
        choices: ['e1', 'e1', 'e1', 'DONE'],
      })
      const result = await run(h.deps, { record: true, control: { model: control.model, cap: 12 } })

      expect(result.status).toBe('done')
      expect(result.steps).toBe(3)
      expect(traceOf(result.recordDir).filter((record) => 'landmark' in record).map((record) => record.url)).toEqual([
        'https://hotels.test/list?cityId=1',
        'https://hotels.test/list?cityId=1&old=1',
      ])

      rmSync(result.recordDir, { recursive: true, force: true })
    })

    it('carries on, and says so, when the checklist cannot be read', async () => {
      // The two ways a read fails land on the same promise, and the one line they leave tells them
      // apart: a door that refused, and a model that answered something the parser would not take —
      // the second one is a prompt problem, and its sentence carries the words it actually said.
      for (const [reply, why] of [
        [new Error('route is down'), '调用出错：route is down'],
        ['not a plan at all', '答非所问（不是能解析的 JSON：JSON 本身对不上（引号、逗号或括号））：not a plan at all'],
      ] as const) {
        const control = controlModel(reply)
        const h = harness({ pages: [pageState('f0'), pageState('f1')], choices: ['e1', 'DONE'] })
        const result = await run(h.deps, { record: true, control: { model: control.model, cap: 12 } })

        expect(result.status).toBe('done')
        expect(h.seen.executed.map((action) => action.id)).toEqual(['e1'])
        // Asked once and never again: a checklist nobody could read is not retried on every step.
        expect(control.asked).toHaveLength(1)
        expect(traceOf(result.recordDir).filter((record) => record.kind === 'control')).toEqual([
          { at: expect.any(Number), kind: 'control', error: '清单没读成', why },
        ])

        rmSync(result.recordDir, { recursive: true, force: true })
      }
    })

    it('refuses a done the checklist does not support, then lets the fourth one through', async () => {
      // Every page this run sees is the one the flag says it should not be on, so the finish is
      // refused when it is claimed — three times. The refusal is not a stop, and after the run of
      // 2026-10-02 it is not endless either: an answer sent back for ever is a stop by other means,
      // and 106 of them spent a 120-decision budget on five steps of work.
      const control = controlModel(planFor('地址里一直带着结果页', '/results'))
      const h = harness({ pages: [pageState('f0'), pageState('f0'), pageState('f0')], choices: ['DONE'] })
      const result = await run(h.deps, { control: { model: control.model, cap: 12 }, maxSteps: 3 })

      // Let through, which is an ordinary finish — reached in four questions, never near the budget.
      expect(result.status).toBe('done')
      expect(result.reason).toBe('')
      expect(result.steps).toBe(0)
      expect(h.seen.decisions).toBe(4)
      // The first question carries no sentence; the ones after a refusal name the flag that failed,
      // in the words the control model wrote for it — and there are exactly three of them.
      expect(h.seen.contexts[0]!.note).toBeUndefined()
      expect(h.seen.contexts[1]!.note).toContain('地址里一直带着结果页')
      expect(h.seen.contexts.filter((context) => context.note !== undefined)).toHaveLength(3)
    })

    it('says it was let through, not that the conditions came true', async () => {
      // Two flags, one of which this page can never satisfy. Told three times over, the fourth claim
      // is allowed — and what the run leaves behind has to name the condition that stayed unmet and
      // to read as a release: nothing in the record may look like the checklist having passed.
      const control = controlModel(
        JSON.stringify({
          goal: 'g',
          checks: [
            { id: 'u', say: '地址里一直带着结果页', kind: 'url-contains', value: '/results' },
            { id: 't', say: '页面上一直出现「Where from?」', kind: 'text-contains', value: 'Where from?' },
          ],
        }),
      )
      const h = harness({ pages: [pageState('f0'), pageState('f0'), pageState('f0')], choices: ['DONE'] })
      const result = await run(h.deps, { record: true, control: { model: control.model, cap: 12 }, maxSteps: 3 })

      expect(result.status).toBe('done')
      // Only the condition that never held is named: the other one was true all along, and the
      // record is about what the run was released from, not a summary of the checklist. The
      // sentence is what the inspector shows; `let_through` is what says it was not a pass.
      expect(traceOf(result.recordDir).filter((record) => record.kind === 'control' && record.let_through === true)).toEqual([
        expect.objectContaining({
          error: '清单始终没成立，放行了',
          let_through: true,
          unmet: ['地址里一直带着结果页'],
        }),
      ])

      rmSync(result.recordDir, { recursive: true, force: true })
    })

    it('lets a done through once every flag holds on the page in front of it', async () => {
      // The flag is read on the page the run starts from, where it does not hold, and it is the
      // page the step landed on that satisfies it. So this run ends well only because the flags
      // are decided against the screen the run is actually on when it says it is finished.
      const control = controlModel(planFor('地址里一直带着结果页', '/results'))
      const h = harness({
        pages: [pageState('f0'), pageState('f1', { url: 'https://example.test/results' })],
        choices: ['e1', 'DONE'],
      })
      const result = await run(h.deps, { control: { model: control.model, cap: 12 } })

      expect(result.status).toBe('done')
      expect(result.reason).toBe('')
      expect(result.steps).toBe(1)
      expect(h.seen.decisions).toBe(2)
    })
  })
})
