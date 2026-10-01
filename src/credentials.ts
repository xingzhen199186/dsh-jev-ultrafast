/**
 * Credential references, in one place.
 *
 * The plugin never stores a key. Every secret is a *reference* — the name of an
 * environment-variable-shaped credential — resolved through the harness credential
 * store at the moment of use, which is why no key can end up in a cordis.yml, in a
 * session log, or in this repository. The tool and the settings page's health check
 * both resolve through here, so they cannot disagree about what "configured" means.
 */
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef, isCredentialRefName } from '@deepseek-ai/dsh-credentials'
import { DECISION_PROVIDERS, type DecisionKeyShape } from './decision/providers'
import { TEXT_PROVIDERS } from './decision/text-providers'
import type { KeyState } from './protocol'

/**
 * Resolve one credential reference for this operation. Resolution is deliberately
 * per operation rather than cached at load: a key stored while the plugin is
 * running reaches the next run without a restart.
 */
export async function resolveKey(ctx: Context, reference: string, what: string): Promise<string> {
  const trimmed = reference.trim()
  if (!isCredentialRefName(trimmed)) {
    throw new Error(`${what}的凭据名不合法：「${reference}」。它应该是一个环境变量名，例如 TYPESAFE_API_KEY。`)
  }
  const hit = await ctx.credentials.resolve(credentialRef(trimmed))
  if (hit === undefined) {
    // Deliberately specific about every route that works. The page this plugin ships
    // is the easy one, but it is not the only one — and "go to DSH's credential
    // settings" would be wrong, because 0.1.7-rc.2 ships no such screen of its own.
    throw new Error(
      `没有找到凭据 ${trimmed}，所以${what}用不了。` +
        `最容易的一条：打开 DSH 设置 → Jev 浏览器 → 「密钥」，把这个值填上——它存进 DSH 自己的凭据文件，存完立刻生效。` +
        `也可以下载启动 dsh web 之前、于同一个终端里设一个同名环境变量，` +
        `或者直接编辑 ~/.dsh/.credentials.yaml，在 refs: 下面加一行「${trimmed}: <密钥>」。`,
    )
  }
  return hit.value
}

/**
 * Whether a reference resolves — for a status display, so it answers a plain
 * boolean and never looks at the value.
 */
export async function hasKey(ctx: Context, reference: string): Promise<boolean> {
  const trimmed = reference.trim()
  if (!isCredentialRefName(trimmed)) return false
  try {
    return (await ctx.credentials.resolve(credentialRef(trimmed))) !== undefined
  } catch {
    return false
  }
}

/**
 * Ask the store where one name stands: configured or not, from which layer, and
 * whether it may be written. It never returns the value, by construction.
 */
export async function describeKey(ctx: Context, reference: string): Promise<KeyState> {
  const trimmed = reference.trim()
  if (!isCredentialRefName(trimmed)) return { configured: false, writable: false }
  try {
    const info = await ctx.credentials.describe(credentialRef(trimmed))
    return {
      configured: info.configured,
      ...(info.source === undefined ? {} : { source: info.source }),
      writable: info.writable,
    }
  } catch {
    return { configured: false, writable: false }
  }
}

/** One name the settings page may write, and what that name is used for. */
export interface StorableName {
  name: string
  purpose: string
}

/**
 * The names the settings page is allowed to store values for.
 *
 * Both doors' keys are offered even when only one of them is selected — wanting to
 * stash the other key before switching over is reasonable — plus whatever custom
 * names the configuration currently points at. The set stays explicit so the page
 * cannot be talked into writing a credential it has no business writing.
 */
export function storableNames(decisionKeyRef: string, textKeyRef: string): StorableName[] {
  const names: StorableName[] = []
  const seen = new Set<string>()
  const add = (candidate: string, purpose: string): void => {
    const name = candidate.trim()
    if (!isCredentialRefName(name) || seen.has(name)) return
    seen.add(name)
    names.push({ name, purpose })
  }
  for (const spec of DECISION_PROVIDERS) add(spec.keyRef, `决策服务 · ${spec.label}`)
  for (const spec of TEXT_PROVIDERS) add(spec.keyRef, `文本模型 · ${spec.label}`)
  add(decisionKeyRef, '决策服务 · 你在配置里指定的名字')
  add(textKeyRef, '文本模型 · 你在配置里指定的名字')
  return names
}

/**
 * Store one value under a name, or remove it.
 *
 * The write goes to DSH's own credential file and is picked up by the very next
 * operation, so there is nothing to restart. Three refusals get the user's words
 * rather than the store's: a read-only layer already supplying the name (the write
 * would appear to succeed while resolution kept returning the other value), an empty
 * value (removal is the operation that means that), and a value whose shape is not the
 * one the door owning that name declares — which is what keeps the other door's key, or
 * one cut short by a half-finished paste, out of the file. A refusal never repeats the
 * value it refused.
 *
 * The value is trimmed at its ends: keys pasted from a browser or a password
 * manager routinely arrive with a stray newline, and no key legitimately has one.
 */
