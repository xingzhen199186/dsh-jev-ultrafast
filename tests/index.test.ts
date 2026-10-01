import { readFileSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { describe, expect, it } from 'vitest'
import type { Config as ConfigShape } from '../src/config'
import { resolveDecisionRoute } from '../src/decision/providers'
import { resolveTextRoute } from '../src/decision/text-providers'
import { Config, apply, cutNote, followNotes, inject, launchNote, name, saveScreenshot } from '../src/index'

/**
 * The plugin's registration surface: what it asks the harness for, what it
 * registers, and the defaults a user gets without writing any configuration.
 *
 * The loader calls the schema with whatever a cordis.yml provided and lets the
 * defaults fill the rest — a call the schema's own type does not describe, which
 * is why this one line casts.
 */
function resolveConfig(input: Record<string, unknown>): ConfigShape {
  return (Config as unknown as (data: unknown) => ConfigShape)(input)
}

function registerWith(): ToolDefinition[] {
  const registered: ToolDefinition[] = []
  const ctx = {
    tools: {
      register: (definition: ToolDefinition) => {
        registered.push(definition)
        return () => {}
      },
    },
  } as unknown as Context
  apply(ctx, resolveConfig({}))
  return registered
}

describe('plugin surface', () => {
  it('declares its identity and the two services it needs', () => {
    expect(name).toBe('dsh-jev-ultrafast')
    expect(inject).toEqual(['tools', 'credentials'])
  })

  it('registers two tools, each with a closed output contract', () => {
    const registered = registerWith()
    expect(registered.map((tool) => tool.name)).toEqual(['jev_browser_task', 'jev_browser_read'])
    for (const tool of registered) {
      expect(tool.output.schema, tool.name).toMatchObject({ type: 'object', additionalProperties: false })
    }
    // The reading route answers a different question, so it must not carry the task
    // parameters: a goal handed to a tool that never decides anything is a promise the
    // tool cannot keep.
    const readParameters = registered[1]!.parameters as { properties: Record<string, unknown>; required: string[] }
    expect(Object.keys(readParameters.properties)).toEqual(['url', 'maxScreens', 'maxChars'])
    expect(readParameters.required).toEqual(['url'])
  })

  it('names credential references rather than secrets, and leaves the route to the chosen provider', () => {
    const config = resolveConfig({})
    expect(config.decisionProvider.get()).toBe('typesafe')
    // The three route fields stay empty by default on purpose: empty means "whatever
    // the chosen door says", so switching providers is one field to change and no
    // value from the other door can be left behind to be used by mistake.
    expect(config.decisionEndpoint.get()).toBe('')
    expect(config.decisionModel.get()).toBe('')
    expect(config.decisionKeyRef.get()).toBe('')
    expect(
      resolveDecisionRoute({
        provider: config.decisionProvider.get(),
        endpoint: config.decisionEndpoint.get(),
        model: config.decisionModel.get(),
        keyRef: config.decisionKeyRef.get(),
      }),
    ).toMatchObject({
      provider: 'typesafe',
      endpoint: 'https://api.typesafe.ai/v1/systemone',
      model: 'jev-latest',
      keyRef: 'TYPESAFE_API_KEY',
    })
    // The text half works the same way: the door carries the values, so all four
    // overrides start empty rather than repeating DeepSeek's address here.
    expect(config.textProvider.get()).toBe('deepseek')
    expect(config.textBaseUrl.get()).toBe('')
    expect(config.textModel.get()).toBe('')
    expect(config.textKeyRef.get()).toBe('')
    expect(
      resolveTextRoute({
        provider: config.textProvider.get(),
        baseUrl: config.textBaseUrl.get(),
        model: config.textModel.get(),
        keyRef: config.textKeyRef.get(),
        reasoning: config.textReasoning.get(),
      }),
    ).toMatchObject({
      provider: 'deepseek',
      kind: 'preset',
      baseUrl: 'https://api.deepseek.com/v1',
      model: 'deepseek-v4-flash',
      keyRef: 'DEEPSEEK_API_KEY',
    })
    expect(config.textReasoning.get()).toBe('none')
    expect(config.cdpUrl.get()).toBe('')
    expect(config.userDataDir.get()).toBe('')
    expect(config.maxSteps.get()).toBe(60)
    expect(config.screenshots.get()).toBe(false)
  })

  it('makes every field live, which is what lets the settings page edit it', () => {
    // The Plugins page only hands a page a form when the entry exposes live
    // Config fields, so a field that stops being volatile silently loses its
    // input. The whole surface is flat, so every own value is one field.
    const fields = Object.entries(resolveConfig({}))
    expect(fields.length).toBeGreaterThan(0)
    for (const [key, value] of fields) {
      expect(typeof (value as { get?: unknown }).get, `${key} is not a live field`).toBe('function')
    }
  })
})

describe('the step line that reports a new window', () => {
  const entry = { url: 'https://baike.test/subject', title: 'A subject page' }

  it('says which page the run moved onto and which it left behind', () => {
    expect(
      followNotes([
        { step: 2, adopted: entry, appeared: [{ url: 'https://ads.test/popup', title: 'Popup' }, entry] },
      ]),
    ).toEqual(['还点开了「Popup」，留在浏览器里没跟', '点开了新窗口「A subject page」，已跟过去'])
  })

  it('says the click went somewhere else even when it could not follow', () => {
    // A page the run cannot use (a browser-internal one) still has to be reported:
    // otherwise the step reads as "nothing happened", which is what this line exists
    // to stop saying.
    expect(followNotes([{ step: 1, adopted: null, appeared: [{ url: 'chrome://newtab/', title: '' }] }])).toEqual([
      '点开了新窗口「chrome://newtab/」，没有跟过去',
    ])
  })
})

describe('the line that reports a page too big for one decision to read', () => {
  it('says nothing when the whole page was sent', () => {
    // The ordinary case. A run that read the page whole must not grow a sentence about size, or the
    // line would stop meaning anything on the runs where it does appear.
    expect(cutNote(12, 0, 0)).toBe('')
  })

  it('names both what was sent and what was left out', () => {
    // The reader cannot tell a wrong decision from a decision made on a fraction of the page, so the
    // count comes first and the reason it was cut comes with it.
    expect(cutNote(44, 53, 0)).toBe('（这一页元素太多，已按与目标的相关性裁到 44 项，另有 53 项没有送去判断）')
  })

  it('reports the page text on its own when only the text was too long', () => {
    expect(cutNote(12, 0, 3000)).toBe('（这一页文字太长，只把前面的 3000 字送去判断，后面还有 3000 字没有送去）')
  })

  it('reads as one sentence when both had to be cut', () => {
    expect(cutNote(44, 53, 250)).toBe(
      '（这一页元素太多，已按与目标的相关性裁到 44 项，另有 53 项没有送去判断；' +
        '文字也太长，只把前面的 3000 字送去判断，后面还有 250 字没有送去）',
    )
  })
})

describe('the line that reports a browser the run started itself', () => {
  it('says nothing when a browser was already there', () => {
    // The ordinary case: a run that found a browser must not grow a sentence about one.
    expect(launchNote(null)).toBe('')
  })

  it('names the browser it started and warns about its own profile', () => {
    // A window appearing on the reader's desktop is not something to leave unsaid, and
    // the one fact they need is that it is not their everyday browser.
    const note = launchNote({
      kind: 'edge',
      label: 'Edge',
      exe: 'C:\\msedge.exe',
      endpoint: 'http://127.0.0.1:63412',
      profileDir: 'C:\\profile\\edge',
      source: '插件启动的 Edge',
    })
    expect(note).toContain('启动 Edge')
    expect(note).toContain('登录')
  })
})

describe('the screenshot a run can leave behind', () => {
  it('writes what the browser handed over and returns the path to it', () => {
    // What matters is that the bytes land somewhere a caller can open, since a screenshot
    // nobody can look at is the dead code this replaced.
    const path = saveScreenshot(Buffer.from('hello').toString('base64'))

    expect(path).not.toBe('')
    expect(path.endsWith('.jpg')).toBe(true)
    expect(readFileSync(path, 'utf8')).toBe('hello')
  })
})
