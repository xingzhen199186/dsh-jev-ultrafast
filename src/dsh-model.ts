/**
 * How this plugin reaches DSH's own model service.
 *
 * Two halves need it, and they need the same care: a run whose text door is a route DSH
 * serves, and the settings page, which has to list those routes before one can be chosen
 * at all. The narrow service slice, the message construction and the one refusal that
 * must not be skipped all live here rather than duplicated in either half.
 *
 * Ported from `dsh-advisor-group` (`src/providers/ctx-llm.ts` and the provider listing in
 * its settings API), same author, 2026-09-29.
 */
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { TEXT_PROVIDERS, dshValue } from './decision/text-providers'
import type { DshChunk } from './decision/text-helper'
import type { TextProviderOption } from './protocol'

type MaybePromise<T> = T | Promise<T>

/** One route DSH serves; `name` is what DSH calls it, when it says. */
export interface DshProviderInfo {
  id: string
  name?: string
}

/** The slice of DSH's model service this plugin uses. */
export interface DshLlmLike {
  listProviders(): MaybePromise<readonly DshProviderInfo[]>
  listModels(provider: string): MaybePromise<readonly { id: string }[]>
  stream(options: Record<string, unknown>): AsyncIterable<DshChunk>
}

/**
 * Catch DSH's model service as soon as this profile has one.
 *
 * Deliberately not part of the plugin's `inject`: a profile with no model route should
 * still load this plugin and still run browser tasks. Only the built-in text door needs
 * the service, and choosing that door without it is refused where the choice is used.
 */
export function captureLlm(ctx: Context): { get(): DshLlmLike | undefined } {
  let llm: DshLlmLike | undefined
  const scoped = ctx as Context & {
    inject?(keys: string[], callback: (inner: Context & { llm?: DshLlmLike }) => void): void
  }
  scoped.inject?.(['llm'], (inner) => {
    llm = inner.llm
  })
  return { get: () => llm }
}

/**
 * The session a call belongs to when its own caller has no live agent.
 *
 * Some routes behind DSH — the opencode-backed ones — require `x-opencode-session`, which the
 * harness fills in from `GenerateOptions.sessionId`, and refuse the request without it
 * (measured 2026-10-04: `MissingSessionID`, 400). A run or a command hands over the live
 * session's own id; the settings page's test button and the inspector run outside any session,
 * and this stable stand-in is what keeps that door usable for them.
 */
const STANDALONE_SESSION_ID = 'dsh-jev-ultrafast@standalone'

/**
 * One call into DSH's model service, for a text door the user configured in DSH.
 *
 * The message goes through the harness' own constructor rather than a hand-written
 * object: a message carries an identity and a producer tag the harness relies on, and
 * fabricating one is the kind of drift nothing downstream would catch.
 *
 * `sessionId` is the routing identity the harness' own loop also passes
 * (`GenerateOptions.sessionId`); a built-in route that requires it cannot answer without one,
 * so a call always carries one — the caller's when it has a session, the stand-in above when it
 * does not.
 */
export function dshStream(
  llm: DshLlmLike | undefined,
  request: {
    provider: string
    model: string
    system: string
    user: string
    maxTokens: number
    reasoningEffort?: string
    signal?: AbortSignal
    sessionId?: string
  },
): AsyncIterable<DshChunk> {
  if (llm === undefined) throw new Error(NO_SERVICE)
  return llm.stream({
    provider: request.provider,
    model: request.model,
    system: request.system,
    messages: [
      createUserMessage({ content: [{ type: 'text', text: request.user }], source: { kind: 'user' } }),
    ],
    maxTokens: request.maxTokens,
    sessionId: request.sessionId ?? STANDALONE_SESSION_ID,
    ...(request.reasoningEffort === undefined ? {} : { reasoningEffort: request.reasoningEffort }),
    signal: request.signal,
  })
}

/**
 * Refuse to run when the chosen built-in route is not one DSH currently serves.
 *
 * The alternative is what the plugin this feature was ported from documents:
 * `ctx.llm.stream` answers an unknown provider with an empty stream and no error, so a
 * run would look like a model that returned nothing — a far worse thing to explain than
 * one sentence naming the route.
 */
export async function assertDshRoute(llm: DshLlmLike | undefined, provider: string): Promise<void> {
  if (llm === undefined) throw new Error(NO_SERVICE)
  const list = await llm.listProviders()
  if (!list.some((item) => item.id === provider)) {
    throw new Error(
      `设置页「文本模型」里选的 DSH 内置供应商「${provider}」不在 DSH 现在的模型名册里。` +
        '请让它重新选一个，或者换成一个预设供应商。',
    )
  }
}

/**
 * Every text door the settings page may offer: the routes DSH serves first, then this
 * plugin's own presets.
 *
 * No de-duplication between the two lists, unlike upstream: a built-in route is stored
 * with a `dsh:` prefix, so the preset `deepseek` and a DSH route named `deepseek` are two
 * different choices rather than one shadowing the other.
 */
export async function providerOptions(llm: DshLlmLike | undefined): Promise<TextProviderOption[]> {
  const routes: TextProviderOption[] = []
  if (llm !== undefined) {
    try {
      for (const provider of await llm.listProviders()) {
        routes.push({
          id: dshValue(provider.id),
          label: provider.name ?? provider.id,
          kind: 'dsh',
          models: await modelsOf(llm, provider.id),
        })
      }
    } catch {
      // No roster at all: the page still gets the presets, which need none of this.
    }
  }
  return [
    ...routes,
    ...TEXT_PROVIDERS.map((spec) => ({
      id: spec.id,
      label: spec.label,
      kind: 'preset' as const,
      models: [...spec.models],
    })),
  ]
}

/** A route that publishes no model list keeps an empty one rather than disappearing. */
async function modelsOf(llm: DshLlmLike, provider: string): Promise<string[]> {
  try {
    return (await llm.listModels(provider)).map((model) => model.id)
  } catch {
    return []
  }
}

const NO_SERVICE =
  '这个会话里没有可用的 DSH 模型服务，用不了内置的文本模型。请在设置页把「文本模型」换成一个预设供应商。'
