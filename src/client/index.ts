/**
 * dsh-jev-ultrafast browser half: the plugin's own page inside DSH's settings.
 *
 * The page is four blocks — browser, decision service, text model, run budget — and
 * every block keeps two things together: a line saying how that part stands right now,
 * and the controls that change it. That is the point of the layout. The health check
 * used to be its own section, which forced the page to keep telling the reader to go
 * somewhere else ("fill it in under 密钥 below") for something the page already knew.
 * Now nothing points anywhere: the state sits directly above what decides it.
 *
 * Two jobs, and neither can be done from the host alone. It draws the configuration,
 * edited through the settings form DSH serves for this row, so a save goes through the
 * harness's own validation instead of around it. And it runs the health check: is a
 * browser reachable, is each key present, does the decision service actually answer.
 * Those need a DevTools connection and a key, so they happen in src/panel.ts and reach
 * the page through ./protocol's route.
 *
 * A note on the imports below: they are type-only on purpose. Reaching across a
 * plugin boundary for a *value* fails the client bundle-purity gate, and the shell
 * components belong to the Web UI anyway — this page brings its own.
 */
import { createElement, useCallback, useEffect, useState, type CSSProperties, type ReactNode } from 'react'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: activates the settings-section slot these packages declare, the
// `slots` service the renderer provides, and the config-form service.
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { decisionProvider, resolveDecisionRoute } from '../decision/providers'
import { TEXT_PROVIDERS, isDshRoute, resolveTextRoute, textProvider } from '../decision/text-providers'
import { ENTRY_ID, ROUTE, TOKEN_GLOBAL, TOKEN_HEADER, inspectPageUrl, sourceLabel } from '../protocol'
import type {
  DecisionTestReport,
  KeyState,
  LaunchReport,
  LoginProbeReport,
  StatusReport,
  StorableKey,
  TextModelReport,
  TextProviderOption,
  TextTestReport,
} from '../protocol'
import {
  FIELD_GROUPS,
  FIELDS,
  KEY_BLOCKS,
  SELF_SAVING_BLOCKS,
  fieldsOfBlock,
  type FieldGroup,
  type FieldGroupId,
  type FieldSpec,
  type SectionId,
} from './fields'

export const name = ENTRY_ID

/**
 * `slots` is all this half needs from the shell: the section is registered on it.
 * `configForms` is deliberately *not* injected — the settings package materialises
 * it late, and a hard dependency on a late service leaves a plugin pending forever.
 * It is looked up when the page mounts instead, and a page without it still works.
 */
export const inject = ['slots']

export function apply(ctx: ClientContext): void {
  ctx.slots.inject('settings.section', () =>
    ctx.slots.register(
      {
        name: 'settings.section',
        id: ENTRY_ID,
        // After the built-in sections (通用设置 / 模型 / 内置插件 / Agent 预设).
        order: 50,
        label: 'Jev 浏览器',
      },
      () => createElement(JevSettingsPage, { ctx }),
    ),
  )
}

/** The slice of the config-form service this page uses. */
interface ConfigFormSnapshotLike {
  status: 'loading' | 'ready' | 'unavailable'
  value?: Record<string, unknown>
  writable: boolean
}

interface ConfigFormLike {
  getSnapshot(): ConfigFormSnapshotLike
  subscribe(listener: () => void): () => void
  set(field: string, value: unknown): Promise<boolean>
}

/**
 * Find the form DSH serves for this row, or nothing.
 *
 * Per use rather than at load: the service is materialised late, and a page that
 * cannot find it should say so and stay usable, not fail to render.
 */
function lookupForm(ctx: ClientContext): ConfigFormLike | undefined {
  const services = ctx as unknown as {
    get?(name: string): unknown
    configForms?: unknown
  }
  const service = (typeof services.get === 'function' ? services.get('configForms') : services.configForms) as
    | { get?(entryId: string): unknown }
    | undefined
  const form = service?.get?.(ENTRY_ID) as ConfigFormLike | undefined
  return form && typeof form.getSnapshot === 'function' ? form : undefined
}

async function ask<T>(path: string, init?: RequestInit): Promise<T> {
  const token = String((globalThis as Record<string, unknown>)[TOKEN_GLOBAL] ?? '')
  const response = await fetch(ROUTE + path, {
    ...init,
    headers: { ...(init?.headers as Record<string, string> | undefined), [TOKEN_HEADER]: token },
  })
  const payload = (await response.json().catch(() => ({}))) as T & { error?: string }
  if (!response.ok) throw new Error(payload.error ?? `请求失败（HTTP ${response.status}）`)
  return payload
}

function message(failure: unknown): string {
  return failure instanceof Error ? failure.message : String(failure)
}

/** The credential-name grammar the host enforces, checked here so a typo is caught before a save. */
const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

/** The blocks whose override fields live in 高级设置, and the order they are listed there. */
const SECTION_ORDER: readonly SectionId[] = ['decision', 'text', 'browser']

/**
 * How long the model-list button keeps saying 正在获取… at the least.
 *
 * A DSH route answers in tens of milliseconds, so the honest busy state would be unreadable — and
 * an unreadable state is no feedback at all. Six hundred milliseconds turned out to be readable
 * only if you are already looking at the button, and nobody is: the eye is on the pointer when it
 * clicks. So the floor is set to about as long as it takes to look up and read two words. The work
 * itself is unchanged, and a slower answer is simply shown until it arrives.
 */
const BUSY_FLOOR_MS = 1200

/** A block's visible title, for the sentences that have to name the block they are about. */
function blockTitle(id: FieldGroupId): string {
  return FIELD_GROUPS.find((group) => group.id === id)?.title ?? id
}

/**
 * Which browser the connection went to, in the words the dropdown above uses.
 *
 * The report's own answer is what is named, not the boxes as they are being edited: which of
 * the two browsers a run drives is exactly the thing a half-saved page must not be able to
 * misreport.
 */
function connectionLabel(connection?: 'plugin' | 'daily'): string {
  const labels = FIELDS.find((field) => field.key === 'browserConnection')?.choiceLabels
  return (connection === undefined ? undefined : labels?.[connection]) ?? '浏览器'
}

type Tone = 'ok' | 'bad' | 'idle'

