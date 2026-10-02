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
import { createServer } from 'node:http'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { TargetCovered, act } from '../src/browser/act'
import { readPage } from '../src/browser/read'
import { BrowserSession, StalePage, type PageState, type SnapshotAction } from '../src/browser/session'
import type { Decision } from '../src/decision/typesafe'
import { runTask, type TaskDeps, type TaskResult } from '../src/loop'

const enabled = process.env.JEV_BROWSER === '1'
const fixtureUrl = pathToFileURL(fileURLToPath(new URL('./fixture/probe.html', import.meta.url))).href
const longUrl = pathToFileURL(fileURLToPath(new URL('./fixture/long.html', import.meta.url))).href
const lateUrl = pathToFileURL(fileURLToPath(new URL('./fixture/late.html', import.meta.url))).href
const challengeUrl = pathToFileURL(fileURLToPath(new URL('./fixture/challenge.html', import.meta.url))).href
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

  it('refuses a target that is covered by another element, and says what covered it', async () => {
    const page = await session.observe()
    const covered = byLabel(page, 'Covered button')
    // Observed, because it is a visible control in the viewport...
    expect(covered).toBeDefined()
    // ...but not executable, because the hit test at its centre lands elsewhere. The refusal is the
    // stale-page one every caller already re-observes for, narrowed to the case that has a culprit,
    // and it names the culprit: the fixture covers the button with `#veil`, an empty `<span>` with
    // no role and no words, which is still the element the click would have landed on.
    const refusal = await act(session, page, covered!).then(
      () => null,
      (error: unknown) => error,
    )
    expect(refusal).toBeInstanceOf(TargetCovered)
    expect(refusal).toBeInstanceOf(StalePage)
    const message = refusal instanceof Error ? refusal.message : ''
    expect(message).toContain('盖住了')
    expect(message).toContain('SPAN')
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

  it('names a human-verification page, and is not troubled by a frame it may not read', async () => {
    // The two halves of the page-side check only meet a real browser here: `innerText` and the
    // selectors as Chromium answers them, and the frame the fixture carries, whose document this page
    // is refused — as `null` on Edge, measured 2026-10-02, which is the shape Chromium uses for a read
    // across origins. The check skips it and names the page anyway. `tests/challenge.test.ts` pins the
    // same answers against a stand-in document, plus the two shapes no page here produces: a frame
    // whose read throws, and one that really is readable.
    await session.call('Page.navigate', { url: challengeUrl })
    const page = await session.observe()

    expect(page.challenge).toEqual({
      kind: 'cloudflare',
      reason: 'Cloudflare interstitial ("Just a moment")',
    })
    // The observation still read the page it was on: a challenge is never a reason for one to fail.
    expect(page.title).toBe('Just a moment...')
    expect(page.text).toContain('Verifying you are human')
    // And a page that offers nothing to act on is the shape the loop stops on, rather than one more
    // page to guess at (`challengeStopping` in `src/loop.ts`).
    expect(page.actions.some((action) => action.kind === 'click')).toBe(false)

    // Back on an ordinary fixture, the field is absent rather than present and empty.
    await session.call('Page.navigate', { url: fixtureUrl })
    const ordinary = await session.observe()
    expect(ordinary.challenge).toBeUndefined()
    expect(Object.keys(ordinary)).not.toContain('challenge')
  })
})

/**
 * The one click this plugin always sends: the first click of a tab that has never been touched.
 *
 * The sibling implementation (`dsh-browser`, on an Electron view) puts the pointer on the target first
 * because Chromium routes a synthesised press to the control the view is *currently* hovering rather
 * than to whatever sits at the coordinates — a view that has never received a mouse event has no hover
 * target, and there the first press of a fresh tab went nowhere while CDP still answered success.
 * Every click this plugin sends is that first one, on a tab it has just opened, which is why these two
 * tests exist: they drive exactly that click for real and check the page it was aimed at.
 *
 * What they measured on 2026-10-02 (raw CDP, Edge): the click landed both ways. Two runs of this whole
 * file with the `mouseMoved` dispatch in `act.ts` (19 tests each) and four runs of these two tests with
 * it commented out all passed, so the move is not what rescues the click on this path — the tests stay
 * because the click they drive is the one under every real run, and a version of it that stopped
 * landing would show up here first.
 */
