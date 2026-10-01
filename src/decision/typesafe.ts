/**
 * The decision layer: build the request TypeSafe answers, and read that answer
 * back under strict validation.
 *
 * Ported from jev-ultrafast `jev_ultrafast/model.py` (`choose`, `validate_choice`,
 * `post_json`)
 * (https://github.com/browser-use/jev-ultrafast, MIT, Copyright (c) 2026 Browser Use).
 *
 * Two things are deliberately different from upstream:
 *
 *  - The endpoint, the model and the credential are configuration rather than
 *    constants, so the same code can talk to the vendor's own endpoint or to a
 *    reseller route without a code change.
 *  - Building the request and reading the answer are separate pure functions, so
 *    the validation rules can be tested without a key and without the network.
 *
 * The validation is not decoration. The service answers with a probability
 * distribution over the choices *we* offered; anything else — a choice we never
 * offered, probabilities that do not sum to one, a winner that is not the most
 * probable choice — is a malformed answer, and the caller must execute nothing.
 */
import { recordable, redactUrl, type TraceSink } from '../artifacts'
import type { SnapshotAction } from '../browser/session'
import { requestSignal } from '../net'
import { MAX_PAGE_TEXT, NEXT_ACTION, TARGET } from '../prompts'
import type { ActionSpace } from './action-space'
import type { DecisionKeyShape } from './providers'

/** The decision service returned something we cannot safely act on. */
export class InvalidDecision extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidDecision'
  }
}

/** One executed step, as it is recorded and as it is shown back to the service. */
export interface HistoryEntry {
  step: number
  /** The label of the target that was executed. */
  action: string
  kind: string
  /** The action id the decision chose. */
  choice: string
  probability: number
  confidence: number
  latency_ms: number
  text: string | null
  text_helper: string | null
  text_latency_ms: number
  operation: string
  target: string | null
  /** Whether the page changed afterwards; `null` until it has been observed. */
  page_changed: boolean | null
  url: string
  usage: Record<string, unknown>
  executed_ms: number
  elapsed_ms: number
}

/** Everything the decision layer needs that is not page state. */
export interface DecisionContext {
  goal: string
  page: { url: string; title: string; text: string }
  history: HistoryEntry[]
  /**
   * One plain sentence for this request only, when the run has something to say that page
   * state cannot: the element the last answer named is no longer on the page (see
   * `loop.ts`), or the page's content sits where the snapshot cannot reach (see
   * `browser/nested.ts`). Absent on an ordinary step.
   */
  note?: string
  /**
   * How many of the page's own elements this request's table left out, because the page offered more
   * than one request can carry (see `action-space.ts`). Absent when there were none. The service is
   * told the number so it reads the table as a selection rather than as the whole page; what it is not
   * told is anything about the elements themselves, which are simply not there.
   *
   * An element the run ruled out as a dead end is deliberately not counted here: it stays in the table
   * and is only taken out of the questions that offer it, so the table is still the page's own and the
   * count stays the cap's own arithmetic (see `dead-ends.ts`).
   */
  omittedElements?: number
}

/**
 * Which credential a run's key was read from: its name, its door, and the shape that door's key
 * is known to have.
 *
 * It exists so a refusal can say what was read instead of only what came back. A 401 whose whole
 * text is the status code cannot be told apart from a wrong address or a wrong model name, and the
 * reader is left with nothing to check; this is the smallest thing that changes that. A *value*
 * never travels here — a name, a length and a short prefix are all it can carry.
 */
export interface KeyOrigin {
  /** The credential name the value was read from. Never the value. */
  ref: string
  /** The door, as the settings page names it. */
  label: string
  /** The shape this door's key has, when it is known. */
  shape?: DecisionKeyShape
}