function JevSettingsPage({ ctx }: { ctx: ClientContext }): ReactNode {
  const { form, snapshot } = useForm(ctx)
  const [status, setStatus] = useState<StatusReport>()
  const [checking, setChecking] = useState(false)
  const [testing, setTesting] = useState(false)
  const [test, setTest] = useState<DecisionTestReport>()
  const [launching, setLaunching] = useState(false)
  const [draft, setDraft] = useState<Record<string, unknown>>({})
  const [keyDrafts, setKeyDrafts] = useState<Record<string, string>>({})
  /** Which blocks have their rarely-used fields opened; an unset entry follows the values. */
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const [busyName, setBusyName] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  /** What the chosen supplier answered when asked for its own model list. */
  const [textModels, setTextModels] = useState<TextModelReport>()
  const [loadingModels, setLoadingModels] = useState(false)
  /** Bumped by the 获取模型列表 button, so asking again needs no other change. */
  const [modelFetch, setModelFetch] = useState(0)
  /** The text block's own connectivity check, and what it answered. */
  const [textTesting, setTextTesting] = useState(false)
  const [textTest, setTextTest] = useState<TextTestReport>()
  /** The browser block's login probe, and what it found in the reader's own browser. */
  const [probing, setProbing] = useState(false)
  const [loginProbe, setLoginProbe] = useState<LoginProbeReport>()

  const check = useCallback(async () => {
    setChecking(true)
    setError('')
    try {
      setStatus(await ask<StatusReport>('/status'))
    } catch (failure) {
      setError(message(failure))
    } finally {
      setChecking(false)
    }
  }, [])

  // The browser check is local and free, so the page does it on its own; the
  // decision check costs the user a call, so that one stays a button.
  useEffect(() => {
    void check()
  }, [check])

  const runDecisionTest = useCallback(async () => {
    setTesting(true)
    setError('')
    setTest(undefined)
    try {
      setTest(await ask<DecisionTestReport>('/test-decision', { method: 'POST' }))
    } catch (failure) {
      setError(message(failure))
    } finally {
      setTesting(false)
    }
  }, [])

  /**
   * Ask the text model one real question, from this page.
   *
   * The page cannot make the call itself — the key sits on the host side — but it can ask the host
   * to, which is the same call a run will make. It sends what the boxes currently hold rather than
   * what is saved, so a route can be tried before it is committed; it spends the reader's quota, so
   * it happens on a press and never on its own.
   */
  const runTextTest = async (): Promise<void> => {
    setTextTesting(true)
    setError('')
    setTextTest(undefined)
    try {
      setTextTest(
        await ask<TextTestReport>('/test-text', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            provider: filled('textProvider'),
            baseUrl: filled('textBaseUrl'),
            model: filled('textModel'),
            keyRef: filled('textKeyRef'),
            reasoning: filled('textReasoning'),
          }),
        }),
      )
    } catch (failure) {
      setError(message(failure))
    } finally {
      setTextTesting(false)
    }
  }

  /**
   * Re-read everything except the browser probe.
   *
   * Cheaper than a full check and it touches no tab; used after a save, when the
   * browser's answer cannot have changed but the credentials and the key names can.
   * The previous browser line is kept because the host leaves it out on purpose.
   */
  const refreshKeys = useCallback(async () => {
    const next = await ask<StatusReport>('/status?browser=skip')
    setStatus((current) =>
      next.browser === undefined && current?.browser !== undefined
        ? { ...next, browser: current.browser }
        : next,
    )
  }, [])

  /**
   * Remove one stored value. Removing is its own verb on purpose: storing an empty
   * string would look the same in the file but mean something else, so the store
   * refuses it and this is how a value goes away.
   */
  const clearKey = useCallback(async (name: string) => {
    setBusyName(name)
    setError('')
    setNotice('')
    try {
      const after = await ask<{ keys: StorableKey[] }>('/credential', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, clear: true }),
      })
      setStatus((current) => (current ? applyKeys(current, after.keys) : current))
      setKeyDrafts((current) => ({ ...current, [name]: '' }))
      setNotice(`已清除 ${name} 的值。`)
    } catch (failure) {
      setError(message(failure))
    } finally {
      setBusyName('')
    }
  }, [])

  /**
   * Save the page's drafts: the fields, then any pasted key values.
   *
   * Given a block, only that block's own fields and its own credential are written —
   * `ownKey` is the name its value box stores under. Without a block, everything on the
   * page is written, which is what the button at the bottom still does. A draft sitting
   * in the other block therefore stays a draft until its own button is pressed.
   *
   * The order is not cosmetic. A credential name typed into a field only becomes
   * storable once the config that mentions it is saved — the host checks the name
   * against the names in play — so the fields go first and the keys follow.
   */
  const save = useCallback(
    async (scope?: FieldGroupId, ownKey?: string): Promise<boolean> => {
      if (!form) return false
      setSaving(true)
      setError('')
      setNotice('')
      const done: string[] = []
      /** The fields this save owns: all of them, or one block's (its overrides included). */
      const owned = scope === undefined ? undefined : new Set(fieldsOfBlock(scope).map((field) => field.key))
      const where = scope === undefined ? '' : `「${blockTitle(scope)}」这一块`
      try {
        const changed = Object.entries(draft).filter(([key]) => owned === undefined || owned.has(key))
        for (const [key, raw] of changed) {
          const field = FIELDS.find((candidate) => candidate.key === key)
          let next = raw
          if (field?.kind === 'number') {
            next = Number(raw)
            if (!Number.isFinite(next)) throw new Error(`「${field.label}」要填一个数字。`)
          }
          if (!(await form.set(key, next))) {
            throw new Error(`「${field?.label ?? key}」没有存下去，可能别处刚改过配置，请重试。`)
          }
        }
        if (changed.length > 0) done.push(`配置改了 ${changed.length} 项`)

        let latest: StorableKey[] | undefined
        const stored: string[] = []
        for (const [name, value] of Object.entries(keyDrafts)) {
          if (value.trim().length === 0) continue
          // A block owns one name: its own. Any other pasted value is left where it is.
          if (ownKey !== undefined && name !== ownKey) continue
          const after = await ask<{ keys: StorableKey[] }>('/credential', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name, value }),
          })
          latest = after.keys
          stored.push(name)
          done.push(`密钥存进 ${name}`)
        }
        if (latest) setStatus((current) => (current ? applyKeys(current, latest) : current))
        setDraft((current) => {
          if (owned === undefined) return {}
          const next = { ...current }
          for (const key of owned) delete next[key]
          return next
        })
        setKeyDrafts((current) => {
          const next = { ...current }
          for (const name of stored) delete next[name]
          return next
        })
        setNotice(
          done.length > 0
            ? `${where}已保存：${done.join('，')}。下一次任务立刻就用新值，不用重启。`
            : `${where}没有需要保存的改动。`,
        )
        // A save can change which key names are in play, so the key rows are re-read.
        // A failed refresh is not a failed save, and must not be reported as one.
        void refreshKeys().catch(() => undefined)
        return true
      } catch (failure) {
        setError(message(failure))
        if (done.length > 0) setNotice(`${where}这一部分已经保存了：${done.join('，')}。`)
        return false
      } finally {
        setSaving(false)
      }
    },
    [draft, keyDrafts, form, refreshKeys],
  )

  const values = snapshot?.value ?? {}
  const value = (key: string): unknown => (key in draft ? draft[key] : values[key])
  const filled = (key: string): string => {
    const raw = value(key)
    return raw === undefined || raw === null ? '' : String(raw).trim()
  }

  const textDoor = filled('textProvider')
  const textDoorBaseUrl = filled('textBaseUrl')
  const textDoorKeyRef = filled('textKeyRef')

  // One report for both doors: a preset is asked over the network, a DSH route is re-read through
  // the host. Both are real round trips, which is what lets the button report honestly that it did
  // something — echoing the roster the page already had would be a press that changes nothing.
  const modelReport = textModels

  /**
   * Ask the chosen supplier what models it serves.
   *
   * The page cannot ask by itself: a preset's key lives in the host's credential store, and a DSH
   * route's roster is the host's to read — so either way this goes through the plugin's own route
   * and only names come back. It follows the draft rather than the saved value, so switching
   * supplier updates the list right away.
   */
  useEffect(() => {
    if (!textDoor) {
      setTextModels(undefined)
      return
    }
    let live = true
    void (async () => {
      const startedAt = Date.now()
      setLoadingModels(true)
      try {
        const query = new URLSearchParams({ provider: textDoor })
        for (const [key, entered] of [
          ['baseUrl', textDoorBaseUrl],
          ['keyRef', textDoorKeyRef],
        ] as const) {
          if (entered) query.set(key, entered)
        }
        const report = await ask<TextModelReport>(`/text-models?${query}`)
        if (live) setTextModels(report)
      } catch (failure) {
        if (live) setTextModels({ ok: false, models: [], note: `没能取回模型清单：${message(failure)}` })
      } finally {
        // A DSH route is a local question and answers in tens of milliseconds, so without this the
        // button would stop saying 正在获取… before anyone could read it — which is the same as
        // saying nothing. The busy state is merely held long enough to be seen; no work is invented.
        const remaining = BUSY_FLOOR_MS - (Date.now() - startedAt)
        if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining))
        if (live) setLoadingModels(false)
      }
    })()
    return () => {
      live = false
    }
  }, [textDoor, textDoorBaseUrl, textDoorKeyRef, modelFetch])

  /**
   * Start the browser from this page, then connect to it.
   *
   * The browser block is saved first, because that choice is the reader's: without it the
   * page would say "Chrome" after a reload while an Edge is the one running. One block is
   * written, never the whole page, so nothing the reader has half-typed elsewhere is
   * committed by this button.
   */
  const launchBrowserFromPage = useCallback(async () => {
    setLaunching(true)
    setError('')
    setNotice('')
    try {
      const saved = await save('browser')
      const report = await ask<LaunchReport>('/launch-browser', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: filled('browserKind') === 'chrome' ? 'chrome' : 'edge' }),
      })
      setStatus((current) => (current === undefined ? current : { ...current, browser: report.browser }))
      setNotice(
        `已按你选的 ${report.label} 启动并连上了：${report.endpoint}。它用的是` +
          `插件自己的数据目录（${report.profileDir}），和你日常那个分开；` +
          `需要登录的网站，就在这个窗口里登录一次，登录会留在那里${saved ? '；这个选择也存下了' : '（浏览器那块的配置这次没存上，见上面的提示）'}。`,
      )
    } catch (failure) {
      setError(message(failure))
    } finally {
      setLaunching(false)
    }
  }, [filled, save])

  /**
   * Ask the host to count what the reader's own browser could bring along.
   *
   * A read of the browser the reader is already using: nothing is started, nothing is opened, and
   * nothing is written. It can only be done on the host, because only the host can reach a DevTools
   * socket — and it waits on the 「允许远程调试？」 box that browser raises, so this button may sit in
   * 正在探测… for as long as that box is on screen. That waiting is the whole behaviour, not a hang.
   */
  const runLoginProbe = useCallback(async () => {
    setProbing(true)
    setError('')
    setNotice('')
    setLoginProbe(undefined)
    try {
      setLoginProbe(await ask<LoginProbeReport>('/login-probe'))
    } catch (failure) {
      setError(message(failure))
    } finally {
      setProbing(false)
    }
  }, [])

  /** The name a value pasted into a block would be stored under, defaults included. */
  const decisionName = filled('decisionKeyRef') || routeDefault('keyRef', filled('decisionProvider'))
  // The name a block will actually use. Deliberately not falling back to the server's
  // reported credential: that report is one save behind, so a name just cleared here would
  // keep the page showing the old one — and the old one was the illegal name that took the
  // paste box away in the first place.
  const textName = filled('textKeyRef') || textRouteDefault('keyRef', filled('textProvider'))
  /** True while the text model is a route DSH serves, which owns its own address and key. */
  const textIsDsh = resolveTextRoute({ provider: filled('textProvider') }).kind === 'dsh'
  /**
   * What the store says about a name. A name that is not in the report is one the
   * reader has just typed: nothing is known about it yet, and the honest default is
   * "not stored, but writable" — the save order above is what makes that true.
   */
  const keyState = (name: string): KeyState =>
    status?.keys.find((entry) => entry.name === name)?.state ?? { configured: false, writable: true }
  const pending =
    Object.keys(draft).length + Object.values(keyDrafts).filter((entry) => entry.trim().length > 0).length
  /** The same count, for one block: its own fields plus the value pasted into its own box. */
  const pendingOf = (id: FieldGroupId): number => {
    const owned = new Set(fieldsOfBlock(id).map((field) => field.key))
    const fields = Object.keys(draft).filter((key) => owned.has(key)).length
    const name = id === 'decision' ? decisionName : id === 'text' ? textName : ''
    const pasted = name.length > 0 && (keyDrafts[name] ?? '').trim().length > 0 ? 1 : 0
    return fields + pasted
  }
  const onDraft = (name: string, next: string): void =>
    setKeyDrafts((current) => ({ ...current, [name]: next }))

  /** The name a block would use with nothing configured. */
  const defaultNameOf = (group: FieldGroup): string =>
    group.id === 'text'
      ? textRouteDefault('keyRef', filled('textProvider'))
      : routeDefault('keyRef', filled('decisionProvider'))

  /**
   * Put a credential name back to its default.
   *
   * The name box lives in 高级设置, and a name the store refuses takes the paste box away
   * with it: the reader is left staring at a dead end whose only cure sits two clicks away,
   * which is exactly the kind of dead end this page is supposed to remove. So the sentence
   * that explains the problem carries the button that fixes it.
   */
  const restoreDefaultName = async (group: FieldGroup): Promise<void> => {
    if (!form) return
    const key = group.id === 'text' ? 'textKeyRef' : 'decisionKeyRef'
    setError('')
    setNotice('')
    try {
      if (!(await form.set(key, ''))) {
        throw new Error('这个名字没有改回去，可能别处刚改过配置，请重试。')
      }
      setDraft((current) => {
        const next = { ...current }
        delete next[key]
        return next
      })
      setNotice(`名字已经改回默认的 ${defaultNameOf(group)}，粘贴框出来了。`)
    } catch (failure) {
      setError(message(failure))
    }
  }

  /**
   * What an empty box will use, for its grey placeholder.
   *
   * Which route to ask depends on the block the field came from: both halves have a 模型
   * and a 密钥名, and only the block says whose they are.
   */
  const routePlaceholder = (group: FieldGroup, field: FieldSpec): string | undefined => {
    const from = field.fromRoute
    if (from === undefined) return undefined
    if (group.id === 'text' || field.section === 'text') {
      return from === 'endpoint' ? undefined : textRouteDefault(from, filled('textProvider'))
    }
    return from === 'baseUrl' ? undefined : routeDefault(from, filled('decisionProvider'))
  }

  /**
   * The doors the model column can offer.
   *
   * Built from the host's report rather than from a constant here, because half of the
   * list is what DSH itself serves and only the host can enumerate that. A value the
   * report does not know — a route unregistered since it was chosen, say — is still shown
   * as it stands, so the picker cannot quietly claim the settings say something else.
   */
  const doors = (current: string): TextProviderOption[] => {
    const listed =
      status?.providers ??
      TEXT_PROVIDERS.map((spec) => ({
        id: spec.id,
        label: spec.label,
        kind: 'preset' as const,
        models: [...spec.models],
      }))
    if (current === '' || listed.some((entry) => entry.id === current)) return listed
    return [{ id: current, label: current, kind: isDshRoute(current) ? 'dsh' : 'preset', models: [] }, ...listed]
  }

  const providerSelect = (group: FieldGroup, field: FieldSpec): ReactNode =>
    createElement(
      'select',
      {
        'aria-label': `${group.title} · ${field.label}`,
        style: S.input,
        value: String(value(field.key) ?? ''),
        onChange: (event: { target: { value: string } }) =>
          setDraft((current) => ({ ...current, [field.key]: event.target.value })),
      },
      (() => {
        const options = doors(String(value(field.key) ?? ''))
        const preset = options.filter((entry) => entry.kind === 'preset')
        const builtin = options.filter((entry) => entry.kind === 'dsh')
        const option = (entry: TextProviderOption): ReactNode =>
          createElement('option', { key: entry.id, value: entry.id }, entry.label)
        return [
          builtin.length > 0 ? createElement('optgroup', { key: 'dsh', label: 'DSH 内置（由 DSH 管理地址和密钥）' }, builtin.map(option)) : null,
          createElement('optgroup', { key: 'preset', label: '插件预设（本插件直连）' }, preset.map(option)),
        ]
      })(),
    )

  const providerNote = (field: FieldSpec): string | undefined => {
    const selected = String(value(field.key) ?? '')
    if (field.key === 'decisionProvider') return decisionProvider(selected).note
    if (field.key !== 'textProvider') return undefined
    // A DSH route needs nothing here: the field's own hint and the key row below both
    // already say DSH owns the address and the credential, and a third repetition would
    // only push the vendor's line further from the box it explains.
    if (isDshRoute(selected)) return undefined
    return textProvider(selected)?.note
  }

  const fieldRow = (group: FieldGroup, field: FieldSpec): ReactNode =>
    createElement(
      'div',
      { key: field.key, style: S.field },
      createElement('div', { style: S.label }, field.label),
      createElement(
        'div',
        { style: S.control },
        field.kind === 'provider'
          ? providerSelect(group, field)
          : control(
              field,
              value(field.key),
              (next) => setDraft((current) => ({ ...current, [field.key]: next })),
              // Empty means "whatever the chosen door says", so the grey placeholder is
              // how an empty box still tells the truth. Reading the door from the draft
              // makes it follow the dropdown as it moves.
              routePlaceholder(group, field),
              `${group.title} · ${field.label}`,
              field.modelsFrom === 'textProvider'
                ? textModelChoices(filled('textProvider'), status?.providers, textModels?.models)
                : undefined,
              // A complete list (the supplier answered, or DSH reported its own) turns the box
              // into a pick list; anything shorter leaves it a text box.
              field.modelsFrom === 'textProvider' && modelReport?.ok === true && modelReport.models.length > 0,
            ),
      ),
      field.hint ? createElement('div', { style: S.hint }, field.hint) : null,
      // What the supplier answered when asked for its own list: the line under the model box,
      // which is also where "why there is no list" belongs.
      // A failure stays on screen, because why there is no list is what the reader has to act on.
      // Success says nothing at all: the list itself is the answer, and the button's own disabled
      // state already covers "it is working right now".
      field.key === 'textModel' && modelReport && !modelReport.ok
        ? stateRow('模型清单', '没取到', 'bad', modelReport.note)
        : null,
      // The supplier's own note, for both halves: the decision supplier is a `choice`
      // field and the text supplier is a `provider` field, and both are better off
      // saying what the selected door means than leaving the reader to guess.
      (field.kind === 'provider' || field.kind === 'choice') && providerNote(field)
        ? createElement('div', { style: S.hint }, providerNote(field))
        : null,
    )

  const keyRow = (group: FieldGroup, name: string): ReactNode => {
    const state = keyState(name)
    const legal = NAME_PATTERN.test(name)
    // A box only appears where a write could actually land: the store refuses a name
    // the launching environment already supplies, and that refusal is not worth a
    // round trip — saying why it cannot change is the honest, and shorter, answer.
    const box = legal && state.writable
    return createElement(
      'div',
      { key: `${group.id}-key`, style: S.field },
      createElement('div', { style: S.label }, '密钥'),
      createElement(
        'div',
        { style: S.control },
        createElement(
          'div',
          { style: S.keyState },
          `${name}：${standing(state)}`,
        ),
        !legal
          ? createElement(
              'div',
              { style: S.keyActions },
              createElement(
                'div',
                { style: S.keyState },
                '这个名字不能用：只能是字母、数字、下划线，而且不能以数字开头——所以这里没有粘贴框。',
              ),
              createElement(
                'button',
                {
                  type: 'button',
                  style: S.clear,
                  disabled: busyName === name,
                  onClick: () => void restoreDefaultName(group),
                },
                `把名字改回默认的（${defaultNameOf(group)}）`,
              ),
            )
          : null,
        box
          ? createElement(
              'div',
              { style: S.keyActions },
              createElement('input', {
                type: 'password',
                'aria-label': `${name} 的密钥值`,
                autoComplete: 'off',
                spellCheck: false,
                placeholder: '把密钥粘贴到这里',
                style: S.keyInput,
                value: keyDrafts[name] ?? '',
                onChange: (event: { target: { value: string } }) => onDraft(name, event.target.value),
              }),
              state.configured
                ? createElement(
                    'button',
                    {
                      type: 'button',
                      style: S.clear,
                      disabled: busyName === name,
                      onClick: () => {
                        // Cheap insurance: the value is not shown anywhere once stored, so
                        // a mis-click would mean going back to the provider to fetch it again.
                        if (globalThis.confirm?.(`清除 ${name} 的值？清除以后要重新粘贴。`) !== false) {
                          void clearKey(name)
                        }
                      },
                    },
                    busyName === name ? '正在清除…' : '清除',
                  )
                : null,
            )
          : null,
      ),
      createElement(
        'div',
        { style: S.hint },
        `任务跑起来找的就是 ${name} 这个名字；值不会再显示出来。`,
      ),
    )
  }

  const stateRow = (label: string, verdict: string, tone: Tone, detail?: ReactNode): ReactNode =>
    createElement(
      'div',
      { style: S.stateRow, key: `state-${label}` },
      createElement('div', { style: S.rowLabel }, label),
      createElement(
        'div',
        { style: S.rowDetail },
        createElement('span', { style: toneStyle(tone) }, verdict),
        detail ? createElement('div', { style: S.stateDetail }, detail) : null,
      ),
    )

  /**
   * A second half of a state line, kept behind a click.
   *
   * The browser's own error text is the honest one — it is what a run would report —
   * but it arrives as a paragraph of instructions. The first sentence says what is
   * wrong, which is what the state line is for; the how-to follows the click.
   */
  const more = (id: string, trigger: string, body: ReactNode): ReactNode =>
    createElement(
      'div',
      null,
      createElement(
        'button',
        {
          type: 'button',
          style: S.disclosure,
          onClick: () => setOpen((current) => ({ ...current, [id]: !(current[id] === true) })),
        },
        open[id] === true ? '收起' : trigger,
      ),
      open[id] === true ? createElement('div', { style: S.stateDetail }, body) : null,
    )

  const blockState = (group: FieldGroup): ReactNode => {
    if (group.id === 'browser') {
      const browser = status?.browser
      if (status === undefined) return stateRow('现在', checking ? '正在检查' : '还没检查', 'idle')
      if (browser === undefined) return stateRow('现在', '这次没重新连', 'idle', '上面那句是上一次的结果。')
      if (browser.ok) {
        return stateRow(
          '现在',
          '连上了',
          'ok',
          `${browser.endpoint}（${browser.version}）· 连的是${connectionLabel(browser.connection)} · ` +
            `当前标签页「${browser.title || '空白页'}」，能操作的元素 ${browser.elements} 个。`,
        )
      }
      const text = browser.message ?? '连不上这个浏览器。'
      const stop = text.indexOf('。')
      const brief = stop === -1 ? text : text.slice(0, stop + 1)
      const rest = stop === -1 ? '' : text.slice(stop + 1).trim()
      return stateRow(
        '现在',
        '连不上',
        'bad',
        rest.length === 0 ? brief : createElement('div', null, brief, more('browser-fix', '怎么弄 ▾', rest)),
      )
    }
    if (group.id === 'decision') {
      if (status === undefined) return stateRow('现在', '还没检查', 'idle')
      const { decision } = status
      return stateRow(
        '现在',
        decision.configured ? '可用' : '缺密钥',
        decision.configured ? 'ok' : 'bad',
        `${decision.providerLabel} · ${decision.model} · ${
          decision.configured
            ? `密钥已配置${whereFrom(decision.source)}。`
            : // The report's own credential name, not `decisionName`: the line is labelled
              // 现在 and must describe the saved configuration from end to end. The key box
              // below follows the draft on purpose (so a new route's value can be pasted
              // before saving), and a half-draft sentence here would read as a state that
              // never existed. The text block has always done it this way.
              `密钥 ${decision.credential} 还没有值。`
        }`,
      )
    }
    if (group.id === 'text') {
      if (status === undefined) return stateRow('现在', '还没检查', 'idle')
      const { text } = status
      const label = status.providers.find((entry) => entry.id === text.provider)?.label ?? text.providerLabel
      const kindLabel = text.kind === 'dsh' ? 'DSH 内置' : '预设'
      // Three different things can be missing here and each is fixed in a different place,
      // so the line names the one that is actually missing instead of one word for all.
      const standing =
        text.kind === 'dsh' && !text.configured
          ? '不在名册里'
          : text.model.length === 0
            ? '还没选模型'
            : text.configured
              ? '可用'
              : '缺密钥'
      const detail =
        text.kind === 'dsh'
          ? `${kindLabel} · ${label} · ${text.model || '还没有选模型'} · ${
              text.configured ? '密钥由 DSH 自己管。' : '这条路由现在不在 DSH 的模型名册里，选了也用不了。'
            }`
          : `${kindLabel} · ${label} · ${text.model} · ${
              text.configured
                ? `密钥已配置${whereFrom(text.source)}。`
                : `密钥 ${text.credential} 还没有值，任务真需要填字时才会用到它。`
            }`
      return stateRow('现在', standing, standing === '可用' ? 'ok' : 'bad', detail)
    }
    return null
  }

  /**
   * What the login probe found, in one sentence and a list.
   *
   * Counts only: the browser's cookies never leave it, so there is no name, no value and no expiry
   * here even if someone wanted one. The list arrives sorted — most cookies first — and the closing
   * sentence is there because the number is easy to over-read: a site can hold a dozen cookies and
   * still ask for a password again in another browser.
   */
  const probeResult = (probe: LoginProbeReport): ReactNode =>
    createElement(
      'div',
      { style: S.stateDetail },
      probe.ok
        ? [
            createElement(
              'div',
              { key: 'line' },
              `能带走 ${probe.sites} 个站、${probe.total} 条 cookie，其中 ${probe.sessionCookies} 条是关掉浏览器后可能失效的。`,
            ),
            probe.bySite.length > 0
              ? createElement(
                  'div',
                  { key: 'sites' },
                  probe.bySite.map((site) => `${site.domain}（${site.count} 条）`).join('\n'),
                )
              : null,
            createElement(
              'div',
              { key: 'honest' },
              'cookie 多不等于一定免登录，有些站换浏览器后还要再验一次。',
            ),
          ]
        : probe.message ?? '这次没探测成。',
    )

  const visibleGroups = FIELD_GROUPS.filter((group) => group.id !== 'advanced')
  const advancedGroup = FIELD_GROUPS.find((group) => group.id === 'advanced')
  const advancedFields = FIELDS.filter((field) => field.group === 'advanced')
  const advancedChanged = advancedFields.filter((field) => filled(field.key) !== '').length
  const advancedOpen = open.advanced === true
  /** Whether the browser block is drawn for the reader's own browser, which it may not start. */
  const dailyConnection = filled('browserConnection') === 'daily'
  /** Inside 高级设置 a field keeps the name of the block it came from. */
  const blockOf = (id: SectionId): FieldGroup =>
    visibleGroups.find((group) => group.id === id) ?? visibleGroups[0]

  const blocks = visibleGroups.map((group) => {
    const fields = FIELDS.filter((field) => field.group === group.id)
    // Which name a pasted value would go under. Only the two key-taking blocks show a
    // value box; the rest of the page has no credential of its own.
    const name = group.id === 'decision' ? decisionName : group.id === 'text' ? textName : ''
    // A built-in door has no credential of ours at all: DSH holds it, so the row says so
    // rather than drawing a paste box nothing would ever read.
    const dshKeys = group.id === 'text' && textIsDsh
    const keyName = KEY_BLOCKS.includes(group.id) && !dshKeys ? name : ''
    return createElement(
      'div',
      { key: group.id, style: S.block },
      createElement(
        'div',
        { style: S.blockHead },
        createElement('span', { style: S.blockTitle }, group.title),
        group.note ? createElement('span', { style: S.blockNote }, group.note) : null,
      ),
      blockState(group),
      ...fields.map((field) => fieldRow(group, field)),
      keyName ? keyRow(group, keyName) : null,
      dshKeys
        ? createElement(
            'div',
            { key: 'text-key', style: S.field },
            createElement('div', { style: S.label }, '密钥'),
            createElement(
              'div',
              { style: S.control },
              createElement(
                'div',
                { style: S.keyState },
                '由 DSH 自己管：这条路由的地址和密钥都在 DSH 里配好了，这里不用粘贴。',
              ),
            ),
          )
        : null,
      group.id === 'browser'
        ? createElement(
            'div',
            { style: S.actions },
            // The two routes need different things here. On 「你正在用的浏览器」 the plugin may not
            // start, close or write to that browser, so the only control is the probe — a read —
            // and the sentences say what to do in the browser itself. On 「插件自己的浏览器」 the
            // button starts it, and only the launch itself blocks it: the page's own check opens a
            // tab and can take a while, and letting that disable this would make a press do nothing
            // at all.
            ...(dailyConnection
              ? [
                  // A read of the reader's own browser: it counts what is already there and opens
                  // nothing. The host does the connecting, so this button is the only control on the
                  // page that touches a browser the plugin does not own — which is exactly why it
                  // says what it does, and why it waits.
                  createElement(
                    'button',
                    {
                      key: 'probe',
                      type: 'button',
                      onClick: () => void runLoginProbe(),
                      disabled: probing,
                    },
                    probing ? '正在探测…' : '看看能带走多少登录',
                  ),
                  createElement(
                    'span',
                    { key: 'probe-hint', style: S.actionsHint },
                    '浏览器里会弹出「允许远程调试？」的框，要在框上点「允许」，不点它就会一直等。',
                  ),
                  createElement(
                    'span',
                    { key: 'how', style: S.actionsHint },
                    `连不上时：在 ${inspectPageUrl(filled('browserKind') === 'chrome' ? 'chrome' : 'edge')} 里勾上` +
                      '「允许远程调试」，再在弹出的「允许远程调试？」框上点「允许」——插件会一直等这个框，不超时、也不重试。',
                  ),
                ]
              : [
                  createElement(
                    'button',
                    {
                      key: 'launch',
                      type: 'button',
                      onClick: () => void launchBrowserFromPage(),
                      disabled: launching,
                    },
                    launching ? '正在启动…' : '启动并连接',
                  ),
                  createElement(
                    'span',
                    { key: 'hint', style: S.actionsHint },
                    '在插件自己的浏览器里登录一次，之后长期保留。',
                  ),
                ]),
          )
        : null,
      // Only where its own button is: a result with no button above it would be a number the
      // reader cannot ask for again, and one from a route the page is no longer showing.
      group.id === 'browser' && dailyConnection && loginProbe !== undefined ? probeResult(loginProbe) : null,
      group.id === 'decision'
        ? createElement(
            'div',
            { style: S.actions },
            // Only the test itself blocks this button. The page's own check (which
            // includes a browser probe that can take a long time, and fails when no
            // debugging port is open) has nothing to do with the decision service —
            // letting it disable this button makes a click do nothing at all.
            createElement(
              'button',
              { type: 'button', onClick: () => void runDecisionTest(), disabled: testing },
              testing ? '正在测试…' : '测一次决策服务',
            ),
            createElement(
              'span',
              { style: S.actionsHint },
              '会真的发一次请求，用掉你账号里一次很小的调用。',
            ),
          )
        : null,
      test && group.id === 'decision'
        ? stateRow(
            '刚测过',
            '正常',
            'ok',
            `模型 ${test.model} 回答「${test.operation}」，落到 ${test.choice}，用时 ${(test.latencyMs / 1000).toFixed(1)} 秒。`,
          )
        : null,
      textTest && group.id === 'text'
        ? stateRow(
            '刚测过',
            '正常',
            'ok',
            `模型 ${textTest.model} 按要求的 JSON 回了话，用时 ${(textTest.latencyMs / 1000).toFixed(1)} 秒。`,
          )
        : null,
      // This block's own save, so a key can be pasted and stored without walking down to
      // the page's button — and without dragging the other block's drafts along with it.
      SELF_SAVING_BLOCKS.includes(group.id)
        ? createElement(
            'div',
            { style: S.actions },
            // One real question, answered by the route this block names: the only way to know the
            // address, the model and the key work together before a run needs them. It spends the
            // reader's quota, so it is a press — and it sends the boxes as they are, not as saved.
            group.id === 'text'
              ? createElement(
                  'button',
                  { type: 'button', onClick: () => void runTextTest(), disabled: textTesting },
                  textTesting ? '正在测试…' : '测试连接',
                )
              : null,
            // Same button on both doors: a preset supplier is asked over the network, a DSH route
            // answers from the roster DSH already reported. Nothing here is a save.
            group.id === 'text' && textDoor
              ? createElement(
                  'button',
                  {
                    type: 'button',
                    onClick: () => setModelFetch((current) => current + 1),
                    disabled: loadingModels,
                  },
                  loadingModels ? '正在获取…' : '获取模型列表',
                )
              : null,
            createElement(
              'button',
              {
                type: 'button',
                onClick: () => void save(group.id, keyName),
                disabled: saving || pendingOf(group.id) === 0,
              },
              saving ? '正在保存…' : '保存',
            ),
            createElement(
              'span',
              { style: S.actionsHint },
              snapshot && !snapshot.writable
                ? '这一层配置是只读的，改动不会生效。'
                : pendingOf(group.id) > 0
                  ? `这一块有 ${pendingOf(group.id)} 处改动还没保存。`
                  : '这一块没有改动。',
            ),
          )
        : null,
    )
  })

  /**
   * Every override, in one disclosure.
   *
   * Each of these already has an answer in effect — the provider's own, or the default —
   * and that answer is what the block above reports. So the disclosure stays closed until
   * the reader asks for it; the count of what has been changed stands in for the pile, so
   * a value someone did set is never silently hidden.
   */
  const advanced = advancedGroup
    ? createElement(
        'div',
        { key: 'advanced', style: S.block },
        createElement(
          'div',
          { style: S.blockHead },
          createElement('span', { style: S.blockTitle }, advancedGroup.title),
          advancedGroup.note ? createElement('span', { style: S.blockNote }, advancedGroup.note) : null,
        ),
        advancedChanged > 0 && !advancedOpen
          ? createElement(
              'div',
              { style: S.keyState },
              `其中 ${advancedChanged} 项你已经改过，展开就能看到。`,
            )
          : null,
        createElement(
          'button',
          {
            type: 'button',
            style: S.disclosure,
            onClick: () => setOpen((current) => ({ ...current, advanced: !advancedOpen })),
          },
          `${advancedOpen ? '收起' : '展开'}（共 ${advancedFields.length} 项）`,
        ),
        advancedOpen
          ? SECTION_ORDER.map((section) => {
              const rows = advancedFields.filter((field) => field.section === section)
              if (rows.length === 0) return null
              const group = blockOf(section)
              return createElement(
                'div',
                { key: section },
                createElement('div', { style: S.subHead }, group.title),
                ...rows.map((field) => fieldRow(group, field)),
              )
            })
          : null,
      )
    : null

  return createElement(
    'div',
    { style: S.page },
    createElement(
      'div',
      { style: S.head },
      createElement('h2', { style: S.title }, 'Jev 浏览器'),
      createElement(
        'button',
        { type: 'button', onClick: () => void check(), disabled: checking || testing },
        checking ? '正在检查…' : '重新检查',
      ),
    ),
    ...blocks,
    advanced,

    !form || snapshot?.status === 'unavailable'
      ? createElement(
          'p',
          { style: S.lead },
          '读不到配置表单，所以上面只能看、不能改。可以直接改这个插件那一行的配置文件（cordis.yml）里的对应字段，改完重载即可。',
        )
      : createElement(
          'div',
          { style: S.actions },
          createElement(
            'button',
            { type: 'button', onClick: () => void save(), disabled: saving },
            saving ? '正在保存…' : '保存全部改动',
          ),
          createElement(
            'span',
            { style: S.actionsHint },
            snapshot && !snapshot.writable
              ? '这一层配置是只读的，改动不会生效。'
              : pending > 0
                ? `有 ${pending} 处改动还没保存。`
                : '保存后立刻生效，下一次任务就用新值。',
          ),
        ),

    error ? createElement('p', { style: S.error }, `出错了：${error}`) : null,
    notice ? createElement('p', { style: S.notice }, notice) : null,
  )
}

