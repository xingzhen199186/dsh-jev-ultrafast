import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/decision/text-helper', () => ({ askText: vi.fn() }))

import { askText } from '../src/decision/text-helper'
import { controlModelFromTextDoor } from '../src/control/ask-control'

const mockAsk = vi.mocked(askText)
beforeEach(() => {
  mockAsk.mockReset()
})
const answer = (content: string): { content: string; usage: Record<string, unknown> } => ({ content, usage: {} })
const source = (over: { apiKey?: string } = {}) => ({
  baseUrl: 'https://example.test/v1',
  apiKey: over.apiKey ?? 'key-1',
  model: 'a-model',
  reasoning: 'none' as const,
})

describe('the control model through the run\u2019s own text door', () => {
  it('hands the answer straight back, unparsed', async () => {
    mockAsk.mockResolvedValue(answer('{"checks":[]}'))
    const model = controlModelFromTextDoor(() => source())
    await expect(model.call({ system: 'S', user: 'U' })).resolves.toBe('{"checks":[]}')
    const [sent, system, user, maxTokens] = mockAsk.mock.calls[0]
    expect(system).toBe('S')
    expect(user).toBe('U')
    expect(maxTokens).toBeUndefined()
    expect(sent.model).toBe('a-model')
  })

  it('resolves the source per call, so a rotated credential is not answered with a stale copy', async () => {
    mockAsk.mockResolvedValue(answer('x'))
    let calls = 0
    const model = controlModelFromTextDoor(() => source({ apiKey: `key-${++calls}` }))
    await model.call({ system: 's', user: 'u' })
    await model.call({ system: 's', user: 'u' })
    expect(mockAsk.mock.calls.map(([sent]) => sent.apiKey)).toEqual(['key-1', 'key-2'])
  })

  it('passes the caller\u2019s cancellation down to the door', async () => {
    mockAsk.mockResolvedValue(answer('x'))
    const controller = new AbortController()
    const model = controlModelFromTextDoor(() => source())
    await model.call({ system: 's', user: 'u', signal: controller.signal })
    const [sent] = mockAsk.mock.calls[mockAsk.mock.calls.length - 1]
    expect(sent.signal).toBe(controller.signal)
  })

  it('lets a broken door throw, for readChecklist to turn into nothing at all', async () => {
    mockAsk.mockRejectedValue(new Error('route is down'))
    const model = controlModelFromTextDoor(() => source())
    await expect(model.call({ system: 's', user: 'u' })).rejects.toThrow('route is down')
  })
})