describe.skipIf(!enabled)('the first click in a tab that has never seen a mouse event', () => {
  it(
    'lands it, and the page really changes',
    async () => {
      // A tab of this test's own, opened and never clicked in: nothing before this point has sent
      // the view a mouse event, which is exactly the state the plugin's every click starts from.
      const fresh = await BrowserSession.open(fixtureUrl, { cdpUrl: process.env.JEV_CDP_URL })
      try {
        const before = await fresh.observe()
        const button = byLabel(before, 'Add one')
        expect(button).toBeDefined()
        expect(await fresh.evaluate<number>('window.__probeCount()')).toBe(0)

        const result = await act(fresh, before, button!)

        expect(result.executed).toBe(button!.id)
        expect(await fresh.evaluate<number>('window.__probeCount()')).toBe(1)
        expect(await fresh.evaluate<string>('document.getElementById("counter").textContent')).toBe('1')
        const after = await fresh.observe()
        expect(after.fingerprint).not.toBe(before.fingerprint)
      } finally {
        await fresh.close()
      }
    },
    60_000,
  )

  it(
    'opens the window the link asked for',
    async () => {
      const fresh = await BrowserSession.open(fixtureUrl, { cdpUrl: process.env.JEV_CDP_URL })
      try {
        const before = await fresh.observe()
        const link = byLabel(before, 'Open a second page')
        expect(link?.kind).toBe('click')

        await act(fresh, before, link!)

        const found = await fresh.adoptNewPage({ onlyIfSameUrl: true })
        expect(found?.appeared.length).toBeGreaterThan(0)
        expect(found?.adopted?.url.endsWith('newtab.html')).toBe(true)
      } finally {
        await fresh.close()
      }
    },
    60_000,
  )
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

describe.skipIf(!enabled)('a step that lands in the same tab', () => {
  /**
   * 豆瓣读书, 2026-10-02 (run-1790941414586-t83x): the 「搜索」 click landed in the tab the run was
   * already on, and the run ended on 「结果：出错了（页面正在跳转）」 with the results page never seen.
   * The state it died in is a document whose body has not arrived yet — `browser/snapshot.ts` answers
   * `null` while `document.body` does not exist, and `browser/session.ts` turns that into a
   * `StalePage`. A page whose head is committed while its body is held back holds a run in exactly
   * that state for as long as it likes, which is what makes it testable here; a real site only does it
   * for as long as its own network takes, which is why this was found on a search that took a moment.
   *
   * Both halves of the rule are pinned below: a jump that lasts a moment costs the run a few looks and
   * nothing else, and one that never ends still stops it on the same words, at the same count.
   */
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

  /**
   * A server whose `/slow` commits its head at once and holds its body back for `stallMs`, so the run
   * that lands there is on a document that exists with no body in it yet.
   */
  async function servingLateBody(stallMs: number): Promise<{ url: string; close: () => Promise<void> }> {
    const timers = new Set<NodeJS.Timeout>()
    const server = createServer((_request, response) => {
      if ((_request.url ?? '').startsWith('/slow')) {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        response.write('<!doctype html><html><head><title>慢</title></head>')
        const timer = setTimeout(() => {
          timers.delete(timer)
          response.end('<body><h1>到了</h1></body></html>')
        }, stallMs)
        timers.add(timer)
        return
      }
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end('<!doctype html><html><body><a id="go" href="/slow">去下一页</a></body></html>')
    })
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
    const address = server.address()
    const port = typeof address === 'object' && address !== null ? address.port : 0
    return {
      url: `http://127.0.0.1:${port}/`,
      close: async () => {
        for (const timer of timers) clearTimeout(timer)
        timers.clear()
        server.closeAllConnections()
        await new Promise<void>((done) => server.close(() => done()))
      },
    }
  }

  /**
   * Click the link the first page offers, then finish; every page the run was working on is recorded,
   * so the test can say which page the run's last answer was about. The page it lands on has no link,
   * so nothing is clicked a second time however the timing goes.
   */
  function clickThroughOnce(asked: string[]): TaskDeps['decide'] {
    return async (_source, space, context) => {
      asked.push(context.page.url)
      const index = space.elements.find((element) => element.label.includes('去下一页'))?.index ?? ''
      const id = space.targets.CLICK?.[index]?.id
      if (id === undefined) return terminal
      return { ...terminal, choice: id, operation: 'CLICK', target: index, probabilities: { [id]: 0.9 } }
    }
  }

  /**
   * The same session, with the loop's closing of it skipped: a run closes the browser it was handed,
   * which is right for a tool and unhelpful for a test that reads the page after the run.
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

  /** The tab's own body text, read from the page rather than from the run's record of it. */
  async function bodyText(session: BrowserSession): Promise<string> {
    const answer = (await session.call('Runtime.evaluate', {
      expression: 'document.body ? document.body.innerText : ""',
      returnByValue: true,
    })) as { result?: { value?: unknown } }
    return typeof answer.result?.value === 'string' ? answer.result.value : ''
  }

  /** One run over the late-body pages, with the session and the server left open for the caller. */
  async function runOnto(
    stallMs: number,
  ): Promise<{ result: TaskResult; asked: string[]; read: () => Promise<string>; done: () => Promise<void> }> {
    const asked: string[] = []
    const serving = await servingLateBody(stallMs)
    const session = await BrowserSession.open(serving.url, { cdpUrl: process.env.JEV_CDP_URL })
    try {
      const result = await runTask({
        goal: '打开下一页',
        startUrl: serving.url,
        decision: { endpoint: 'https://decisions.test/v1', apiKey: '', model: 'scripted' },
        text: { baseUrl: '', apiKey: '', model: 'scripted', reasoning: 'none' as const },
        screenshots: false,
        maxSteps: 3,
        deps: { open: async () => keepOpen(session), decide: clickThroughOnce(asked) },
      })
      return {
        result,
        asked,
        read: () => bodyText(session),
        done: async () => {
          await session.close()
          await serving.close()
        },
      }
    } catch (error) {
      await session.close()
      await serving.close()
      throw error
    }
  }

  it(
    'waits a moment of it out and finishes on the page it was going to',
    async () => {
      // The body arrives 5.6 seconds in, which is where this hurts and where it is worth pinning: the
      // run's own settle waits `#waitForLoad`'s five seconds out first (the document never reaches
      // `complete` without a body), so the observation that follows is the one that meets the jump.
      // A body that arrived sooner than that would be waited out by the settle and prove nothing.
      const run = await runOnto(5_600)
      try {
        expect(run.result.status).toBe('done')
        expect(run.result.reason).toBe('')
        // The click is the run's only step, and it is kept.
        expect(run.result.steps).toBe(1)
        // Two answers were asked for, and the second one was asked about the page the run was trying
        // to reach — not about the page it started on, which is where a run that died on the jump
        // never got past.
        expect(run.asked).toHaveLength(2)
        expect(run.asked[1]).toContain('/slow')
        // And the tab really is that document, body and all.
        await expect(run.read()).resolves.toContain('到了')
      } finally {
        await run.done()
      }
    },
    120_000,
  )

  it(
    'still stops when the body never arrives, on the same words',
    async () => {
      // The same page with a body that never comes: nothing here is a matter of timing, so this is
      // also what says the state above is real rather than missed. The run is allowed its looks, all
      // seven of them, and then ends on the words it always ended on.
      const run = await runOnto(30_000)
      try {
        expect(run.result.status).toBe('failed')
        expect(run.result.reason).toBe('页面正在跳转')
        // What happened before the stop is kept: the click is still a step the run took.
        expect(run.result.steps).toBe(1)
      } finally {
        await run.done()
      }
    },
    120_000,
  )
})