/** `，来自哪里`, or nothing when the store did not say. */
function whereFrom(source?: string): string {
  if (source === undefined) return ''
  const label = sourceLabel(source)
  // A Chinese label needs no space after 来自; a Latin one (DSH 的凭据文件) does.
  return `，来自${/^[A-Za-z0-9]/.test(label) ? ' ' : ''}${label}`
}

/**
 * Where one credential name stands, in one sentence.
 *
 * The read-only case is spelled out rather than hidden: a layer that wins but cannot be
 * changed from here is exactly what a reader needs to know before pasting a new value.
 */
function standing(state: KeyState): string {
  if (!state.writable) {
    const head = state.configured ? `已配置${whereFrom(state.source)}` : '启动时的环境变量占着这个名字'
    return `${head}。这一页改不了它：那一层优先，而且只在 dsh web 启动那一刻读一次。`
  }
  return state.configured
    ? `已配置${whereFrom(state.source)}。想换值，粘贴一个新的保存就行。`
    : '还没有值。'
}

function toneStyle(tone: Tone): CSSProperties {
  if (tone === 'bad') return S.verdictBad
  if (tone === 'ok') return S.verdictOk
  return S.verdictIdle
}

/**
 * Fold the store's answer about the writable names back into the report, so the health
 * lines and the key rows agree the moment a value is stored or removed.
 */
