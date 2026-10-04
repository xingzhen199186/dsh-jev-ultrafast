/**
 * The elements this run has already found to be dead ends, judged by the plugin itself before the
 * state goes to the decision model.
 *
 * The judgement is made from the run's own honest reading of a step — `page_changed`, which is the
 * address and the element table and never the page's own text (see `repeatedActionState` in
 * `./loop.ts`): the last step acted on an element and the screen did not move for it, so that
 * element is a dead end. A step that really changed the screen empties the set, and the run starts
 * over from the page it landed on.
 *
 * Whether a dead end then comes out of the candidates is the caller's business rather than this
 * judgement's, and since the reader's ruling of 2026-10-04 it always does: the removal is
 * unconditional, with no switch left to turn it off (the settings page's own
 * `excludeDeadEndElements` field was deleted by the same ruling that restored the behaviour).
 *
 * The ruling came from a measured run rather than a change of taste. On 2026-10-04 the bilibili task
 * (留痕 run-1791128895514-22oy) judged its step 15 element — the search box, again — a dead end, and
 * because the removal was off at the time the judgement went into the request as a mere fact while the
 * candidate stayed offered; the model picked it once more a few steps later. That is the 15-of-15
 * offline result below, met live: what binds is taking the number out of the questions, not telling the
 * model about it. The doubt that had kept the removal off — "a step that showed nothing is not proof
 * that the element can never matter" — is not withdrawn; it is simply outweighed, because the element a
 * wrong exclusion costs the run is one, and the steps a live dead end costs are the whole budget.
 *
 * The judgement is recorded either way, because the judgement — not the removal — is what a reader has
 * to be able to check afterwards.
 *
 * This is the plugin's own decision rather than a sentence to the model because two sets of offline
 * experiments said so (2026-10). Telling the service in words not to repeat itself changed nothing —
 * 15 runs of 15, whether the rule was written into the next-step rules or the honest "nothing moved"
 * fact was put in the state, and the run kept picking the element it had just wasted a step on. A
 * straight, unconditional sentence does bind, but only for the question it sits in: the run changed
 * its operation and picked the same element again. What works is taking the number out of the
 * questions that offer it: 5 runs of 5 and then 10 of 10 stopped choosing it, with no answer naming it
 * at all. The element *entry* is not what has to go, which the second round measured by itself: with
 * the entry cut and the candidate left in, 15 of 15 answers still named the number and 3 acted on it,
 * while with the entry kept and the candidate cut, 10 of 10 runs chose something else. Cutting the
 * questions is what `withoutElements` does.
 *
 * Two things this rule deliberately is not:
 *
 *  - It does not decide where to go instead. An element it takes away only narrows the candidates;
 *    the model still chooses among what is left and nothing steers it. The same experiment showed
 *    why this has to be said out loud: with the element gone, the run went and typed into another
 *    field — a different choice, not a better one. Removing a dead end is the whole of the job here.
 *  - A field that was typed into and changed nothing is excluded like any other element. Entering a
 *    value does not move a page's address or its element table, so a step that put text in a field
 *    and showed nothing for it reads as "no change" — and that is wanted: a field that swallowed the
 *    text and did nothing with it is exactly the one to set aside for a step.
 */

import { elementIndexOf } from './decision/action-space'

/** The only two facts about a finished step this rule reads. */
export interface StepOutcome {
  /** The target the step acted on — `7`, `7:2`, `7:enter` — or `null` when it had no target. */
  target: string | null
  /** Whether that step changed the screen; `null` until its aftermath has been read back. */
  page_changed: boolean | null
  /** Stable identity for the element when the browser supplied one. */
  element_key?: string | null
}

/**
 * How many elements a request must keep offering.
 *
 * The set only ever grows while the screen stands still, and a table of too few options is a request
 * the service cannot answer well, so the last five are never taken away.
 */
export const MIN_OPEN_ELEMENTS = 5

/**
 * The dead ends after one more step, given the ones already known.
 *
 * @param dead    the elements already ruled out
 * @param last    the step just finished, absent before any step has run
 * @param offered how many elements the page's own table holds, which is what the floor is measured
 *                against — and it is the same table the next request is built from, because a step
 *                that counts here is a step whose address and element table did not move
 */
export function nextDeadEnds(
  dead: ReadonlySet<string>,
  last: StepOutcome | null | undefined,
  offered: number,
): Set<string> {
  // Before any step has run there is nothing to have learned, so the first request is the page's own.
  if (!last) return new Set(dead)
  // The screen really moved: whatever was ruled out on the screen before it is forgotten.
  if (last.page_changed === true) return new Set()
  // A step with no target of its own (`WAIT`, a scroll) says nothing about any element, and neither
  // does a step whose aftermath was never read back: both leave the set as it stands.
  if (last.target === null || last.page_changed !== false) return new Set(dead)

  const element = last.element_key ?? elementIndexOf(last.target)
  const next = new Set(dead)
  if (next.has(element)) return next
  // The floor: taking this one away has to leave at least `MIN_OPEN_ELEMENTS` behind.
  if (offered - next.size - 1 < MIN_OPEN_ELEMENTS) return next
  next.add(element)
  return next
}

/**
 * One element the run judged a dead end, and the step that judged it.
 *
 * Kept in the run's own report as well as acted on, because the judgement is what a reader has to be
 * able to check: the removal is silent by design — the element is simply not offered — so this record
 * is the only place the judgement itself can be read back.
 */
export interface DeadEndRecord {
  /** The step whose action led nowhere — the step itself, not the request that followed it. */
  step: number
  /** The element itself, as the index the page and the code both use: `4` for `4`, `4:2`, `4:enter`. */
  element: string
  /** The target key the step acted on, so a dropdown option or a key press is told apart. */
  target: string
  /** What that element was called when it was judged. */
  label: string
}

/**
 * One line about the dead ends this run judged: how many, that they were taken out of the candidates,
 * and which step produced each one. Empty when the run judged none, so an ordinary run grows no
 * sentence about them.
 */
export function deadEndNote(deadEnds: readonly DeadEndRecord[]): string {
  if (deadEnds.length === 0) return ''
  const where = deadEnds
    .map((record) => `第 ${record.step} 步的 [${record.element}]${record.label ? `「${record.label}」` : ''}`)
    .join('、')
  return `本次识别到 ${deadEnds.length} 个死路（已排除，不再列为候选）：${where}`
}
