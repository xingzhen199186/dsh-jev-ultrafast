/**
 * The way in that needs no model turn: one human command the reader types themselves.
 *
 * Everything else this plugin offers is reached either by asking the model (which then calls
 * the tool) or by opening the inspector page. Both need something to happen first. This is the
 * third door — `/jev-ultrafast` followed by what to do — typed straight into the composer,
 * dispatched by DSH against the agent whose UI received it, and answered from here. The command
 * line and its result stay on the client: nothing here becomes a model message on its own.
 *
 * What follows the command is read as a sentence, not as fields. An address anywhere in it is
 * the page to open; a sentence with no address in it is one small question to the text model
 * ("which site is this about?") away from a run. The first is `urls.ts`, the second
 * `resolve-start.ts`.
 *
 * Two things shape the code. First, `commands` is an optional host service: a headless or SDK
 * profile has no interactive adapter and therefore no registry, so the registration lives inside
 * `ctx.inject(['commands'], …)` and simply never runs there — the tool and the settings page do
 * not depend on any of it. Second, a browser run takes minutes, and DSH offers no user gesture
 * that cancels a running command handler. So when a background-job registry is available the run
 * goes there: the command answers immediately, the run keeps going, its progress is visible in
 * the session's jobs panel, and the panel's stop button can kill it. Without that registry the
 * run happens inside the command instead, and the answer arrives when it ends.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Config as ConfigShape } from './config'
import { deadEndNote } from './dead-ends'
import type { captureLlm } from './dsh-model'
import type { LoopEvent, RunStatus, TaskResult } from './loop'
import { runTask } from './loop'
import { INSPECTOR_PATH, LOGIN_HINT } from './protocol'
import { namedSite, resolveStart } from './resolve-start'
import { unfinishedDeaths } from './run-history'
import { prepareRun } from './run-setup'
import { findUrl } from './urls'

/** The name DSH parses out of `/jev-ultrafast …`: lowercase ASCII, as the registry requires. */
export const COMMAND_NAME = 'jev-ultrafast'

/** Stable plugin-owned identity, so the command can be recognised across versions. */
export const DEFINITION_ID = 'dsh-jev-ultrafast'

/** Where a reader can watch a run step by step instead of only reading its result. */
export const INSPECTOR_URL = 'http://127.0.0.1:3080' + INSPECTOR_PATH

const STATUS_LABEL: Record<RunStatus, string> = { done: '完成', blocked: '没做成', failed: '出错了' }

/**
 * What the reader typed, after the command name, read as a sentence rather than as fields.
 *
 * An address anywhere in it — `https://…` or a bare `example.com` — is the page to open, and
 * everything left over is the goal. A sentence with no address in it is not an error: the
 * address is the one thing the text model can supply, so that case is handed on instead of
 * refused (see `resolve-start.ts`).
 */
export type ParsedInput =
  | { kind: 'help' }
  | { kind: 'run'; url: string; goal: string }
  | { kind: 'resolve'; text: string }
  | { kind: 'error'; text: string }

export function parseInput(rawInput: string): ParsedInput {
  const text = rawInput.trim()
  if (text.length === 0) return { kind: 'help' }

  const found = findUrl(text)
  if (found === null) return { kind: 'resolve', text }

  // The address is taken out of the sentence; what is left, with its spacing tidied, is the goal.
  // Punctuation that only separated the two ("到 <地址>，看看价格") dangles once the address is
  // gone, so it goes with it.
  const after = found.after.replace(/^[\s，。；：、,.]+/u, '')
  const goal = `${found.before} ${after}`.replace(/\s+/gu, ' ').trim()
  if (goal.length === 0) {
    return {
      kind: 'error',
      text:
        `网址有了，还差一句目标——要它在这个页面上做什么？\n` +
        `比如：/${COMMAND_NAME} ${found.url} 找到价格并说明是多少`,
    }
  }
  return { kind: 'run', url: found.url, goal }
}

