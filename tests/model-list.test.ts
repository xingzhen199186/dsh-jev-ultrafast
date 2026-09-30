import { describe, expect, it, vi } from 'vitest'
import { fetchModelList, parseModelList } from '../src/model-list'

/**
 * The supplier's own model list.
 *
 * Two halves are worth locking down: reading whatever shape a supplier happens to answer with, and
 * describing a failure in a way that is safe to show on a page — an authentication refusal is the
 * one answer likely to quote the credential back, so it never gets repeated.
 */

describe('reading a supplier’s model list', () => {
  it('reads the shape OpenAI-compatible suppliers answer with', () => {
    expect(parseModelList({ object: 'list', data: [{ id: 'zz' }, { id: 'aa' }] })).toEqual(['aa', 'zz'])
  })

  it('reads the shape that names models under `models`', () => {
    expect(parseModelList({ models: [{ name: 'b' }, { name: 'a' }] })).toEqual(['a', 'b'])
  })

  it('reads a bare list of names', () => {
    expect(parseModelList(['m2', 'm1'])).toEqual(['m1', 'm2'])
  })

  it('takes whichever name a row offers, and drops rows that offer none', () => {
    expect(parseModelList({ data: [{ id: 'x', name: 'y' }, 'z', null, 7, {}, { id: '   ' }] })).toEqual([
      'x',
      'y',
      'z',
    ])
  })

  it('says nothing when the answer holds no names at all', () => {
    expect(parseModelList({ status: 'ok' })).toEqual([])
    expect(parseModelList(null)).toEqual([])
    expect(parseModelList('nope')).toEqual([])
  })
})

describe('asking a supplier for its model list', () => {
  it('asks the supplier’s own address with the key, and hands back the names', async () => {
    let seen: { url: string; auth?: string } = { url: '' }
    vi.stubGlobal('fetch', async (url: string, init: { headers: Record<string, string> }) => {
      seen = { url, auth: init.headers.authorization }
      return new Response(JSON.stringify({ data: [{ id: 'm' }] }))
    })
    await expect(fetchModelList({ baseUrl: 'https://api.example.com/v1/', apiKey: 'k' })).resolves.toEqual(['m'])
    expect(seen.url).toBe('https://api.example.com/v1/models')
    expect(seen.auth).toBe('Bearer k')
  })

  it('does not repeat the supplier’s own words when the key is refused', async () => {
    vi.stubGlobal('fetch', async () => new Response('your key sk-secret-123 is not valid', { status: 401 }))
    const failure = await fetchModelList({ baseUrl: 'https://api.example.com/v1', apiKey: 'k' }).catch(
      (error: Error) => error.message,
    )
    expect(failure).toMatch(/没认这把密钥/)
    expect(failure).not.toMatch(/sk-secret-123/)
  })

  it('repeats a useful explanation from any other failure', async () => {
    vi.stubGlobal('fetch', async () => new Response('model list is unavailable', { status: 503 }))
    await expect(fetchModelList({ baseUrl: 'https://api.example.com/v1', apiKey: 'k' })).rejects.toThrow(
      /HTTP 503：model list is unavailable/,
    )
  })

  it('says so when the answer is not JSON, or holds no model name', async () => {
    vi.stubGlobal('fetch', async () => new Response('<html>nope</html>'))
    await expect(fetchModelList({ baseUrl: 'https://api.example.com/v1', apiKey: 'k' })).rejects.toThrow(
      /不是 JSON/,
    )
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ ok: true })))
    await expect(fetchModelList({ baseUrl: 'https://api.example.com/v1', apiKey: 'k' })).rejects.toThrow(
      /没有一个模型名/,
    )
  })

  it('names the host it could not reach', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('connect ECONNREFUSED')
    })
    await expect(fetchModelList({ baseUrl: 'https://api.example.com/v1', apiKey: 'k' })).rejects.toThrow(
      /连不上「api\.example\.com」/,
    )
  })
})
