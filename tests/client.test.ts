import { describe, expect, it } from 'vitest'
import type { Config as ConfigShape } from '../src/config'
import { BROWSER_CONNECTIONS, BROWSER_KINDS, BROWSER_LABELS } from '../src/browser/launch'
import { FIELDS, FIELD_GROUPS, KEY_BLOCKS, SELF_SAVING_BLOCKS, fieldsOfBlock, saveOwnsKey } from '../src/client/fields'
import { INSPECTOR_URL } from '../src/command'
import { DECISION_PROVIDER_IDS } from '../src/decision/providers'
import { INSPECTOR_PATH, ROUTE, inspectorUrl } from '../src/protocol'
import { Config } from '../src/index'

const resolveConfig = (input: Record<string, unknown>): ConfigShape =>
  (Config as unknown as (data: unknown) => ConfigShape)(input)

/**
 * The settings page is the only place a user can edit this plugin, and it draws its
 * own inputs. A field the page does not know about is therefore a field nobody can
 * edit — and nothing else in the build would notice, which is what these checks are
 * for. They also double as the guard that the page and the schema stay one shape.
 */
describe('settings page fields', () => {
  it('covers every config key exactly once', () => {
    const schemaKeys = Object.keys(resolveConfig({})).sort()
    expect(FIELDS.map((field) => field.key).sort()).toEqual(schemaKeys)
  })

  it('gives every field a label, a kind, and choices where a choice is expected', () => {
    for (const field of FIELDS) {
      expect(field.label.length, field.key).toBeGreaterThan(0)
      expect(['text', 'number', 'switch', 'choice', 'provider'], field.key).toContain(field.kind)
      if (field.kind === 'choice') {
        expect((field.choices ?? []).length, field.key).toBeGreaterThan(0)
      }
    }
  })

  it('renders the two non-string fields as the control the schema expects', () => {
    const kinds = Object.fromEntries(FIELDS.map((field) => [field.key, field.kind]))
    expect(kinds.maxSteps).toBe('number')
    expect(kinds.screenshots).toBe('switch')
    expect(kinds.textReasoning).toBe('choice')
  })

  it('offers exactly the browsers the launcher can start', () => {
    // The list is written out in fields.ts rather than imported from the launcher, because
    // the launcher reads the disk and the page bundle must stay free of node built-ins.
    // That makes this check the only thing keeping the two from drifting apart.
    const field = FIELDS.find((candidate) => candidate.key === 'browserKind')
    expect(field?.kind).toBe('choice')
    expect(field?.group).toBe('browser')
    expect([...(field?.choices ?? [])]).toEqual([...BROWSER_KINDS])
    for (const kind of BROWSER_KINDS) {
      expect(field?.choiceLabels?.[kind], kind).toBe(BROWSER_LABELS[kind])
    }
  })

  it('offers the two ways to reach a browser, and opens a fresh install on the reader’s own Edge', () => {
    // Same reason as above, and the default matters here rather than being decoration: it is the
    // route a fresh install drives, and it is the one that attaches to the browser the reader is
    // already logged into instead of starting a window of its own.
    const field = FIELDS.find((candidate) => candidate.key === 'browserConnection')
    expect(field?.kind).toBe('choice')
    expect(field?.group).toBe('browser')
    expect([...(field?.choices ?? [])]).toEqual([...BROWSER_CONNECTIONS])
    for (const route of BROWSER_CONNECTIONS) {
      // A value with no wording would show the raw id in a Chinese page.
      expect(field?.choiceLabels?.[route]?.length, route).toBeGreaterThan(0)
    }
    expect(resolveConfig({}).browserConnection.get()).toBe('daily')
    // And the browser on the same no-config answer: Edge is what the schema declares, and it is
    // the one Windows ships with, so the default window a task opens is one the reader already has.
    expect(resolveConfig({}).browserKind.get()).toBe('edge')
  })

  it('draws the decision provider as a dropdown fed by the host route table', () => {
    const provider = FIELDS.find((field) => field.key === 'decisionProvider')
    expect(provider?.kind).toBe('choice')
    expect(provider?.choices).toEqual(DECISION_PROVIDER_IDS)
    for (const id of DECISION_PROVIDER_IDS) {
      // A value with no wording would show the raw id in a Chinese page.
      expect(provider?.choiceLabels?.[id]?.length, id).toBeGreaterThan(0)
    }
  })

  it('draws the text model its own 供应商 picker and a model box that knows the door', () => {
    // The list of doors is not in FIELDS: half of it is what DSH serves, which only the
    // host can enumerate, so the kind is what has to be right here.
    expect(FIELDS.find((field) => field.key === 'textProvider')?.kind).toBe('provider')
    const model = FIELDS.find((field) => field.key === 'textModel')
    // The model sits in the block, not in 高级设置: choosing a DSH route leaves no default
    // model, so leaving the box two clicks away would strand the reader.
    expect(model?.group).toBe('text')
    expect(model?.modelsFrom).toBe('textProvider')
  })

  it('keeps the decision model beside the decision supplier', () => {
    const model = FIELDS.find((field) => field.key === 'decisionModel')
    expect(model?.group).toBe('decision')
    expect(model?.fromRoute).toBe('model')
  })

  it('asks for a placeholder only on fields whose value an empty box would inherit', () => {
    // Which fields ask is what matters here; the order they sit in is the page's
    // business, and the visible model fields now sit beside their selected supplier.
    expect(
      FIELDS.filter((field) => field.fromRoute !== undefined)
        .map((field) => field.key)
        .sort(),
    ).toEqual([
      'decisionEndpoint',
      'decisionKeyRef',
      'decisionModel',
      'textBaseUrl',
      'textKeyRef',
      'textModel',
    ])
  })

  it('files every field under a declared block, and leaves no block empty', () => {
    const declared = FIELD_GROUPS.map((group) => group.id)
    for (const field of FIELDS) {
      expect(declared, field.key).toContain(field.group)
    }
    for (const group of FIELD_GROUPS) {
      const fields = FIELDS.filter((field) => field.group === group.id).length
      // A block with no field of its own is still not empty when it takes a key: it draws
      // the heading, the state line, and the value box. Anything else would be a heading
      // over a rule and nothing else.
      expect(fields + (KEY_BLOCKS.includes(group.id) ? 1 : 0), group.id).toBeGreaterThan(0)
    }
  })

  it('keeps only credential-name overrides inside 高级设置', () => {
    for (const key of ['decisionKeyRef', 'textKeyRef']) {
      const field = FIELDS.find((candidate) => candidate.key === key)
      // 2026-09-29, at the reader's request: that block is there to take the key, and the
      // name box in front of it made the key itself unclear. 2026-09-29 (later same day)
      // it went one level further — every override moved into one disclosure, because the
      // page showed the same three facts three times (status line, value box, then the
      // boxes again). Nothing is lost: the value box names the credential on its own line,
      // and the disclosure reports how many overrides the reader has changed.
      expect(field?.group, key).toBe('advanced')
    }
    expect(FIELDS.find((field) => field.key === 'decisionModel')?.group).toBe('decision')
  })

  it('gives every 高级设置 field the block it came from, so it is drawn under a real name', () => {
    const sections = FIELD_GROUPS.map((group) => group.id)
    const advanced = FIELDS.filter((field) => field.group === 'advanced')
    expect(advanced.length).toBeGreaterThan(0)
    for (const field of advanced) {
      expect(typeof field.section, field.key).toBe('string')
      expect(sections, field.key).toContain(field.section)
      // 高级设置 is where the grouping happens; a field filed under itself would say nothing.
      expect(field.section, field.key).not.toBe('advanced')
    }
  })

  it('gives the two service blocks their own 保存, scoped to what that block owns', () => {
    // 2026-09-29, at the reader's request: 「决策服务和文本模型板块都要有自己的保存按钮」.
    // The page's own button stays and still writes every field, so this is additive — what
    // changes is that pressing a block's button writes that block's set and no other draft.
    expect([...SELF_SAVING_BLOCKS]).toEqual(['decision', 'text'])
    expect(fieldsOfBlock('decision').map((field) => field.key).sort()).toEqual([
      'decisionEndpoint',
      'decisionKeyRef',
      'decisionModel',
      'decisionProvider',
    ])
    expect(fieldsOfBlock('text').map((field) => field.key).sort()).toEqual([
      'textBaseUrl',
      'textKeyRef',
      'textModel',
      'textProvider',
      'textReasoning',
    ])
  })

  it('puts the credential name in the set a block saves, or its own key could not be stored', () => {
    // The host accepts a value only for a name the saved config mentions. A block that saved
    // its value box but not its name box would fail on exactly the case it exists for:
    // pasting a key right after typing a name the store does not know yet.
    const declared = FIELD_GROUPS.map((group) => group.id)
    for (const id of SELF_SAVING_BLOCKS) {
      expect(declared, id).toContain(id)
      expect(id, id).not.toBe('advanced')
      // A block with its own save button needs somewhere to put a value, too.
      expect(KEY_BLOCKS, id).toContain(id)
      expect(fieldsOfBlock(id).map((field) => field.key), id).toContain(`${id}KeyRef`)
    }
  })

  it('keeps a block save off every credential but its own', () => {
    // 2026-10-01: the browser block's buttons save that block first, so a connection goes to the
    // browser the dropdown names. The fields were scoped; the pasted key values were not, so
    // 启动并连接 / 连接你的浏览器 committed every value box on the page — a key meant for 决策服务
    // or 文本模型 could be stored, under a name the reader was not looking at, by a press that
    // had nothing to do with it. A block with no value box owns no credential at all.
    expect(saveOwnsKey(undefined, undefined, 'OPENROUTER_API_KEY')).toBe(true) // the page's own 保存
    expect(saveOwnsKey('decision', 'OPENROUTER_API_KEY', 'OPENROUTER_API_KEY')).toBe(true)
    expect(saveOwnsKey('decision', 'OPENROUTER_API_KEY', 'TYPESAFE_API_KEY')).toBe(false)
    expect(saveOwnsKey('text', 'DEEPSEEK_API_KEY', 'OPENROUTER_API_KEY')).toBe(false)
    for (const id of ['browser', 'run'] as const) {
      expect(KEY_BLOCKS, id).not.toContain(id)
      expect(saveOwnsKey(id, undefined, 'OPENROUTER_API_KEY'), id).toBe(false)
      expect(saveOwnsKey(id, undefined, 'DEEPSEEK_API_KEY'), id).toBe(false)
    }
  })
})

/**
 * Two places name the inspector: the route the host registers and the sentence the slash
 * command prints. They have to be one address, and nothing else in the build ties them
 * together — a rename that missed one would leave a line of help pointing at nothing.
 */
describe('the way into the inspector', () => {
  it('lives under the route prefix, so the host serves what the page asks for', () => {
    expect(INSPECTOR_PATH).toBe(`${ROUTE}/inspector`)
  })

  it('is built from the origin the page is served on, not from a port written down', () => {
    expect(inspectorUrl('http://127.0.0.1:3080')).toBe('http://127.0.0.1:3080/jev-ultrafast/inspector')
    // The desktop app's own port: the same path has to come out right on it.
    expect(inspectorUrl('http://127.0.0.1:19387')).toBe('http://127.0.0.1:19387/jev-ultrafast/inspector')
    expect(inspectorUrl('http://dsh.lan/')).toBe('http://dsh.lan/jev-ultrafast/inspector')
  })

  it('is the same address the slash command quotes, under its default port', () => {
    expect(INSPECTOR_URL).toBe('http://127.0.0.1:3080' + INSPECTOR_PATH)
  })
})