function applyKeys(status: StatusReport, keys: StorableKey[]): StatusReport {
  const stateOf = (name: string): KeyState | undefined =>
    keys.find((entry) => entry.name === name)?.state
  const decision = stateOf(status.decision.credential)
  const text = stateOf(status.text.credential)
  return {
    ...status,
    keys,
    decision: decision ? { ...status.decision, ...decision } : status.decision,
    text: text ? { ...status.text, ...text } : status.text,
  }
}

/** What an empty decision field will actually use, for its grey placeholder. */
function routeDefault(key: 'endpoint' | 'model' | 'keyRef', provider: unknown): string {
  return resolveDecisionRoute({ provider: typeof provider === 'string' ? provider : undefined })[key]
}

/** The same for the text model, whose empty fields fall back to the chosen door's own. */
function textRouteDefault(key: 'baseUrl' | 'model' | 'keyRef', provider: unknown): string {
  return resolveTextRoute({ provider: typeof provider === 'string' ? provider : undefined })[key]
}

/**
 * What to offer under the model box: the supplier's own answer when we have one, otherwise this
 * door's built-in names, otherwise DSH's roster. A live list wins outright because it is the only
 * one that cannot be out of date — a name the supplier does not serve is worse than no suggestion.
 */
function textModelChoices(
  provider: string,
  providers: readonly TextProviderOption[] | undefined,
  live?: readonly string[],
): string[] {
  const route = resolveTextRoute({ provider })
  if (route.kind === 'preset' && live && live.length > 0) return live.slice()
  return providers?.find((entry) => entry.id === route.provider)?.models ?? textProvider(route.provider)?.models.slice() ?? []
}