export async function changeKey(
  ctx: Context,
  reference: string,
  action: { kind: 'store'; value: string } | { kind: 'clear' },
  credentialsFile: string,
): Promise<void> {
  const name = reference.trim()
  if (!isCredentialRefName(name)) {
    throw new Error(`「${reference}」不是一个合法的凭据名。它应该是一个变量名，例如 TYPESAFE_API_KEY。`)
  }
  const ref = credentialRef(name)
  if (action.kind === 'clear') {
    const state = await describeKey(ctx, name)
    if (!state.writable) throw new Error(shadowedMessage(name, state.configured, credentialsFile))
    await ctx.credentials.unset(ref)
    return
  }
  const value = action.value.trim()
  if (value.length === 0) {
    throw new Error('密钥不能是空的。想删掉它就点「清除」。')
  }
  // A value that cannot be the key of the door owning this name is refused before the store is
  // asked anything. The check is lenient by construction: a name no door declares a shape for
  // saves exactly as it always has.
  const declared = declaredShape(name)
  if (declared !== undefined && !fitsShape(value, declared.shape)) {
    throw new Error(shapeMismatchMessage(name, declared, value))
  }
  const state = await describeKey(ctx, name)
  if (!state.writable) throw new Error(shadowedMessage(name, state.configured, credentialsFile))
  await ctx.credentials.set(ref, value)
}

/**
 * The shape the door owning a name declares for its key, read from the door tables themselves.
 *
 * Nothing is restated here: a door that gains a shape in `providers.ts` gains this check with it,
 * and the tables stay the one place a shape is ever written down. `undefined` means no door has
 * anything to say about that name, which is the case for every name but OpenRouter's today.
 */
function declaredShape(name: string): { label: string; shape: DecisionKeyShape } | undefined {
  const doors: readonly { keyRef: string; label: string; keyShape?: DecisionKeyShape }[] = [
    ...DECISION_PROVIDERS,
    ...TEXT_PROVIDERS,
  ]
  const spec = doors.find((door) => door.keyRef === name)
  if (spec?.keyShape === undefined) return undefined
  return { label: spec.label, shape: spec.keyShape }
}

/** Whether a value looks like the key a door describes: the same length, and the same opening. */
function fitsShape(value: string, shape: DecisionKeyShape): boolean {
  return value.length === shape.length && value.startsWith(shape.prefix)
}

/**
 * Why a value was refused for its shape, and how to get past the refusal.
 *
 * It never repeats the refused value, nor any part of it. The only two things it says about what
 * arrived are how many characters it had and whether it began with the expected prefix; between
 * them a reader can tell "this is the other door's key" and "this paste lost its tail" apart
 * without the value ever being handed back to anyone who can read the page.
 */
function shapeMismatchMessage(
  name: string,
  declared: { label: string; shape: DecisionKeyShape },
  value: string,
): string {
  const { label, shape } = declared
  const opening = value.startsWith(shape.prefix) ? '开头是对的，长度不对' : `开头也不是 ${shape.prefix}`
  return (
    `${name} 这次没有存：它看起来不是 ${label} 的密钥。` +
    `${label} 的密钥是 ${shape.length} 个字符、以 ${shape.prefix} 开头；这次送来的值有 ${value.length} 个字符，${opening}。` +
    `插件不会替你改这个值，也不会替你猜它是哪一家的。要存进去：如果这一格已经存着不对的值，先点它旁边的「清除」，` +
    `再从 ${label} 重新复制一把完整的密钥贴进来；要是你手上的确是一把形状不同、但 ${label} 也认的钥匙，` +
    `就把它的凭据名换成一个插件不认识的名字（在「高级设置」里改），那个名字不检查形状。`
  )
}

/** Why a write was refused, in terms of what the user can do about it. */
function shadowedMessage(name: string, configured: boolean, credentialsFile: string): string {
  if (configured) {
    return (
      `${name} 现在的值来自启动 dsh web 时的环境变量，这一轮里改不了（环境变量优先，而且只在启动时读一次）。` +
      `要换掉它，先在启动 dsh web 的那个终端里清掉这个变量，再回来保存；或者另换一个名字，把 ${credentialsFile} 的 refs: 里加一行。`
    )
  }
  return `${name} 现在写不进去：DSH 的凭据存储把它标成了只读。可以直接往 ${credentialsFile} 的 refs: 里加一行。`
}
