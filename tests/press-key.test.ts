import { describe, expect, it } from 'vitest'
import { PRESS_KEYS, keyEvents } from '../src/browser/act'
import { SNAPSHOT_SOURCE } from '../src/browser/snapshot'
import type { SnapshotAction } from '../src/browser/session'
import { actionSpace } from '../src/decision/action-space'
import { type DecisionContext, buildQuestionnaire } from '../src/decision/typesafe'
import { NEXT_ACTION } from '../src/prompts'

/**
 * The keyboard path, and the reason it exists.
 *
 * A 携程 run (2026-10-01) had its destination typed for it, then spent its remaining steps
 * typing the same words again and clicking the field they were already in: the site's
 * candidate list was on the page and in the text, but none of its rows was ever an element
 * the run could name, so there was nothing to click and no way to say "close this".
 * These checks hold the two things that fix it: a key that really reaches the page, and the
 * rule that tells the model to use one.
 */

const context: DecisionContext = {
  goal: '把目的地填成「生命科学园」，然后搜索',
  page: { url: 'https://www.ctrip.com/', title: '携程旅行网', text: '目的地/酒店名称' },
  history: [],
}

describe('press_key', () => {
  it('sends the press and then the release, with the numbers CDP wants', () => {
    expect(keyEvents('enter')).toEqual([
      {
        type: 'keyDown',
        key: 'Enter',
        code: 'Enter',
        windowsVirtualKeyCode: 13,
        nativeVirtualKeyCode: 13,
        text: '\r',
      },
      {
        type: 'keyUp',
        key: 'Enter',
        code: 'Enter',
        windowsVirtualKeyCode: 13,
        nativeVirtualKeyCode: 13,
        text: '\r',
      },
    ])
  })

  it('carries a character only where the key has one, and the same numbers on both events', () => {
    // CDP types nothing for a key event without `text`, which is why Enter and Tab have to
    // carry theirs — a key that arrives without one is a key the page never sees.
    expect(keyEvents('enter')[0]).toMatchObject({ key: 'Enter', text: '\r' })
    expect(keyEvents('tab')[0]).toMatchObject({ key: 'Tab', text: '\t' })
    for (const name of ['escape', 'arrowdown', 'arrowup']) {
      // No invented character: these keys produce none, and a `text` would be typed instead.
      expect(keyEvents(name)[0]).not.toHaveProperty('text')
    }
    for (const name of Object.keys(PRESS_KEYS)) {
      const [down, up] = keyEvents(name)
      // The release is the press with one field changed, so it lands on what the page saw.
      expect(up).toEqual({ ...down, type: 'keyUp' })
      expect(down!.nativeVirtualKeyCode).toBe(down!.windowsVirtualKeyCode)
    }
  })

  it('covers the five keys a field is driven with', () => {
    expect(Object.keys(PRESS_KEYS).sort()).toEqual(['arrowdown', 'arrowup', 'enter', 'escape', 'tab'])
    for (const name of Object.keys(PRESS_KEYS)) {
      const events = keyEvents(name)
      expect(events).toHaveLength(2)
      const [down, up] = events
      expect(down!.type).toBe('keyDown')
      expect(up!.type).toBe('keyUp')
      // The pair is the same key, so the release lands on the press the page saw.
      expect(down!.key).toBe(up!.key)
      expect(String(down!.key).length).toBeGreaterThan(0)
      expect(String(down!.code).length).toBeGreaterThan(0)
      expect(typeof down!.windowsVirtualKeyCode).toBe('number')
    }
  })

  it('refuses a key nobody supports rather than typing nothing', () => {
    expect(() => keyEvents('f13')).toThrow(/不支持的按键/)
    expect(() => keyEvents('')).toThrow(/不支持的按键/)
  })

  it('offers every one of those keys from the page snapshot, so the two cannot drift apart', () => {
    for (const name of Object.keys(PRESS_KEYS)) expect(SNAPSHOT_SOURCE).toContain(`'${name}'`)
  })
})

describe('a key offered as its own target', () => {
  const typed: SnapshotAction[] = [
    { id: 'e1', kind: 'fill', node: 7, role: 'textbox', label: '目的地', value: '生命科学园' },
    { id: 'e2', kind: 'click', node: 7, role: 'textbox', label: 'Open 目的地', value: '生命科学园' },
    { id: 'e3', kind: 'press_key', node: 7, key: 'arrowdown', role: 'textbox', label: '目的地 → arrowdown', value: '生命科学园' },
    { id: 'e4', kind: 'press_key', node: 7, key: 'enter', role: 'textbox', label: '目的地 → enter', value: '生命科学园' },
    { id: 'e5', kind: 'press_key', node: 7, key: 'escape', role: 'textbox', label: '目的地 → escape', value: '生命科学园' },
  ]

  it('keeps the field at one index and gives each key its own target key', () => {
    const space = actionSpace(typed)
    expect(space.elements).toHaveLength(1)
    expect(space.elements[0]).toMatchObject({
      index: '1',
      label: '目的地',
      operations: ['TYPE_TEXT', 'CLICK', 'PRESS_KEY'],
    })
    expect(Object.keys(space.targets.PRESS_KEY!)).toEqual(['1:arrowdown', '1:enter', '1:escape'])
    expect(space.targets.PRESS_KEY!['1:enter']!.id).toBe('e4')
  })

  it('is asked about as its own operation, with the key in the label it is shown', () => {
    const { operations, request } = buildQuestionnaire(actionSpace(typed), context, 'jev-latest')
    expect(operations).toContain('PRESS_KEY')
    const questions = request.questions as Record<string, { criteria: Record<string, { element: string }> }>
    const criteria = questions.press_key_target!.criteria
    expect(Object.keys(criteria)).toEqual(['1:arrowdown', '1:enter', '1:escape'])
    expect(criteria['1:enter']!.element).toContain('enter')
  })
})

describe('the candidate-list rules in the prompt', () => {
  it('says to pick from the list instead of retyping, and to use a key when it is not indexed', () => {
    expect(NEXT_ACTION).toContain('就从列表里点选目标那一项，不要反复重新输入')
    expect(NEXT_ACTION).toContain('这一条优先于其它做法')
    expect(NEXT_ACTION).toContain('PRESS_KEY')
  })
})
