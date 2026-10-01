/**
 * The elements this run has already found to be dead ends, judged by the plugin itself before the
 * state goes to the decision model.
 *
 * The judgement is made from the run's own honest reading of a step — `page_changed`, which is the
 * address and the element table and never the page's own text (see `repeatedActionState` in
 * `./loop.ts`): the last step acted on an element and the screen did not move for it, so that
 * element is a dead end and comes out of the candidate table from the next request on. A step that
 * really changed the screen empties the set, and the run starts over from the page it landed on.
 *
 * This is the plugin's own decision rather than a sentence to the model because two sets of offline
 * experiments said so (2026-10, four rounds). Telling the service in words not to repeat itself
 * changed nothing — 15 runs of 15, whether the rule was written into the next-step rules or the
 * honest "nothing moved" fact was put in the state, and the run kept picking the element it had just
 * wasted a step on. A straight, unconditional sentence does bind, but only for the question it sits
 * in: the run changed its operation and picked the same element again. Taking the element out of the
 * candidate table is what worked — 5 runs of 5 stopped choosing it — and only when the number left
 * *every* copy of the table: with just the element list cut, 15 of 20 answers still named it and 3 of
 * them acted on it as the live target. Taking the copies out together is what `withoutElements` does.
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

  const element = elementIndexOf(last.target)
  const next = new Set(dead)
  if (next.has(element)) return next
  // The floor: taking this one away has to leave at least `MIN_OPEN_ELEMENTS` behind.
  if (offered - next.size - 1 < MIN_OPEN_ELEMENTS) return next
  next.add(element)
  return next
}
