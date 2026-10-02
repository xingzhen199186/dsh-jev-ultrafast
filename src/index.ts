import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { ensureBrowser } from './browser/launch'
import { DEFAULT_MAX_CHARS, DEFAULT_MAX_SCREENS, readPage } from './browser/read'
import { registerCommand } from './command'
import { Config } from './config'
import type { Config as ConfigShape } from './config'
import { deadEndNote } from './dead-ends'
import { captureLlm } from './dsh-model'
import { runTask, verdictText } from './loop'
import type { FollowRecord, RunStatus, TaskResult } from './loop'
import { registerPanel } from './panel'
import { MAX_PAGE_TEXT } from './prompts'
import { LOGIN_HINT } from './protocol'
import { browserNote, prepareRun } from './run-setup'

export const name = 'dsh-jev-ultrafast'
// `credentials` is injected so a key is resolved through the harness credential
// store rather than read from the process environment behind its back.
export const inject = ['tools', 'credentials']

// Re-export the schema so the loader can validate this plugin's config.
export { Config }

/** What the model is told about one run. All of it comes from observed evidence. */
interface TaskOutput {
  status: RunStatus
  reason: string
  /**
   * The checklist's own sentences for what was still not holding when this run's finish was let
   * through anyway; empty on every other run. The judgement above reads this: a run released from a
   * checklist it never satisfied is reported as one that did not do the job (`loop.ts` `verdictText`).
   */
  unmet: string[]
  /**
   * What the run's own model said it found, in its own words, asked once at the end. Empty when
   * there was nothing to report — and never the same thing as the judgement above, which is the
   * plugin's (see `loop.ts`): the two are shown as two lines so a reader can tell them apart.
   */
  answer: string
  /** Something this run did beyond running the task: starting a browser, today. Empty usually. */
  note: string
  url: string
  title: string
  text: string
  steps: number
  decisions: number
  elapsedMs: number
  actions: string[]
  elements: string[]
  textCalls: number
  /** The independent check of the run's own claim, in the user's language. */
  verification: string
  /** How many element actions were left out because the page offered more than 250. */
  omittedActions: number
  /** Elements the run's last request carried, and how many of the page's own it left out. */
  sentElements: number
  omittedElements: number
  /** Page-text characters that request had to leave out; `0` when the whole text went. */
  textCut: number
  /**
   * The dead ends this run judged for itself, in the user's language; empty when it judged none.
   * Present whether or not they were taken out of the candidates, so a reader can see a judgement
   * that set aside the one element that mattered.
   */
  deadEnds: string
  /** Where the last screen's screenshot was written, or empty when none was taken. */
  screenshot: string
  /** Where this run's raw exchanges (and, with screenshots on, one frame per step) were written. */
  recordDir: string
}

/** The page text is evidence, not the question: it is capped so one run cannot flood the conversation. */
const EVIDENCE_LIMIT = 6000

