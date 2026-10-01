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
 */
import type { SnapshotAction } from '../browser/session'

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
