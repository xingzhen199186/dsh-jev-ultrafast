/**
 * Browser-layer integration test: it needs a real Chromium-based browser with a
 * DevTools endpoint, so it stays skipped unless asked for.
 *
 *   JEV_BROWSER=1 pnpm test
 *   JEV_BROWSER=1 JEV_CDP_URL=http://127.0.0.1:9222 pnpm test
 *
 * Start a browser for it with, for example:
 *   chrome.exe --remote-debugging-port=9222 --user-data-dir="C:\chrome-cdp"
 */
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { act } from '../src/browser/act'
import { readPage } from '../src/browser/read'
import { BrowserSession, StalePage, type PageState, type SnapshotAction } from '../src/browser/session'
import type { Decision } from '../src/decision/typesafe'
import { runTask, type TaskDeps } from '../src/loop'

const enabled = process.env.JEV_BROWSER === '1'
const fixtureUrl = pathToFileURL(fileURLToPath(new URL('./fixture/probe.html', import.meta.url))).href
const longUrl = pathToFileURL(fileURLToPath(new URL('./fixture/long.html', import.meta.url))).href
const lateUrl = pathToFileURL(fileURLToPath(new URL('./fixture/late.html', import.meta.url))).href
/** Paragraphs in tests/fixture/long.html, each carrying its own 「第 N 段」 marker. */
const PARAGRAPHS = 24

function byLabel(page: PageState, label: string): SnapshotAction | undefined {
  return page.actions.find((action) => typeof action.label === 'string' && action.label.includes(label))
}

