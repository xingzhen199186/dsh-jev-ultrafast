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

  it('reads the answer one real run refused, where the extra goal key was never the reason', () => {
    // Character for character what the trace of run-1790932184390-wrft kept of the control model's
    // answer: the record cuts the model's own words at 200 characters, and the cut landed inside the
    // second check, so what survives cannot be valid json whatever the answer said next. The one
    // thing that run's sentence does show is the key the answer carried — `goal`, which the prompt's
    // own shape example asks for and which this parser has always ignored. Written out to its end,
    // the same answer parses: the `goal` beside `checks` is not what a refusal can be about.
    const kept =
      '{"goal":"在携程搜索「北大医疗产业园」进入酒店列表，设置位置筛选并按「直线距离 近→远」排序后，读出第一家酒店的名字、直线距离和点评数。","checks":[{"id":"site-domain","say":"地址一直在携程域内","kind":"url-contains","value":"ctrip.com"},{"id":"brand","say":"页面上一直出现携程品牌词",'
    expect(kept).toHaveLength(200)
    let why = ''
    expect(parseControlPlan(kept, 'g', (said) => { why = said })).toBeNull()
    // Cut off, not answered wrongly: the reason says so, which is the whole point of reporting it.
    expect(why).toMatch(/不是能解析的 JSON/)
    expect(why).toMatch(/还没写完就断了/)

    const whole = kept + '"kind":"text-contains","value":"携程"}]}'
    expect(parseControlPlan(whole, 'g')?.checks.map((check) => check.id)).toEqual(['site-domain', 'brand'])

    // And it is not `goal` in particular: every key beside `checks` is the model's own business.
    const noisy = whole.replace('"goal":', '"notes":"这些是我随手加的","goal":')
    expect(parseControlPlan(noisy, 'g')?.checks).toHaveLength(2)
  })

  it('says which rule refused a plan, so a trace can tell the ways apart', () => {
    // Every refusal used to arrive as one and the same sentence, which left a run that asked a
    // real question with a record nobody could act on: not-json, prose-wrapped json, thirteen
    // checks and a check with no value all read as 答非所问 and nothing more.
    const whyOf = (raw: unknown): string => {
      let why = ''
      expect(parseControlPlan(raw as string, 'g', (said) => { why = said })).toBeNull()
      return why
    }
    expect(whyOf('   ')).toBe('模型什么都没说')
    expect(whyOf(JSON.stringify({ checks: [] }) + ' and that is all')).toBe(
      '不是能解析的 JSON：JSON 后面还跟着别的话（不是纯 JSON）',
    )
    expect(whyOf("I think the landmark matters, so here's a sentence instead of json")).toBe(
      '不是能解析的 JSON：JSON 本身对不上（引号、逗号或括号）',
    )
    expect(whyOf('[]')).toBe('顶层不是一个 JSON 对象')
    expect(whyOf('{"goal":"g"}')).toBe('没有 checks 数组')
    expect(whyOf('{"checks":[]}')).toBe('checks 是空的')
    expect(whyOf(JSON.stringify({
      checks: Array.from({ length: 13 }, (_, i) => ({ id: `c${i}`, say: 's', kind: 'url-contains', value: 'x' })),
    }))).toBe('checks 有 13 条，超过 12 条上限')
    expect(whyOf('{"checks":[{"id":"a","say":"s","kind":"nonsense","value":"x"}]}')).toBe(
      '第 1 条的 kind「nonsense」不在 url-contains / text-contains / text-absent / ask 里',
    )
    expect(whyOf('{"checks":[{"id":"a","say":"","kind":"url-contains","value":"x"}]}')).toBe('第 1 条的 id 或 say 是空的')
    expect(whyOf('{"checks":[{"id":"a","say":"s","kind":"url-contains"}]}')).toBe('第 1 条（id=a）没有可判定的 value')
    expect(whyOf('{"checks":[{"id":"a","say":"s","kind":"ask","value":"x"}]}')).toBe('第 1 条是 ask，不能带 value')
    expect(
      whyOf('{"checks":[{"id":"a","say":"s","kind":"url-contains","value":"x"},{"id":"a","say":"t","kind":"text-contains","value":"y"}]}'),
    ).toBe('第 2 条的 id「a」和前面的一条重复了')
    // A read that works reports nothing, which is what keeps this out of the way of good runs.
    let quiet = 'unset'
    expect(parseControlPlan('{"checks":[{"id":"a","say":"s","kind":"url-contains","value":"x"}]}', 'g', (said) => { quiet = said })).not.toBeNull()
    expect(quiet).toBe('unset')
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