/** Everything the reader needs to know to use this command, and where the pictures are. */
export function helpText(): string {
  return [
    `这个插件用真浏览器去跑一个目标：它自己开一个标签页，一步一步决定点哪里、填什么，过程不进这段对话。`,
    ``,
    `怎么用：命令后面直接说要做什么就行，网址可有可无。`,
    `/${COMMAND_NAME} 上百度查一下明天北京的天气`,
    `/${COMMAND_NAME} https://www.example.com 找到价格并说明是多少`,
    `/${COMMAND_NAME}                  只看这段说明。`,
    ``,
    `话里带网址（http:// 或 https:// 开头，或者 example.com 这样的写法）就照它开跑，`,
    `这一步不花模型调用；整句话里没有网址时，认得出句子里点名的站点（百度、知乎、B 站…）就用它，`,
    `认不出就从搜索引擎开始——开跑前这一步不经过模型，所以它不会失败，也不会让你先等一次提问。`,
    ``,
    `跑起来之后：任务在后台进行，这个会话的「任务」面板里能看到进度、也能停；跑完我会把结果交回来。`,
    `想一步一步看它每个动作、甚至最后按真实节奏回放，打开检查器：${INSPECTOR_URL}`,
    `（逐帧画面听设置页那个「每一步都截图」开关；它关着时只有原始往来留痕，没有画面。）`,
  ].join('\n')
}

/** What the answer says once a run is over, in the reader's language. */
export function summaryText(result: TaskResult, url: string): string {
  const lines = [
    `目标：${result.goal}`,
    `结果：${STATUS_LABEL[result.status]}${result.reason ? `（${result.reason}）` : ''}`,
  ]
  // The model's own words, on their own line right under the judgement, and never a line of their
  // own when there are none: a reader has to be able to tell which of the two sentences is the
  // plugin's verdict and which is what the model said it saw, and an empty 「它自己说：」 would read
  // as the model having said nothing when in fact nobody asked it anything.
  if (result.answer) lines.push(`它自己说：${result.answer}`)
  lines.push(`执行 ${result.steps} 步、${result.decisions} 次决策，用时 ${(result.elapsedMs / 1000).toFixed(1)} 秒`)
  if (result.verification.checked) lines.push(result.verification.note)
  if (result.page) {
    lines.push(`最后停在：${result.page.title} — ${result.page.url}`)
    const excerpt = pageExcerpt(result.page.text)
    if (excerpt) lines.push(excerpt)
  } else lines.push(`没能读到页面（起点：${url}）`)
  // Said here as well as in the snapshot: the model's sentence about a page it cannot read
  // is worth no more than the reader's chance to act on it.
  if (result.pageNote) lines.push(result.pageNote)
  if (result.status === 'blocked') lines.push(LOGIN_HINT)
  if (result.recordDir) {
    lines.push(`这次运行的原始往返留痕（开着截图时还有逐帧画面）在这个目录里：${result.recordDir}`)
    if (!result.screenshot) lines.push(`（这次没有逐帧画面：设置页的「每一步都截图」关着。）`)
  }
  // The dead ends the run judged for itself, whether or not they were taken out of the candidates: with
  // the removal off by default, this sentence is the only place a reader can see the judgement at all.
  const deadEnds = deadEndNote(result.deadEnds, result.deadEndsExcluded)
  if (deadEnds) lines.push(deadEnds)
  if (result.history.length > 0) {
    lines.push(result.history.map((entry, index) => `${index + 1}. ${entry.action}`).join('\n'))
  }
  return lines.join('\n')
}

/** How much of the page the answer quotes back: enough to read, short enough to stay an answer. */
const PAGE_EXCERPT_CHARS = 900

/**
 * The page's own words, because the title and the action list are not an answer.
 *
 * A reader who asked for something on a page was, until now, told which page it was and what was
 * clicked — never what the page said. That is what "the content I asked for never came back" was
 * (2026-09-30). Trimmed rather than summarised: another model call could paraphrase, and a
 * paraphrase is harder to trust than the sentence actually on the page.
 */
function pageExcerpt(text: string): string {
  const trimmed = text.trim()
  if (!trimmed) return ''
  const cut = trimmed.slice(0, PAGE_EXCERPT_CHARS)
  const more = trimmed.length > PAGE_EXCERPT_CHARS ? '\n…（后面还有，完整内容在留痕目录里）' : ''
  return `页面上读到的内容（节选）：\n${cut}${more}`
}

/** The command registry, as much of it as this file uses. */
interface CommandsLike {
  register(definition: {
    definitionId: string
    name: string
    description: string
    input: { hint: string }
    handler: (invocation: CommandInvocation) => Promise<{ kind: 'success' | 'error'; text: string }>
  }): () => void
}

interface CommandInvocation {
  /** The exact agent whose UI received the command; its id is the session id. */
  agent: { id: string }
  /** The text after the command name, exactly as typed, separator whitespace included. */
  rawInput: string
  signal?: AbortSignal
}

