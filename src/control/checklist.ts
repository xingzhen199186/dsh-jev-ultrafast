/**
 * The checklist a control model writes at the start of a run, and everything the plugin
 * can decide about it on its own: which checks still hold, which were lost, and whether
 * the run is allowed to say it is finished.
 *
 * Pure by design — no io, no clock, no randomness, no plugin imports, so every rule here
 * is decidable in a millisecond. Reading a page and calling a model belong elsewhere.
 */

/** How one check is decided. The first three are decidable here; `ask` is not. */
export type CheckKind = 'url-contains' | 'text-contains' | 'text-absent' | 'ask'

/** `unknown` before the first look, and for every `ask` check. */
export type CheckState = 'unknown' | 'holds' | 'lost'

export interface ControlCheck {
  /** Stable, unique within one plan. */
  id: string
  /** One plain sentence, for the user. */
  say: string
  kind: CheckKind
  /** Required for the three decidable kinds, refused on `ask`. */
  value?: string
  state: CheckState
}

export interface ControlPlan {
  goal: string
  checks: ControlCheck[]
}

/** The parts of one page observation a check may look at. */
export interface PageFacts {
  url: string
  title: string
  text: string
}

const KINDS: readonly CheckKind[] = ['url-contains', 'text-contains', 'text-absent', 'ask']

/** Beyond this a plan stops being a shortlist of things that must hold. */
const MAX_CHECKS = 12

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

