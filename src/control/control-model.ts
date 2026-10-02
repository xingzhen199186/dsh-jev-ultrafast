/**
 * Asking the control model once, and the budget that bounds the asking.
 *
 * Deliberately knows nothing about which model it is talking to: the caller hands in
 * something that answers, which is what keeps this file testable and what lets the
 * wiring decide between a DSH route and a preset provider in one place.
 *
 * The one promise this file makes to the run: it never throws. Whatever goes wrong with
 * the control model �?no budget, a timeout, an error, an answer nobody can read �?the
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
export const CONTROL_TIMEOUT_MS = 90_000

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
 *
 * `onFailure` is for whoever reads the run afterwards, not for the run: `null` alone cannot
 * say whether the door refused, the answer came too late, or the model answered something this
 * parser will not accept �?and the last of those is a prompt problem rather than a transport
 * one, which is why the model's own words go into the sentence. Being told is a courtesy, so
 * nothing it does can become the run's problem.
 */
export async function readChecklist(
  model: ControlModel,
  input: { goal: string; url: string; title: string },
  budget: ControlBudget,
  options: { timeoutMs?: number; onFailure?: (why: string) => void } = {},
): Promise<ControlPlan | null> {
  if (!spendControlCall(budget)) {
    report(options.onFailure, '这次运行的问话次数用完了')
    return null
  }
  const timeoutMs = Math.max(1, Math.floor(options.timeoutMs ?? CONTROL_TIMEOUT_MS))
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  // Set before the abort, so the reason stays right whichever of the two rejections the race
  // settles on: the model's own answer to being cancelled, or the timeout's own error.
  let timedOut = false
  try {
    const { system, user } = checklistPrompt(input)
    const raw = await Promise.race([
      model.call({ system, user, signal: controller.signal }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          timedOut = true
          controller.abort()
          reject(new Error('control timeout'))
        }, timeoutMs)
      }),
    ])
    const plan = parseControlPlan(raw, input.goal)
    // The one worth knowing about: the model answered, and this parser would not have it. The
    // words it actually said are the whole diagnosis �?a summary of them would hide the shape
    // the prompt failed to get across �?so they are what the sentence carries, cut short.
    if (plan === null) report(options.onFailure, `答非所问：${String(raw).slice(0, 200)}`)
    return plan
  } catch (error) {
    report(options.onFailure, timedOut ? `超时�?{timeoutMs} 毫秒）` : `调用出错�?{messageOf(error)}`)
    return null
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** What a thrown thing says, as one short line: a stack trace is not what a reader needs. */
function messageOf(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 200)
}

/** Say why, without the saying itself becoming a failure: `readChecklist` promises never to throw. */
function report(onFailure: ((why: string) => void) | undefined, why: string): void {
  try {
    onFailure?.(why)
  } catch {
    // A reason the caller cannot take is still better than a run broken by the telling.
  }
}
