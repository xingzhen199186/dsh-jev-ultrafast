/**
 * The text helper: when a decision says TYPE_TEXT, a small model writes the value,
 * and nothing else.
 *
 * It has two doors, and the difference is only where address and key come from: a
 * preset provider is called directly with a base URL and a key resolved from the
 * harness store, while a DSH route is handed to the harness' own model service,
 * which owns both. The prompt, the parsing and the refusal to type anything it is
 * unsure about are identical either way.
 *
 * Ported from jev-ultrafast `jev_ultrafast/model.py` (`field_context`,
 * `field_text`)
 * (https://github.com/browser-use/jev-ultrafast, MIT, Copyright (c) 2026 Browser Use).
 *
 * Upstream was explicit that the executor never extracts a quoted literal from
 * the goal and never guesses: this helper is the only source of a typed value,
 * and if it cannot produce one, nothing is typed.
 */
import { recordable, type TraceSink } from '../artifacts'
import type { SnapshotAction } from '../browser/session'
import { requestSignal } from '../net'
import { FINAL_ANSWER, TEXT_VALUE } from '../prompts'
import type { HistoryEntry } from './typesafe'

/** One streamed chunk from DSH's model service; only text deltas matter here. */
export interface DshChunk {
  type: string
  text?: string
  /** The `finish` chunk's reason: the only place a failed or truncated route shows up. */
  reason?: unknown
}

/**
 * One bound call into DSH's own model service.
 *
 * The host half supplies this, because only it holds a context; the helper stays a
 * pure module that a test can drive with a fake stream. `provider` is the DSH route
 * id with the `dsh:` prefix already stripped.
 */
export interface DshTextCall {
  provider: string
  stream(options: {
    provider: string
    model: string
    system: string
    user: string
    maxTokens: number
    reasoningEffort?: string
    signal?: AbortSignal
  }): AsyncIterable<DshChunk>
}

/** Where typed values come from. */
export interface TextHelperSource {
  /** OpenAI-compatible base URL, for example `https://openrouter.ai/api/v1`. */
  baseUrl: string
  /** Credential resolved from the harness credential store per call. Unused for a DSH route. */
  apiKey: string
  model: string
  /**
   * `none` asks the provider to reason as little as possible, which is the right
   * posture for copying one value out of a goal; `auto` keeps the upstream
   * per-vendor default.
   */
  reasoning: 'none' | 'auto'
  /** Set when the chosen door is a DSH route instead of a preset provider. */
  dsh?: DshTextCall | undefined
  timeoutMs?: number
  /** The caller's cancellation, so a cancelled run stops spending immediately. */
  signal?: AbortSignal
  /** Where the raw exchange goes, when the caller asked for a record of the run. */
  trace?: TraceSink
}

/** What the helper is shown about the field it must fill. */
export interface FieldContext {
  goal: string
  field: { label: string; role: string; value: string }
  page: { title: string; text: string }
  recent_actions: Array<{ action: unknown; text: unknown }>
}

export interface TextResult {
  text: string
  model: string
  latencyMs: number
  usage: Record<string, unknown>
}

/** Build the helper's input. Kept separate so a stale retry can compare inputs. */
export function fieldContext(
  goal: string,
  action: SnapshotAction,
  page: { title: string; text: string },
  history: HistoryEntry[],
): FieldContext {
  return {
    goal,
    field: {
      label: String(action.label ?? ''),
      role: String(action.role ?? ''),
      value: String(action.value ?? ''),
    },
    page: { title: page.title, text: page.text.slice(0, 6000) },
    recent_actions: history.slice(-6).map((entry) => ({ action: entry.action, text: entry.text })),
  }
}