/** Unwrap one fenced block, which is how a model usually returns json when asked for it. */
function unfence(raw: string): string {
  const text = raw.trim()
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n?```$/.exec(text)
  return fenced ? fenced[1].trim() : text
}

/**
 * Why an answer was not json, in the terms a reader of the trace needs.
 *
 * The distinction is the one that decides what to do about it: an answer cut off mid-object is a
 * door or a ceiling problem, an answer with prose around it is a prompt problem, and an answer with
 * its own quotes or brackets wrong is a model problem. Read off the parser's own sentence — an
 * engine's wording rather than this project's, hence the two forms each class is recognised by and
 * the fallback, which is true of every case this cannot name and never claims to be one of them.
 */
function whyNotJson(error: unknown, text: string): string {
  const said = error instanceof Error ? error.message : String(error)
  if (/after JSON/i.test(said)) return 'JSON 后面还跟着别的话（不是纯 JSON）'
  // A parser that gave up at the last character had nothing left to read: that is a cut-off
  // answer, whatever the sentence calls it — and every wording V8 uses for it carries the
  // position, which is the whole reason it can be told from a stray quote further in.
  const at = /at position (\d+)/.exec(said)
  if (/end of JSON input|unterminated string/i.test(said)) return 'JSON 还没写完就断了（像是被截断）'
  if (at && Number(at[1]) >= text.length - 1) return 'JSON 还没写完就断了（像是被截断）'
  return 'JSON 本身对不上（引号、逗号或括号）'
}

/**
 * Read a plan out of what the control model returned, or nothing at all.
 *
 * All or nothing on purpose: a half-understood plan would govern a run with rules nobody
 * agreed to, which is worse than running without one. The state the model writes is
 * ignored — only this plugin decides what holds.
 *
 * What is read is `checks` and nothing else: the keys around it are the model's own business, and
 * the prompt's own shape example asks for a `goal` beside them — a run that returned one and was
 * read as "答非所问" would be this parser blaming the model for following the prompt. Inside
 * `checks` the rules below are strict, and a plan that breaks one is refused whole rather than
 * repaired: the reader gets a run with no checklist rather than a run governed by rules nobody
 * wrote. `onRefusal` says which rule it was — for the trace, never for the run, which stops caring
 * the moment this returns `null`. Without it this reads exactly as it always did.
 */
export function parseControlPlan(
  raw: string,
  goal: string,
  onRefusal?: (why: string) => void,
): ControlPlan | null {
  const refuse = (why: string): null => {
    onRefusal?.(why)
    return null
  }
  if (typeof raw !== 'string' || raw.trim() === '') return refuse('模型什么都没说')
  const text = unfence(raw)
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    return refuse(`不是能解析的 JSON：${whyNotJson(error, text)}`)
  }
  if (!isRecord(parsed)) return refuse('顶层不是一个 JSON 对象')
  const list = parsed.checks
  if (!Array.isArray(list)) return refuse('没有 checks 数组')
  if (list.length === 0) return refuse('checks 是空的')
  if (list.length > MAX_CHECKS) return refuse(`checks 有 ${list.length} 条，超过 ${MAX_CHECKS} 条上限`)

  const checks: ControlCheck[] = []
  const seen = new Set<string>()
  for (const [position, item] of list.entries()) {
    const nth = `第 ${position + 1} 条`
    if (!isRecord(item)) return refuse(`${nth}不是一个 JSON 对象`)
    const { id, say, kind, value } = item
    if (!nonEmpty(id) || !nonEmpty(say)) return refuse(`${nth}的 id 或 say 是空的`)
    if (typeof kind !== 'string' || !KINDS.includes(kind as CheckKind)) {
      return refuse(`${nth}的 kind「${String(kind)}」不在 ${KINDS.join(' / ')} 里`)
    }
    if (seen.has(id)) return refuse(`${nth}的 id「${id}」和前面的一条重复了`)
    seen.add(id)
    const decided = kind as CheckKind
    if (decided === 'ask') {
      if (value !== undefined) return refuse(`${nth}是 ask，不能带 value`)
      checks.push({ id, say, kind: decided, state: 'unknown' })
    } else {
      if (!nonEmpty(value)) return refuse(`${nth}（id=${id}）没有可判定的 value`)
      checks.push({ id, say, kind: decided, value, state: 'unknown' })
    }
  }
  return { goal, checks }
}

/** Where a decidable check looks, and what it wants to find there. */
function stateOf(check: ControlCheck, facts: PageFacts): CheckState {
  if (check.kind === 'ask') return 'unknown'
  const hay = check.kind === 'url-contains' ? facts.url : `${facts.title}\n${facts.text}`
  const found = hay.includes(check.value ?? '')
  const holds = check.kind === 'text-absent' ? !found : found
  return holds ? 'holds' : 'lost'
}

/** Update every decidable check against one page observation. The plan shape is kept. */
export function applyFacts(plan: ControlPlan, facts: PageFacts): ControlPlan {
  return { ...plan, checks: plan.checks.map((check) => ({ ...check, state: stateOf(check, facts) })) }
}

/**
 * The checks that held a moment ago and do not hold now — the one-shot signal worth
 * acting on. `shouldEscalate` reports what is lost at this moment, which stays true for
 * as long as the run stays off course, so a caller that acts should act on this instead.
 */
export function newlyLost(before: ControlPlan, after: ControlPlan): ControlCheck[] {
  const was = new Map(before.checks.map((check) => [check.id, check.state]))
  return after.checks.filter((check) => was.get(check.id) === 'holds' && check.state === 'lost')
}

/**
 * What stands in the way of saying the run is finished.
 *
 * An `ask` check is deliberately not one of them: nothing here can decide it, and until
 * the fallback exists, a check nobody can decide would only block runs that went fine.
 */
export function blockedChecks(plan: ControlPlan): ControlCheck[] {
  return plan.checks.filter((check) => check.kind !== 'ask' && check.state !== 'holds')
}

/** Whether the run may announce the result it was asked for. */
export function canFinish(plan: ControlPlan): boolean {
  return blockedChecks(plan).length === 0
}

/** The decidable checks that are lost right now. */
export function shouldEscalate(plan: ControlPlan): ControlCheck[] {
  return plan.checks.filter((check) => check.kind !== 'ask' && check.state === 'lost')
}
