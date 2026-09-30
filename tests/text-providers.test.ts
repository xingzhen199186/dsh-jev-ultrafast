import { describe, expect, it } from 'vitest'
import {
  DEFAULT_TEXT_PROVIDER,
  DSH_PREFIX,
  TEXT_PROVIDERS,
  dshRouteId,
  dshValue,
  isDshRoute,
  resolveTextRoute,
  textProvider,
} from '../src/decision/text-providers'

/**
 * The text model's doors, in one table, read by both halves of the plugin.
 *
 * Two things here are easy to get wrong later and would be quiet about it: a row
 * that forgets its credential name (the run then looks for a key nobody has), and
 * the `dsh:` prefix (a built-in route must never be resolved as a preset, because
 * a preset brings an address and a credential name that the built-in route does
 * not use).
 */
describe('text providers', () => {
  it('describes every preset completely', () => {
    expect(TEXT_PROVIDERS.length).toBeGreaterThan(0)
    for (const spec of TEXT_PROVIDERS) {
      expect(spec.label.length, spec.id).toBeGreaterThan(0)
      expect(spec.baseUrl, spec.id).toMatch(/^https:\/\//)
      expect(spec.models.length, spec.id).toBeGreaterThan(0)
      for (const model of spec.models) expect(model.length, `${spec.id}/${model}`).toBeGreaterThan(0)
      expect(spec.keyRef, spec.id).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/)
      expect(spec.note.length, spec.id).toBeGreaterThan(0)
    }
  })

  it('keeps the ids unique and leaves the dsh prefix to built-in routes', () => {
    const ids = TEXT_PROVIDERS.map((spec) => spec.id)
    expect(new Set(ids).size).toBe(ids.length)
    // A preset id that started with the prefix would be read as a built-in route and
    // silently lose its address and credential name.
    for (const id of ids) expect(id.startsWith(DSH_PREFIX), id).toBe(false)
    expect(textProvider(DEFAULT_TEXT_PROVIDER)?.id).toBe(DEFAULT_TEXT_PROVIDER)
  })

  it('resolves a blank field to the chosen door, not to an empty string', () => {
    const route = resolveTextRoute({ provider: 'openrouter', baseUrl: '', model: '   ', keyRef: '' })
    expect(route).toEqual({
      provider: 'openrouter',
      label: 'OpenRouter',
      kind: 'preset',
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'deepseek/deepseek-chat',
      keyRef: 'OPENROUTER_API_KEY',
      reasoning: 'none',
    })
  })

  it('lets a filled-in field win, trimmed', () => {
    const route = resolveTextRoute({
      provider: 'deepseek',
      baseUrl: ' https://reseller.example.test/v1 ',
      model: '',
      keyRef: 'MY_TEXT_KEY',
    })
    expect(route.baseUrl).toBe('https://reseller.example.test/v1')
    expect(route.keyRef).toBe('MY_TEXT_KEY')
    // Empty means "this door's own model"; the first row of the list is that model.
    expect(route.model).toBe(TEXT_PROVIDERS[0]!.models[0])
    expect(route.reasoning).toBe('none')
  })

  it('falls back to the default door when nothing names one', () => {
    expect(resolveTextRoute({}).provider).toBe(DEFAULT_TEXT_PROVIDER)
    expect(resolveTextRoute({ provider: '' }).provider).toBe(DEFAULT_TEXT_PROVIDER)
    expect(resolveTextRoute({ provider: 'nonsense' }).provider).toBe(DEFAULT_TEXT_PROVIDER)
  })

  it('reads a built-in door as a route with no address and no credential of ours', () => {
    const route = resolveTextRoute({ provider: dshValue('deepseek-official'), model: 'deepseek-v4-flash' })
    expect(route).toEqual({
      provider: 'dsh:deepseek-official',
      label: 'deepseek-official',
      kind: 'dsh',
      baseUrl: '',
      model: 'deepseek-v4-flash',
      keyRef: '',
      reasoning: 'none',
    })
    // A built-in route must never borrow a preset's address or credential name: if it
    // did, a run would go direct and fail with a key DSH was supposed to supply.
    expect(textProvider(route.provider)).toBeUndefined()
  })

  it('leaves the model of a built-in door empty until one is chosen', () => {
    // There is no sensible default to guess here — DSH route ids carry no model — so
    // the run is expected to fail loudly instead of naming a model nobody picked.
    expect(resolveTextRoute({ provider: dshValue('deepseek-official') }).model).toBe('')
    expect(resolveTextRoute({ provider: dshValue('deepseek-official'), model: '  ' }).model).toBe('')
  })

  it('recognises the prefix without eating an id that merely contains it', () => {
    expect(isDshRoute(dshValue('x'))).toBe(true)
    expect(isDshRoute('dshx')).toBe(false)
    expect(isDshRoute(undefined)).toBe(false)
    expect(dshRouteId(dshValue('deepseek-official'))).toBe('deepseek-official')
    expect(dshRouteId('deepseek')).toBe('deepseek')
    expect(dshRouteId(dshValue(''))).toBe('')
  })

  it('keeps reasoning to the two values the helper understands', () => {
    expect(resolveTextRoute({ reasoning: 'auto' }).reasoning).toBe('auto')
    expect(resolveTextRoute({ reasoning: 'none' }).reasoning).toBe('none')
    expect(resolveTextRoute({ reasoning: '' }).reasoning).toBe('none')
    expect(resolveTextRoute({ reasoning: 'high' }).reasoning).toBe('none')
  })
})
