import { describe, expect, it } from 'vitest'
import {
  applyFacts,
  blockedChecks,
  canFinish,
  newlyLost,
  parseControlPlan,
  shouldEscalate,
  type ControlPlan,
  type PageFacts,
} from '../src/control/checklist'

const page = (over: Partial<PageFacts> = {}): PageFacts => ({
  url: 'https://hotels.example/list?city=1&landmark=2501722',
  title: '北京酒店',
  text: '找到 6245 家酒店 直线距离 近→远',
  ...over,
})

const plan = (checks: Array<Record<string, unknown>>, goal = '找最近的酒店'): ControlPlan => ({
  goal,
  checks: checks.map((check) => ({ state: 'unknown', ...check })) as ControlPlan['checks'],
})

describe('reading a plan out of what the control model said', () => {
  it('reads bare json', () => {
    const raw = '{"goal":"找酒店","checks":[{"id":"landmark","say":"地标一直在","kind":"url-contains","value":"landmark="}]}'
    const parsed = parseControlPlan(raw, '任务原文')
    expect(parsed).not.toBeNull()
    expect(parsed?.checks).toEqual([
      { id: 'landmark', say: '地标一直在', kind: 'url-contains', value: 'landmark=', state: 'unknown' },
    ])
  })

  it('reads json wrapped in a fence, with or without the language tag', () => {
    const body = '{"goal":"g","checks":[{"id":"a","say":"s","kind":"text-contains","value":"北京"}]}'
    expect(parseControlPlan('```json\n' + body + '\n```', 'g')?.checks).toHaveLength(1)
    expect(parseControlPlan('```\n' + body + '\n```', 'g')?.checks).toHaveLength(1)
  })

  it('ignores the state the model wrote and decides that itself', () => {
    const raw = '{"goal":"g","checks":[{"id":"a","say":"s","kind":"url-contains","value":"x","state":"holds"}]}'
    expect(parseControlPlan(raw, 'g')?.checks[0].state).toBe('unknown')
  })

  it('keeps the goal it was given rather than the one the model repeated', () => {
    const raw = '{"goal":"模型写的","checks":[{"id":"a","say":"s","kind":"url-contains","value":"x"}]}'
    expect(parseControlPlan(raw, '任务原文')?.goal).toBe('任务原文')
  })

  it('refuses a plan that is wrong anywhere, rather than repairing it', () => {
    const bad: string[] = [
      '',
      'not json at all',
      '[]',
      '{}',
      '{"checks":[]}',
      '{"checks":[{"say":"s","kind":"url-contains","value":"x"}]}',
      '{"checks":[{"id":"a","say":"","kind":"url-contains","value":"x"}]}',
      '{"checks":[{"id":"a","say":"s","kind":"nonsense","value":"x"}]}',
      '{"checks":[{"id":"a","say":"s","kind":"url-contains"}]}',
      '{"checks":[{"id":"a","say":"s","kind":"text-contains","value":"  "}]}',
      '{"checks":[{"id":"a","say":"s","kind":"ask","value":"x"}]}',
      '{"checks":[{"id":"a","say":"s","kind":"url-contains","value":"x"},{"id":"a","say":"t","kind":"url-contains","value":"y"}]}',
      JSON.stringify({
        checks: Array.from({ length: 13 }, (_, i) => ({ id: `c${i}`, say: 's', kind: 'url-contains', value: 'x' })),
      }),
    ]
    for (const raw of bad) expect(parseControlPlan(raw, 'g'), raw).toBeNull()
  })

  it('takes exactly twelve checks', () => {
    const raw = JSON.stringify({
      checks: Array.from({ length: 12 }, (_, i) => ({ id: `c${i}`, say: 's', kind: 'url-contains', value: 'x' })),
    })
    expect(parseControlPlan(raw, 'g')?.checks).toHaveLength(12)
  })
})

describe('deciding a check against one page', () => {
  it('decides the three local kinds, both ways', () => {
    const start = plan([
      { id: 'u', say: 's', kind: 'url-contains', value: 'landmark=2501722' },
      { id: 't', say: 's', kind: 'text-contains', value: '直线距离' },
      { id: 'a', say: 's', kind: 'text-absent', value: '验证码' },
    ])
    const good = applyFacts(start, page())
    expect(good.checks.map((check) => check.state)).toEqual(['holds', 'holds', 'holds'])

    const bad = applyFacts(start, page({ url: 'https://hotels.example/list?city=1', text: '请先登录 验证码' }))
    expect(bad.checks.map((check) => check.state)).toEqual(['lost', 'lost', 'lost'])
  })

  it('looks at the title as well as the body text', () => {
    const only = plan([{ id: 't', say: 's', kind: 'text-contains', value: '生命科学园' }])
    expect(applyFacts(only, page({ title: '中关村生命科学园', text: '' })).checks[0].state).toBe('holds')
  })

  it('leaves an ask check undecided for ever', () => {
    const asked = plan([{ id: 'q', say: 's', kind: 'ask' }])
    expect(applyFacts(asked, page()).checks[0].state).toBe('unknown')
  })

  it('hands back a new plan and leaves the one it was given alone', () => {
    const start = plan([{ id: 'u', say: 's', kind: 'url-contains', value: 'landmark=' }])
    const after = applyFacts(start, page())
    expect(start.checks[0].state).toBe('unknown')
    expect(after).not.toBe(start)
  })
})

describe('what the run is allowed to do about it', () => {
  it('reports a check that held and then stopped holding, once', () => {
    const before = applyFacts(plan([{ id: 'u', say: 's', kind: 'url-contains', value: 'landmark=' }]), page())
    const after = applyFacts(before, page({ url: 'https://hotels.example/list?city=1' }))
    expect(newlyLost(before, after).map((check) => check.id)).toEqual(['u'])
    // Still lost on the next look, but that is no longer news.
    const later = applyFacts(after, page({ url: 'https://hotels.example/list?city=1' }))
    expect(newlyLost(after, later)).toEqual([])
    expect(shouldEscalate(later).map((check) => check.id)).toEqual(['u'])
  })

  it('holds the finish until every decidable check holds', () => {
    const two = plan([
      { id: 'u', say: 's', kind: 'url-contains', value: 'landmark=' },
      { id: 't', say: 's', kind: 'text-contains', value: '直线距离' },
    ])
    expect(canFinish(applyFacts(two, page()))).toBe(true)

    const half = applyFacts(two, page({ url: 'https://hotels.example/list?city=1' }))
    expect(canFinish(half)).toBe(false)
    expect(blockedChecks(half).map((check) => check.id)).toEqual(['u'])
  })

  it('never lets an ask check block the finish or raise an escalation', () => {
    const asked = plan([
      { id: 'q', say: 's', kind: 'ask' },
      { id: 'u', say: 's', kind: 'url-contains', value: 'landmark=' },
    ])
    const now = applyFacts(asked, page())
    expect(blockedChecks(now).map((check) => check.id)).toEqual([])
    expect(canFinish(now)).toBe(true)
    expect(shouldEscalate(now)).toEqual([])
  })
})
