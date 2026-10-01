/**
 * The indexed action space: one index per observed element, and per operation
 * only the targets that operation can actually use.
 *
 * Ported from jev-ultrafast `jev_ultrafast/model.py` (`action_space`)
 * (https://github.com/browser-use/jev-ultrafast, MIT, Copyright (c) 2026 Browser Use).
 *
 * Two properties are the point of this module and are covered by tests:
 * a node keeps one index even when it both types and clicks, and a dropdown
 * option carries an index minted here, never a value the model invented.
 *
 * `trimActionSpace` is the third: the table handed to the decision service is a selection of what
 * the page offered whenever the page offered more than one request can carry, and both the
 * selection and the count of what it left out are returned rather than only the selection.
 */
import type { SnapshotAction } from '../browser/session'
import { MAX_ELEMENTS } from '../prompts'

/** One observed element, reduced to what the decision model is allowed to see. */
export interface ElementEntry {
  /** Code-owned index, `1`-based, matching the target keys. */
  index: string
  label: string
  /** Which operations this element supports; at most one of each. */
  operations: string[]
  role?: string
  value?: string
  checked?: string
  selected?: string
  expanded?: string
  /** Select options, each with its own `index:option` target key. */
  options?: Array<{ index: string; label: string; value: string }>
}

export interface ActionSpace {
  elements: ElementEntry[]
  /** Operation name → its own target candidates, keyed by target index. */
  targets: Record<string, Record<string, SnapshotAction>>
  /** Non-element operations (scroll, wait), keyed by their upper-case name. */
  controls: Record<string, SnapshotAction>
}

/** Snapshot action kinds that map to a model-chosen operation. */
const OPERATIONS: Record<string, string> = {
  click: 'CLICK',
  fill: 'TYPE_TEXT',
  select: 'SELECT',
  press_key: 'PRESS_KEY',
}

/** Element fields the model is allowed to see. */
const ELEMENT_FIELDS = ['role', 'value', 'checked', 'selected', 'expanded'] as const

export function actionSpace(actions: SnapshotAction[]): ActionSpace {
  const elements: ElementEntry[] = []
  const indices = new Map<number, string>()
  const targets: Record<string, Record<string, SnapshotAction>> = {}
  const controls: Record<string, SnapshotAction> = {}

  for (const action of actions) {
    const operation = OPERATIONS[action.kind]
    if (!operation) {
      controls[action.id.toUpperCase()] = action
      continue
    }
    const node = action.node
    if (typeof node !== 'number') throw new Error(`观察到的动作缺少元素编号：${action.id}`)

    let index = indices.get(node)
    if (index === undefined) {
      index = String(elements.length + 1)
      indices.set(node, index)
      const element: ElementEntry = {
        index,
        label: action.label.split(' → ')[0] || action.label,
        operations: [],
      }
      for (const field of ELEMENT_FIELDS) {
        const value = action[field]
        if (value !== undefined) element[field] = String(value)
      }
      if (action.kind === 'select') {
        // A select's own `value` is the option it would choose; the element shows what is selected now.
        element.value = typeof action.current_value === 'string' ? action.current_value : ''
        element.options = []
      }
      elements.push(element)
    }

    const element = elements[Number(index) - 1]!
    if (!element.operations.includes(operation)) element.operations.push(operation)

    let target = index
    if (action.kind === 'select') {
      element.options ??= []
      target = `${index}:${element.options.length + 1}`
      element.options.push({ index: target, label: action.label, value: String(action.value ?? '') })
    }
    // One key is one action on the same element, so the key has to be in the target key —
    // otherwise the five keys of one field would all collide on the element's own index.
    if (action.kind === 'press_key') target = `${index}:${String(action.key ?? '').toLowerCase()}`
    const group = (targets[operation] ??= {})
    group[target] = action
  }

  return { elements, targets, controls }
}

/** One request's element table, cut to size, and how many elements that cost. */
export interface TrimmedSpace {
  space: ActionSpace
  /** How many observed elements the table left out; `0` when nothing was cut. */
  omitted: number
}

/**
 * Cut the element table down to `limit` and say how many entries that cost.
 *
 * The order is the rule, and it is applied to one element at a time rather than taken from the
 * element's position on the page:
 *
 *  1. an element the run has just acted on is kept first — a loop that loses the very target it
 *     was working on is not a smaller loop, it is a loop that cannot finish;
 *  2. then an element that carries a visible label of its own, rather than only its role as a
 *     stand-in name, and that can be operated at all;
 *  3. only then does distance from the goal's own words decide, and elements equally close keep
 *     the page's own order.
 *
 * Unlabelled, non-interactive entries are therefore what goes first. Every element that survives
 * survives entire — no label is cut in half, and no element is left in `elements` without its
 * targets, or the other way round.
 */
