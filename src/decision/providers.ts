/**
 * The decision service has two doors: TypeSafe's own endpoint, and OpenRouter's
 * alpha Decisions route, which serves the same thing under a prefixed model name.
 *
 * They differ in exactly three values — address, model, and which credential name
 * is expected to hold the key — so the whole difference is one table rather than a
 * branch scattered through the code. Adding a third door later means adding a row.
 *
 * This file is shared: the host reads it to build the request, and the settings
 * page reads it to show what a choice will actually do. That is why it holds plain
 * data and pure functions only — the browser half bundles it, and anything that
 * touched the filesystem or the harness would not survive that trip.
 *
 * Where the two doors' values came from (2026-09-28): the OpenRouter route and its
 * tilde-prefixed model name are what the `behavior-driven-decision` skill's
 * `jev_ask.py` uses, and the wrapper fallback mirrors its `JEV_REQUEST_WRAP=auto`
 * default. Neither door has been exercised against a live service from this
 * machine yet — no key for either is stored here — so these are the documented
 * values, not measured ones.
 */

/** The two doors. Add a member here and both the page and the host follow. */
export type DecisionProvider = 'typesafe' | 'openrouter'

/**
 * The shape a door's key has, as far as it is known.
 *
 * Two facts only, and both are safe to put in front of a reader: how many characters the key
 * has, and what it starts with. Together they are what tells "the other door's key ended up in
 * this cell" apart from "this key was cut short when it was pasted" — and neither can rebuild
 * a key. Nothing here is ever the value itself.
 */
export interface DecisionKeyShape {
  length: number
  prefix: string
}

export interface DecisionProviderSpec {
  id: DecisionProvider
  /** What the settings page calls this door. */
  label: string
  /** Full URL of the decision endpoint. */
  endpoint: string
  /** Model name the endpoint should route to. */
  model: string
  /** The credential *name* expected to hold the key. Never a key. */
  keyRef: string
  /**
   * What this door's own key looks like, when that is known. Absent means "no shape is known
   * for this door", and a refusal then says less rather than guessing.
   */
  keyShape?: DecisionKeyShape
  /** One line the page shows to explain the choice. */
  note: string
  /**
   * Whether a rejected request may be retried once with the body wrapped in a
   * `decisionsRequest` envelope. OpenRouter's route has been seen to want that
   * envelope; TypeSafe's own endpoint takes the flat body and has never needed it.
   */
  wrapFallback: boolean
}

export const DECISION_PROVIDERS: readonly DecisionProviderSpec[] = [
  {
    id: 'typesafe',
    label: 'TypeSafe 官方直连',
    endpoint: 'https://api.typesafe.ai/v1/systemone',
    model: 'jev-latest',
    keyRef: 'TYPESAFE_API_KEY',
    note: '官方地址。密钥在 console.typesafe.ai 申请，这里填的是它的凭据名。',
    wrapFallback: false,
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    endpoint: 'https://openrouter.ai/api/alpha/decisions',
    model: '~typesafe/jev-latest',
    keyRef: 'OPENROUTER_API_KEY',
    // `sk-or-v1-` plus 64 hex characters, so 73 in all. TypeSafe's own shape is deliberately left
    // blank: no key of that door has ever been in hand here, and a guessed shape would be worse
    // than none once it is printed back to a reader who is trying to check a key by eye.
    keyShape: { length: 73, prefix: 'sk-or-v1-' },
    note: 'OpenRouter 的 alpha 通道，模型名前带一个波浪号。密钥是 OpenRouter 的，不是 TypeSafe 的。',
    wrapFallback: true,
  },
]

export const DECISION_PROVIDER_IDS: readonly DecisionProvider[] = DECISION_PROVIDERS.map((spec) => spec.id)

/** The first door, used when the configured value names nothing we know. */
export const DEFAULT_DECISION_PROVIDER: DecisionProvider = 'typesafe'

/** One door by id; an unknown id falls back rather than throwing mid-run. */
export function decisionProvider(id: string | undefined): DecisionProviderSpec {
  return DECISION_PROVIDERS.find((spec) => spec.id === id) ?? DECISION_PROVIDERS[0]!
}

/** What the configuration holds: a chosen door and up to three optional overrides. */
export interface DecisionOverrides {
  provider?: string | undefined
  endpoint?: string | undefined
  model?: string | undefined
  keyRef?: string | undefined
}

/** The values one run will actually use, each with the door it came from. */
export interface DecisionRoute {
  provider: DecisionProvider
  label: string
  endpoint: string
  model: string
  keyRef: string
  /** The shape this door's key has, when it is known; a refusal names it when it is. */
  keyShape?: DecisionKeyShape
  wrapFallback: boolean
}

/**
 * Decide what a run talks to.
 *
 * A filled-in field wins; an empty one means "use this door's own value" rather
 * than "use the empty string". That distinction is what makes switching doors
 * safe: nothing typed for the other door is left behind to be used by mistake.
 */
export function resolveDecisionRoute(overrides: DecisionOverrides = {}): DecisionRoute {
  const spec = decisionProvider(overrides.provider)
  return {
    provider: spec.id,
    label: spec.label,
    endpoint: filled(overrides.endpoint) ?? spec.endpoint,
    model: filled(overrides.model) ?? spec.model,
    keyRef: filled(overrides.keyRef) ?? spec.keyRef,
    keyShape: spec.keyShape,
    wrapFallback: spec.wrapFallback,
  }
}

/** A value that is present once trimmed; anything blank counts as not filled in. */
function filled(value: string | undefined): string | undefined {
  const text = value?.trim()
  return text ? text : undefined
}