export function apply(ctx: Context, config: ConfigShape): void {
  // DSH's own model service, captured whenever this profile has one, so the built-in text
  // door can use it without making the whole plugin depend on it.
  const llm = captureLlm(ctx)

  ctx.tools.register(
    defineTool({
      name: 'jev_browser_task',
      description:
        'Drive a real browser toward one goal. Call it whenever the user asks for something to be done on the web and names the browser or this tool — for example "jev浏览器", "用浏览器", "打开浏览器帮我…", "上网帮我…", "浏览器里查/填/点一下". The plugin opens its own Chrome/Edge tab and a separate decision model chooses an indexed element to act on at each step, so the page never has to enter this conversation. Use it for a task that needs several steps on a site (filling a form, applying filters, searching and reading a result); when the user only wants a page read from top to bottom, that is jev_browser_read instead. Do not call it when the user merely mentions browsers in passing — the browser is laggy, browser settings, how browsers behave — without asking for something to be done on a web page. Returns what was observed at the end as evidence for your answer.',
      parameters: {
        goal: {
          type: 'string',
          required: true,
          description:
            'The whole task in one self-contained sentence, including every value to type and every filter to set. The loop sees only this goal and the page, never this conversation.',
        },
        url: {
          type: 'string',
          required: true,
          description: 'The page to open first. The action space can click links but cannot navigate to an address, so this is where the run begins.',
        },
        maxSteps: {
          type: 'number',
          description: 'Override the configured step budget for this run only.',
        },
        expect: {
          type: 'array',
          items: { type: 'string' },
          description:
            "Strings the finished page must show, written down before the run starts and checked by the plugin afterwards — a run whose own DONE fails this check comes back as not done, so use it for the success markers named in the goal (an order number, a confirmation line, a result count). Prefix an entry with ! to require that a string must NOT be there, for example \"!No results\".",
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            status: { type: 'string', enum: ['done', 'blocked', 'failed'], required: true },
            reason: { type: 'string', required: true },
            unmet: { type: 'array', items: { type: 'string' }, required: true },
            answer: { type: 'string', required: true },
            note: { type: 'string', required: true },
            url: { type: 'string', required: true },
            title: { type: 'string', required: true },
            text: { type: 'string', required: true },
            steps: { type: 'integer', required: true },
            decisions: { type: 'integer', required: true },
            elapsedMs: { type: 'integer', required: true },
            actions: { type: 'array', items: { type: 'string' }, required: true },
            elements: { type: 'array', items: { type: 'string' }, required: true },
            textCalls: { type: 'integer', required: true },
            verification: { type: 'string', required: true },
            omittedActions: { type: 'integer', required: true },
            sentElements: { type: 'integer', required: true },
            omittedElements: { type: 'integer', required: true },
            textCut: { type: 'integer', required: true },
            deadEnds: { type: 'string', required: true },
            screenshot: { type: 'string', required: true },
            recordDir: { type: 'string', required: true },
          },
        },
        render(args, value) {
          const summary = [
            `任务：${args.goal}`,
            `结果：${verdictText(value.status, value.reason, value.unmet)}`,
          ]
          // What the model said it found, kept apart from the judgement above by its own lead-in and
          // its own line — and left out entirely when it had nothing to say, rather than shown empty.
          if (value.answer) summary.push(`它自己说：${value.answer}`)
          summary.push(`执行 ${value.steps} 步、${value.decisions} 次决策，用时 ${(value.elapsedMs / 1000).toFixed(1)} 秒`)
          if (value.verification) summary.push(value.verification)
          if (value.omittedActions > 0) {
            summary.push(`这个页面能操作的元素超过 250 个，还有 ${value.omittedActions} 个没进候选表`)
          }
          const cut = cutNote(value.sentElements, value.omittedElements, value.textCut)
          if (cut) summary.push(cut)
          if (value.deadEnds) summary.push(value.deadEnds)
          if (value.note) summary.push(value.note)
          if (value.screenshot) summary.push(`最后一屏的截图已写到：${value.screenshot}`)
          if (value.recordDir) {
            summary.push(`这次运行的原始往返留痕（开着截图时还有逐帧画面）在这个目录里：${value.recordDir}`)
          }
          if (value.actions.length > 0) {
            summary.push(value.actions.map((action, index) => `${index + 1}. ${action}`).join('\n'))
          }
          if (value.status === 'blocked') summary.push(LOGIN_HINT)
          if (value.status !== 'done' && value.elements.length > 0) {
            summary.push(`当时页面上还能操作的有：\n${value.elements.slice(0, 20).join('\n')}`)
          }
          const blocks: Array<{ type: 'text'; text: string }> = [
            { type: 'text', text: summary.join('\n') },
          ]
          if (value.text) {
            blocks.push({
              type: 'text',
              text: `最终页面（${value.title} — ${value.url}）的可见正文：\n${value.text}`,
            })
          }
          return blocks
        },
      },
      async execute(args, exec) {
        // The run is assembled in one shared place, so the tool and the inspector page start
        // the same run: same doors, same credentials, same browser.
        const { base, note } = await prepareRun(ctx, config, llm, {
          maxSteps: args.maxSteps,
          signal: exec.signal,
          record: true,
        })
        const result = await runTask({ ...base, goal: args.goal, startUrl: args.url, expect: args.expect })
        // The run's own note about a page it could only partly see rides the note the caller
        // already reads, so the sentence reaches the user through the channel that exists.
        const output = toOutput(result, [note, result.pageNote].filter(Boolean).join('\n'))
        // Screenshots are off unless the settings page turns them on. When they are on, the
        // picture the last observation took is written out instead of being thrown away, so
        // the caller can look at the page it was told about.
        if (result.screenshot) {
          const saved = saveScreenshot(result.screenshot)
          return saved ? { ...output, screenshot: saved } : output
        }
        return output
      },
    }),
  )

  // The second route. It is deliberately a separate tool rather than a mode of the one
  // above: it answers a different question (what does this page say, all of it), it needs
  // no goal and no budget, and it spends no decision request, so neither tool's parameters
  // have to be explained in terms of the other's.
  ctx.tools.register(
    defineTool({
      name: 'jev_browser_read',
      description:
        'Read a whole page from top to bottom, without acting on it. Call it when the user asks to read or fetch one specific page in full — for example "jev浏览器读一下这个链接", "把这一页读完", "上网读一下这篇" — or when a task reported only the last screen, or whenever the question is what a page says rather than what it should do; when the user wants something done on a site, that is jev_browser_task instead. Scrolls one screen at a time, collects the visible text of each screen and returns it stitched together, so a document longer than one screen comes back complete. No decision model is called and nothing on the page is clicked, so this is the cheap way to read an article, a document, a changelog or a spec. Do not call it when the user merely mentions browsers in passing without asking for any page to be read.',
      parameters: {
        url: {
          type: 'string',
          required: true,
          description: 'The page to read.',
        },
        maxScreens: {
          type: 'number',
          description: `Stop after this many screens. Default ${DEFAULT_MAX_SCREENS}.`,
        },
        maxChars: {
          type: 'number',
          description: `Stop once this many characters have been collected. Default ${DEFAULT_MAX_CHARS}.`,
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            url: { type: 'string', required: true },
            title: { type: 'string', required: true },
            chars: { type: 'integer', required: true },
            screens: { type: 'integer', required: true },
            capped: { type: 'integer', required: true },
            stop: { type: 'string', required: true },
            reason: { type: 'string', required: true },
            note: { type: 'string', required: true },
            text: { type: 'string', required: true },
          },
        },
        render(args, value) {
          const summary = [
            `读全文：${args.url}`,
            `标题：${value.title || '（这个页面没有标题）'}`,
            `收了 ${value.screens} 屏、共 ${value.chars} 字 —— ${value.reason}`,
          ]
          if (value.capped > 0) {
            summary.push(`其中 ${value.capped} 屏正好顶到单屏上限（6000 字），那几屏的文字可能被截断`)
          }
          if (value.note) summary.push(value.note)
          const blocks: Array<{ type: 'text'; text: string }> = [{ type: 'text', text: summary.join('\n') }]
          if (value.text) blocks.push({ type: 'text', text: value.text })
          return blocks
        },
      },
      async execute(args, exec) {
        const ensured = await ensureBrowser({
          cdpUrl: config.cdpUrl.get() || undefined,
          userDataDir: config.userDataDir.get() || undefined,
          preferredKind: config.browserKind.get(),
          exeOverride: config.browserPath.get() || undefined,
          connection: config.browserConnection.get(),
        })
        const result = await readPage({
          url: args.url,
          maxScreens: args.maxScreens,
          maxChars: args.maxChars,
          signal: exec.signal,
          browser: {
            cdpUrl: ensured.endpoint.httpUrl || ensured.endpoint.wsUrl,
            userDataDir: config.userDataDir.get() || undefined,
            preferredKind: config.browserKind.get(),
            connection: config.browserConnection.get(),
          },
        })
        return {
          url: result.url,
          title: result.title,
          chars: result.chars,
          screens: result.screens.length,
          capped: result.capped,
          stop: result.stop,
          reason: result.reason,
          note: browserNote(config.browserConnection.get(), ensured),
          text: result.text,
        }
      },
    }),
  )

  // The settings page's host side, which also serves the inspector page next to it. It does
  // nothing where there is no Web UI.
  registerPanel(ctx, config)

  // And the way in that needs no model turn: the reader types the command themselves. It does
  // nothing where no interactive adapter is composed, which is the whole reason it lives behind
  // the same optional-service door as the settings page.
  registerCommand(ctx, config, llm)
}