function control(
  field: FieldSpec,
  value: unknown,
  onChange: (next: unknown) => void,
  placeholder?: string,
  ariaLabel?: string,
  candidates?: readonly string[],
  /** True when `candidates` is the whole truth about what this field may hold. */
  complete?: boolean,
): ReactNode {
  // The visible label is short (the block heading carries the rest), so every control
  // also gets the full name: without it a screen reader announces an unnamed input.
  const aria = { 'aria-label': ariaLabel ?? field.label }
  if (field.kind === 'switch') {
    return createElement('input', {
      type: 'checkbox',
      ...aria,
      checked: value === true,
      onChange: (event: { target: { checked: boolean } }) => onChange(event.target.checked),
    })
  }
  if (field.kind === 'choice') {
    return createElement(
      'select',
      {
        ...aria,
        style: S.input,
        value: String(value ?? ''),
        onChange: (event: { target: { value: string } }) => onChange(event.target.value),
      },
      (field.choices ?? []).map((choice) =>
        createElement('option', { key: choice, value: choice }, field.choiceLabels?.[choice] ?? choice),
      ),
    )
  }
  const options = (candidates ?? []).filter((entry) => entry.trim().length > 0)
  // A list that is the whole truth becomes a real pick list, so one click shows everything that
  // can be chosen without typing anything. A short fallback list stays a text box, because there
  // typing a name we did not list is exactly what the reader may need.
  if (complete === true && options.length > 0) {
    const current = value === undefined || value === null ? '' : String(value)
    // A value that is not in the list — a route unregistered since it was chosen — is still
    // offered first, so the picker cannot silently claim the settings say something else.
    const names = current !== '' && !options.includes(current) ? [current, ...options] : options
    return createElement(
      'select',
      {
        ...aria,
        style: S.input,
        value: current,
        onChange: (event: { target: { value: string } }) => onChange(event.target.value),
      },
      [
        current === ''
          ? createElement('option', { key: 'default', value: '' }, '（用这一条路的默认模型）')
          : null,
        ...names.map((entry) => createElement('option', { key: entry, value: entry }, entry)),
      ],
    )
  }
  const listId = `${field.key}-choices`
  return [
    createElement('input', {
      key: 'input',
      type: field.kind === 'number' ? 'number' : 'text',
      ...aria,
      style: S.input,
      ...(placeholder ? { placeholder } : {}),
      // A native pick-list rather than a select: a model name nobody listed is still
      // usable, because the box stays a text box.
      ...(options.length > 0 ? { list: listId } : {}),
      value: value === undefined || value === null ? '' : String(value),
      onChange: (event: { target: { value: string } }) => onChange(event.target.value),
    }),
    options.length > 0
      ? createElement(
          'datalist',
          { key: 'list', id: listId },
          options.map((entry) => createElement('option', { key: entry, value: entry })),
        )
      : null,
  ]
}

