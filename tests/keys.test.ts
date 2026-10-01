import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { changeKey, describeKey, storableNames } from '../src/credentials'
import { DECISION_PROVIDERS } from '../src/decision/providers'
import { TEXT_PROVIDERS } from '../src/decision/text-providers'

/**
 * The settings page can now store a key, so three rules have to hold without the
 * page being trusted: only names the plugin actually uses may be written; the value
 * is written to the store rather than read back from it; and a layer that outranks
 * the store is reported rather than silently lose the write.
 */

/** A stand-in credential store: records what it was asked, answers what it was told. */
function fakeStore(info: { configured: boolean; source?: string; writable: boolean }): {
  ctx: Context
  written: string[]
  removed: string[]
  refs: string[]
} {
  const written: string[] = []
  const removed: string[] = []
  const refs: string[] = []
  const ctx = {
    credentials: {
      describe: async (ref: unknown) => {
        refs.push(String(ref))
        return info
      },
      set: async (ref: unknown, value: string) => {
        refs.push(String(ref))
        written.push(value)
      },
      unset: async (ref: unknown) => {
        refs.push(String(ref))
        removed.push(String(ref))
      },
    },
  } as unknown as Context
  return { ctx, written, removed, refs }
}

const FILE = 'C:\\Users\\me\\.dsh\\.credentials.yaml'
const DOORS = DECISION_PROVIDERS.map((spec) => spec.keyRef)
/** Every preset's own credential name, which is what the text half stores under. */
const TEXT_DOORS = TEXT_PROVIDERS.map((spec) => spec.keyRef)
const ALL_DOORS = [...new Set([...DOORS, ...TEXT_DOORS])]

describe('storable names', () => {
  it('offers every door on both halves, so the other key can be stashed before switching over', () => {
    const names = storableNames('', '')
    expect(names.map((entry) => entry.name)).toEqual(ALL_DOORS)
    for (const spec of DECISION_PROVIDERS) {
      expect(names.find((entry) => entry.name === spec.keyRef)?.purpose, spec.keyRef).toContain('决策服务')
    }
    for (const spec of TEXT_PROVIDERS) {
      const entry = names.find((candidate) => candidate.name === spec.keyRef)
      // A name both halves want — OpenRouter's, say — is offered once, under whichever door
      // claimed it first, so the purpose only has to say which of the two it belongs to.
      expect(entry?.purpose, spec.keyRef).toMatch(DOORS.includes(spec.keyRef) ? /决策服务/ : /文本模型/)
    }
  })

  it('adds the custom names the configuration points at', () => {
    expect(storableNames('MY_ROUTE_KEY', 'MY_TEXT_KEY').map((entry) => entry.name)).toEqual([
      ...ALL_DOORS,
      'MY_ROUTE_KEY',
      'MY_TEXT_KEY',
    ])
  })

  it('does not offer the same name twice when a custom name is a door default', () => {
    const names = storableNames(ALL_DOORS[0]!, ` ${ALL_DOORS[1]} `)
    expect(names.map((entry) => entry.name)).toEqual(ALL_DOORS)
  })

  it('skips a name that could never work rather than drawing a box that cannot save', () => {
    expect(storableNames('has space', '9-lead').map((entry) => entry.name)).toEqual(ALL_DOORS)
    expect(storableNames('   ', '').map((entry) => entry.name)).toEqual(ALL_DOORS)
  })
})

describe('describeKey', () => {
  it('reports presence, source and writability — and never the value', async () => {
    const store = fakeStore({ configured: true, source: 'file', writable: true })
    const state = await describeKey(store.ctx, ' TYPESAFE_API_KEY ')
    expect(state).toEqual({ configured: true, source: 'file', writable: true })
    expect('value' in state).toBe(false)
    expect(store.refs).toEqual(['TYPESAFE_API_KEY'])
  })

  it('answers unconfigured for an illegal name without asking the store', async () => {
    const store = fakeStore({ configured: true, writable: true })
    expect(await describeKey(store.ctx, 'not a name')).toEqual({ configured: false, writable: false })
    expect(store.refs).toEqual([])
  })

  it('treats a store that refuses to answer as unconfigured', async () => {
    const ctx = {
      credentials: {
        describe: async () => {
          throw new Error('closed')
        },
      },
    } as unknown as Context
    expect(await describeKey(ctx, 'TYPESAFE_API_KEY')).toEqual({ configured: false, writable: false })
  })
})

describe('changeKey', () => {
  it('stores a trimmed value in the store', async () => {
    const store = fakeStore({ configured: false, writable: true })
    await changeKey(store.ctx, ' TYPESAFE_API_KEY ', { kind: 'store', value: '  sk-abc  ' }, FILE)
    expect(store.written).toEqual(['sk-abc'])
    expect(store.refs).toContain('TYPESAFE_API_KEY')
  })

  it('refuses an empty value and names the verb that does mean removal', async () => {
    const store = fakeStore({ configured: false, writable: true })
    await expect(changeKey(store.ctx, 'K_KEY', { kind: 'store', value: '   ' }, FILE)).rejects.toThrow(/清除/)
    expect(store.written).toEqual([])
  })

  it('clears by removing the entry rather than by writing a blank', async () => {
    const store = fakeStore({ configured: true, source: 'file', writable: true })
    await changeKey(store.ctx, 'K_KEY', { kind: 'clear' }, FILE)
    expect(store.removed).toEqual(['K_KEY'])
    expect(store.written).toEqual([])
  })

  it('refuses to write while a read-only layer supplies the name, in the user words', async () => {
    const store = fakeStore({ configured: true, source: 'env', writable: false })
    await expect(changeKey(store.ctx, 'K_KEY', { kind: 'store', value: 'sk-new' }, FILE)).rejects.toThrow(
      /环境变量/,
    )
    await expect(changeKey(store.ctx, 'K_KEY', { kind: 'clear' }, FILE)).rejects.toThrow(/环境变量/)
    expect(store.written).toEqual([])
    expect(store.removed).toEqual([])
  })

  it('refuses an illegal name before touching the store', async () => {
    const store = fakeStore({ configured: false, writable: true })
    await expect(changeKey(store.ctx, 'not a name', { kind: 'store', value: 'sk' }, FILE)).rejects.toThrow(
      /合法的凭据名/,
    )
    expect(store.refs).toEqual([])
  })
})

