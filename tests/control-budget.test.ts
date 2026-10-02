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

describe('why a checklist was lost, for whoever reads the run afterwards', () => {
  it('carries the model\u2019s own words when the answer was not a plan', async () => {
    // The reason this exists: "清单没读成" alone cannot tell a door that refused from a model that
    // answered something this parser will not accept — and only the second one is a prompt problem.
    const said = 'I think the landmark matters, so here is a sentence instead of json'
    const heard: string[] = []
    const plan = await readChecklist(controlModelFrom(async () => said), asked, newControlBudget(3), {
      onFailure: (why) => heard.push(why),
    })
    expect(plan).toBeNull()
    expect(heard).toEqual([`答非所问：${said}`])

    // A long answer is cut short: this is a reason to read, not a transcript.
    const long = 'x'.repeat(500)
    const cut: string[] = []
    await readChecklist(controlModelFrom(async () => long), asked, newControlBudget(3), {
      onFailure: (why) => cut.push(why),
    })
    expect(cut).toEqual([`答非所问：${'x'.repeat(200)}`])

    // And a read that worked reports nothing at all: the sentence is for the failures only.
    const quiet: string[] = []
    await readChecklist(controlModelFrom(async () => goodAnswer), asked, newControlBudget(3), {
      onFailure: (why) => quiet.push(why),
    })
    expect(quiet).toEqual([])
  })

  it('names the other three ways a read is lost', async () => {
    const spent: string[] = []
    await readChecklist(controlModelFrom(async () => goodAnswer), asked, newControlBudget(0), {
      onFailure: (why) => spent.push(why),
    })
    expect(spent).toEqual(['这次运行的问话次数用完了'])

    const veryLong = 'route is down'.repeat(50)
    const broken: string[] = []
    await readChecklist(
      controlModelFrom(async () => {
        throw new Error(veryLong)
      }),
      asked,
      newControlBudget(3),
      { onFailure: (why) => broken.push(why) },
    )
    expect(broken).toEqual([`调用出错：${veryLong.slice(0, 200)}`])

    const late: string[] = []
    const stuck: ControlModel = {
      call: ({ signal }) =>
        new Promise<string>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new Error('aborted')))
        }),
    }
    await readChecklist(stuck, asked, newControlBudget(3), { timeoutMs: 20, onFailure: (why) => late.push(why) })
    expect(late).toEqual(['超时（20 毫秒）'])
  })
})