/** The background-job registry, as much of it as this file uses. */
interface JobsLike {
  start(spec: {
    kind: string
    label: string
    owner?: string
    run: (job: { updateProgress?: (line: string) => void }) => {
      cancel: (reason?: string) => void
      done: Promise<{ status: 'completed' | 'killed' | 'failed'; detail?: string }>
    }
  }): string
}

/** One run's outcome, either way it was run. */
export type Attempt =
  | { ok: true; result: TaskResult; note: string }
  | { ok: false; message: string; note: string }

/**
 * How one run is started. It is a parameter rather than a direct call only so the command's own
 * plumbing — the parsing, the background job, the answer, the fallbacks — can be exercised
 * without a browser; the run itself is the loop's, and is covered where the loop is.
 */
export type RunStarter = (
  parsed: Extract<ParsedInput, { kind: 'run' }>,
  signal: AbortSignal | undefined,
  onProgress?: (line: string) => void,
) => Promise<Attempt>

/**
 * How a sentence with no address in it becomes a starting point. A parameter for the same reason
 * `start` is: the command's own plumbing is worth exercising without a browser behind it. It cannot
 * fail in practice — the one it defaults to reads the sentence offline — but the seam is what lets
 * the tests drive a start the sentence did not name.
 */
export type TargetResolver = (text: string) => Promise<{ url: string; goal: string }>

export function registerCommand(
  ctx: Context,
  config: ConfigShape,
  llm: ReturnType<typeof captureLlm>,
  start: RunStarter = (parsed, signal, onProgress) =>
    runOnce(ctx, config, llm, parsed, signal, onProgress),
  resolveTarget: TargetResolver = async (text) => resolveStart(text),
): void {
  const scoped = ctx as Context & {
    inject?(keys: string[], callback: (inner: Context & { commands?: CommandsLike }) => void): void
  }
  if (typeof scoped.inject !== 'function') return

  scoped.inject(['commands'], (inner) => {
    const commands = inner.commands
    if (typeof commands?.register !== 'function') return

    const dispose = commands.register({
      definitionId: DEFINITION_ID,
      name: COMMAND_NAME,
      description: '用真浏览器跑一件事：后面直接说做什么，网址可有可无',
      input: { hint: '<直接说目标，网址可有可无>' },
      handler: (invocation) => execute(ctx, start, resolveTarget, invocation),
    })
    ctx.effect(() => dispose, 'dsh-jev-ultrafast: human command')
  })
}

async function execute(
  ctx: Context,
  start: RunStarter,
  resolveTarget: TargetResolver,
  invocation: CommandInvocation,
): Promise<{ kind: 'success' | 'error'; text: string }> {
  const answer = await answerTo(ctx, start, resolveTarget, invocation)
  // A death the reader was never told about goes in front of the next answer. This command is the
  // one place the plugin talks to the session on its own, so it is where an interrupted run has to
  // surface — otherwise the promise "跑完我把结果交回来" is simply broken in silence.
  const interrupted = interruptionNote()
  return interrupted === '' ? answer : { ...answer, text: `${interrupted}\n${answer.text}` }
}

/**
 * One sentence about runs that died with an earlier process, and at most one per run: a death is
 * worth saying once, while a sentence that comes back on every command for the rest of the day is
 * nagging. Empty when there is nothing to report, which is the usual case.
 */
function interruptionNote(): string {
  const lost = unfinishedDeaths()
  if (lost.length === 0) return ''
  const last = lost[lost.length - 1]!
  const when = new Date(last.startedAt).toLocaleString('zh-CN')
  const others = lost.length > 1 ? `（另外还有 ${lost.length - 1} 趟更早的也一样）` : ''
  return (
    `补一句：${when} 开的那趟没跑完，也没有留下结果${others}。` +
    `最可能的原因是 DSH 在那中间重启过，把正在做的事一起带走了。想重来就再发一次这条命令。`
  )
}

