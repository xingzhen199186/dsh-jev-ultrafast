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
import { NEXT_ACTION, TARGET } from '../prompts'
import type { ActionSpace } from './action-space'

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

/** Human-readable descriptions of the three element operations. */
const OPERATION_LABELS: Record<string, string> = {
  CLICK: 'Click an element, button, menu option, autocomplete suggestion, or calendar day.',
  TYPE_TEXT: 'Enter or replace text in an editable field. A small LLM will supply the value from the goal.',
  SELECT: 'Select an observed dropdown value.',
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
  operations.DONE = 'Every requirement is visibly satisfied.'
  operations.BLOCKED = 'No supported operation can progress.'

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
      page: { url: context.page.url, title: context.page.title, text: context.page.text },
      // Sits with the page it is about, and only when there is something to say: an empty
      // field would be one more thing for the service to read on every step.
      ...(context.note ? { note: context.note } : {}),
      elements: space.elements,
      recent_actions: context.history.slice(-10).map((entry) => pick(entry, ['action', 'kind', 'text', 'page_changed'])),
    },
    questions,
  }
  return { request, operations: Object.keys(operations), targetIds }
}

/**
 * Validate one answer against the choices its question actually offered.
 * A probability distribution that does not cover exactly those choices, or whose
 * winner is not the most probable one, is a broken answer rather than a decision.
 */
export function validateChoice(answer: unknown, ids: string[]): ChoiceAnswer {
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

  if (!valid) throw new InvalidDecision('决策服务返回了无法执行的结果，没有执行任何动作')
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
    throw new InvalidDecision('决策服务没有返回 answers 字段，没有执行任何动作')
  }

  const operationAnswer = validateChoice(answers.operation, questionnaire.operations)
  const operation = operationAnswer.choice

  let choice: string
  let target: string | null = null
  let targetAnswer: ChoiceAnswer | null = null
  const probabilities: Record<string, number> = {}

  const candidates = space.targets[operation]
  if (candidates) {
    targetAnswer = validateChoice(answers[`${operation.toLowerCase()}_target`], questionnaire.targetIds[operation]!)
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
      throw new Error(
        `决策服务返回 HTTP ${response.status}，没有执行任何动作` +
          (detail ? `（服务端原话：${detail}）` : '') +
          (wrapped ? '（已经试过带 decisionsRequest 包裹的写法）' : ''),
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