/** Ask for the value of one field. Throws rather than typing anything it is unsure about. */
export async function fieldText(source: TextHelperSource, context: FieldContext): Promise<TextResult> {
  if (source.dsh === undefined && !source.apiKey) {
    throw new Error(
      '这次决定需要在字段里填内容，但文本模型那一块还没有可用的密钥。请让用户在插件设置页' +
        '（设置 → Jev 浏览器）的「文本模型」里，把密钥粘到粘贴框里；或者把那一块的供应商换成 DSH 里已经配好的模型。' +
        '也可以让目标改成不需要输入文字的操作。',
    )
  }
  if (source.dsh !== undefined && !source.model.trim()) {
    throw new Error(
      '文本模型这一块选的是 DSH 内置的模型，但还没有选具体哪一个。请让用户在插件设置页' +
        '（设置 → Jev 浏览器）的「文本模型」里选一个模型，再重试。',
    )
  }
  const started = Date.now()
  // The two doors' own sentences are the helper's; what they mean *for a field* is added here,
  // so this door keeps saying exactly what it said before the shared call was named.
  let answer: { content: string; usage: Record<string, unknown> }
  try {
    answer = await askText(source, TEXT_VALUE, JSON.stringify(context))
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}，什么都没有输入`)
  }
  const content = answer.content
  let parsed: unknown
  try {
    parsed = JSON.parse(typeof content === 'string' ? content : '')
  } catch {
    throw new Error('文本模型没有返回可用的字段值，什么都没有输入')
  }
  const record = parsed as { text?: unknown } | null
  const value = record?.text
  if (Object.keys(record ?? {}).length !== 1 || typeof value !== 'string' || !value.trim() || value.length > 2000) {
    throw new Error('文本模型没有返回可用的字段值，什么都没有输入')
  }
  return {
    text: value,
    model: source.model,
    latencyMs: Date.now() - started,
    usage: answer.usage,
  }
}

/** What the helper is shown when it is asked for the run's own answer, once, at the end of a run. */
export interface AnswerContext {
  goal: string
  page: { title: string; text: string }
}

/**
 * The model read the page and said the goal's result was not on it: `{"text": null}`, the answer
 * `FINAL_ANSWER` offers for a page with nothing to report.
 *
 * Neither a sentence nor a failure. The question was answered, and the answer is about the page —
 * so it travels as its own kind of error rather than as a `TextResult`, which this door only ever
 * uses for words that were written, and a caller holding a `TextResult` is holding words. The
 * distinction is the whole point of the class: `loop.ts` carries it to the reader as the model's
 * own judgement, where the plain `Error` below is a model that never handed a sentence over at all.
 */
export class NoResultOnPage extends Error {
  constructor() {
    super('文本模型说最后这一页没有目标的结果')
    this.name = 'NoResultOnPage'
  }
}

/**
 * Ask, once, for the result in the model's own words: the one thing an operation table cannot carry.
 *
 * Same door and same one-key JSON shape as the field value above, with the question changed — that
 * one copies a value into a field, this one says what the page came back with. It refuses in the
 * same way and for the same reason: a sentence nobody wrote is worse than no sentence at all. What
 * differs is what the caller does with the refusal, and that belongs to the caller — `loop.ts` reads
 * every failure here as "there is nothing to say" and lets the run end exactly as it would have
 * without asking, so this call can never fail a run that would otherwise have succeeded.
 *
 * The length is the one rule it does not share with the field door. A 2000-character field value is
 * a model that has lost the thread; a list read off a page is not, and the goal may have asked for
 * exactly that. The question asks for a few sentences and the answer is taken as it comes.
 *
 * Three things can leave here, and the caller can tell them apart: the sentence (`TextResult`), the
 * model's own "this page shows no result for the goal" (`NoResultOnPage`), and everything else —
 * not JSON, the wrong key, the wrong type, a call that never came back — as a plain `Error`. Only
 * the literal `null` is the middle one: an empty string, a missing key and a second key are all a
 * model that did not answer the question, and are read as such.
 */
export async function answerText(source: TextHelperSource, context: AnswerContext): Promise<TextResult> {
  const started = Date.now()
  const answer = await askText(source, FINAL_ANSWER, JSON.stringify(context))
  const content = answer.content
  let parsed: unknown
  try {
    parsed = JSON.parse(typeof content === 'string' ? content : '')
  } catch {
    throw new Error('文本模型没有给出可用的结论')
  }
  const record = parsed as { text?: unknown } | null
  const value = record?.text
  const keys = Object.keys(record ?? {})
  if (keys.length === 1 && value === null) throw new NoResultOnPage()
  if (keys.length !== 1 || typeof value !== 'string' || !value.trim()) {
    throw new Error('文本模型没有给出可用的结论')
  }
  return {
    text: value,
    model: source.model,
    latencyMs: Date.now() - started,
    usage: answer.usage,
  }
}

/**
 * How much the small questions are allowed to write back.
 *
 * Every one of these calls wants one short value: a field's text, the site a sentence is about, a
 * one-key probe answer. The ceiling is not a target — a model stops when it is done — so it only
 * ever does one of two things: stop a runaway, or cut a real answer off. It cut a real answer off
 * once already: on a route where the model thinks first, the thinking and the answer share this one
 * budget, and a tight cap was spent entirely on thinking, so the answer never got written and the
 * reader was told the model "said nothing".
 *
 * So the ceiling is the reader's own number, 393216: high enough that no model asked one short
 * question could reach it, which makes it a number that can never be the reason that question failed.
 * A route that refuses a number above its model's own limit is handled by the retry in `askText`.
 */
export const HELPER_MAX_TOKENS = 393_216

/** What the second try uses when a refusal names no limit of its own. Well within every route's. */
const FALLBACK_MAX_TOKENS = 8192

/**
 * How long one question to the text model may take: five minutes.
 *
 * The reader's ruling of 2026-10-04, set after watching the earlier limit fail twice: 25 seconds
 * killed mimo-v2.6-flash mid-reasoning (measured — 154 characters of thinking at 25 012 ms) and
 * reported a working route as a dead one. Five minutes gives a thinking model room for the big
 * questions (a page's text plus a JSON demand), while a route that is genuinely gone still fails
 * well before the reader would have stopped waiting himself.
 */
const TEXT_TIMEOUT_MS = 300_000

/**
 * The limit a refusal names, when it names one.
 *
 * Anthropic answers "max_tokens: 393216 > 8192, which is the maximum allowed"; OpenAI answers
 * "max_tokens is too large ... supports at most 16384 completion tokens"; the mimo line behind DSH
 * answers "'max_tokens' 257737 is out of supported range (0, 131072]" — and that last sentence is
 * why the *smallest* surviving number is the one to take. It carries two numbers: the value the
 * harness clamped our request to on the way out (257737, below the 393216 we asked for, so the
 * refused-number filter keeps it), and the route's real ceiling (131072). The largest of the two
 * would retry with the very number that was refused and fail the same way twice — measured
 * 2026-10-04, that is exactly how a run died. Every number in such a sentence claims to be some
 * limit; the smallest claim never exceeds any of them, and one that is too low only cuts the
 * answer short, while one that is too high cannot succeed at all.
 *
 * The floor is there because this sentence is our own wrapper around the vendor's words and also
 * carries the HTTP status: a status code is not a limit, and reading `400` as one would ask the
 * second time with 400 tokens — a ceiling low enough to cut the answer off by itself.
 */
function ceilingFromRefusal(said: string, requested: number): number {
  const numbers = (said.match(/\d{3,7}/g) ?? [])
    .map(Number)
    .filter((value) => value >= 1024 && value < requested)
  return numbers.length > 0 ? Math.min(...numbers) : FALLBACK_MAX_TOKENS
}

/**
 * One plain question to the chosen text model, through either door.
 *
 * The field door was the only caller for a while, so both doors carried its prompt and its
 * record shape inside them. Naming the shared part is what lets the command ask the same model
 * a different question — where should this run start — without a second copy of the two doors,
 * their retry rule and their traces. `content` is the model's own answer, unparsed.
 *
 * A refusal aimed at the ceiling is not a refusal of the question: some vendors reject a number
 * above their model's maximum output before reading a word, so that case is asked again with the
 * limit the refusal itself named. Any other error is the door's own answer and is passed straight on.
 */
export async function askText(
  source: TextHelperSource,
  system: string,
  user: string,
  maxTokens = HELPER_MAX_TOKENS,
): Promise<{ content: string; usage: Record<string, unknown> }> {
  try {
    return await askOnce(source, system, user, maxTokens)
  } catch (error) {
    const said = error instanceof Error ? error.message : String(error)
    if (maxTokens <= FALLBACK_MAX_TOKENS || !/max[\s_-]?tokens?/i.test(said)) throw error
    return await askOnce(source, system, user, ceilingFromRefusal(said, maxTokens))
  }
}

async function askOnce(
  source: TextHelperSource,
  system: string,
  user: string,
  maxTokens: number,
): Promise<{ content: string; usage: Record<string, unknown> }> {
  if (source.dsh === undefined) {
    const answer = await post(source, system, user, maxTokens)
    return { content: typeof answer.content === 'string' ? answer.content : '', usage: answer.usage }
  }
  return { content: await streamViaDsh(source, system, user, maxTokens), usage: {} }
}

/** The direct door: one OpenAI-compatible request to a preset provider. */
async function post(
  source: TextHelperSource,
  system: string,
  user: string,
  maxTokens: number,
): Promise<{ content: unknown; usage: Record<string, unknown> }> {
  const body: Record<string, unknown> = {
    model: source.model,
    max_tokens: maxTokens,
    response_format: { type: 'json_object' },
    ...reasoningFor(source),
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  }
  const began = Date.now()
  // 429/529/503 mean "later", not "no": two backoff retries, the same rule the
  // decision call follows (see typesafe.ts). A refusal that could have been a real
  // answer is never retried, and neither is a connection failure — the run stops
  // with a sentence the user can act on rather than spending the same call again.
  let transient = 0
  for (;;) {
    let response: Response
    try {
      response = await fetch(`${source.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${source.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: requestSignal(source.timeoutMs ?? TEXT_TIMEOUT_MS, source.signal),
      })
    } catch {
      source.trace?.write({ at: Date.now(), kind: 'text', door: 'preset', model: source.model, error: '连接文本模型失败' })
      throw new Error('连接文本模型失败，什么都没有输入')
    }
    // The body is read once: the retry rule, the error line and the trace all want it.
    let reply: Record<string, any> = {}
    try {
      reply = JSON.parse(await response.text()) as Record<string, any>
    } catch {
      reply = {}
    }
    source.trace?.write({
      at: Date.now(),
      kind: 'text',
      door: 'preset',
      model: source.model,
      attempt: transient,
      status: response.status,
      request: recordable(body, source.apiKey),
      response: recordable(reply, source.apiKey),
      took_ms: Date.now() - began,
    })
    if ([429, 529, 503].includes(response.status) && transient < 2) {
      await delay(500 * 2 ** transient)
      transient += 1
      continue
    }
    if (!response.ok) {
      // The vendor's own words, when it sent any: a 400 whose reason is thrown away is the kind of
      // report that costs an hour, and one of those reasons is the ceiling this module sends.
      const said = typeof reply.error?.message === 'string' ? reply.error.message : ''
      throw new Error(
        `文本模型返回 HTTP ${response.status}${said ? `（${said.slice(0, 200)}）` : ''}，什么都没有输入`,
      )
    }
    return {
      content: reply.choices?.[0]?.message?.content,
      usage: typeof reply.usage === 'object' && reply.usage !== null ? reply.usage : {},
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * The built-in door: ask DSH's own model service for a route the user configured in
 * DSH. No address and no key appear here on purpose — DSH owns both, which is the
 * only reason its models are offered as a choice at all.
 *
 * A DSH route that is not registered streams nothing instead of throwing, so an
 * empty reply is reported as "nothing was typed" rather than trusted.
 */
async function streamViaDsh(
  source: TextHelperSource,
  system: string,
  user: string,
  maxTokens: number,
): Promise<string> {
  const call = source.dsh as DshTextCall
  const began = Date.now()
  let text = ''
  // The harness turns an adapter failure into a terminal `finish` reason instead of throwing,
  // so an empty answer has two very different meanings ("the route failed" / "it only thought")
  // that both live in this one value. Throwing them away is what makes a report unreadable.
  let reasoningChars = 0
  let finish = ''
  try {
    for await (const chunk of call.stream({
      provider: call.provider,
      model: source.model,
      system,
      user,
      maxTokens,
      // `reasoning` deliberately asks for nothing here. There is no portable way to say "do not
      // think" on this door: `reasoningEffort` is a value each model declares for itself, and
      // inventing `'off'` for a model that does not offer it fails the whole call
      // (UNSUPPORTED_REASONING_EFFORT) — which reports a working route as broken, and did.
      // The preset door can honour `none` because it speaks each vendor's own shape; this one
      // leaves reasoning to DSH and the model behind it.
      signal: requestSignal(source.timeoutMs ?? TEXT_TIMEOUT_MS, source.signal),
    })) {
      if (chunk.type === 'text-delta') text += chunk.text ?? ''
      else if (chunk.type === 'reasoning-delta') reasoningChars += (chunk.text ?? '').length
      else if (chunk.type === 'finish') finish = describeFinish(chunk.reason)
    }
  } catch (error) {
    // A cancelled run stays cancelled; a deadline or a provider failure becomes the
    // only claim this helper is allowed to make — that nothing was typed.
    source.trace?.write({
      at: Date.now(),
      kind: 'text',
      door: 'dsh',
      model: source.model,
      error: error instanceof Error ? error.message : String(error),
      took_ms: Date.now() - began,
    })
    if (source.signal?.aborted) throw error
    throw new Error('走 DSH 内置的文本模型失败，什么都没有输入')
  }
  // A DSH route that is registered but empty streams nothing rather than failing, so
  // the trace is the only place the difference between "said nothing" and "failed"
  // survives.
  source.trace?.write({
    at: Date.now(),
    kind: 'text',
    door: 'dsh',
    model: source.model,
    ok: text.trim() !== '',
    finish,
    reasoning_chars: reasoningChars,
    request: recordable({ system, user }),
    response: recordable({ text }),
    took_ms: Date.now() - began,
  })
  if (!text.trim()) throw new Error(emptyDshAnswer(finish, reasoningChars))
  return text
}

/** What a `finish` chunk says, as one short line a reader can act on. */
function describeFinish(reason: unknown): string {
  if (typeof reason === 'string') return reason
  const record = reason as { kind?: unknown; failure?: { code?: unknown; message?: unknown } } | null
  const parts = [record?.kind, record?.failure?.code, record?.failure?.message]
  return parts.filter((part): part is string => typeof part === 'string' && part !== '').join('/')
}

/**
 * Why nothing came back, said in the reader's terms.
 *
 * A route that failed and a model that spent its whole budget on thinking look identical from
 * outside — both stream no text — but only one of them is fixed by choosing a different model.
 */
function emptyDshAnswer(finish: string, reasoningChars: number): string {
  // "aborted" is not the route being broken: the request was cut off before an answer arrived.
  // Two very different causes hide behind it — our own deadline, and someone calling off the
  // request — so the sentence names both possibilities instead of blaming the reader's settings.
  if (finish.startsWith('aborted')) {
    return '这一问还没等到答复就被中断了（多半是服务端断开，或这次会话被中止），什么都没有输入'
  }
  if (finish.startsWith('error')) {
    return `走 DSH 内置的文本模型失败（${finish}），什么都没有输入`
  }
  if (finish.startsWith('max-tokens')) {
    return '文本模型把这一问的输出额度用完了、正文还没写出来（换一个不思考的模型试试；走插件直连那条路时，这一页设置里的「思考」也管用），什么都没有输入'
  }
  if (reasoningChars > 0) {
    return '文本模型只在思考里写了内容、正文是空的（换一个不思考的模型试试；走插件直连那条路时，这一页设置里的「思考」也管用），什么都没有输入'
  }
  return '文本模型没有返回可用的字段值，什么都没有输入'
}

/**
 * How to ask for as little reasoning as possible. DeepSeek spells it differently
 * from the OpenAI-compatible default, which is why upstream carried both forms.
 */
function reasoningFor(source: TextHelperSource): Record<string, unknown> {
  if (source.reasoning === 'none') return { reasoning: { enabled: false } }
  if (source.baseUrl.includes('api.deepseek.com/')) return { thinking: { type: 'disabled' } }
  return { reasoning: { effort: 'low' } }
}
