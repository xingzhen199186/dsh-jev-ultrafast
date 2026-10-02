/**
 * Asking the control model once, and the budget that bounds the asking.
 *
 * Deliberately knows nothing about which model it is talking to: the caller hands in
 * something that answers, which is what keeps this file testable and what lets the
 * wiring decide between a DSH route and a preset provider in one place.
 *
 * The one promise this file makes to the run: it never throws. Whatever goes wrong with
 * the control model — no budget, a timeout, an error, an answer nobody can read — the
 * run is told `null` and carries on exactly as it would have without any of this.
 */
import { parseControlPlan, type ControlPlan } from './checklist'
import { checklistPrompt } from './prompt'

/** One call, in whatever shape the caller's model client takes. */
export interface ControlModel {
  call(input: { system: string; user: string; signal?: AbortSignal }): Promise<string>
}

/** A run's allowance of control calls, counted apart from the decisions asked of Jev. */
export interface ControlBudget {
  readonly cap: number
  used: number
}

/** Long enough for a slow route, short enough that a stuck one is not the run's problem. */
export const CONTROL_TIMEOUT_MS = 20_000

export function newControlBudget(cap: number): ControlBudget {
  const whole = Number.isFinite(cap) ? Math.floor(cap) : 0
  return { cap: Math.max(0, whole), used: 0 }
}

/** Take one call from the budget; false means this intervention does not happen. */
export function spendControlCall(budget: ControlBudget): boolean {
  if (budget.used >= budget.cap) return false
  budget.used += 1
  return true
}

/** An adapter for a caller that only has a plain function to offer. */
export function controlModelFrom(call: ControlModel['call']): ControlModel {
  return { call }
}

/**
 * Ask once and read the checklist back, or `null` for any reason at all.
 *
 * A call that fails still spends its budget: an attempt costs the same to the run whether
 * or not it answered, and counting only the good ones would let a broken route be retried
 * without limit.
 */
export async function readChecklist(
  model: ControlModel,
  input: { goal: string; url: string; title: string },
  budget: ControlBudget,
  options: { timeoutMs?: number } = {},
): Promise<ControlPlan | null> {
  if (!spendControlCall(budget)) return null
  const timeoutMs = Math.max(1, Math.floor(options.timeoutMs ?? CONTROL_TIMEOUT_MS))
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const { system, user } = checklistPrompt(input)
    const raw = await Promise.race([
      model.call({ system, user, signal: controller.signal }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort()
          reject(new Error('control timeout'))
        }, timeoutMs)
      }),
    ])
    return parseControlPlan(raw, input.goal)
  } catch {
    return null
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
