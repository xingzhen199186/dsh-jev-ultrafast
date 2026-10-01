import Schema from '@deepseek-ai/schemastery'
import type { BrowserConnection, BrowserKind } from './browser/launch'
import type { DecisionProvider } from './decision/providers'
import { DEFAULT_TEXT_PROVIDER } from './decision/text-providers'

/**
 * A `volatile()` field resolves to a box rather than a value, so the harness can
 * re-read it on every access: an edit made in the settings page reaches the next
 * run without a reload. Read it with `.get()`.
 */
export interface VolatileValue<T> {
  get(): T
}

/**
 * The plugin's whole configuration surface: flat scalar fields, every one of them
 * live.
 *
 * Flat because the settings page renders one labelled input per field — and it is
 * this plugin's own page, so a nested object would only be editable as a JSON
 * blob, which is not a form. Live because that is what makes a field editable at
 * all: the Plugins page hands a page its form only when the entry exposes live
 * Config fields.
 *
 * Every field that stands for a secret is a *reference* — an environment-variable
 * name — carrying Schemastery's `credential-ref` role. The role is a label rather
 * than a mechanism: on 0.1.7-rc.2 nothing turns it into a picker, and this plugin's
 * page draws its own text box either way. The value is resolved through
 * `ctx.credentials` at the moment of use, which is why no key can end up in a
 * cordis.yml, in a session log, or in this file.
 */
export interface Config {
  /** Which browser a run drives: this plugin's own profile, or the one the reader already uses. */
  browserConnection: VolatileValue<BrowserConnection>
  /** Which browser the settings page's own button starts, and which one discovery prefers. */
  browserKind: VolatileValue<BrowserKind>
  /** Explicit path to that browser's executable, for an install that is not in the usual place. */
  browserPath: VolatileValue<string>
  /** Explicit DevTools endpoint; empty means discover one. */
  cdpUrl: VolatileValue<string>
  /** Explicit browser profile directory, for a browser started with `--user-data-dir`. */
  userDataDir: VolatileValue<string>
  /** Which door the decision service is reached through. See src/decision/providers.ts. */
  decisionProvider: VolatileValue<DecisionProvider>
  /** Empty means "use the chosen provider's own endpoint". */
  decisionEndpoint: VolatileValue<string>
  /** Empty means "use the chosen provider's own model". */
  decisionModel: VolatileValue<string>
  /** Empty means "use the chosen provider's own credential name". */
  decisionKeyRef: VolatileValue<string>
  /** Which door the text model is reached through. See src/decision/text-providers.ts. */
  textProvider: VolatileValue<string>
  textBaseUrl: VolatileValue<string>
  textModel: VolatileValue<string>
  textKeyRef: VolatileValue<string>
  textReasoning: VolatileValue<'none' | 'auto'>
  maxSteps: VolatileValue<number>
  screenshots: VolatileValue<boolean>
}

// A Schemastery Schema, never a plain object: the harness validates it when the
// plugin loads, fails loud on an invalid value, and lets every field be set from
// cordis.yml without touching code.
// The schema is what the loader validates; the interface above names the same
// shape for the code that reads it, and the plugin's own test checks the two agree.
// Field order here is the order the settings page shows them in.
export const Config = Schema.object({
  browserConnection: Schema.union(['daily', 'plugin'])
    .default('daily')
    .volatile()
    .description(
      '连哪个浏览器。「你正在用的浏览器」直接用你现在的登录状态：需要在它里面打开「允许远程调试」，插件不启动、不关闭、也不动任何档案文件；' +
        '「插件自己的浏览器」由插件启动并驱动一份自己的数据目录，和你日常那个互不干扰。',
    ),

  browserKind: Schema.union(['chrome', 'edge'])
    .default('edge')
    .volatile()
    .description(
      '设置页里「启动并连接」启动哪个浏览器。插件会给它一个自己的用户数据目录（和你日常那个分开），端口也自己挑，所以这里只管选哪一个。',
    ),

  browserPath: Schema.string()
    .default('')
    .volatile()
    .description('上面那个浏览器的程序位置。只有在标准位置找不到时才需要填，例如便携版。留空就自己找。'),

  cdpUrl: Schema.string()
    .default('')
    .volatile()
    .description('浏览器调试端口，例如 http://127.0.0.1:9222。留空则自动查找（环境变量、浏览器写下的端口文件、9222/9223）。'),

  userDataDir: Schema.string()
    .default('')
    .volatile()
    .description('浏览器的用户数据目录。只有浏览器是用 --user-data-dir 指定了非默认目录启动时才需要填。'),

  decisionProvider: Schema.union(['typesafe', 'openrouter'])
    .default('typesafe')
    .volatile()
    .description(
      '决策服务走哪条路：typesafe = TypeSafe 官方直连，openrouter = OpenRouter 的 alpha 通道。' +
        '下面三项留空就分别用这条路自己的地址、模型和凭据名（设置页里以灰字显示）。',
    ),

  decisionEndpoint: Schema.string()
    .default('')
    .volatile()
    .description('决策服务的完整地址。留空就用所选供应商的默认地址；走转售路由就填这里。'),

  decisionModel: Schema.string().default('').volatile().description('决策模型名。留空就用所选供应商的默认模型。'),

  decisionKeyRef: Schema.string()
    .role('credential-ref')
    .default('')
    .volatile()
    .description(
      '存决策服务密钥的凭据名。留空就用所选供应商的默认名字（官方 TYPESAFE_API_KEY、OpenRouter OPENROUTER_API_KEY）。密钥本身不写进配置。',
    ),

  textProvider: Schema.string()
    .default(DEFAULT_TEXT_PROVIDER)
    .volatile()
    .description(
      '文本模型走哪条路：预设名（deepseek、openrouter、bailian、zhipu、moonshot、siliconflow、openai），' +
        '或者 dsh:<供应商 id>——后者走 DSH 里已经配好的模型，地址和密钥都由 DSH 自己管。' +
        '下面三项留空就分别用这条路自己的地址、模型和凭据名。',
    ),

  textBaseUrl: Schema.string()
    .default('')
    .volatile()
    .description('文本模型的 OpenAI 兼容地址。留空就用所选供应商自己的地址；走 DSH 内置那条路时不用填。'),

  textModel: Schema.string()
    .default('')
    .volatile()
    .description('填写用的模型名。留空就用所选供应商自己的默认模型；走 DSH 内置那条路时，必须在这里选一个。'),

  textKeyRef: Schema.string()
    .role('credential-ref')
    .default('')
    .volatile()
    .description(
      '存文本模型密钥的凭据名。留空就用所选供应商的默认名字（DeepSeek 是 DEEPSEEK_API_KEY，OpenRouter 是 OPENROUTER_API_KEY）。' +
        '走 DSH 内置那条路时由 DSH 自己解析，不用填。密钥本身不写进配置。',
    ),

  textReasoning: Schema.union(['none', 'auto'])
    .default('none')
    .volatile()
    .description('none：不让文本模型做推理（填字段是抄写，不需要推理）；auto：用各家默认。'),

  maxSteps: Schema.number().default(60).volatile().description('一次任务最多执行多少步。决策调用的上限是它的两倍。'),

  screenshots: Schema.boolean().default(false).volatile().description('是否每一步都截图。明显变慢，一般不用开。'),
})