/** Where decisions come from, and with whose credential. */
export interface DecisionSource {
  /** Full URL of the decision endpoint, for example `https://api.typesafe.ai/v1/systemone`. */
  endpoint: string
  /** Bearer credential, resolved from the harness credential store per call. */
  apiKey: string
  /** Model the endpoint should route to, for example `jev-latest`. */
  model: string
  timeoutMs?: number
  /**
   * Which cell `apiKey` came from, when the caller knows. Absent is allowed — a caller with no
   * credential to name gets the refusal as it was before this was carried.
   */
  keyOrigin?: KeyOrigin
  /**
   * Whether a rejected body may be retried once inside a `decisionsRequest`
   * envelope. OpenRouter's alpha route has been seen to want that envelope;
   * TypeSafe's own endpoint takes the flat body. Defaults to off.
   */
  wrapFallback?: boolean
  /** The caller's cancellation, so a cancelled run stops spending immediately. */
  signal?: AbortSignal
  /** Where the raw exchange goes, when the caller asked for a record of the run. */
  trace?: TraceSink
}

/** One validated answer to one choice question. */
export interface ChoiceAnswer {
  choice: string
  confidence: number
  probabilities: Record<string, number>
}

/** The exact questions asked, kept so the answers can be validated against them. */
export interface Questionnaire {
  request: Record<string, unknown>
  /** Answers the operation question may legally give. */
  operations: string[]
  /** Answers each `<operation>_target` question may legally give. */
  targetIds: Record<string, string[]>
}

/** A decision that passed validation: the operation, the target, and the odds behind them. */
export interface Decision {
  /** Action id to execute, or `DONE` / `BLOCKED`. */
  choice: string
  operation: string
  target: string | null
  confidence: number
  /** Probability per action id, so a run log can show what the runner-up was. */
  probabilities: Record<string, number>
  operationProbabilities: Record<string, number>
  targetProbabilities: Record<string, number>
  targetConfidence: number | null
  usage: Record<string, unknown>
  model: string
  latencyMs: number
}

/** Human-readable descriptions of the four element operations. */
const OPERATION_LABELS: Record<string, string> = {
  CLICK: 'Click an element, button, menu option, autocomplete suggestion, or calendar day.',
  TYPE_TEXT: 'Enter or replace text in an editable field. A small LLM will supply the value from the goal.',
  SELECT: 'Select an observed dropdown value.',
  PRESS_KEY:
    'Press one key on an element — Enter, Escape, Tab, ArrowDown or ArrowUp — to choose from the list ' +
    'that element opened or to dismiss it; the element is clicked first.',
}

/**
 * Build the single request that decides both the operation and every operation's
 * target. The target questions are answered in the same round trip, so there is
 * no serial operation-then-target call and no chance of a target that does not
 * belong to the chosen operation.
 */
export function buildQuestionnaire(space: ActionSpace, context: DecisionContext, model: string): Questionnaire {
  const operations: Record<string, string> = {}
  for (const operation of Object.keys(space.targets)) {
    operations[operation] = OPERATION_LABELS[operation] ?? operation
  }
  for (const [name, control] of Object.entries(space.controls)) operations[name] = control.label
  operations.DONE =
    'Every requirement in the goal is satisfied, and the page itself shows the proof: the names, ' +
    'numbers, dates, prices, distances or confirmation the goal asks for appear in the page text or ' +
    'in the element list. A page that only looks like the right screen is not DONE.'
  operations.BLOCKED =
    'No offered operation can move the goal forward: the control this step needs is not on the page, ' +
    'or is disabled or unreachable, and no offered element can change that. Say BLOCKED only when the ' +
    'page shows that, never because a step was already tried.'

  const questions: Record<string, unknown> = {
    operation: {
      type: 'choice',
      criteria: operations,
      instructions: { goal: context.goal, rules: NEXT_ACTION },
    },
  }
  const targetIds: Record<string, string[]> = {}
  for (const [operation, candidates] of Object.entries(space.targets)) {
    const criteria: Record<string, unknown> = {}
    for (const [index, action] of Object.entries(candidates)) {
      criteria[index] = {
        element: `[${index}] ${action.label}`,
        current_value: action.current_value ?? action.value ?? '',
        ...pick(action, ['role', 'checked', 'selected', 'expanded']),
      }
    }
    questions[`${operation.toLowerCase()}_target`] = {
      type: 'choice',
      criteria,
      instructions: { goal: context.goal, operation, rules: [NEXT_ACTION, TARGET] },
    }
    targetIds[operation] = Object.keys(candidates)
  }

  const request = {
    model,
    state: {
      page: { url: context.page.url, title: context.page.title, text: cappedText(context.page.text) },
      // Sits with the page it is about, and only when there is something to say: an empty
      // field would be one more thing for the service to read on every step.
      ...(context.note ? { note: context.note } : {}),
      // Said next to the table it is about, and only when the table is a selection: a page that
      // offered more than one request can carry is not the same page as one that offered exactly
      // this much, and the service is the one being asked to decide about it.
      ...(context.omittedElements ? { elements_omitted: context.omittedElements } : {}),
      elements: space.elements,
      recent_actions: context.history.slice(-10).map((entry) => pick(entry, ['action', 'kind', 'text', 'page_changed'])),
    },
    questions,
  }
  return { request, operations: Object.keys(operations), targetIds }
}

