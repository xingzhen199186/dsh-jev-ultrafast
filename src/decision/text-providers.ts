/**
 * The text model's doors — the same idea as the decision service's two doors in
 * `providers.ts`, one file over, and deliberately the same shape: a table of
 * addresses and names, plus one pure function that says what a run will use.
 * The settings page and the host both read this file, so a choice shown on the
 * page and the choice a run makes cannot drift apart.
 *
 * Two kinds of door live here, and the difference is where the key comes from:
 *
 *   - **预设（preset）** — this plugin knows the address, the model names and the
 *     credential name. The key is read from the harness credential store under
 *     that name, and the page draws its paste box.
 *   - **DSH 内置（built-in）** — a model route the user has already configured in
 *     DSH itself. Address and key are DSH's business; this plugin only names the
 *     route and the model. The page shows no paste box for these.
 *
 * A built-in door is stored as `dsh:<provider id>`. The prefix is the one
 * deliberate departure from the plugin this table was ported from
 * (`dsh-advisor-group`, its `src/providers/presets.ts`, same author): there, a
 * plain id means "built-in if DSH happens to have that id, otherwise preset",
 * so registering a provider in DSH silently changes what an already-saved value
 * points at. A prefix keeps a stored choice's meaning fixed, and it lets a preset
 * and a built-in route coexist under the same name.
 *
 * Only doors that speak the OpenAI-compatible `/chat/completions` shape are
 * listed: filling one form field is a small copying job, and the helper behind it
 * implements exactly that one protocol. Vendors that need a different protocol
 * (Anthropic, Gemini) are reachable through DSH as built-in routes instead, which
 * needs no second protocol here. Adding one later means adding a row plus a
 * protocol branch, exactly like upstream.
 *
 * The first model of each row is what a run uses when the model override is left
 * empty; the rest are the choices the page offers. Rows are ordered cheapest
 * first, because copying a value out of a sentence is not a job for a flagship.
 */
export interface TextProviderSpec {
  id: string
  /** What the settings page calls this door. */
  label: string
  /** OpenAI-compatible base URL; a run appends `/chat/completions`. */
  baseUrl: string
  /** Candidate model names, cheapest first. The first one is the default. */
  models: readonly string[]
  /** The credential *name* this door's key is stored under. Never a key. */
  keyRef: string
  /** One line the page shows to explain the choice. */
  note: string
}

/** Marking a stored provider value as "a route DSH itself serves". */
export const DSH_PREFIX = 'dsh:'

/** True when a stored provider value names a DSH route rather than a preset. */
export function isDshRoute(value: string | undefined): boolean {
  return (value ?? '').startsWith(DSH_PREFIX)
}

/** The provider id inside a `dsh:` value; anything without the prefix is returned as is. */
export function dshRouteId(value: string): string {
  return isDshRoute(value) ? value.slice(DSH_PREFIX.length) : value
}

/** The stored value for one DSH route. */
export function dshValue(providerId: string): string {
  return `${DSH_PREFIX}${providerId}`
}

/**
 * Ported from `dsh-advisor-group` `src/providers/presets.ts` (2026-09-29), keeping
 * its addresses, model names and credential names verbatim; the model lists are
 * trimmed to what a form-filling job would sensibly use.
 */
