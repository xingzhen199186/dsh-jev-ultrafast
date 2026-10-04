import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { TEXT_PROVIDERS } from '../src/decision/text-providers'
import { assertDshRoute, captureLlm, dshStream, providerOptions, type DshLlmLike } from '../src/dsh-model'

/** A model service that answers whatever this test cares about and nothing else. */
const service = (overrides: Partial<DshLlmLike> = {}): DshLlmLike => ({
  listProviders: () => [],
  listModels: () => [],
  stream: () => (async function* () {})(),
  ...overrides,
})

const presetIds = TEXT_PROVIDERS.map((spec) => spec.id)

/**
 * The seam between this plugin and DSH's own model service. Its two failure modes are the
 * reason it is tested at all: an unregistered provider streams nothing without an error,
 * and a provider whose model list does not answer must not take the door away.
 */
describe('DSH model service', () => {
  it('offers the presets and nothing else when this profile has no model service', async () => {
    const options = await providerOptions(undefined)
    expect(options.map((entry) => entry.id)).toEqual(presetIds)
    expect(options.every((entry) => entry.kind === 'preset')).toBe(true)
    expect(options[0]?.models.length).toBeGreaterThan(0)
  })

  it('puts the routes DSH serves in front, under a prefixed value', async () => {
    const options = await providerOptions(
      service({
        listProviders: () => [
          { id: 'deepseek-official', name: 'DeepSeek' },
          { id: 'anthropic' },
        ],
        listModels: (provider) => [{ id: `${provider}-model` }],
      }),
    )
    expect(options.map((entry) => entry.id)).toEqual([
      'dsh:deepseek-official',
      'dsh:anthropic',
      ...presetIds,
    ])
    expect(options[0]).toMatchObject({ label: 'DeepSeek', kind: 'dsh', models: ['deepseek-official-model'] })
    // A route DSH does not name falls back to its id rather than showing nothing.
    expect(options[1]).toMatchObject({ label: 'anthropic', models: ['anthropic-model'] })
  })

  it('keeps a route whose model list does not answer, and every preset when the roster does not', async () => {
    const half = await providerOptions(
      service({
        listProviders: () => [{ id: 'quiet' }],
        listModels: () => {
          throw new Error('no list')
        },
      }),
    )
    // The door stays: a provider that publishes no list is still a door you can pick.
    expect(half[0]).toMatchObject({ id: 'dsh:quiet', models: [] })
    expect(half.length).toBe(presetIds.length + 1)

    const none = await providerOptions(
      service({
        listProviders: () => {
          throw new Error('no roster')
        },
      }),
    )
    expect(none.map((entry) => entry.id)).toEqual(presetIds)
  })

  it('does not merge a built-in route into a preset of the same name', async () => {
    // The prefix is what keeps these two apart; without it the preset would shadow the
    // route or the other way round, depending on which list was written first.
    const options = await providerOptions(service({ listProviders: () => [{ id: 'deepseek' }] }))
    expect(options.map((entry) => entry.id)).toContain('dsh:deepseek')
    expect(options.map((entry) => entry.id)).toContain('deepseek')
  })

  it('refuses a built-in route DSH does not serve, naming the route', async () => {
    const llm = service({ listProviders: () => [{ id: 'deepseek-official' }] })
    await expect(assertDshRoute(llm, 'deepseek-official')).resolves.toBeUndefined()
    await expect(assertDshRoute(llm, 'gone')).rejects.toThrow('gone')
    // Without a service at all, the refusal names the way out instead of the route.
    await expect(assertDshRoute(undefined, 'deepseek-official')).rejects.toThrow('预设供应商')
  })

  it('streams through DSH with the message the harness builds itself', async () => {
    const seen: Record<string, unknown>[] = []
    const llm = service({
      stream: (options) => {
        seen.push(options)
        return (async function* () {})()
      },
    })
    const signal = new AbortController().signal
    await dshStream(llm, {
      provider: 'deepseek-official',
      model: 'deepseek-flash',
      system: 'system wording',
      user: 'fill this field',
      maxTokens: 1200,
      reasoningEffort: 'low',
      signal,
    })[Symbol.asyncIterator]().next()

    const request = seen[0]!
    expect(request).toMatchObject({
      provider: 'deepseek-official',
      model: 'deepseek-flash',
      system: 'system wording',
      maxTokens: 1200,
      reasoningEffort: 'low',
      signal,
    })
    expect(request).not.toHaveProperty('response_format')
    const message = (request.messages as { content: { type: string; text: string }[] }[])[0]!
    expect(message.content[0]).toEqual({ type: 'text', text: 'fill this field' })

    // Reasoning is only sent when there is something to say about it.
    const plain: Record<string, unknown>[] = []
    const quiet = service({
      stream: (options) => {
        plain.push(options)
        return (async function* () {})()
      },
    })
    await dshStream(quiet, {
      provider: 'p',
      model: 'm',
      system: 's',
      user: 'u',
      maxTokens: 1,
    })[Symbol.asyncIterator]().next()
    expect(plain[0]).not.toHaveProperty('reasoningEffort')
  })

  it('carries a session id, because some routes refuse a call without one', async () => {
    // Measured 2026-10-04: the opencode-backed routes behind DSH answer a call with no
    // `x-opencode-session` with a 400 (`MissingSessionID`), and the harness fills that header
    // from this one field (`GenerateOptions.sessionId`) — so a call always carries one.
    const seen: Record<string, unknown>[] = []
    const llm = service({
      stream: (options) => {
        seen.push(options)
        return (async function* () {})()
      },
    })
    await dshStream(llm, {
      provider: 'opencode-go',
      model: 'deepseek-v4.1-flash',
      system: 'system wording',
      user: 'fill this field',
      maxTokens: 1200,
      sessionId: 'session-1',
    })[Symbol.asyncIterator]().next()
    expect(seen[0]!.sessionId).toBe('session-1')

    // A caller with no live session (the settings page's own test button) still sends one.
    await dshStream(llm, {
      provider: 'opencode-go',
      model: 'deepseek-v4.1-flash',
      system: 'system wording',
      user: 'fill this field',
      maxTokens: 1200,
    })[Symbol.asyncIterator]().next()
    expect(typeof seen[1]!.sessionId).toBe('string')
    expect(seen[1]!.sessionId).not.toBe('')
  })

  it('refuses to stream at all without a model service', () => {
    expect(() =>
      dshStream(undefined, { provider: 'p', model: 'm', system: 's', user: 'u', maxTokens: 1 }),
    ).toThrow('DSH 模型服务')
  })

  it('captures the service whenever this profile has one', () => {
    const llm = service()
    const withLlm = {
      inject: (keys: string[], callback: (inner: { llm?: DshLlmLike }) => void) => {
        expect(keys).toEqual(['llm'])
        callback({ llm })
      },
    } as unknown as Context
    expect(captureLlm(withLlm).get()).toBe(llm)
    // A profile with no model route still loads the plugin: the getter simply stays empty.
    expect(captureLlm({} as Context).get()).toBeUndefined()
  })
})