/**
 * The size of the body one decision request would carry, in characters.
 *
 * Exported because the request is the only thing whose size matters, and the caller is the one that
 * decides how much of the page goes into it: counting the elements and the page-text characters is
 * arithmetic, and arithmetic cannot see how long a page's own labels are (see `prompts.ts`).
 */
export function requestChars(space: ActionSpace, context: DecisionContext, model: string): number {
  return JSON.stringify(buildQuestionnaire(space, context, model).request).length
}

/**
 * Page-text characters one request has to leave out; `0` when the whole text fits.
 *
 * Shared rather than recomputed, so the request and the run that reports it cannot disagree about
 * whether the page was cut.
 */
export function textLeftOut(text: string): number {
  return Math.max(0, text.length - MAX_PAGE_TEXT)
}

/**
 * The page text as this request may carry it.
 *
 * The cut is marked where it happened and says how much was left out, so a service reading the
 * text knows it is reading the top of a longer page rather than the whole of a short one. The cut
 * touches the page text only: the URL, the title, the element table and the recent actions are
 * sized on their own terms and are never sliced mid-value.
 */
function cappedText(text: string): string {
  const left = textLeftOut(text)
  if (left === 0) return text
  return `${text.slice(0, MAX_PAGE_TEXT)}\n[... page text cut here: ${left} more characters of this page were not sent ...]`
}

/** Three decimals is enough to read a probability back; more only makes the sentence longer. */
function odds(value: number): string {
  return String(Math.round(value * 1000) / 1000)
}

/**
 * A short stand-in for whatever the service put where an answer was expected.
 *
 * Only ever handed an answer, never page state, so no page text can reach a message
 * through here. Strings are cut off because the interesting part of "it sent us this"
 * is the shape, not the whole body.
 */
function seen(value: unknown): string {
  if (value === undefined) return '什么都没有'
  if (value === null) return 'null'
  if (Array.isArray(value)) return `一个数组（${value.length} 项）`
  if (typeof value === 'object') {
    const keys = Object.keys(value as object)
    if (keys.length === 0) return '一个空对象'
    return `一个对象（含 ${keys.slice(0, 5).join('、')}${keys.length > 5 ? ' 等' : ''}）`
  }
  if (typeof value === 'string') return value.length > 40 ? `「${value.slice(0, 40)}…」` : `「${value}」`
  return String(value)
}

/**
 * Why one answer cannot be acted on, said so the reader knows what came back and what
 * was wrong with it.
 *
 * This used to be one sentence for every failure, and the one failure that actually
 * stops runs — a distribution whose stated winner is not its most probable choice (the
 * service answering "CLICK" over a 0.37 "TYPE_TEXT" with 0.36) — was indistinguishable
 * from a network or parsing problem. Naming the winner and the runner-up is the evidence
 * a reader needs to tell "the service is unsure" apart from "we asked it badly".
 * `label` names an element index when the question is a target question; it is the same
 * label the question itself carried.
 */
