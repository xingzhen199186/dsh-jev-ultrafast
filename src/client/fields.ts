/**
 * What the settings page draws, field by field.
 *
 * This is the page's own concern — labels, order, which kind of input, and which
 * block of the page a field belongs to — so it lives with the browser half rather
 * than with the schema. tests/client.test.ts checks it against the schema's own keys,
 * because a field missing here is a field the user can no longer edit and nothing else
 * would report it.
 *
 * Neither provider dropdown is written out here: both come from the tables the host itself
 * uses (src/decision/providers.ts and src/decision/text-providers.ts), so a dropdown
 * cannot drift away from what a run would actually do. The text model's list also carries
 * the routes DSH itself serves, which only the host can enumerate — those arrive with the
 * status report.
 *
 * The page shows four blocks — one per thing the plugin has to talk to, plus what a
 * task is allowed to spend. Everything that only *overrides* a default (the credential
 * name and the endpoint) lives in one disclosure at the bottom, because an
 * empty box there means "use what the provider recommends" rather than "fill me in",
 * and a page that mixes the two reads as a form to complete. The status line on each
 * block already says which values are in effect, so nothing is hidden by that.
 *
 * An advanced field remembers which block it came from, so the disclosure can draw it
 * under that block's own name instead of as one undivided pile.
 */
import { DECISION_PROVIDERS, DECISION_PROVIDER_IDS } from '../decision/providers'

/** The blocks the page is divided into, in the order they are drawn. */
export type FieldGroupId = 'browser' | 'decision' | 'text' | 'run' | 'advanced'

/** The four blocks a block of text can belong to; 高级设置 is not one of them. */
export type SectionId = 'browser' | 'decision' | 'text' | 'run'

export interface FieldGroup {
  id: FieldGroupId
  title: string
  /** One line under the title, only where the block needs explaining. */
  note?: string
}

/**
 * The blocks that take a key value rather than a config field.
 *
 * Their whole content is the state line and the value box, so they are allowed to have
 * no entry in FIELDS at all — which is the point: what the reader came there for is the
 * key, and the name/endpoint/model it would otherwise show are overrides. tests/client.test.ts
 * uses this so that "no block is empty" stays a real check rather than a list of excuses.
 */
export const KEY_BLOCKS: readonly FieldGroupId[] = ['decision', 'text']

/**
 * One concern per block, and each block keeps its state line on top: the reader sees
 * what is wrong and where to change it without leaving the block.
 */
export const FIELD_GROUPS: readonly FieldGroup[] = [
  { id: 'browser', title: '浏览器', note: '给它一句话目标，它就在这个浏览器里把事办完。' },
  { id: 'decision', title: '决策服务', note: '每一步点哪里，由它来选。这里直接选供应商和模型，密钥也在本块保存。' },
  {
    id: 'text',
    title: '文本模型',
    note:
      '只有任务需要往输入框里填字时才会用到。直接选择供应商、模型和密钥；' +
      '插件预设由插件直连，DSH 内置则由 DSH 管地址和凭据。',
  },
  { id: 'run', title: '任务', note: '一次任务最多走多少步、要不要留下每一步的截图。' },
  {
    id: 'advanced',
    title: '高级设置',
    note: '改默认值用的：这些框留空，就是用它自己推荐的值。平时不用打开。',
  },
]

export interface FieldSpec {
  /** Config key, exactly as src/config.ts declares it. */
  key: string
  label: string
  hint: string
  kind: 'text' | 'number' | 'switch' | 'choice' | 'provider'
  /** Allowed values for `kind: 'choice'`. */
  choices?: readonly string[]
  /** Wording to show for each value of a choice; the value itself is what is stored. */
  choiceLabels?: Readonly<Record<string, string>>
  /**
   * Show the chosen door's own value for this key as the input's grey placeholder. Empty
   * means "whatever the chosen door says", so an empty box still tells the user what it
   * will use.
   */
  fromRoute?: 'endpoint' | 'baseUrl' | 'model' | 'keyRef'
  /**
   * Offer the chosen provider's model names as a pick-list under a text input. Only the
   * text model has one, because only it depends on which door is selected.
   */
  modelsFrom?: 'textProvider'
  /** Which block of the page this field is drawn in. */
  group: FieldGroupId
  /**
   * For `group: 'advanced'` only: which block the field belongs to, so the disclosure
   * can put it under that block's name. Long-standing config set by hand may point a
   * value at a name nobody changed here, and an unlabelled row would not say whose it is.
   */
  section?: SectionId
}

/**
 * Order is the order the page shows: a block's own fields in the order drawn, then the
 * key value under them, and the override fields last, inside the disclosure.
 */