export const TEXT_PROVIDERS: readonly TextProviderSpec[] = [
  {
    id: 'deepseek',
    label: 'DeepSeek 官方',
    baseUrl: 'https://api.deepseek.com/v1',
    models: ['deepseek-v4-flash', 'deepseek-v4-pro'],
    keyRef: 'DEEPSEEK_API_KEY',
    note: '默认这一家。地址和模型名几乎不用动，密钥在 platform.deepseek.com 申请。',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    models: ['deepseek/deepseek-chat', 'openai/gpt-5.6', 'anthropic/claude-sonnet-4.6'],
    keyRef: 'OPENROUTER_API_KEY',
    note: '一个 Key 通很多家模型，模型名前带厂商前缀（例如 deepseek/deepseek-chat）。',
  },
  {
    id: 'bailian',
    label: '阿里云百炼',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: ['qwen3.8-flash', 'qwen3.8-max'],
    keyRef: 'DASHSCOPE_API_KEY',
    note: '阿里云的 OpenAI 兼容地址。密钥在百炼控制台申请。',
  },
  {
    id: 'zhipu',
    label: '智谱 AI',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    models: ['glm-5.3-flash', 'glm-5.3'],
    keyRef: 'ZHIPU_API_KEY',
    note: '智谱的 OpenAI 兼容地址。',
  },
  {
    id: 'moonshot',
    label: '月之暗面 Kimi',
    baseUrl: 'https://api.moonshot.cn/v1',
    models: ['kimi-k3', 'kimi-k2.7-code'],
    keyRef: 'MOONSHOT_API_KEY',
    note: '月之暗面的 OpenAI 兼容地址。',
  },
  {
    id: 'siliconflow',
    label: '硅基流动',
    baseUrl: 'https://api.siliconflow.cn/v1',
    models: ['deepseek-ai/DeepSeek-V3.2', 'Qwen/Qwen3-235B-A22B'],
    keyRef: 'SILICONFLOW_API_KEY',
    note: '国内聚合站，模型名带厂商前缀。',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    models: ['gpt-5.4', 'gpt-6-astra'],
    keyRef: 'OPENAI_API_KEY',
    note: '官方地址。国内直连通常需要自己处理网络。',
  },
]

/** The first door, used when the configured value names nothing we know. */
export const DEFAULT_TEXT_PROVIDER: string = 'deepseek'

/** One preset row by id; an unknown or built-in id has no row. */
export function textProvider(id: string | undefined): TextProviderSpec | undefined {
  const value = id ?? ''
  if (isDshRoute(value)) return undefined
  return TEXT_PROVIDERS.find((spec) => spec.id === value)
}

/** What the configuration holds: a chosen door and four optional overrides. */
export interface TextOverrides {
  provider?: string | undefined
  baseUrl?: string | undefined
  model?: string | undefined
  keyRef?: string | undefined
  reasoning?: string | undefined
}

/** The values one run will actually use. */
export interface TextRoute {
  /** The stored value: a preset id, or `dsh:<provider id>`. */
  provider: string
  label: string
  /** Whether a run goes direct (preset) or through DSH's own model service. */
  kind: 'preset' | 'dsh'
  /** Empty for a built-in route: DSH owns the address. */
  baseUrl: string
  /** Empty for a built-in route until a model is chosen — a run then fails loudly. */
  model: string
  /** Empty for a built-in route: DSH resolves its own credential. */
  keyRef: string
  reasoning: 'none' | 'auto'
}

/**
 * Decide what a run talks to.
 *
 * A filled-in field wins; an empty one means "use this door's own value" rather
 * than "use the empty string" — the same rule the decision service follows, and
 * the reason switching doors cannot leave the previous door's values behind.
 *
 * A value naming no preset and carrying no `dsh:` prefix is treated as the
 * default preset: the alternative is failing a run because of one stale config
 * value, which is worse than the drift the page already reports.
 */
export function resolveTextRoute(overrides: TextOverrides = {}): TextRoute {
  const reasoning = overrides.reasoning === 'auto' ? 'auto' : 'none'
  if (isDshRoute(overrides.provider)) {
    const providerId = dshRouteId(overrides.provider ?? '')
    return {
      provider: overrides.provider ?? dshValue(providerId),
      label: providerId,
      kind: 'dsh',
      baseUrl: '',
      model: filled(overrides.model) ?? '',
      keyRef: '',
      reasoning,
    }
  }
  const spec = textProvider(overrides.provider) ?? TEXT_PROVIDERS[0]!
  return {
    provider: spec.id,
    label: spec.label,
    kind: 'preset',
    baseUrl: filled(overrides.baseUrl) ?? spec.baseUrl,
    model: filled(overrides.model) ?? spec.models[0]!,
    keyRef: filled(overrides.keyRef) ?? spec.keyRef,
    reasoning,
  }
}

/** A value that is present once trimmed; anything blank counts as not filled in. */
function filled(value: string | undefined): string | undefined {
  const text = value?.trim()
  return text ? text : undefined
}