describe.skipIf(!enabled)('browser layer', () => {
  let session: BrowserSession

  beforeAll(async () => {
    session = await BrowserSession.open(fixtureUrl, { cdpUrl: process.env.JEV_CDP_URL })
  }, 60_000)

  afterAll(async () => {
    await session?.close()
  })

  it('reports which browser it attached to', async () => {
    expect(await session.version()).toMatch(/\//)
  })

  it('reads the page into an indexed element table', async () => {
    const page = await session.observe()
    expect(page.url).toBe(fixtureUrl)
    expect(page.actions.length).toBeGreaterThan(5)
    expect(page.actions.every((action) => typeof action.id === 'string')).toBe(true)
    expect(byLabel(page, 'Add one')?.kind).toBe('click')
    expect(byLabel(page, 'Guest name')?.kind).toBe('fill')
    expect(page.actions.some((action) => action.kind === 'select' && action.value === 'double')).toBe(true)
  })

  it('never offers an element that is outside the viewport', async () => {
    const page = await session.observe()
    expect(byLabel(page, 'Off screen')).toBeUndefined()
  })

  it('clicks a button and sees the effect', async () => {
    const before = await session.observe()
    const button = byLabel(before, 'Add one')
    expect(button).toBeDefined()
    const result = await act(session, before, button!)
    expect(result.executed).toBe(button!.id)
    const after = await session.observe()
    expect(after.fingerprint).not.toBe(before.fingerprint)
    const count = await session.evaluate<string>('document.getElementById("counter").textContent')
    expect(count).toBe('1')
  })

  it('waits for a page that paints its content after loading finished', async () => {
    // The real shape of it: the document is `complete` while the body is still a shell, and the
    // content arrives afterwards. Baidu's results page is exactly this, and a decision taken on
    // that shell is how a run came back with a search it had never read (2026-09-30).
    await session.call('Page.navigate', { url: lateUrl })
    const before = await session.observe()
    expect(before.text).not.toContain('迟到的内容')

    await session.settle(before)
    const after = await session.observe()
    expect(after.text).toContain('迟到的内容')
    // The session is shared with the tests that follow, so it goes back where they expect it.
    await session.call('Page.navigate', { url: fixtureUrl })
  })

  it('refuses a target that is covered by another element', async () => {
    const page = await session.observe()
    const covered = byLabel(page, 'Covered button')
    // Observed, because it is a visible control in the viewport...
    expect(covered).toBeDefined()
    // ...but not executable, because the hit test at its centre lands elsewhere.
    await expect(act(session, page, covered!)).rejects.toBeInstanceOf(StalePage)
  })

  it('refuses a node the page never handed out', async () => {
    const page = await session.observe()
    const forged: SnapshotAction = { id: 'e999', kind: 'click', node: 999_999, label: 'forged' }
    await expect(act(session, page, forged)).rejects.toThrow()
  })

  it('refuses a decision made against a page that has since changed', async () => {
    const stale = await session.observe()
    const button = byLabel(stale, 'Add one')
    expect(button).toBeDefined()
    await act(session, stale, button!)
    await expect(act(session, stale, button!)).rejects.toBeInstanceOf(StalePage)
  })

  it('fills a field, replacing whatever was already there', async () => {
    const first = await session.observe()
    const field = byLabel(first, 'Guest name')
    expect(field?.kind).toBe('fill')
    await act(session, first, field!, 'Ada Lovelace')

    const second = await session.observe()
    expect(byLabel(second, 'Guest name')?.value).toBe('Ada Lovelace')
    await act(session, second, byLabel(second, 'Guest name')!, 'Grace Hopper')

    expect(await session.evaluate<string>('document.getElementById("field").value')).toBe('Grace Hopper')
    expect(await session.evaluate<string>('document.getElementById("echo").textContent')).toBe('typed:Grace Hopper')
  })

  it('selects an observed dropdown value', async () => {
    const page = await session.observe()
    const option = page.actions.find((action) => action.kind === 'select' && action.value === 'double')
    expect(option).toBeDefined()
    await act(session, page, option!)
    expect(await session.evaluate<string>('document.getElementById("room-out").textContent')).toBe('room:double')
  })

  it('follows the tab a link opened and reads the page that landed there', async () => {
    // The probe page carries a link with target="_blank", which is the shape of every
    // search result: the click succeeds, this page stays exactly as it was, and without
    // following, the run would read "nothing changed" while the effect sits in the new
    // tab. This test drives that for real, including the CDP attach.
    await session.call('Page.navigate', { url: fixtureUrl })
    const before = await session.observe()
    const link = byLabel(before, 'Open a second page')
    expect(link?.kind).toBe('click')

    await act(session, before, link!)
    const after = await session.observe()
    expect(after.fingerprint).toBe(before.fingerprint)

    const found = await session.adoptNewPage({ onlyIfSameUrl: true })
    expect(found?.appeared.length).toBeGreaterThan(0)
    expect(found?.adopted?.url.endsWith('newtab.html')).toBe(true)

    const second = await session.observe()
    expect(second.url.endsWith('newtab.html')).toBe(true)
    expect(second.text).toContain('Second page')
    // The tab this test opened stays behind (only the tab the session created is
    // closed), which is also the intended product behaviour: the page the task ended
    // on is left open for whoever asked for it.
  })
})

describe.skipIf(!enabled)('reading a long page', () => {
  it(
    'collects a page taller than the viewport, losing no paragraph and repeating none',
    async () => {
      // The reading route against a real browser: this is the check that matters for it,
      // because both of its failure modes are invisible in a scripted page — a missed
      // screen shows up as missing paragraphs, and overlap that was not removed shows up
      // as duplicates.
      const result = await readPage(
        { url: longUrl, maxScreens: 40 },
        { open: (url, options) => BrowserSession.open(url, { ...options, cdpUrl: process.env.JEV_CDP_URL }) },
      )

      expect(result.stop).toBe('bottom')
      expect(result.screens.length).toBeGreaterThan(3)
      const markers = Array.from({ length: PARAGRAPHS }, (_, index) => `第 ${index + 1} 段`)
      expect(markers.filter((marker) => !result.text.includes(marker))).toEqual([])
      // Every marker exactly once: `split` gives one more piece than there were matches.
      expect(markers.filter((marker) => result.text.split(marker).length > 2)).toEqual([])
      expect(result.chars).toBeGreaterThan(1000)
    },
    60_000,
  )
})

describe.skipIf(!enabled)('recording a run', () => {
  it(
    'keeps one real frame per step, and the trace, in a directory of its own',
    async () => {
      // The frame path against a real page: what a replay needs is a real JPEG per step,
      // and that is exactly what a scripted page cannot prove. The decisions are scripted
      // instead, so no model call is spent on checking a file layout.
      const session = await BrowserSession.open(fixtureUrl, { cdpUrl: process.env.JEV_CDP_URL })
      const terminal: Decision = {
        choice: 'DONE',
        operation: 'DONE',
        target: null,
        confidence: 0.9,
        probabilities: { DONE: 0.9 },
        operationProbabilities: {},
        targetProbabilities: {},
        targetConfidence: null,
        usage: {},
        model: 'scripted',
        latencyMs: 1,
      }
      let calls = 0
      const result = await runTask({
        goal: 'Add one to the counter',
        startUrl: fixtureUrl,
        decision: { endpoint: 'https://decisions.test/v1', apiKey: '', model: 'scripted' },
        text: { baseUrl: '', apiKey: '', model: 'scripted', reasoning: 'none' },
        screenshots: true,
        record: true,
        maxSteps: 2,
        deps: {
          open: async () => session,
          decide: async (_source, space) => {
            calls += 1
            if (calls > 1) return terminal
            const index = space.elements.find((element) => element.label.includes('Add one'))?.index ?? ''
            const id = space.targets.CLICK?.[index]?.id ?? 'DONE'
            return {
              ...terminal,
              choice: id,
              operation: 'CLICK',
              target: index,
              probabilities: { [id]: 0.9 },
            }
          },
        },
      })

      try {
        expect(result.status).toBe('done')
        const manifest = JSON.parse(readFileSync(join(result.recordDir, 'frames.json'), 'utf8'))
        // One frame before the first action and one after it.
        expect(manifest.frames).toHaveLength(2)
        for (const frame of manifest.frames) {
          const bytes = readFileSync(join(result.recordDir, 'frames', String(frame.file)))
          // A file is not a picture: the check is on what is in it.
          expect([bytes[0], bytes[1]]).toEqual([0xff, 0xd8])
          expect(bytes.length).toBeGreaterThan(1000)
        }

        const trace = readFileSync(join(result.recordDir, 'trace.jsonl'), 'utf8').trim().split('\n')
        expect(JSON.parse(trace[trace.length - 1]!)).toMatchObject({ kind: 'run', status: 'done', steps: 1 })
      } finally {
        rmSync(result.recordDir, { recursive: true, force: true })
        await session.close()
      }
    },
    120_000,
  )
})

describe.skipIf(!enabled)('holding a run before it acts', () => {
  const terminal: Decision = {
    choice: 'DONE',
    operation: 'DONE',
    target: null,
    confidence: 0.9,
    probabilities: { DONE: 0.9 },
    operationProbabilities: {},
    targetProbabilities: {},
    targetConfidence: null,
    usage: {},
    model: 'scripted',
    latencyMs: 1,
  }

  /** Click the fixture's counter button once, then finish. */
  function clickAddOneOnce(): TaskDeps['decide'] {
    let calls = 0
    return async (_source, space) => {
      calls += 1
      if (calls > 1) return terminal
      const index = space.elements.find((element) => element.label.includes('Add one'))?.index ?? ''
      return {
        ...terminal,
        choice: space.targets.CLICK?.[index]?.id ?? 'DONE',
        operation: 'CLICK',
        target: index,
        probabilities: {},
      }
    }
  }

  /** The fixture's own counter, read from the page instead of from the snapshot text. */
  async function probeCount(session: BrowserSession): Promise<number> {
    const answer = (await session.call('Runtime.evaluate', {
      expression: 'window.__probeCount()',
      returnByValue: true,
    })) as { result?: { value?: unknown } }
    return typeof answer.result?.value === 'number' ? answer.result.value : -1
  }

  /**
   * The same session, with the loop's closing of it skipped.
   *
   * A run closes the browser it was handed, which is right for a tool and unhelpful for a test
   * that wants to read the page after the run. The real session is closed in the finally block.
   */
  function keepOpen(session: BrowserSession): BrowserSession {
    return new Proxy(session, {
      get(target, property) {
        if (property === 'close') return async () => {}
        const value = Reflect.get(target, property) as unknown
        return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value
      },
    })
  }

  function scripted(session: BrowserSession, gate: (info: { step: number; action: string }) => Promise<void>) {
    return {
      goal: 'Add one to the counter',
      startUrl: fixtureUrl,
      decision: { endpoint: 'https://decisions.test/v1', apiKey: '', model: 'scripted' },
      text: { baseUrl: '', apiKey: '', model: 'scripted', reasoning: 'none' as const },
      screenshots: true,
      record: true,
      deps: { open: async () => keepOpen(session), decide: clickAddOneOnce() },
      gate,
    }
  }

  it(
    'really waits, so nothing has been clicked while the run is held',
    async () => {
      // This is the promise a pause makes, checked against a real page: while the run waits,
      // the button has not been pressed. The counter is read inside the hold, before the
      // click the loop is waiting to deliver, and the page is read again afterwards.
      const session = await BrowserSession.open(fixtureUrl, { cdpUrl: process.env.JEV_CDP_URL })
      let release: (() => void) | null = null
      let counterWhileHeld = -1
      let entered: () => void = () => {}
      const held = new Promise<void>((resolve) => (entered = resolve))
      const running = runTask({
        ...scripted(session, async () => {
          if (release !== null) return
          counterWhileHeld = await probeCount(session)
          entered()
          await new Promise<void>((resolve) => (release = resolve))
        }),
      })

      // The run is held now, in front of its first click; the page is read while it waits,
      // then released — the click must land only after that.
      await held
      expect(counterWhileHeld).toBe(0)
      release!()
      const result = await running

      try {
        expect(counterWhileHeld).toBe(0)
        expect(result.status).toBe('done')
        expect(result.steps).toBe(1)
        expect(await probeCount(session)).toBe(1)
      } finally {
        rmSync(result.recordDir, { recursive: true, force: true })
        await session.close()
      }
    },
    120_000,
  )

  it(
    'stops without delivering the action it was held in front of',
    async () => {
      // Stopping from the inspector is cancellation, not a nudge: the action the run was held
      // in front of must never land on the page.
      const session = await BrowserSession.open(fixtureUrl, { cdpUrl: process.env.JEV_CDP_URL })
      const controller = new AbortController()
      const held: Array<{ step: number; action: string }> = []
      const result = await runTask({
        ...scripted(session, async (info) => {
          held.push(info)
          controller.abort()
        }),
        signal: controller.signal,
      })

      try {
        expect(held).toEqual([{ step: 1, action: 'Add one' }])
        expect(result.status).toBe('blocked')
        expect(result.reason).toBe('任务已被取消')
        expect(await probeCount(session)).toBe(0)
      } finally {
        rmSync(result.recordDir, { recursive: true, force: true })
        await session.close()
      }
    },
    120_000,
  )
})
