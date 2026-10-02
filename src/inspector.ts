/**
 * The interactive inspector: the same loop, watched and stepped by hand.
 *
 * Upstream shipped a small local page that showed numbered elements, the probability behind
 * each of them, and what the run then did; this is that idea on top of this plugin's own
 * loop, plus the two things a chat transcript cannot offer — holding the run before an
 * action lands, and replaying a finished run from the frames it left behind.
 *
 * The page polls. A local page asking twice a second for a small JSON document is simpler
 * than any streaming machinery, and it keeps this side to plain request/response, the same
 * shape as the settings route it lives under.
 *
 * One run at a time, on purpose: two would share the one browser window, and the page would
 * have to explain which of them a click belonged to.
 *
 * Nothing here resolves a credential or picks a door: it goes through the same run setup the
 * tool uses, so the inspector cannot start a run the tool would not have started.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Config as ConfigShape } from './config'
import type { captureLlm } from './dsh-model'
import { readJson, send, sendBytes } from './http'
import { inspectorPage } from './inspector-page'
import { runTask, type LoopEvent, type RunStatus, type TaskResult } from './loop'
import { prepareRun } from './run-setup'
import { hasLastWord } from './run-history'

/** Where every run's artifacts live. `openArtifacts` owns that layout; this only reads it. */
const ARTIFACTS_ROOT = join(tmpdir(), 'dsh-jev-ultrafast')
/** The only names this module will touch: exactly what `openArtifacts` writes, nothing else.
 *  Frames carry the step they were taken after; the millisecond names are what a run recorded
 *  before that left behind, and are still this module's to read and serve. */
const RUN_NAME = /^run-[0-9]+-[a-z0-9]{4}$/
const FRAME_NAME = /^(step-[0-9]{3}-[a-z]+|[0-9]{6})\.jpg$/
/** How many lines the page keeps. A run is a few hundred events at most; older ones drop. */
const MAX_LINES = 600

const STATUS_LABEL: Record<RunStatus, string> = { done: '完成', blocked: '没做成', failed: '出错了' }

type LineKind = 'observed' | 'decided' | 'executed' | 'followed' | 'finished' | 'waiting' | 'error'

interface StepLine {
  seq: number
  kind: LineKind
  line: string
  /** Present on a decision: what it was choosing between, with the odds it was given. */
  table?: Array<{ index: string; label: string; operations: string[]; probability: number | null }>
}

interface Run {
  controller: AbortController
  goal: string
  /** The run's own directory name under the artifacts root, once the loop has opened it. */
  dir: string
  note: string
  running: boolean
  paused: boolean
  /** One step was released while paused; consumed by the next gate. */
  stepped: boolean
  /** The gate is holding right now: the page shows this as "已停下，等你". */
  waiting: boolean
  stopped: boolean
  hold: (() => void) | null
  steps: StepLine[]
  seq: number
  result: TaskResult | null
  error: string
}

export interface Inspector {
  /**
   * Serve one request from the inspector's corner of the settings route.
   *
   * `offered` is the token that arrived; only the page document itself is served without
   * one, because a page cannot carry a token it has not been given yet.
   */
  handle(path: string, req: IncomingMessage, res: ServerResponse, token: string, offered: string): Promise<void>
}