function whyUnusable(answer: unknown, ids: string[], label?: (id: string) => string | undefined): string {
  if (typeof answer !== 'object' || answer === null || Array.isArray(answer)) {
    return `这一问的回答不是一个对象：收到 ${seen(answer)}`
  }
  const record = answer as { choice?: unknown; confidence?: unknown; probabilities?: unknown }
  const { choice, confidence, probabilities } = record

  if (typeof probabilities !== 'object' || probabilities === null || Array.isArray(probabilities)) {
    return `这一问没有给出可用的概率表：收到 ${seen(probabilities)}`
  }

  const entries = Object.entries(probabilities as Record<string, unknown>)
  const offScale = entries.find(
    ([, value]) => typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1,
  )
  if (offScale) return `概率表里「${offScale[0]}」的概率不是 0 到 1 的数字：收到 ${seen(offScale[1])}`

  if (entries.length !== ids.length || entries.some(([key]) => !ids.includes(key))) {
    const extra = entries.filter(([key]) => !ids.includes(key)).map(([key]) => key)
    const missing = ids.filter((id) => !entries.some(([key]) => key === id))
    return (
      `概率表覆盖的选项与问题里列出的对不上：问题给了 ${ids.length} 个，回答里是 ${entries.length} 个` +
      (extra.length > 0 ? `，多出 ${extra.slice(0, 3).join('、')}` : '') +
      (missing.length > 0 ? `，缺少 ${missing.slice(0, 3).join('、')}` : '')
    )
  }

  const named = (id: string): string => {
    const name = label?.(id)
    return name ? `${id}「${name}」` : id
  }

  if (typeof choice !== 'string' || !ids.includes(choice)) {
    return `它给出的选择 ${seen(choice)} 不在问题列出的选项里`
  }
  if (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    return `它给出的把握度不是 0 到 1 的数字：收到 ${seen(confidence)}`
  }

  const values = entries.map(([, value]) => value as number)
  const total = values.reduce((sum, value) => sum + value, 0)
  if (Math.abs(total - 1) >= 0.02) return `概率加起来不等于 1：实际是 ${odds(total)}`

  const top = Math.max(...values)
  const chosen = (probabilities as Record<string, number>)[choice]!
  if (chosen < top - 1e-6) {
    const winners = entries.filter(([, value]) => (value as number) >= top - 1e-9).map(([key]) => key)
    return (
      `它选的是 ${named(choice)}（概率 ${odds(chosen)}），但概率最高的是 ` +
      `${winners.map(named).join('、')}（概率 ${odds(top)}）——这一问它自己没拿定主意`
    )
  }
  return '回答缺少必需的字段'
}

/**
 * Validate one answer against the choices its question actually offered.
 * A probability distribution that does not cover exactly those choices, or whose
 * winner is not the most probable one, is a broken answer rather than a decision.
 *
 * `question` and `label` exist only to make the refusal readable; neither changes what
 * is accepted. A caller that passes neither gets the same validation as before.
 */
