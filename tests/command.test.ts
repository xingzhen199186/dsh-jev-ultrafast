import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import {
  COMMAND_NAME,
  DEFINITION_ID,
  INSPECTOR_URL,
  helpText,
  parseInput,
  registerCommand,
  summaryText,
  type RunStarter,
} from '../src/command'
import type { Config as ConfigShape } from '../src/config'
import type { HistoryEntry } from '../src/decision/typesafe'
import type { TaskResult } from '../src/loop'
import type { Verification } from '../src/verify'

/**
 * The command's own half: the name DSH is handed, what a typed line means, and what happens to
 * a run that takes minutes. The run itself is started through a parameter, so none of this needs
 * a browser; the loop is covered where the loop is.
 */

/** The registry's own grammar, quoted from `@deepseek-ai/dsh-commands` (`COMMAND_NAME`). */
const COMMAND_NAME_PATTERN = /^[a-z][a-z0-9_-]*$/u

function entry(overrides: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    step: 1,
    action: 'Next',
    kind: 'click',
    choice: 'e1',
    probability: 0.9,
    confidence: 0.9,
    latency_ms: 500,
    text: null,
    text_helper: null,
    text_latency_ms: 0,
    operation: 'click',
    target: null,
    page_changed: true,
    url: 'https://example.test/',
    usage: {},
    executed_ms: 1000,
    elapsed_ms: 1000,
    ...overrides,
  }
}

function verification(overrides: Partial<Verification> = {}): Verification {
  return { checked: false, passed: true, items: [], note: '没有写必须出现的内容，所以结果没被核验。', ...overrides }
}

function result(overrides: Partial<TaskResult> = {}): TaskResult {
  return {
    goal: '找到价格并说明是多少',
    status: 'done',
    reason: '',
    elapsedMs: 42000,
    steps: 2,
    decisions: 2,
    history: [entry(), entry({ step: 2, action: 'DONE', kind: 'done' })],
    textCalls: [],
    reasks: [],
    sentElements: 0,
    omittedElements: 0,
    textCut: 0,
    follows: [],
    deadEnds: [],
    deadEndsExcluded: false,
    verification: verification(),
    pageNote: '',
    omittedActions: 0,
    screenshot: null,
    recordDir: 'C:\\Temp\\dsh-jev-ultrafast\\run-1-abcd',
    page: { url: 'https://example.test/price', title: '价格页', text: '价格 12 元' },
    elements: [],
    ...overrides,
  }
}

interface Registered {
  definitionId: string
  name: string
  description: string
  input: { hint: string }
  handler: (invocation: { agent: { id: string }; rawInput: string; signal?: AbortSignal }) => Promise<{
    kind: string
    text: string
  }>
}

interface FakeCtx {
  ctx: Context
  registered: Registered[]
  disposed: number[]
  effects: string[]
  tearDown: () => void
}

function fakeCtx(options: { injectable?: boolean; commands?: boolean; jobs?: unknown } = {}): FakeCtx {
  const registered: Registered[] = []
  const disposed: number[] = []
  const effects: string[] = []
  const disposers: Array<() => void> = []
  let counter = 0
  const ctx = {
    ...(options.injectable === false
      ? {}
      : {
          inject(_keys: string[], callback: (inner: unknown) => void) {
            callback({
              commands:
                options.commands === false
                  ? undefined
                  : {
                      register(definition: Registered) {
                        registered.push(definition)
                        const id = counter++
                        return () => disposed.push(id)
                      },
                    },
            })
          },
        }),
    effect(callback: () => () => void, label?: string) {
      effects.push(label ?? '')
      const dispose = callback()
      if (typeof dispose === 'function') disposers.push(dispose)
    },
    get(name: string) {
      return name === 'jobs' ? options.jobs : undefined
    },
  }
  return {
    ctx: ctx as unknown as Context,
    registered,
    disposed,
    effects,
    tearDown: () => {
      for (const dispose of disposers.splice(0)) dispose()
    },
  }
}

interface JobSpec {
  kind: string
  label: string
  owner?: string
  run: (job: { updateProgress?: (line: string) => void }) => {
    cancel: (reason?: string) => void
    done: Promise<{ status: string; detail?: string }>
  }
}

function fakeJobs(options: { throws?: string } = {}) {
  const specs: JobSpec[] = []
  const registry = {
    start(spec: JobSpec) {
      if (options.throws !== undefined) throw new Error(options.throws)
      specs.push(spec)
      return `jev-${specs.length}`
    },
  }
  return { specs, registry }
}

