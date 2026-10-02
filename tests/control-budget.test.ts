import { describe, expect, it, vi } from 'vitest'
import {
  CONTROL_TIMEOUT_MS,
  controlModelFrom,
  newControlBudget,
  readChecklist,
  spendControlCall,
  type ControlModel,
} from '../src/control/control-model'

const asked = { goal: '找最近的酒店', url: 'https://example.test/', title: '首页' }
const goodAnswer =
  '{"goal":"g","checks":[{"id":"landmark","say":"地标一直在","kind":"url-contains","value":"landmark="}]}'

describe('the budget bounds the asking', () => {
  it('counts whole calls and stops at the cap', () => {
    const budget = newControlBudget(2)
    expect(budget.cap).toBe(2)
    expect([spendControlCall(budget), spendControlCall(budget), spendControlCall(budget)]).toEqual([
      true,
      true,
      false,
    ])
    expect(budget.used).toBe(2)
  })

  it('treats a nonsense cap as none at all', () => {
    expect(newControlBudget(-3).cap).toBe(0)
    expect(newControlBudget(Number.NaN).cap).toBe(0)
    expect(newControlBudget(2.7).cap).toBe(2)
    expect(spendControlCall(newControlBudget(0))).toBe(false)
  })

  it('is a plain default, not a hidden setting', () => {
    expect(CONTROL_TIMEOUT_MS).toBe(20_000)
  })
})

describe('reading a checklist never becomes the run\u2019s problem', () => {
  it('reads a good answer', async () => {
    const model = controlModelFrom(async () => goodAnswer)
    const plan = await readChecklist(model, asked, newControlBudget(3))
    expect(plan?.checks.map((check) => check.id)).toEqual(['landmark'])
    expect(plan?.goal).toBe(asked.goal)
  })

  it('hands back nothing, and asks nobody, once the budget is spent', async () => {
    const call = vi.fn(async () => goodAnswer)
    const budget = newControlBudget(1)
    expect(await readChecklist(controlModelFrom(call), asked, budget)).not.toBeNull()
    expect(await readChecklist(controlModelFrom(call), asked, budget)).toBeNull()
    expect(call).toHaveBeenCalledTimes(1)
  })

  it('hands back nothing when the answer cannot be read', async () => {
    expect(await readChecklist(controlModelFrom(async () => 'I think the landmark matters'), asked, newControlBudget(3))).toBeNull()
    expect(await readChecklist(controlModelFrom(async () => ''), asked, newControlBudget(3))).toBeNull()
  })

  it('hands back nothing when the model itself fails', async () => {
    const model = controlModelFrom(async () => {
      throw new Error('route is down')
    })
    await expect(readChecklist(model, asked, newControlBudget(3))).resolves.toBeNull()
  })

  it('gives up on a stuck call instead of holding the run', async () => {
    let aborted = false
    const model: ControlModel = {
      call: ({ signal }) =>
        new Promise<string>((_resolve, reject) => {
          signal?.addEventListener('abort', () => {
            aborted = true
            reject(new Error('aborted'))
          })
        }),
    }
    const started = Date.now()
    await expect(readChecklist(model, asked, newControlBudget(3), { timeoutMs: 20 })).resolves.toBeNull()
    expect(aborted).toBe(true)
    expect(Date.now() - started).toBeLessThan(1_000)
  })

  it('counts the attempt that failed, so a broken route cannot be retried for ever', async () => {
    const budget = newControlBudget(2)
    const model = controlModelFrom(async () => {
      throw new Error('nope')
    })
    await readChecklist(model, asked, budget)
    await readChecklist(model, asked, budget)
    expect(budget.used).toBe(2)
  })
})