export function createInspector(
  ctx: Context,
  config: ConfigShape,
  llm: ReturnType<typeof captureLlm>,
): Inspector {
  let current: Run | null = null

  const line = (run: Run, kind: LineKind, text: string, table?: StepLine['table']): void => {
    run.seq += 1
    run.steps.push({ seq: run.seq, kind, line: text, ...(table ? { table } : {}) })
    if (run.steps.length > MAX_LINES) run.steps.splice(0, run.steps.length - MAX_LINES)
  }

  const onEvent = (run: Run, event: LoopEvent): void => {
    switch (event.type) {
      case 'recording':
        // The frames of this run land here as they are taken, which is what lets the page
        // show the current screen while the run is still going.
        run.dir = basename(event.dir)
        line(run, 'observed', `这次运行的留痕目录：${event.dir}`)
        break
      case 'observed':
        line(
          run,
          'observed',
          event.step === 0
            ? `开始看页面：${event.url}（${event.elements} 个可操作元素）`
            : `第 ${event.step} 步后重新看页面：${event.url}（${event.elements} 个可操作元素）`,
        )
        break
      case 'decided':
        line(
          run,
          'decided',
          `第 ${event.step} 步：决定 ${event.operation} → ${event.action}（把握 ${event.confidence.toFixed(2)}）`,
          event.table,
        )
        break
      case 'executed':
        line(
          run,
          'executed',
          `第 ${event.step} 步：执行完「${event.action}」，用时 ${event.elapsedMs} 毫秒${
            event.pageChanged ? '，页面变了' : '，页面没变'
          }`,
        )
        break
      case 'followed':
        line(run, 'followed', `第 ${event.step} 步：跟到新窗口「${event.title || event.url}」`)
        break
      case 'finished':
        line(
          run,
          'finished',
          `运行结束：${STATUS_LABEL[event.status]}${event.reason ? `（${event.reason}）` : ''}`,
        )
        break
    }
  }

  /**
   * The hold the loop waits on. A pause is honoured before an action, never during one, and
   * returning from here is what lets either one step through or the whole run carry on.
   */
  const gate = async (run: Run, info: { step: number; action: string }): Promise<void> => {
    if (!run.paused || run.stepped) {
      run.stepped = false
      return
    }
    run.waiting = true
    line(run, 'waiting', `第 ${info.step} 步：已停下，等你按「继续」或「单步」再执行「${info.action}」`)
    await new Promise<void>((resolve) => {
      run.hold = resolve
    })
    run.waiting = false
    run.hold = null
    run.stepped = false
  }

  const start = (goal: string, url: string, expect: string[]): void => {
    const controller = new AbortController()
    const run: Run = {
      controller,
      goal,
      dir: '',
      note: '',
      running: true,
      paused: false,
      stepped: false,
      waiting: false,
      stopped: false,
      hold: null,
      steps: [],
      seq: 0,
      result: null,
      error: '',
    }
    current = run
    void (async () => {
      try {
        // The inspector is inherently visual, so it takes the screenshots and the record a
        // run would only take when asked for: without frames there is nothing to step through
        // or to replay afterwards.
        const { base, note } = await prepareRun(ctx, config, llm, {
          screenshots: true,
          record: true,
          signal: controller.signal,
          onEvent: (event) => onEvent(run, event),
          gate: (info) => gate(run, info),
        })
        run.note = note
        run.result = await runTask({ ...base, goal, startUrl: url, expect })
      } catch (error) {
        run.error = error instanceof Error ? error.message : String(error)
        line(run, 'error', `这次运行没能开始：${run.error}`)
      } finally {
        run.running = false
        run.waiting = false
      }
    })()
  }

  const stateOf = (run: Run | null): Record<string, unknown> => {
    if (run === null) {
      return { running: false, paused: false, waiting: false, state: '未开始', note: '', steps: [], frame: null, runs: listRuns() }
    }
    const result = run.result
    const state = run.running
      ? run.waiting
        ? '已暂停：等你按「继续」或「单步」'
        : '运行中'
      : run.error
        ? `没能跑起来：${run.error}`
        : result
          ? `结束：${STATUS_LABEL[result.status]}${result.reason ? `（${result.reason}）` : ''} — ${result.steps} 步、${
              result.decisions
            } 次决策、${(result.elapsedMs / 1000).toFixed(1)} 秒${result.verification.note ? `；${result.verification.note}` : ''}${
              result.pageNote ? `；${result.pageNote}` : ''
            }`
          : '已停止'
    const manifest = run.dir ? frameManifest(join(ARTIFACTS_ROOT, run.dir)) : { frames: [] }
    const newest = manifest.frames[manifest.frames.length - 1]
    return {
      running: run.running,
      paused: run.paused,
      waiting: run.waiting,
      state,
      note: run.note,
      steps: run.steps,
      frame: run.dir && newest ? { run: run.dir, file: newest.file } : null,
      runs: listRuns(),
    }
  }

  const handle = async (
    path: string,
    req: IncomingMessage,
    res: ServerResponse,
    token: string,
    offered: string,
  ): Promise<void> => {
    // The document is the one thing served without a token; it carries it instead.
    if (path === '' || path === '/') {
      sendBytes(res, 200, 'text/html; charset=utf-8', Buffer.from(inspectorPage(token), 'utf8'))
      return
    }
    if (offered !== token) {
      send(res, 403, { error: '这个请求没有带对令牌。请从 DSH 的设置页打开本插件页面。' })
      return
    }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')

    if (path === '/state') {
      send(res, 200, stateOf(current))
      return
    }

    if (path === '/start') {
      if (req.method !== 'POST') {
        send(res, 405, { error: '这个接口只接受 POST。' })
        return
      }
      if (current?.running) {
        send(res, 409, { error: '已经有一次运行在跑了。先等它结束，或者按「停止」。' })
        return
      }
      const body = await readJson(req)
      const goal = String(body.goal ?? '').trim()
      const url_ = String(body.url ?? '').trim()
      const expect = Array.isArray(body.expect) ? body.expect.filter((item): item is string => typeof item === 'string') : []
      if (!goal || !url_) {
        send(res, 400, { error: '目标和起始网址都要填。' })
        return
      }
      start(goal, url_, expect)
      send(res, 200, { ok: true })
      return
    }

    if (path === '/control') {
      if (req.method !== 'POST') {
        send(res, 405, { error: '这个接口只接受 POST。' })
        return
      }
      const body = await readJson(req)
      const action = String(body.action ?? '')
      const run = current
      if (!run || !run.running) {
        send(res, 409, { error: '现在没有在跑的运行。' })
        return
      }
      const release = (): void => {
        run.hold?.()
        run.hold = null
      }
      if (action === 'pause') run.paused = true
      else if (action === 'resume') {
        run.paused = false
        release()
      } else if (action === 'step') {
        run.stepped = true
        release()
      } else if (action === 'stop') {
        // Stopping is cancellation, not a nudge: the loop checks the signal right after the
        // hold, so a paused run stops without executing the action it was holding.
        run.stopped = true
        run.controller.abort()
        release()
      } else {
        send(res, 400, { error: '不认识的控制指令。' })
        return
      }
      send(res, 200, { ok: true })
      return
    }

    if (path === '/frame') {
      const run = url.searchParams.get('run') ?? ''
      const file = url.searchParams.get('file') ?? ''
      if (!RUN_NAME.test(run) || !FRAME_NAME.test(file)) {
        send(res, 400, { error: '帧的名字不对。' })
        return
      }
      const target = join(ARTIFACTS_ROOT, run, 'frames', file)
      if (!existsSync(target)) {
        send(res, 404, { error: '这一帧还没有写出来，或者已经不在磁盘上了。' })
        return
      }
      sendBytes(res, 200, 'image/jpeg', readFileSync(target))
      return
    }

    if (path === '/run') {
      const name = url.searchParams.get('run') ?? ''
      if (!RUN_NAME.test(name)) {
        send(res, 400, { error: '运行的名字不对。' })
        return
      }
      const dir = join(ARTIFACTS_ROOT, name)
      if (!existsSync(dir)) {
        send(res, 404, { error: '这个运行目录不在了。' })
        return
      }
      const manifest = frameManifest(dir)
      send(res, 200, {
        label: `${new Date(modifiedAt(dir)).toLocaleString('zh-CN')} — ${manifest.frames.length} 帧${
          manifest.run_ms === undefined ? '' : `，共 ${(manifest.run_ms / 1000).toFixed(1)} 秒`
        }`,
        frames: manifest.frames,
        trace: traceLines(dir),
      })
      return
    }

    send(res, 404, { error: '没有这个接口。' })
  }

  return { handle }
}