/**
 * One run, in the shape the tool hands back. Exported so the mapping from a run's result to what a
 * reader is shown can be pinned as a whole rather than one field at a time.
 */
export function toOutput(result: TaskResult, note = ''): TaskOutput {
  return {
    status: result.status,
    reason: result.reason,
    unmet: result.unmet,
    answer: result.answer,
    note,
    url: result.page?.url ?? '',
    title: result.page?.title ?? '',
    text: (result.page?.text ?? '').slice(0, EVIDENCE_LIMIT),
    steps: result.steps,
    decisions: result.decisions,
    elapsedMs: result.elapsedMs,
    actions: result.history.map((entry, index) => {
      const typed =
        entry.kind === 'fill' && entry.text !== null ? `${entry.action} → 输入「${entry.text}」` : entry.action
      // Said only when the model itself was unsure. A step taken on a coin flip is worth
      // seeing; a step taken on 0.9 is not worth a line of noise on every step.
      const unsure =
        typeof entry.probability === 'number' && entry.probability < 0.5
          ? `（模型不太确定：${entry.probability.toFixed(2)}）`
          : ''
      const notes = followNotes(result.follows.filter((record) => record.step === index + 1))
      const line = `${typed}${unsure}`
      return notes.length === 0 ? line : `${line} → ${notes.join('；')}`
    }),
    elements: result.elements.map((element) => `[${element.index}] ${element.label} — ${element.operations.join('/')}`),
    textCalls: result.textCalls.length,
    verification: result.verification.note,
    omittedActions: result.omittedActions,
    sentElements: result.sentElements,
    omittedElements: result.omittedElements,
    textCut: result.textCut,
    deadEnds: deadEndNote(result.deadEnds, result.deadEndsExcluded),
    screenshot: '',
    recordDir: result.recordDir,
  }
}

