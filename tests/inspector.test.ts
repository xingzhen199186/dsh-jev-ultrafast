import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { AdoptResult, BrowserPort, PageState, SnapshotAction } from '../src/browser/session'
import type { Config as ConfigShape } from '../src/config'
import type { Decision } from '../src/decision/typesafe'
import { createInspector } from '../src/inspector'
import { inspectorPage } from '../src/inspector-page'
import { runTask, type LoopEvent, type TaskDeps } from '../src/loop'

/**
 * The inspector's own seams.
 *
 * Two different things are pinned here. The route half is exercised through a stub request and
 * response against a run directory this file fabricates — that is what the review view reads,
 * so a frame name or a trace line going wrong is caught without a browser. The hold half drives
 * the real loop with scripted page states, because "cancelled while paused must not act" is a
 * property of the loop, not of the page.
 */

const ARTIFACTS = join(tmpdir(), 'dsh-jev-ultrafast')
const TOKEN = 'test-token'
const RUN = 'run-1700000000000-tst1'
const created: string[] = []

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A run directory shaped exactly like the one `openArtifacts` writes. */
function fakeRun(): string {
  const dir = join(ARTIFACTS, RUN)
  created.push(dir)
  mkdirSync(join(dir, 'frames'), { recursive: true })
  writeFileSync(join(dir, 'frames', '000000.jpg'), Buffer.from([0xff, 0xd8, 1, 2, 3]))
  writeFileSync(join(dir, 'frames', '001500.jpg'), Buffer.from([0xff, 0xd8, 4, 5, 6]))
  writeFileSync(
    join(dir, 'frames.json'),
    JSON.stringify({
      frames: [
        { file: '000000.jpg', at_ms: 0 },
        { file: '001500.jpg', at_ms: 1500 },
      ],
      run_ms: 1500,
    }),
  )
  writeFileSync(
    join(dir, 'trace.jsonl'),
    [
      JSON.stringify({ at: 1700000000000, kind: 'decision', url: 'https://x.test/v1', status: 200, attempt: 0, took_ms: 800 }),
      JSON.stringify({ at: 1700000000500, kind: 'text', door: 'preset', url: 'https://t.test/v1', status: 200, took_ms: 300 }),
      // A step that opened a window, once without the run moving onto it and once with — the two
      // cases the tab record is written for.
      JSON.stringify({ at: 1700000000800, kind: 'follow', step: 1, new_tabs: ['https://ads.test/popup'], followed_tab: null }),
      JSON.stringify({ at: 1700000001200, kind: 'follow', step: 2, new_tabs: ['https://example.test/two'], followed_tab: 'https://example.test/two' }),
      JSON.stringify({ at: 1700000001500, kind: 'run', status: 'done', reason: '', steps: 2, decisions: 3, elapsed_ms: 1500 }),
    ].join('\n') + '\n',
  )
  return dir
}

interface Reply {
  status: number
  headers: Record<string, string>
  body: string
  bytes: Buffer
}

function inspector() {
  return createInspector({} as Context, {} as ConfigShape, {} as never)
}

async function ask(
  path: string,
  options: { method?: string; token?: string; body?: unknown } = {},
): Promise<Reply> {
  const token = 'token' in options ? options.token : TOKEN
  // The route is handed the pathname alone, exactly as the settings route hands it over; the
  // query stays in the URL, which is where the handlers read it from.
  const [pathname = '', query = ''] = path.split('?')
  const req = {
    method: options.method ?? 'GET',
    url: `/jev-ultrafast/inspector${pathname}${query ? `?${query}` : ''}`,
    headers: token === undefined ? {} : { 'x-jev-ultrafast-token': token },
    async *[Symbol.asyncIterator]() {
      if (options.body !== undefined) yield Buffer.from(JSON.stringify(options.body))
    },
  } as unknown as IncomingMessage
  const parts: Buffer[] = []
  const headers: Record<string, string> = {}
  const res = {
    statusCode: 200,
    setHeader(name: string, value: string) {
      headers[name.toLowerCase()] = String(value)
    },
    end(chunk?: unknown) {
      if (chunk !== undefined && chunk !== null) parts.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
    },
  } as unknown as ServerResponse
  await inspector().handle(pathname, req, res, TOKEN, token ?? '')
  const bytes = Buffer.concat(parts)
  return { status: res.statusCode, headers, body: bytes.toString('utf8'), bytes }
}