export function validateChoice(
  answer: unknown,
  ids: string[],
  question = '这一问',
  label?: (id: string) => string | undefined,
): ChoiceAnswer {
  const record = answer as { choice?: unknown; confidence?: unknown; probabilities?: unknown } | null | undefined
  const probabilities = record?.probabilities
  const { choice, confidence } = record ?? {}

  let valid =
    typeof choice === 'string' &&
    typeof confidence === 'number' &&
    typeof probabilities === 'object' &&
    probabilities !== null &&
    !Array.isArray(probabilities)

  if (valid) {
    const entries = Object.entries(probabilities as Record<string, unknown>)
    const numbers = [...entries.map(([, value]) => value), confidence]
    valid =
      ids.includes(choice as string) &&
      entries.length === ids.length &&
      entries.every(([key]) => ids.includes(key)) &&
      numbers.every((value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1) &&
      Math.abs(entries.reduce((sum, [, value]) => sum + (value as number), 0) - 1) < 0.02 &&
      (probabilities as Record<string, number>)[choice as string]! >=
        Math.max(...entries.map(([, value]) => value as number)) - 1e-6
  }

  if (!valid) {
    throw new InvalidDecision(
      `决策服务返回了无法执行的结果，没有执行任何动作：「${question}」${whyUnusable(answer, ids, label)}`,
    )
  }
  return {
    choice: choice as string,
    confidence: confidence as number,
    probabilities: probabilities as Record<string, number>,
  }
}

/**
 * Read a validated decision out of one service response.
 * Only the target head belonging to the chosen operation is consumed; the other
 * target heads cannot cause an action even if they are malformed.
 */
export function readDecision(payload: unknown, space: ActionSpace, questionnaire: Questionnaire): Decision {
  const answers = (payload as { answers?: Record<string, unknown> } | null)?.answers
  if (typeof answers !== 'object' || answers === null) {
    throw new InvalidDecision(`决策服务没有返回 answers 字段（收到 ${seen(payload)}），没有执行任何动作`)
  }

  const operationAnswer = validateChoice(answers.operation, questionnaire.operations, '下一步该做哪个操作')
  const operation = operationAnswer.choice

  let choice: string
  let target: string | null = null
  let targetAnswer: ChoiceAnswer | null = null
  const probabilities: Record<string, number> = {}

  const candidates = space.targets[operation]
  if (candidates) {
    targetAnswer = validateChoice(
      answers[`${operation.toLowerCase()}_target`],
      questionnaire.targetIds[operation]!,
      `用 ${operation} 时该选哪个元素`,
      (id) => candidates[id]?.label.split(' → ')[0],
    )
    target = targetAnswer.choice
    for (const [index, action] of Object.entries(candidates)) {
      probabilities[action.id] = targetAnswer.probabilities[index]!
    }
    choice = candidates[target]!.id
  } else {
    const control = space.controls[operation]
    choice = control ? control.id : operation
    probabilities[choice] = operationAnswer.probabilities[operation]!
  }

  return {
    choice,
    operation,
    target,
    confidence: operationAnswer.confidence,
    probabilities,
    operationProbabilities: operationAnswer.probabilities,
    targetProbabilities: targetAnswer?.probabilities ?? {},
    targetConfidence: targetAnswer?.confidence ?? null,
    usage: {},
    model: '',
    latencyMs: 0,
  }
}

/** Ask for one decision and validate it. */
export async function choose(
  source: DecisionSource,
  space: ActionSpace,
  context: DecisionContext,
): Promise<Decision> {
  const questionnaire = buildQuestionnaire(space, context, source.model)
  const started = Date.now()
  const payload = await postJson(
    source.endpoint,
    source.apiKey,
    questionnaire.request,
    source.timeoutMs,
    source.signal,
    source.wrapFallback ?? false,
    source.trace,
    source.keyOrigin,
  )
  const decision = readDecision(payload, space, questionnaire)
  return {
    ...decision,
    model: typeof payload.model === 'string' ? payload.model : source.model,
    usage: typeof payload.usage === 'object' && payload.usage !== null ? (payload.usage as Record<string, unknown>) : {},
    latencyMs: Date.now() - started,
  }
}

/**
 * POST with the same transport posture as upstream: retries only on the status
 * codes that mean "later", never on a refusal that could have been a real answer,
 * and nothing here touches the browser.
 *
 * One thing upstream did not need: `wrapFallback`. A body the service refuses with
 * 400/422 may be refused for its *shape* — the alpha route has been seen to want the
 * whole request inside a `decisionsRequest` envelope — so for those two codes only,
 * and only once, the same body is sent again wrapped. The flat body always goes
 * first: the envelope is a documented-by-experience fallback, not a guess.
 */
async function postJson(
  url: string,
  key: string,
  body: unknown,
  timeoutMs = 25_000,
  signal?: AbortSignal,
  wrapFallback = false,
  trace?: TraceSink,
  keyOrigin?: KeyOrigin,
): Promise<Record<string, any>> {
  const began = Date.now()
  let wrapped = false
  let transient = 0
  for (;;) {
    let response: Response
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify(wrapped ? { decisionsRequest: body } : body),
        signal: requestSignal(timeoutMs, signal),
      })
    } catch {
      trace?.write({ at: Date.now(), kind: 'decision', url: redactUrl(url), wrapped, error: '连接决策服务失败' })
      throw new Error('连接决策服务失败，没有执行任何动作')
    }
    // The body is read once: the retry rule, the refusal detail and the trace all want it.
    let reply: Record<string, any> = {}
    let raw = ''
    try {
      raw = await response.text()
      reply = JSON.parse(raw) as Record<string, any>
    } catch {
      reply = {}
    }
    trace?.write({
      at: Date.now(),
      kind: 'decision',
      url: redactUrl(url),
      wrapped,
      attempt: transient,
      status: response.status,
      request: recordable(wrapped ? { decisionsRequest: body } : body, key),
      response: recordable(reply, key),
      took_ms: Date.now() - began,
    })
    if (wrapFallback && !wrapped && [400, 422].includes(response.status)) {
      wrapped = true
      continue
    }
    if ([429, 529, 503].includes(response.status) && transient < 2) {
      await delay(500 * 2 ** transient)
      transient += 1
      continue
    }
    if (!response.ok) {
      const detail = flatDetail(raw, key)
      // Only a 401 is taken as "this key was refused": it is the status the decision service uses
      // for a credential it does not recognize, and the one an end-to-end run hit. Every other
      // refusal keeps the plain sentence, so the added line stays a diagnosis rather than noise.
      const keyNote = response.status === 401 && keyOrigin !== undefined ? `。${keyRefusal(keyOrigin, key)}` : ''
      throw new Error(
        `决策服务返回 HTTP ${response.status}，没有执行任何动作` +
          (detail ? `（服务端原话：${detail}）` : '') +
          (wrapped ? '（已经试过带 decisionsRequest 包裹的写法）' : '') +
          keyNote,
      )
    }
    return reply
  }
}