/**
 * Put one screenshot on disk and hand back its path.
 *
 * The browser hands over base64 JPEG. The tool execution context carries no workspace
 * directory, so this goes to the system temp directory under a name of its own rather than
 * into whatever directory the server happens to have been started in. Nothing depends on
 * the file afterwards: a write that fails returns empty and the run is reported as usual.
 */
export function saveScreenshot(base64: string): string {
  try {
    const directory = join(tmpdir(), 'dsh-jev-ultrafast')
    mkdirSync(directory, { recursive: true })
    const path = join(directory, `screen-${Date.now()}.jpg`)
    writeFileSync(path, Buffer.from(base64, 'base64'))
    return path
  } catch {
    return ''
  }
}

// `launchNote` and `browserNote` live in ./run-setup with the rest of a run's assembly; they are
// exported from here as well, because this is where the tool and the tests already look for them.
export { browserNote, launchNote } from './run-setup'

/**
 * What to say about the tabs one step opened. A page the run moved onto is where that
 * step's effect was; one it left behind is still open in the browser. Saying which is
 * which is the difference between "nothing happened" and "it happened over there".
 *
 * Exported because it is pure and worth pinning: this line is the only place the user
 * reads that a click went somewhere else.
 */
export function followNotes(records: FollowRecord[]): string[] {
  return records.flatMap((record) =>
    record.appeared.map((page) => {
      const name = page.title || page.url
      if (record.adopted && (record.adopted === page || record.adopted.url === page.url)) {
        return `点开了新窗口「${name}」，已跟过去`
      }
      if (record.adopted) return `还点开了「${name}」，留在浏览器里没跟`
      return `点开了新窗口「${name}」，没有跟过去`
    }),
  )
}

/**
 * What to say when the page was bigger than one decision could read.
 *
 * A run decides on a selection whenever a page offers more elements, or more text, than one request
 * can carry; it is never told about the page whole. The pages that broke the audit's runs were
 * exactly those, so the summary has to say which of the two was cut and by how much — otherwise a
 * wrong decision and a decision made on part of the page read the same to whoever is looking.
 *
 * Exported because it is pure and worth pinning: this is the only place a reader learns that the
 * run did not see everything.
 */
export function cutNote(sent: number, omitted: number, textCut: number): string {
  const parts: string[] = []
  if (omitted > 0) {
    parts.push(`这一页元素太多，已按与目标的相关性裁到 ${sent} 项，另有 ${omitted} 项没有送去判断`)
  }
  if (textCut > 0) {
    const start = omitted > 0 ? '文字也太长' : '这一页文字太长'
    parts.push(`${start}，只把前面的 ${MAX_PAGE_TEXT} 字送去判断，后面还有 ${textCut} 字没有送去`)
  }
  return parts.length === 0 ? '' : `（${parts.join('；')}）`
}
