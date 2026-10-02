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
 * Read a plan out of what the control model returned, or nothing at all.
 *
 * All or nothing on purpose: a half-understood plan would govern a run with rules nobody
 * agreed to, which is worse than running without one. The state the model writes is
 * ignored — only this plugin decides what holds.
 */
export function parseControlPlan(raw: string, goal: string): ControlPlan | null {
  if (typeof raw !== 'string' || raw.trim() === '') return null
  let parsed: unknown
  try {
    parsed = JSON.parse(unfence(raw))
  } catch {
    return null
  }
  if (!isRecord(parsed)) return null
  const list = parsed.checks
  if (!Array.isArray(list) || list.length === 0 || list.length > MAX_CHECKS) return null

  const checks: ControlCheck[] = []
  const seen = new Set<string>()
  for (const item of list) {
    if (!isRecord(item)) return null
    const { id, say, kind, value } = item
    if (!nonEmpty(id) || !nonEmpty(say)) return null
    if (typeof kind !== 'string' || !KINDS.includes(kind as CheckKind)) return null
    if (seen.has(id)) return null
    seen.add(id)
    const decided = kind as CheckKind
    if (decided === 'ask') {
      if (value !== undefined) return null
      checks.push({ id, say, kind: decided, state: 'unknown' })
    } else {
      if (!nonEmpty(value)) return null
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
