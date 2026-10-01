import { describe, expect, it } from 'vitest'
import { DECISION_PROVIDERS, DECISION_PROVIDER_IDS, decisionProvider, resolveDecisionRoute } from '../src/decision/providers'
import { Config } from '../src/index'

/**
 * The two doors to the decision service differ in exactly three values — an address,
 * a model name and a credential name — and those live in one table. Everything else
 * (the settings page's dropdown, the host's request, the health check) reads it, so
 * these checks are what keeps a copy of the route from growing somewhere else.
 */
describe('decision providers', () => {
  const resolve = (data: unknown): { decisionProvider: { get(): string } } =>
    (Config as unknown as (input: unknown) => { decisionProvider: { get(): string } })(data)

  it('describes both doors completely', () => {
    expect(DECISION_PROVIDER_IDS).toEqual(['typesafe', 'openrouter'])
    for (const spec of DECISION_PROVIDERS) {
      expect(spec.label.length, spec.id).toBeGreaterThan(0)
      expect(spec.endpoint, spec.id).toMatch(/^https:\/\//)
      expect(spec.model.length, spec.id).toBeGreaterThan(0)
      expect(spec.keyRef, spec.id).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/)
      expect(spec.note.length, spec.id).toBeGreaterThan(0)
    }
  })

  it('keeps the doors apart, including the tilde in the alpha route model name', () => {
    const [typesafe, openrouter] = DECISION_PROVIDERS
    expect(openrouter!.endpoint).not.toBe(typesafe!.endpoint)
    expect(openrouter!.model).not.toBe(typesafe!.model)
    expect(openrouter!.keyRef).not.toBe(typesafe!.keyRef)
    // Dropping the tilde would ask OpenRouter for a model it does not serve, and the
    // request would fail at the far end with nothing local to point at.
    expect(openrouter!.model.startsWith('~')).toBe(true)
  })

  it('resolves a blank field to the chosen door, not to an empty string', () => {
    expect(resolveDecisionRoute({ provider: 'openrouter', endpoint: '', model: '   ', keyRef: '' })).toEqual({
      provider: 'openrouter',
      label: 'OpenRouter',
      endpoint: 'https://openrouter.ai/api/alpha/decisions',
      model: '~typesafe/jev-latest',
      keyRef: 'OPENROUTER_API_KEY',
      keyShape: { length: 73, prefix: 'sk-or-v1-' },
      wrapFallback: true,
    })
  })

  it('claims a key shape only where one is known', () => {
    // A shape is printed back to a reader as "the key here should look like this", so an
    // unfounded one is worse than none. OpenRouter's is `sk-or-v1-` plus 64 hex characters;
    // TypeSafe's has never been in hand on this machine and is therefore not claimed at all.
    expect(resolveDecisionRoute({ provider: 'openrouter' }).keyShape).toEqual({ length: 73, prefix: 'sk-or-v1-' })
    expect(resolveDecisionRoute({ provider: 'typesafe' }).keyShape).toBeUndefined()
  })

  it('lets a filled-in field win, trimmed', () => {
    const route = resolveDecisionRoute({
      provider: 'typesafe',
      endpoint: ' https://reseller.example.test/v1/systemone ',
      model: '',
      keyRef: 'MY_ROUTE_KEY',
    })
    expect(route.endpoint).toBe('https://reseller.example.test/v1/systemone')
    expect(route.keyRef).toBe('MY_ROUTE_KEY')
    expect(route.model).toBe('jev-latest')
    // The vendor endpoint takes the flat body, so its door never retries wrapped.
    expect(route.wrapFallback).toBe(false)
  })

  it('falls back to the first door when nothing names one', () => {
    expect(resolveDecisionRoute({}).provider).toBe('typesafe')
    expect(resolveDecisionRoute({ provider: '' }).provider).toBe('typesafe')
    expect(decisionProvider('nonsense').id).toBe('typesafe')
    expect(decisionProvider(undefined).id).toBe('typesafe')
  })

  it('accepts every door in the table through the schema, and nothing else', () => {
    // The dropdown's values come from DECISION_PROVIDER_IDS while the schema's union is
    // written out by hand; this is the check that the two are still the same list.
    for (const id of DECISION_PROVIDER_IDS) {
      expect(resolve({ decisionProvider: id }).decisionProvider.get()).toBe(id)
    }
    expect(() => resolve({ decisionProvider: 'not-a-door' })).toThrow()
  })
})