describe('the inspector page', () => {
  it('is served without a token, and carries the token the page will need', async () => {
    const reply = await ask('/', { token: undefined })

    expect(reply.status).toBe(200)
    expect(reply.headers['content-type']).toContain('text/html')
    expect(reply.body).toContain('交互式检查器')
    // The token has to reach the page somehow, and this document is the only way it can.
    expect(reply.body).toContain(TOKEN)
    expect(reply.body).toContain('单步')
  })

  it('refuses every other route without the token', async () => {
    const reply = await ask('/state', { token: 'wrong' })

    expect(reply.status).toBe(403)
    expect(JSON.parse(reply.body).error).toContain('令牌')
  })

  it('ships a page whose script parses', () => {
    // A script that does not parse is a blank page, and nothing else here would notice: the
    // document would still be served with a 200 and all the right words in its markup.
    const script = /<script>([\s\S]*)<\/script>/.exec(inspectorPage(TOKEN))?.[1] ?? ''

    expect(script.length).toBeGreaterThan(500)
    expect(() => new Function(script)).not.toThrow()
    // The page has to be able to reach the routes it talks to.
    expect(script).toContain('x-jev-ultrafast-token')
    expect(script).not.toContain('__TOKEN__')
  })

  it('says nothing has run yet, rather than failing', async () => {
    const reply = await ask('/state')
    const state = JSON.parse(reply.body)

    expect(reply.status).toBe(200)
    expect(state.state).toBe('未开始')
    expect(state.running).toBe(false)
    expect(state.frame).toBeNull()
    expect(Array.isArray(state.runs)).toBe(true)
  })

  it('lists a recorded run, reads its trace back, and serves its frames', async () => {
    fakeRun()

    const listed = JSON.parse((await ask('/state')).body)
    const summary = (listed.runs as Array<{ name: string; label: string }>).find((run) => run.name === RUN)
    expect(summary?.label).toContain('2 帧')
    expect(summary?.label).toContain('1.5 秒')

    const run = JSON.parse((await ask(`/run?run=${RUN}`)).body)
    expect(run.frames.map((frame: { file: string }) => frame.file)).toEqual(['000000.jpg', '001500.jpg'])
    expect(run.trace).toHaveLength(5)
    // Each line is a sentence about one real round trip; the raw record stays next to it.
    expect(run.trace[0].line).toContain('决策请求 → HTTP 200')
    expect(run.trace[0].raw.kind).toBe('decision')
    expect(run.trace[1].line).toContain('文本模型请求（预设供应商）')
    // The tab record is a kind of its own, and a reader gets a sentence for it rather than the raw
    // record: which step opened a window, and whether the run went there.
    expect(run.trace[2].line).toContain('第 1 步开出了新页面：没有跟过去')
    expect(run.trace[2].line).not.toContain('new_tabs')
    expect(run.trace[3].line).toContain('第 2 步开出了新页面：跟过去了')
    expect(run.trace[4].line).toContain('本次运行结束：done')

    const frame = await ask(`/frame?run=${RUN}&file=001500.jpg`)
    expect(frame.status).toBe(200)
    expect(frame.headers['content-type']).toBe('image/jpeg')
    expect(frame.bytes).toEqual(readFileSync(join(ARTIFACTS, RUN, 'frames', '001500.jpg')))
  })

  it('reads frames named by step, and hands the step and action on to the page', async () => {
    // The reader's question is "what did step 3 look like", so the step has to survive the trip
    // from disk to the page. A run recorded before frames were named by step is still readable:
    // the test above reads exactly that one.
    const dir = join(ARTIFACTS, RUN)
    created.push(dir)
    mkdirSync(join(dir, 'frames'), { recursive: true })
    writeFileSync(join(dir, 'frames', 'step-000-start.jpg'), Buffer.from([0xff, 0xd8, 1, 2, 3]))
    writeFileSync(join(dir, 'frames', 'step-001-press.jpg'), Buffer.from([0xff, 0xd8, 4, 5, 6]))
    writeFileSync(
      join(dir, 'frames.json'),
      JSON.stringify({
        frames: [
          { file: 'step-000-start.jpg', step: 0, action: 'start', at_ms: 0 },
          { file: 'step-001-press.jpg', step: 1, action: 'press', at_ms: 900 },
        ],
        run_ms: 900,
      }),
    )

    const run = JSON.parse((await ask(`/run?run=${RUN}`)).body)
    expect(run.frames).toEqual([
      { file: 'step-000-start.jpg', step: 0, action: 'start', at_ms: 0 },
      { file: 'step-001-press.jpg', step: 1, action: 'press', at_ms: 900 },
    ])

    const frame = await ask(`/frame?run=${RUN}&file=step-001-press.jpg`)
    expect(frame.status).toBe(200)
    expect(frame.headers['content-type']).toBe('image/jpeg')
    expect(frame.bytes).toEqual(readFileSync(join(ARTIFACTS, RUN, 'frames', 'step-001-press.jpg')))
  })

  it('only serves names the writer itself would produce', async () => {
    fakeRun()

    // A frame name is the only thing between a route and the disk, so anything not of the
    // written form is refused before a path is built from it.
    expect((await ask(`/frame?run=${RUN}&file=${encodeURIComponent('../../secret.jpg')}`)).status).toBe(400)
    expect((await ask(`/frame?run=${RUN}&file=000000.png`)).status).toBe(400)
    // A step-named frame is held to the same rule as the millisecond one it replaced: the step
    // pads to three digits, the action is lowercase, and nothing else gets past the pattern.
    expect((await ask(`/frame?run=${RUN}&file=step-01-press.jpg`)).status).toBe(400)
    expect((await ask(`/frame?run=${RUN}&file=${encodeURIComponent('step-001-press.jpg/../../secret')}`)).status).toBe(400)
    expect((await ask('/frame?run=../..&file=000000.jpg')).status).toBe(400)
    expect((await ask('/run?run=run-1-x')).status).toBe(400)
    expect((await ask('/run?run=' + encodeURIComponent('../../..'))).status).toBe(400)
    expect((await ask('/nope')).status).toBe(404)
  })

  it('wants a goal and an address, and a run to control', async () => {
    const started = await ask('/start', { method: 'POST', body: { goal: '', url: '' } })
    expect(started.status).toBe(400)
    expect(JSON.parse(started.body).error).toContain('起始网址')

    const controlled = await ask('/control', { method: 'POST', body: { action: 'pause' } })
    expect(controlled.status).toBe(409)
    expect(JSON.parse(controlled.body).error).toContain('没有在跑的运行')

    expect((await ask('/start')).status).toBe(405)
  })
})