function invoke(input: string, signal?: AbortSignal) {
  return { agent: { id: 'session-1' }, rawInput: input, signal }
}

describe('the name and shape DSH is handed', () => {
  it('registers one command whose name the registry would accept', () => {
    const harness = fakeCtx()
    registerCommand(harness.ctx, {} as ConfigShape, {} as never, async () => ({ ok: true, result: result(), note: '' }))

    expect(harness.registered).toHaveLength(1)
    const definition = harness.registered[0]!
    expect(definition.name).toBe(COMMAND_NAME)
    expect(definition.name).toMatch(COMMAND_NAME_PATTERN)
    expect(definition.definitionId).toBe(DEFINITION_ID)
    expect(definition.description.trim().length).toBeGreaterThan(0)
    expect(definition.input.hint.trim().length).toBeGreaterThan(0)
    expect(typeof definition.handler).toBe('function')
  })

  it('is taken back when the plugin is disposed', () => {
    const harness = fakeCtx()
    registerCommand(harness.ctx, {} as ConfigShape, {} as never, async () => ({ ok: true, result: result(), note: '' }))

    expect(harness.effects).toEqual(['dsh-jev-ultrafast: human command'])
    expect(harness.disposed).toEqual([])
    harness.tearDown()
    expect(harness.disposed).toEqual([0])
  })

  it('registers nothing where there is no command registry, and does not throw', () => {
    const withoutRegistry = fakeCtx({ commands: false })
    const withoutInject = fakeCtx({ injectable: false })

    expect(() =>
      registerCommand(withoutRegistry.ctx, {} as ConfigShape, {} as never, async () => ({ ok: true, result: result(), note: '' })),
    ).not.toThrow()
    expect(() =>
      registerCommand(withoutInject.ctx, {} as ConfigShape, {} as never, async () => ({ ok: true, result: result(), note: '' })),
    ).not.toThrow()
    expect(withoutRegistry.registered).toEqual([])
    expect(withoutInject.registered).toEqual([])
  })
})

describe('what a typed line means', () => {
  it('is help when nothing follows the name', () => {
    expect(parseInput('')).toEqual({ kind: 'help' })
    expect(parseInput('   ')).toEqual({ kind: 'help' })
    expect(parseInput('\t \n')).toEqual({ kind: 'help' })
  })

  it('is a run when a page to open is followed by a goal', () => {
    expect(parseInput(' https://example.test/a 找到价格 ')).toEqual({
      kind: 'run',
      url: 'https://example.test/a',
      goal: '找到价格',
    })
    // The goal keeps its inner spacing: it is one sentence, not a list of words.
    expect(parseInput('https://example.test 找出 价格 并说明 是多少')).toEqual({
      kind: 'run',
      url: 'https://example.test',
      goal: '找出 价格 并说明 是多少',
    })
    expect(parseInput('HTTP://example.test/a 点开登录')).toEqual({
      kind: 'run',
      url: 'HTTP://example.test/a',
      goal: '点开登录',
    })
  })

  it('finds the address wherever it stands in the sentence', () => {
    // People say what they want first and name the address second, or put it in the middle.
    expect(parseInput('帮我打开 https://example.test/a 看看价格')).toEqual({
      kind: 'run',
      url: 'https://example.test/a',
      goal: '帮我打开 看看价格',
    })
    // The punctuation that separated the two goes with the address it separated.
    expect(parseInput('到 https://example.test/a。看看价格')).toEqual({
      kind: 'run',
      url: 'https://example.test/a',
      goal: '到 看看价格',
    })
  })

  it('takes a bare domain as an address and gives it a scheme', () => {
    expect(parseInput('打开 example.com 看看价格')).toEqual({
      kind: 'run',
      url: 'https://example.com',
      goal: '打开 看看价格',
    })
    // Chinese is written without spaces, so the address sits inside the sentence.
    expect(parseInput('打开example.com看看价格')).toEqual({
      kind: 'run',
      url: 'https://example.com',
      goal: '打开 看看价格',
    })
  })

  it('hands a sentence that names no address on, instead of refusing it', () => {
    expect(parseInput('找到价格并说明是多少')).toEqual({
      kind: 'resolve',
      text: '找到价格并说明是多少',
    })
    expect(parseInput(' 上百度查一下明天北京的天气 ')).toEqual({
      kind: 'resolve',
      text: '上百度查一下明天北京的天气',
    })
    // A number with a dot in it is not a site, so this is a question for the text model too.
    expect(parseInput('看看是不是 3.5 折')).toEqual({ kind: 'resolve', text: '看看是不是 3.5 折' })
  })

  it('says what is missing when the address is the whole line', () => {
    const noGoal = parseInput('https://example.test')
    expect(noGoal.kind).toBe('error')
    expect(noGoal.kind === 'error' && noGoal.text).toContain('目标')
  })

  it('tells the reader how to use it and where the pictures are', () => {
    const text = helpText()
    expect(text).toContain(`/${COMMAND_NAME}`)
    expect(text).toContain('网址可有可无')
    expect(text).toContain(INSPECTOR_URL)
  })
})