/**
 * Subscribe to the row's config form, if there is one.
 *
 * Mount is also the first moment the late service is likely to exist, so the lookup
 * happens here rather than in a module-level constant.
 */
function useForm(ctx: ClientContext): { form?: ConfigFormLike; snapshot?: ConfigFormSnapshotLike } {
  const [state, setState] = useState<{ form?: ConfigFormLike; snapshot?: ConfigFormSnapshotLike }>({})
  useEffect(() => {
    const found = lookupForm(ctx)
    if (!found) return
    const sync = (): void => setState({ form: found, snapshot: found.getSnapshot() })
    sync()
    return found.subscribe(sync)
  }, [ctx])
  return state
}

// Inline styles rather than a stylesheet: this bundle is loaded as a module by the
// Web UI, and shipping CSS would mean depending on its styling internals. The CSS
// variables are the app's own, with a fallback so the page still reads correctly if
// a name ever changes.
const S: Record<string, CSSProperties> = {
  page: { maxWidth: 720, paddingBottom: 24 },
  head: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  title: { fontSize: 16, fontWeight: 600, margin: 0 },
  lead: { fontSize: 13, lineHeight: 1.75, opacity: 0.7, margin: '8px 0 0' },
  block: {
    marginTop: 20,
    paddingTop: 12,
    borderTop: '1px solid var(--dsh-border, rgba(127,127,127,0.22))',
  },
  blockHead: { display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' },
  blockTitle: { fontSize: 14, fontWeight: 600 },
  blockNote: { fontSize: 12, opacity: 0.55 },
  /** A block's name inside 高级设置, where the fields are grouped by where they came from. */
  subHead: { fontSize: 12.5, fontWeight: 600, opacity: 0.75, marginTop: 12 },
  stateRow: { display: 'flex', alignItems: 'baseline', gap: 12, padding: '8px 0 6px' },
  rowLabel: { flex: '0 0 84px', fontSize: 13, opacity: 0.5 },
  rowDetail: { flex: '1 1 auto', fontSize: 13, lineHeight: 1.7, wordBreak: 'break-word' },
  verdictBad: { color: 'var(--dsh-danger, #d4380d)', fontWeight: 600 },
  verdictOk: { color: 'var(--dsh-success, #237804)', fontWeight: 600 },
  verdictIdle: { opacity: 0.6 },
  stateDetail: {
    marginTop: 3,
    fontSize: 12.5,
    lineHeight: 1.7,
    opacity: 0.75,
    whiteSpace: 'pre-line',
  },
  field: {
    display: 'grid',
    gridTemplateColumns: '150px 1fr',
    gap: '4px 12px',
    alignItems: 'center',
    padding: '8px 0 4px',
    borderTop: '1px solid var(--dsh-border, rgba(127,127,127,0.12))',
  },
  label: { fontSize: 13 },
  control: { minWidth: 0 },
  /** A field's box fills its column: a narrow box beside a wide hint reads as a mistake. */
  input: { width: '100%', boxSizing: 'border-box' },
  hint: { gridColumn: '2 / 3', fontSize: 12, lineHeight: 1.6, opacity: 0.55 },
  keyState: { fontSize: 13, lineHeight: 1.7 },
  keyActions: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 6, flexWrap: 'wrap' },
  keyInput: {
    flex: '1 1 220px',
    minWidth: 160,
    fontFamily: 'var(--dsh-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)',
  },
  clear: {
    background: 'none',
    border: 'none',
    padding: '0 2px',
    font: 'inherit',
    fontSize: 12,
    opacity: 0.6,
    cursor: 'pointer',
    textDecoration: 'underline',
  },
  disclosure: {
    background: 'none',
    border: 'none',
    padding: 0,
    font: 'inherit',
    fontSize: 12,
    opacity: 0.65,
    cursor: 'pointer',
    marginTop: 8,
    textAlign: 'left',
  },
  actions: { display: 'flex', alignItems: 'center', gap: 10, marginTop: 16, flexWrap: 'wrap' },
  actionsHint: { fontSize: 12, opacity: 0.6 },
  error: { fontSize: 13, lineHeight: 1.7, marginTop: 14, color: 'var(--dsh-danger, #d4380d)' },
  notice: { fontSize: 13, lineHeight: 1.7, marginTop: 14, opacity: 0.72 },
}