/** A page with one button on it, and a decision script that always presses it. */
function page(fingerprint: string): PageState {
  const actions: SnapshotAction[] = [{ id: 'e1', kind: 'click', node: 1, label: 'Next' }]
  return {
    url: 'https://example.test/',
    title: 'Test',
    w: 1120,
    h: 780,
    text: 'body',
    scroll: { y: 0, height: 1000 },
    actions,
    marker: fingerprint,
    page_key: [],
    guards: {},
    omitted_actions: 0,
    fingerprint,
  }
}

function decision(choice: string): Decision {
  return {
    choice,
    operation: choice === 'DONE' ? 'DONE' : 'CLICK',
    target: choice === 'DONE' ? null : '1',
    confidence: 0.9,
    probabilities: { [choice]: 0.9 },
    operationProbabilities: { CLICK: 0.9 },
    targetProbabilities: { '1': 0.9 },
    targetConfidence: 0.9,
    usage: {},
    model: 'fake',
    latencyMs: 1,
  }
}

function scripted(choices: string[], executed: SnapshotAction[]): TaskDeps {
  const browser: BrowserPort = {
    async call<T>(): Promise<T> {
      return undefined as T
    },
    async observe(): Promise<PageState> {
      return page('f1')
    },
    async fresh(): Promise<boolean> {
      return true
    },
    noteInput(): void {},
    async close(): Promise<void> {},
  }
  let index = 0
  return {
    open: async () => browser,
    decide: async () => decision(choices[index++] ?? 'DONE'),
    typeText: async () => ({ text: 'x', model: 'fake', latencyMs: 1, usage: {} }),
    execute: async (_session, _page, action) => {
      executed.push(action)
      return { executed: action.id }
    },
  }
}

const decisionSource = { endpoint: 'https://decisions.test/v1', apiKey: 'k', model: 'm' }
const textSource = { baseUrl: 'https://text.test/v1', apiKey: 'k', model: 'm', reasoning: 'none' as const }

describe('the hold the inspector pauses on', () => {
  it('is asked once per action, before anything is clicked, and never for the last answer', async () => {
    const executed: SnapshotAction[] = []
    const held: Array<{ step: number; action: string }> = []
    let release: (() => void) | null = null

    const running = runTask({
      goal: 'go',
      startUrl: 'https://example.test/',
      decision: decisionSource,
      text: textSource,
      deps: scripted(['e1', 'DONE'], executed),
      gate: async (info) => {
        held.push(info)
        // The first step is held until this test lets it go; nothing may have run yet.
        if (held.length === 1) await new Promise<void>((resolve) => (release = resolve))
      },
    })

    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(held).toEqual([{ step: 1, action: 'Next' }])
    expect(executed).toEqual([])

    release!()
    const result = await running
    expect(result.steps).toBe(1)
    expect(executed.map((action) => action.id)).toEqual(['e1'])
  })

  it('does not act on an action it was held in front of when the run is cancelled', async () => {
    const executed: SnapshotAction[] = []
    const controller = new AbortController()

    const result = await runTask({
      goal: 'go',
      startUrl: 'https://example.test/',
      decision: decisionSource,
      text: textSource,
      signal: controller.signal,
      deps: scripted(['e1'], executed),
      gate: async () => {
        controller.abort()
      },
    })

    expect(executed).toEqual([])
    expect(result.status).toBe('blocked')
    expect(result.reason).toBe('任务已被取消')
  })

  it('says where its frames are going while the run is still going', async () => {
    const events: LoopEvent[] = []
    const executed: SnapshotAction[] = []

    const result = await runTask({
      goal: 'go',
      startUrl: 'https://example.test/',
      decision: decisionSource,
      text: textSource,
      deps: scripted(['DONE'], executed),
      record: true,
      screenshots: false,
      onEvent: (event) => events.push(event),
    })

    const recording = events.find((event) => event.type === 'recording')
    expect(recording).toBeDefined()
    const dir = (recording as { dir: string }).dir
    created.push(dir)
    expect(existsSync(dir)).toBe(true)
    // No screenshots means no frames, but the trace of the run is always there.
    expect(existsSync(join(dir, 'trace.jsonl'))).toBe(true)
    expect(result.recordDir).toBe(dir)
  })
})