describe('what the reader is told afterwards', () => {
  it('reads a finished run back in their language', () => {
    const text = summaryText(result(), 'https://example.test')
    expect(text).toContain('结果：完成')
    expect(text).toContain('执行 2 步、2 次决策，用时 42.0 秒')
    expect(text).toContain('最后停在：价格页 — https://example.test/price')
    expect(text).toContain('页面上读到的内容（节选）：\n价格 12 元')
    expect(text).toContain('1. Next')
    expect(text).toContain('2. DONE')
    expect(text).toContain('run-1-abcd')
  })

  it('quotes the page back, trimmed, and says when there is more of it', () => {
    const long = '甲'.repeat(900) + '乙'
    const text = summaryText(result({ page: { url: 'https://example.test/p', title: '长页', text: long } }), 'https://example.test')

    expect(text).toContain('甲'.repeat(900))
    expect(text).not.toContain('乙')
    expect(text).toContain('后面还有')
  })

  it('says so when a run left no pictures, and stays quiet when it did', () => {
    expect(summaryText(result(), 'https://example.test')).toContain('没有逐帧画面')
    const withPicture = summaryText(result({ screenshot: 'aGVsbG8=' }), 'https://example.test')
    expect(withPicture).not.toContain('没有逐帧画面')
  })

  it('passes on the run\'s own note about a page it could only partly see', () => {
    const note = '这个页面的主要内容在嵌套的框架里（1 个 iframe），插件看不到里面的内容，所以这里推不动。'
    const text = summaryText(result({ pageNote: note }), 'https://example.test')

    expect(text).toContain(note)
    // Nothing to say about an ordinary page: the line does not appear at all.
    expect(summaryText(result(), 'https://example.test')).not.toContain('嵌套的框架')
  })

  it('says which elements it judged dead ends, and whether they were taken out', () => {
    // The judgement is recorded whether or not it was acted on, so with the removal off — the default —
    // this line is the only place the reader sees it at all. Which of the two happened is part of it.
    const judged = [{ step: 2, element: '4', target: '4:enter', label: '搜索' }]
    const kept = summaryText(result({ deadEnds: judged }), 'https://example.test')
    expect(kept).toContain('本次识别到 1 个死路（未排除，仍照原样交给决策服务）')
    expect(kept).toContain('第 2 步的 [4]「搜索」')

    const removed = summaryText(result({ deadEnds: judged, deadEndsExcluded: true }), 'https://example.test')
    expect(removed).toContain('本次识别到 1 个死路（已排除，不再交给决策服务）')

    // A run that judged none says nothing about them, which is the ordinary run.
    expect(summaryText(result(), 'https://example.test')).not.toContain('死路')
  })

  it('says what the run was stopped by, and where it stopped', () => {
    const text = summaryText(
      result({
        status: 'blocked',
        reason: '连续三步页面没有变化',
        page: null,
        verification: verification({ checked: true, passed: false, note: '没找到「12 元」' }),
      }),
      'https://example.test',
    )
    expect(text).toContain('结果：没做成（连续三步页面没有变化）')
    expect(text).toContain('没找到「12 元」')
    expect(text).toContain('没能读到页面')
  })
})