/** One recorded run, newest first: the name to pass back and the line the page shows. */
function listRuns(): Array<{ name: string; label: string }> {
  try {
    return readdirSync(ARTIFACTS_ROOT)
      .filter((name) => RUN_NAME.test(name))
      .map((name) => ({ name, at: modifiedAt(join(ARTIFACTS_ROOT, name)) }))
      .sort((left, right) => right.at - left.at)
      .slice(0, 20)
      .map(({ name, at }) => {
        const manifest = frameManifest(join(ARTIFACTS_ROOT, name))
        // A run with no last word never finished: the process running it was killed. Saying so in
        // the list is the difference between "this run is short" and "this run died".
        const unfinished = hasLastWord(join(ARTIFACTS_ROOT, name)) ? '' : '（没跑完）'
        return {
          name,
          label: `${new Date(at).toLocaleString('zh-CN')} — ${manifest.frames.length} 帧${
            manifest.run_ms === undefined ? '' : `，共 ${(manifest.run_ms / 1000).toFixed(1)} 秒`
          }${unfinished}`,
        }
      })
  } catch {
    return []
  }
}

function modifiedAt(dir: string): number {
  try {
    return statSync(dir).mtimeMs
  } catch {
    return 0
  }
}

/** One frame as `frames.json` records it. `step` and `action` are absent on a run recorded
 *  before frames carried them, which is why the page falls back to the elapsed time. */