export const FIELDS: readonly FieldSpec[] = [
  {
    key: 'browserKind',
    label: '用哪个浏览器',
    hint: '「启动并连接」会启动它，并给它一个插件自己的数据目录。',
    kind: 'choice',
    choices: ['chrome', 'edge'],
    choiceLabels: { chrome: 'Chrome', edge: 'Edge' },
    group: 'browser',
  },
  {
    key: 'cdpUrl',
    label: '调试端口',
    hint: '例如 http://127.0.0.1:9222。留空就自己找。',
    kind: 'text',
    group: 'browser',
  },
  {
    key: 'browserPath',
    label: '浏览器程序',
    hint: '留空就在标准位置找；便携版之类装在别处的才需要填。',
    kind: 'text',
    group: 'advanced',
    section: 'browser',
  },
  {
    key: 'userDataDir',
    label: '数据目录',
    hint: '只有浏览器是用 --user-data-dir 指定过非默认目录时才需要填。',
    kind: 'text',
    group: 'advanced',
    section: 'browser',
  },
  {
    key: 'decisionProvider',
    label: '供应商',
    hint: '两家的地址、模型、密钥名都不一样，选了哪家就以哪家为准。',
    kind: 'choice',
    choices: DECISION_PROVIDER_IDS,
    choiceLabels: Object.fromEntries(DECISION_PROVIDERS.map((spec) => [spec.id, spec.label])),
    group: 'decision',
  },
  {
    key: 'decisionModel',
    label: '模型',
    hint: '留空就使用所选供应商推荐的 Jev 模型；只有接入转售或自定义路由时才需要覆盖。',
    kind: 'text',
    fromRoute: 'model',
    group: 'decision',
  },
  {
    key: 'decisionKeyRef',
    label: '密钥名',
    hint: '这是名字，不是密钥值——值填在上面那一行的粘贴框里。留空就用这家的默认名字。',
    kind: 'text',
    fromRoute: 'keyRef',
    group: 'advanced',
    section: 'decision',
  },
  {
    key: 'decisionEndpoint',
    label: '地址',
    hint: '留空就用这家自己的地址。走转售路由之类才需要填。',
    kind: 'text',
    fromRoute: 'endpoint',
    group: 'advanced',
    section: 'decision',
  },
  {
    key: 'textProvider',
    label: '供应商',
    hint: '预设供应商由插件直连；DSH 内置供应商使用 DSH 已配置的地址、凭据和模型服务。',
    kind: 'provider',
    group: 'text',
  },
  {
    key: 'textModel',
    label: '模型',
    hint: '留空就用这家自己的默认模型，候选清单可以点开挑，也可以自己填；走「DSH 内置」那条路时没有默认值，必须选一个。',
    kind: 'text',
    fromRoute: 'model',
    modelsFrom: 'textProvider',
    group: 'text',
  },
  {
    key: 'textKeyRef',
    label: '密钥名',
    hint: '这是名字，不是密钥值——值填在文本模型那一行的粘贴框里。留空就用所选供应商的默认名字。',
    kind: 'text',
    fromRoute: 'keyRef',
    group: 'advanced',
    section: 'text',
  },
  {
    key: 'textBaseUrl',
    label: '地址',
    hint: '留空就用所选供应商自己的地址；走 DSH 内置那条路时不用填。',
    kind: 'text',
    fromRoute: 'baseUrl',
    group: 'advanced',
    section: 'text',
  },
  {
    key: 'textReasoning',
    label: '推理',
    hint: '填字段是抄写，通常不需要推理。',
    kind: 'choice',
    choices: ['none', 'auto'],
    choiceLabels: { none: '不推理', auto: '自动' },
    group: 'advanced',
    section: 'text',
  },
  { key: 'maxSteps', label: '最多走多少步', hint: '一次任务的上限。', kind: 'number', group: 'run' },
  {
    key: 'screenshots',
    label: '每一步都截图',
    hint: '明显变慢，一般不用开。',
    kind: 'switch',
    group: 'run',
  },
]

/**
 * The blocks that carry their own 保存 button.
 *
 * These two are where a reader comes to paste a key or switch a supplier, and they sit
 * well above the page's own button at the bottom; saving them in place is what keeps that
 * trip short. 浏览器 / 任务 keep using the bottom button, which still writes everything —
 * so nothing that worked before stopped working.
 */
export const SELF_SAVING_BLOCKS: readonly FieldGroupId[] = ['decision', 'text']

/**
 * Every field one block owns: the ones drawn inside it, plus the overrides it keeps in
 * 高级设置. A block's own save writes exactly this set.
 *
 * The credential-name box is part of it, and that is load-bearing rather than tidy: the
 * host accepts a value only for a name the saved config mentions, so a save that wrote the
 * value box but not the name box would fail on precisely the case it exists for.
 */
export const fieldsOfBlock = (id: FieldGroupId): readonly FieldSpec[] =>
  FIELDS.filter((field) => field.group === id || (field.group === 'advanced' && field.section === id))