describe('a run that goes to the background', () => {
  it('answers immediately, belongs to this session, and reports back when it ends', async () => {
    const jobs = fakeJobs()
    const harness = fakeCtx({ jobs: jobs.registry })

    const progress: string[] = []
    let release: (() => void) | null = null
    const start: RunStarter = async (_parsed, _signal, onProgress) => {
      onProgress?.('第 1 步：Next')
      await new Promise<void>((resolve) => (release = resolve))
      return { ok: true, result: result(), note: '' }
    }

    registerCommand(harness.ctx, {} as ConfigShape, {} as never, start)
    const answer = await harness.registered[0]!.handler(invoke('https://example.test 找到价格'))

    expect(answer.kind).toBe('success')
    expect(answer.text).toContain('已经开跑')
    expect(answer.text).toContain('在后台进行')
    expect(answer.text).toContain(INSPECTOR_URL)

    expect(jobs.specs).toHaveLength(1)
    expect(jobs.specs[0]!.kind).toBe('jev')
    expect(jobs.specs[0]!.owner).toBe('session-1')
    expect(jobs.specs[0]!.label).toContain('找到价格')

    const job = jobs.specs[0]!.run({ updateProgress: (line) => progress.push(line) })
    release!()
    const outcome = await job.done
    expect(progress).toEqual(['第 1 步：Next'])
    expect(outcome.status).toBe('completed')
    expect(outcome.detail).toContain('结果：完成')
  })

  it('kills the run when the job is stopped', async () => {
    const jobs = fakeJobs()
    const harness = fakeCtx({ jobs: jobs.registry })

    let seen: AbortSignal | undefined
    let release: (() => void) | null = null
    const start: RunStarter = async (_parsed, signal) => {
      seen = signal
      await new Promise<void>((resolve) => {
        signal?.addEventListener('abort', () => resolve(), { once: true })
        release = resolve
      })
      return { ok: true, result: result({ status: 'blocked', reason: '任务已被取消' }), note: '' }
    }

    registerCommand(harness.ctx, {} as ConfigShape, {} as never, start)
    await harness.registered[0]!.handler(invoke('https://example.test 找到价格'))

    const job = jobs.specs[0]!.run({})
    expect(seen?.aborted).toBe(false)
    job.cancel()
    expect(seen?.aborted).toBe(true)
    release!()
    expect((await job.done).status).toBe('killed')
  })

  it('takes the session going away as a reason to stop too', async () => {
    const jobs = fakeJobs()
    const harness = fakeCtx({ jobs: jobs.registry })

    let seen: AbortSignal | undefined
    const start: RunStarter = async (_parsed, signal) => {
      seen = signal
      return { ok: true, result: result(), note: '' }
    }

    registerCommand(harness.ctx, {} as ConfigShape, {} as never, start)
    const session = new AbortController()
    await harness.registered[0]!.handler(invoke('https://example.test 找到价格', session.signal))

    // The run is handed to the background, so it starts when the job does — which is when the
    // session's signal has to reach it.
    const job = jobs.specs[0]!.run({})
    expect(seen?.aborted).toBe(false)
    session.abort()
    expect(seen?.aborted).toBe(true)
    await job.done
  })

  it('runs in place and says so when the registry refuses this session', async () => {
    const jobs = fakeJobs({ throws: 'no attached controller for this owner' })
    const harness = fakeCtx({ jobs: jobs.registry })

    const start: RunStarter = async () => ({ ok: true, result: result(), note: '' })
    registerCommand(harness.ctx, {} as ConfigShape, {} as never, start)

    const answer = await harness.registered[0]!.handler(invoke('https://example.test 找到价格'))
    expect(answer.kind).toBe('success')
    expect(answer.text).toContain('当场跑完')
    expect(answer.text).toContain('no attached controller')
    expect(answer.text).toContain('结果：完成')
  })
})