interface FrameRecord {
  file: string
  at_ms: number
  step?: number
  action?: string
}

/**
 * The step frames of one run, in order, as the loop left them.
 *
 * Every name is checked against the same pattern the writer uses before it is read or served:
 * a directory the user can open is also a directory something else could drop a file into.
 */
function frameManifest(dir: string): { frames: FrameRecord[]; run_ms?: number } {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, 'frames.json'), 'utf8')) as {
      frames?: unknown
      run_ms?: unknown
    }
    const frames: FrameRecord[] = []
    if (Array.isArray(parsed.frames)) {
      for (const item of parsed.frames) {
        if (typeof item !== 'object' || item === null) continue
        const { file, at_ms, step, action } = item as {
          file?: unknown
          at_ms?: unknown
          step?: unknown
          action?: unknown
        }
        if (typeof file !== 'string' || !FRAME_NAME.test(file) || typeof at_ms !== 'number') continue
        frames.push({
          file,
          at_ms,
          ...(typeof step === 'number' ? { step } : {}),
          ...(typeof action === 'string' ? { action } : {}),
        })
      }
      frames.sort((left, right) => left.at_ms - right.at_ms)
    }
    return typeof parsed.run_ms === 'number' ? { frames, run_ms: parsed.run_ms } : { frames }
  } catch {
    return { frames: [] }
  }
}

/** The raw trace of one run, each line also said in one Chinese sentence for the page. */
function traceLines(dir: string): Array<{ line: string; raw: Record<string, unknown> }> {
  let text: string
  try {
    text = readFileSync(join(dir, 'trace.jsonl'), 'utf8')
  } catch {
    return []
  }
  return text
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((raw) => {
      let record: Record<string, unknown> = {}
      try {
        const parsed: unknown = JSON.parse(raw)
        if (parsed !== null && typeof parsed === 'object') record = parsed as Record<string, unknown>
      } catch {
        record = { raw }
      }
      return { line: describeRecord(record), raw: record }
    })
}

/** One trace record as a sentence. The raw record is always there to expand; this is the index. */
function describeRecord(record: Record<string, unknown>): string {
  const at = typeof record.at === 'number' ? new Date(record.at).toLocaleTimeString('zh-CN') : ''
  const took = typeof record.took_ms === 'number' ? `，用了 ${record.took_ms} 毫秒` : ''
  const prefix = at ? `${at}　` : ''
  if (typeof record.error === 'string') {
    // The control layer's one recorded sentence is about itself, not about a request that
    // failed: reading its checklist is one model call among others, but "中控：清单没读成"
    // is the fact, where "决策服务请求失败" would name the wrong service.
    if (record.kind === 'control') return `${prefix}中控：${record.error}`
    return `${prefix}${record.kind === 'text' ? '文本模型' : '决策服务'}请求失败：${record.error}`
  }
  if (record.kind === 'decision') {
    const attempt = typeof record.attempt === 'number' && record.attempt > 0 ? `（第 ${record.attempt + 1} 次尝试）` : ''
    const wrapped = record.wrapped === true ? '（带 decisionsRequest 包裹）' : ''
    return `${prefix}决策请求 → HTTP ${String(record.status)}${wrapped}${attempt}${took}`
  }
  if (record.kind === 'text') {
    const door = record.door === 'dsh' ? 'DSH 内置模型' : '预设供应商'
    const status = typeof record.status === 'number' ? `HTTP ${record.status}` : '流式返回'
    return `${prefix}文本模型请求（${door}）→ ${status}${took}`
  }
  if (record.kind === 'run') {
    const seconds = typeof record.elapsed_ms === 'number' ? (record.elapsed_ms / 1000).toFixed(1) : '?'
    return `${prefix}本次运行结束：${String(record.status)}，${String(record.steps)} 步、${String(
      record.decisions,
    )} 次决策，共 ${seconds} 秒${record.reason ? `（${String(record.reason)}）` : ''}`
  }
  if (record.kind === 'follow') {
    // Which pages a step opened, and whether the run moved onto one of them, is what the tab
    // record is for — a click whose effect lands elsewhere leaves the page it was made on
    // saying nothing about it.
    const followed = record.followed_tab ? '跟过去了' : '没有跟过去'
    return `${prefix}第 ${String(record.step)} 步开出了新页面：${followed}`
  }
  return `${prefix}${JSON.stringify(record).slice(0, 160)}`
}
