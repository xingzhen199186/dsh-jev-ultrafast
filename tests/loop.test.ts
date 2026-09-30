import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AdoptResult, BrowserPort, PageState, SnapshotAction } from '../src/browser/session'
import { StalePage } from '../src/browser/session'
import type { FieldContext, TextResult } from '../src/decision/text-helper'
import type { Decision } from '../src/decision/typesafe'
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

function decisionFor(choice: string): Decision {
  return {
    choice,
    operation: choice === 'DONE' || choice === 'BLOCKED' ? choice : 'CLICK',
    target: choice === 'DONE' || choice === 'BLOCKED' ? null : '1',
    confidence: 0.9,
    probabilities: { [choice]: 0.9 },
    operationProbabilities: {},
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
    decide: async () => {
      seen.decisions += 1
      return decisionFor(config.choices.shift() ?? 'DONE')
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

  it('refuses a decision that points at an action it never observed', async () => {
    const h = harness({ pages: [pageState('f0')], choices: ['e99'] })
    const result = await run(h.deps)

    expect(result.status).toBe('failed')
    expect(result.reason).toMatch(/不存在的动作/)
    expect(h.seen.executed).toHaveLength(0)
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
      // One frame before the first action and one after it, in the order they happened.
      const manifest = JSON.parse(readFileSync(join(recorded.recordDir, 'frames.json'), 'utf8'))
      expect(manifest.frames).toHaveLength(2)
      expect(manifest.frames[0].file).toBe('000000.jpg')
      expect(readFileSync(join(recorded.recordDir, 'frames', manifest.frames[0].file), 'utf8')).toBe('hello')

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
})