describe('a run with no background registry in reach', () => {
  it('runs in place and answers with the result', async () => {
    const harness = fakeCtx()
    let asked: { url: string; goal: string } | null = null
    const start: RunStarter = async (parsed) => {
      asked = parsed
      return { ok: true, result: result(), note: '本来没有可连的浏览器，已按设置启动 Edge 并连上' }
    }

    registerCommand(harness.ctx, {} as ConfigShape, {} as never, start)
    const answer = await harness.registered[0]!.handler(invoke('https://example.test 找到价格'))

    expect(asked).toMatchObject({ url: 'https://example.test', goal: '找到价格' })
    expect(answer.kind).toBe('success')
    expect(answer.text).toContain('结果：完成')
    expect(answer.text).toContain('本来没有可连的浏览器')
    expect(answer.text).not.toContain('在后台进行')
  })

  it('turns a run that could not start into an answer, not a thrown error', async () => {
    const harness = fakeCtx()
    const start: RunStarter = async () => ({
      ok: false,
      message: '决策服务（TypeSafe 官方直连）没有可用的钥匙',
      note: '',
    })

    registerCommand(harness.ctx, {} as ConfigShape, {} as never, start)
    const answer = await harness.registered[0]!.handler(invoke('https://example.test 找到价格'))

    expect(answer.kind).toBe('error')
    expect(answer.text).toContain('没法开始这次运行')
    expect(answer.text).toContain('决策服务（TypeSafe 官方直连）没有可用的钥匙')
    expect(answer.text).toContain('设置页')
  })

  it('calls a run that failed an error even though the loop answered', async () => {
    const harness = fakeCtx()
    const start: RunStarter = async () => ({
      ok: true,
      result: result({ status: 'failed', reason: '浏览器调试连接已关闭' }),
      note: '',
    })

    registerCommand(harness.ctx, {} as ConfigShape, {} as never, start)
    const answer = await harness.registered[0]!.handler(invoke('https://example.test 找到价格'))
    expect(answer.kind).toBe('error')
    expect(answer.text).toContain('结果：出错了（浏览器调试连接已关闭）')
  })
})

describe('the help and refusal answers', () => {
  it('answers a help request without starting anything', async () => {
    const harness = fakeCtx()
    let calls = 0
    registerCommand(harness.ctx, {} as ConfigShape, {} as never, async () => {
      calls += 1
      return { ok: true, result: result(), note: '' }
    })

    const answer = await harness.registered[0]!.handler(invoke(''))
    expect(answer.kind).toBe('success')
    expect(answer.text).toContain(INSPECTOR_URL)
    expect(calls).toBe(0)
  })

  it('asks where to start, then runs there, when the line names no address', async () => {
    const harness = fakeCtx()
    const seen: string[] = []
    let calls = 0
    const start: RunStarter = async (parsed) => {
      calls += 1
      seen.push(parsed.url, parsed.goal)
      return { ok: true, result: result({ page: null }), note: '' }
    }
    const resolveTarget = async (text: string) => {
      seen.push(`asked: ${text}`)
      return { url: 'https://www.baidu.com', goal: text }
    }
    registerCommand(harness.ctx, {} as ConfigShape, {} as never, start, resolveTarget)

    const answer = await harness.registered[0]!.handler(invoke('上百度查一下明天北京的天气'))

    expect(answer.kind).toBe('success')
    expect(answer.text).toContain('https://www.baidu.com')
    expect(calls).toBe(1)
    expect(seen).toEqual([
      'asked: 上百度查一下明天北京的天气',
      'https://www.baidu.com',
      '上百度查一下明天北京的天气',
    ])
  })

  it('says in the background answer that the address was the model’s reading', async () => {
    const jobs = fakeJobs()
    const harness = fakeCtx({ jobs: jobs.registry })
    let calls = 0
    const start: RunStarter = async () => {
      calls += 1
      return { ok: true, result: result(), note: '' }
    }
    registerCommand(harness.ctx, {} as ConfigShape, {} as never, start, async (text) => ({
      url: 'https://www.baidu.com',
      goal: text,
    }))

    const answer = await harness.registered[0]!.handler(invoke('上百度查一下明天的天气'))

    expect(answer.kind).toBe('success')
    expect(answer.text).toContain('起点：https://www.baidu.com')
    expect(answer.text).toContain('按你这句里说的网站选的')
    expect(jobs.specs[0]!.label).toContain('上百度查一下明天的天气')
    expect(calls).toBe(0)
  })

  it('starts at a search engine when the sentence names no site, instead of asking for one', async () => {
    const jobs = fakeJobs()
    const harness = fakeCtx({ jobs: jobs.registry })
    let calls = 0
    registerCommand(
      harness.ctx,
      {} as ConfigShape,
      {} as never,
      async () => {
        calls += 1
        return { ok: true, result: result(), note: '' }
      },
      async () => ({ url: 'https://www.baidu.com', goal: '把那件事办了' }),
    )

    const answer = await harness.registered[0]!.handler(invoke('把那件事办了'))
    expect(answer.kind).toBe('success')
    expect(answer.text).toContain('起点：https://www.baidu.com')
    expect(answer.text).toContain('先从搜索引擎开始')
    expect(calls).toBe(0)
  })
})