export function trimActionSpace(
  space: ActionSpace,
  goal: string,
  recent: ReadonlyArray<string | null | undefined>,
  limit = MAX_ELEMENTS,
): TrimmedSpace {
  if (space.elements.length <= limit) return { space, omitted: 0 }

  const tokens = goalTokens(goal)
  const recentIndices = new Set(
    recent.filter((target): target is string => typeof target === 'string').map((target) => elementIndexOf(target)),
  )
  const scored = space.elements.map((element, order) => ({
    element,
    order,
    keep: (recentIndices.has(element.index) ? 4 : 0) + (labelled(element) ? 2 : 0) + (element.operations.length > 0 ? 1 : 0),
    near: closeness(element, tokens),
  }))
  scored.sort((a, b) => b.keep - a.keep || b.near - a.near || a.order - b.order)
  const kept = new Set(scored.slice(0, limit).map((entry) => entry.element.index))

  const elements = space.elements.filter((element) => kept.has(element.index))
  const targets: Record<string, Record<string, SnapshotAction>> = {}
  for (const [operation, group] of Object.entries(space.targets)) {
    const survivors: Record<string, SnapshotAction> = {}
    for (const [target, action] of Object.entries(group)) {
      if (kept.has(elementIndexOf(target))) survivors[target] = action
    }
    // An operation whose every candidate was cut is not offered at all: a question with no choices
    // is one the service has no answer to, and an offered operation with an empty target list
    // would leave the chosen action without a target.
    if (Object.keys(survivors).length > 0) targets[operation] = survivors
  }
  return { space: { elements, targets, controls: space.controls }, omitted: space.elements.length - elements.length }
}

/**
 * The same table with the named elements taken out of it — the element entries, and every target key
 * that belongs to them, so `7`, `7:2` and `7:enter` all leave together.
 *
 * What decides the set is in `../dead-ends.ts`. What matters here is that it is applied to the whole
 * table rather than to the element list: a request that carried an element's label but dropped it
 * from the question asked about it is the failure this exists to prevent — the run then reads back
 * an answer naming the number it took out, and acts on it. An operation whose every candidate went
 * with them is not offered at all, for the reason `trimActionSpace` drops one: a question with no
 * choices is one the service has no answer to.
 *
 * The same object comes back when nothing was named or nothing matched, so a caller that reads
 * identity — a re-ask of the same question, for one — sees the table it already had.
 */
export function withoutElements(space: ActionSpace, excluded: ReadonlySet<string>): ActionSpace {
  if (excluded.size === 0) return space
  const elements = space.elements.filter((element) => !excluded.has(element.index))
  if (elements.length === space.elements.length) return space

  const targets: Record<string, Record<string, SnapshotAction>> = {}
  for (const [operation, group] of Object.entries(space.targets)) {
    const survivors: Record<string, SnapshotAction> = {}
    for (const [target, action] of Object.entries(group)) {
      if (!excluded.has(elementIndexOf(target))) survivors[target] = action
    }
    if (Object.keys(survivors).length > 0) targets[operation] = survivors
  }
  return { elements, targets, controls: space.controls }
}

/** The element a target key belongs to: `7`, `7:2` and `7:enter` are all element `7`. */
export function elementIndexOf(target: string): string {
  return target.split(':')[0]!
}

/** Whether an element carries a name of its own rather than only its role as a stand-in. */
function labelled(element: ElementEntry): boolean {
  const label = element.label.trim()
  return label !== '' && label !== element.role
}

/** How many of the goal's own words this element shows, in its label, its value and its options. */
function closeness(element: ElementEntry, tokens: string[]): number {
  const text = [element.label, element.value, ...(element.options ?? []).map((option) => option.label)]
    .filter((part): part is string => typeof part === 'string' && part !== '')
    .join(' ')
    .toLowerCase()
  if (text === '') return 0
  let hits = 0
  for (const token of tokens) if (text.includes(token)) hits += 1
  return hits
}

/**
 * The goal's own words, such as they can be matched against an element label.
 *
 * A goal written in Chinese arrives as one unbroken run, which no label can ever contain, so a run
 * of Han characters also contributes its two-character windows ("从北京到上海" contributes
 * "从北", "北京", "京到" …). Everything else is split on the characters that cannot be part of a
 * word, and single characters are dropped because they match too much to mean anything.
 */
function goalTokens(goal: string): string[] {
  const tokens = new Set<string>()
  for (const run of goal.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (run.length < 2) continue
    tokens.add(run)
    if (/\p{Script=Han}/u.test(run)) {
      for (let at = 0; at + 2 <= run.length; at += 1) tokens.add(run.slice(at, at + 2))
    }
  }
  return [...tokens]
}