/**
 * The OpenRouter cell was found holding a 35-character `sk-3130b…` key that nobody had pasted there
 * (2026-09-29, and again 2026-10-02), and the next run answered 401. The value can only have come
 * from the box, so no code path is fixed by a check here alone — but a value that is not this door's
 * key by length or by opening is refused rather than written, which is what turns that class of
 * accident into a sentence the reader can act on instead of a silent 401 later.
 *
 * The shape is read from the door table, never copied: `DECLARED` below is what the guard is
 * supposed to consult, so a table that gained or changed a shape moves these tests with it.
 */
describe('changeKey refuses a value whose shape is not the one the name declares', () => {
  const DECLARED = DECISION_PROVIDERS.find((spec) => spec.keyRef === 'OPENROUTER_API_KEY')?.keyShape
  /** The value the real incident left in the cell: 35 characters, `sk-3130b` in front. */
  const STRAY = `sk-3130b${'x'.repeat(27)}`
  /** A key of the declared shape: the prefix, then exactly as many characters as remain of the length. */
  const FITTING = `${DECLARED?.prefix ?? ''}${'a'.repeat((DECLARED?.length ?? 0) - (DECLARED?.prefix.length ?? 0))}`

  const refusal = async (
    name: string,
    value: string,
  ): Promise<{ error: Error | undefined; store: ReturnType<typeof fakeStore> }> => {
    const store = fakeStore({ configured: false, writable: true })
    const error = await changeKey(store.ctx, name, { kind: 'store', value }, FILE).then(
      () => undefined,
      (failure: unknown) => failure as Error,
    )
    return { error, store }
  }

  it('takes the shape it enforces from the door table, not from a second copy of it', () => {
    expect(DECLARED).toEqual({ length: 73, prefix: 'sk-or-v1-' })
    expect(STRAY).toHaveLength(35)
    expect(FITTING).toHaveLength(DECLARED?.length ?? 0)
  })

  it('refuses the stray value for OpenRouter, does not write it, and never repeats it', async () => {
    const { error, store } = await refusal('OPENROUTER_API_KEY', STRAY)
    expect(error?.message).toBeDefined()
    expect(store.written).toEqual([])
    // Refused before the store was asked anything: a shape that cannot belong is answered here.
    expect(store.refs).toEqual([])
    // The value must not reach the reader, not even its first characters.
    expect(error?.message).not.toContain(STRAY)
    expect(error?.message).not.toContain('sk-3130b')
    expect(error?.message).not.toContain('3130')
    // What it may say: what this door's key looks like, that this is not it, and how to get past.
    expect(error?.message).toContain('OPENROUTER_API_KEY')
    expect(error?.message).toContain('73')
    expect(error?.message).toContain('sk-or-v1-')
    expect(error?.message).toContain('35')
    expect(error?.message).toMatch(/不是 OpenRouter 的密钥/)
    expect(error?.message).toContain('清除')
  })

  it('refuses a paste that lost its tail, and says which half was wrong', async () => {
    const cut = `${DECLARED?.prefix ?? ''}${'a'.repeat((DECLARED?.length ?? 0) - (DECLARED?.prefix.length ?? 0) - 2)}`
    const { error, store } = await refusal('OPENROUTER_API_KEY', cut)
    // The opening is right, so the sentence names the length rather than the prefix — the one
    // judgement about the value the refusal is allowed to make.
    expect(error?.message).toContain('开头是对的，长度不对')
    expect(store.written).toEqual([])
  })

  it('stores a value of the declared shape', async () => {
    const store = fakeStore({ configured: false, writable: true })
    await changeKey(store.ctx, 'OPENROUTER_API_KEY', { kind: 'store', value: FITTING }, FILE)
    expect(store.written).toEqual([FITTING])
  })

  it('stores under a name no door declares a shape for, exactly as before', async () => {
    // TypeSafe's own door declares no shape, and a made-up custom name belongs to no table at all:
    // both keep the permissive behaviour this function has always had.
    for (const name of ['TYPESAFE_API_KEY', 'MY_ROUTE_KEY', 'DEEPSEEK_API_KEY']) {
      const store = fakeStore({ configured: false, writable: true })
      await changeKey(store.ctx, name, { kind: 'store', value: STRAY }, FILE)
      expect(store.written, name).toEqual([STRAY])
    }
  })

  it('clears a wrongly shaped value without arguing about its shape', async () => {
    const store = fakeStore({ configured: true, source: 'file', writable: true })
    await changeKey(store.ctx, 'OPENROUTER_API_KEY', { kind: 'clear' }, FILE)
    expect(store.removed).toEqual(['OPENROUTER_API_KEY'])
  })
})