async function answerTo(
  ctx: Context,
  start: RunStarter,
  resolveTarget: TargetResolver,
  invocation: CommandInvocation,
): Promise<{ kind: 'success' | 'error'; text: string }> {
  const parsed = parseInput(invocation.rawInput)
  if (parsed.kind === 'help') return { kind: 'success', text: helpText() }
  if (parsed.kind === 'error') return { kind: 'error', text: parsed.text }

  // A sentence that names no address still starts a run: the site it names, or a search engine.
  // Nothing on this path can fail, and that is deliberate — a settings problem must not cost a
  // reader the run they just asked for. The version that asked a model first did exactly that.
  let run: Extract<ParsedInput, { kind: 'run' }>
  let startNote = ''
  if (parsed.kind === 'resolve') {
    run = { kind: 'run', ...(await resolveTarget(parsed.text)) }
    startNote =
      namedSite(parsed.text) === null
        ? '（这句里没提到哪个网站，先从搜索引擎开始；想换就把它写进命令里）'
        : '（按你这句里说的网站选的；选错了就把地址直接写进命令里再来一次）'
  } else {
    run = parsed
  }

  const jobs = jobRegistry(ctx)
  if (jobs === null) {
    // No background registry here (a minimal preset has none). The run happens inside the
    // command, so the composer stays busy until it ends — said in the answer, not hidden.
    const attempt = await start(run, invocation.signal)
    return {
      kind: attempt.ok && attempt.result.status !== 'failed' ? 'success' : 'error',
      text: answerText(attempt, run.url),
    }
  }

  const controller = new AbortController()
  // The session going away (or the page being disposed) aborts the run with it: a command that
  // outlives the UI it was typed into should not keep driving a browser in the background.
  invocation.signal?.addEventListener('abort', () => controller.abort(), { once: true })

  try {
    jobs.start({
      kind: 'jev',
      label: `浏览器任务：${run.goal}`,
      owner: invocation.agent.id,
      run: (job) => ({
        cancel: () => controller.abort(),
        done: (async () => {
          const attempt = await start(run, controller.signal, (line) => job.updateProgress?.(line))
          return {
            status: controller.signal.aborted
              ? ('killed' as const)
              : attempt.ok && attempt.result.status !== 'failed'
                ? ('completed' as const)
                : ('failed' as const),
            detail: answerText(attempt, run.url),
          }
        })(),
      }),
    })
  } catch (error) {
    // A registry that refuses this owner (an environment without an attached controller). The
    // run is still worth doing, so it is done here instead, and the answer says which happened.
    const attempt = await start(run, invocation.signal)
    return {
      kind: attempt.ok && attempt.result.status !== 'failed' ? 'success' : 'error',
      text: `${answerText(attempt, run.url)}\n（这个环境没能把任务交给后台，所以是当场跑完才回话的：${
        error instanceof Error ? error.message : String(error)
      }）`,
    }
  }

  return {
    kind: 'success',
    text:
      `已经开跑：${run.goal}\n` +
      `起点：${run.url}${startNote}\n` +
      `它在后台进行，这个会话的「任务」面板里能看到进度、也能停；跑完我把结果交回来。\n` +
      `想逐步看画面：${INSPECTOR_URL}`,
  }
}

/** Assemble and run one task, never throwing: a broken setting is an answer, not a crash. */
async function runOnce(
  ctx: Context,
  config: ConfigShape,
  llm: ReturnType<typeof captureLlm>,
  parsed: { url: string; goal: string },
  signal?: AbortSignal,
  onProgress?: (line: string) => void,
): Promise<Attempt> {
  let note = ''
  try {
    const prepared = await prepareRun(ctx, config, llm, {
      record: true,
      signal,
      onEvent: (event: LoopEvent) => {
        if (event.type === 'executed') onProgress?.(`第 ${event.step} 步：${event.action}`)
        else if (event.type === 'finished') {
          onProgress?.(`结束：${STATUS_LABEL[event.status]}${event.reason ? `（${event.reason}）` : ''}`)
        }
      },
    })
    note = prepared.note
    const result = await runTask({ ...prepared.base, goal: parsed.goal, startUrl: parsed.url })
    return { ok: true, result, note }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error), note }
  }
}

function answerText(attempt: Attempt, url: string): string {
  if (!attempt.ok) {
    const lines = [`没法开始这次运行：${attempt.message}`]
    if (attempt.note) lines.push(attempt.note)
    lines.push(`（设置页里可以核对决策服务、文本模型的钥匙与浏览器这几项。）`)
    return lines.join('\n')
  }
  const lines = [summaryText(attempt.result, url)]
  if (attempt.note) lines.push(attempt.note)
  return lines.join('\n')
}

/** The job registry when this profile has one, and nothing when it does not. */
function jobRegistry(ctx: Context): JobsLike | null {
  try {
    const get = (ctx as Context & { get?: (name: string) => unknown }).get
    const jobs = typeof get === 'function' ? (get.call(ctx, 'jobs') as JobsLike | undefined) : undefined
    return typeof jobs?.start === 'function' ? jobs : null
  } catch {
    return null
  }
}