/**
 * The service's own words about a refusal, on one line and short enough to read.
 *
 * The message used to be the status code alone, and that cannot tell apart the two
 * things that need different fixes: a credential the service does not recognize, and
 * a request it does not like. An end-to-end run hit exactly that wall — HTTP 401 with
 * no reason — so the body comes along from now on, folded to one line and cut off.
 *
 * Whatever comes back is scrubbed of the key before it is shown: the one thing this
 * plugin promises about credentials is that they never surface, and an error body is
 * still text from somewhere else.
 */
function flatDetail(raw: string, key: string): string {
  const flat = raw.split(key).join('***').replace(/\s+/g, ' ').trim()
  if (flat === '') return ''
  return flat.length > 240 ? `${flat.slice(0, 240)}…` : flat
}

/**
 * What a refused key can be told about itself: which cell the value was read from, what shape
 * that value has, and the shape this door's key is known to have.
 *
 * A 401 that says `Missing Authentication header` and nothing else leaves the reader with
 * nothing to check — which is how a wrong-shaped key sat in one cell through three separate
 * runs. Naming the cell and the expected shape turns that into one comparison anyone can make
 * without knowing anything about keys.
 *
 * Only two properties of the value are ever named: its length, and — when it is longer than the
 * fragment shown — its first eight characters. Both are fragments by construction, so neither
 * can rebuild a key, and the length guard is what keeps "at most eight characters" from becoming
 * "the whole value" for a value short enough to fit in eight. The value itself stays out, here as
 * everywhere else in this plugin.
 */
function keyRefusal(origin: KeyOrigin, key: string): string {
  const shown = key.length > 8 ? key.slice(0, 8) : ''
  const read = `读到的是 ${origin.ref}，长度 ${key.length}${shown === '' ? '' : `、以 ${shown} 开头`}`
  const should =
    origin.shape === undefined
      ? ''
      : `；${origin.label} 的钥匙应当是 ${origin.shape.length} 个字符、以 ${origin.shape.prefix} 开头`
  return `${read}${should}——请到设置页「决策服务」那一行重贴。`
}

/** Copy the listed keys that are actually present. */
function pick(source: object, keys: string[]): Record<string, unknown> {
  const from = source as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const key of keys) if (from[key] !== undefined) out[key] = from[key]
  return out
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
