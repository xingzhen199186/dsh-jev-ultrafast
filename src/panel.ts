/**
 * The settings page's host half.
 *
 * The browser half draws the page; everything a browser cannot do happens here:
 * reaching a DevTools endpoint, resolving credentials, and asking the decision
 * service one real question. The two halves talk over a prefixed HTTP route this
 * module registers. It is guarded by a per-boot token that only the boot page
 * carries, so no other page — and no other origin — can spend the user's key.
 *
 * The page is contributed by the browser half (see src/client/index.ts); this
 * module deliberately registers no settings namespace of its own, because the
 * bundle's own `Config` is already the row's configuration and a second copy would
 * have to be kept in sync by hand.
 */
import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { discoverBrowser } from './browser/discover'
import { launchBrowser } from './browser/launch'
import { BrowserSession } from './browser/session'
import type { Config as ConfigShape } from './config'
import { changeKey, describeKey, resolveKey, storableNames } from './credentials'
import { actionSpace } from './decision/action-space'
import { askText } from './decision/text-helper'
import { resolveDecisionRoute } from './decision/providers'
import type { DecisionRoute } from './decision/providers'
import { resolveTextRoute } from './decision/text-providers'
import type { TextRoute } from './decision/text-providers'
import { choose } from './decision/typesafe'
import { captureLlm, providerOptions } from './dsh-model'
import { readJson, send } from './http'
import { createInspector, type Inspector } from './inspector'
import { fetchModelList } from './model-list'
import { TEXT_PROBE } from './prompts'
import { ROUTE, TOKEN_GLOBAL, TOKEN_HEADER } from './protocol'
import type {
  BrowserReport,
  DecisionTestReport,
  LaunchReport,
  StorableKey,
  StatusReport,
  TextModelReport,
  TextTestReport,
} from './protocol'
import { resolveTextSource, type TextSettings } from './run-setup'

/** The slice of the Web app's `webServer` service this plugin uses. */
interface WebServerLike {
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
}

/** One structured index-injection row: the boot page reads `globalThis[name]`. */
interface IndexInjectionRow {
  kind: 'global'
  name: string
  value: unknown
}

/** The slice of cordis' `on` this plugin uses, narrowed to the one event. */
interface IndexInjectionEvents {
  on(event: 'webserver/index-inject', listener: (table: IndexInjectionRow[]) => void): unknown
}

/**
 * Serve the settings page's requests, if this profile has a Web UI at all.
 *
 * `webServer` belongs to the Web app layer. In a headless or SDK profile nobody
 * provides it and this simply never runs — which is correct: with no Web UI there
 * is no page to serve, and the tool itself does not depend on any of this.
 */
export function registerPanel(ctx: Context, config: ConfigShape): void {
  const scoped = ctx as Context & {
    inject?(keys: string[], callback: (inner: Context & { webServer?: WebServerLike }) => void): void
  }
  if (typeof scoped.inject !== 'function') return

  // The routes DSH serves, for the provider list. A profile with no model service simply
  // gets a list of presets, which is why the page treats the roster as possibly empty
  // rather than as an error.
  const llm = captureLlm(ctx)

  scoped.inject(['webServer'], (inner) => {
    const webServer = inner.webServer
    if (typeof webServer?.register !== 'function') return

    const token = randomUUID()
    const disposers: Array<() => void> = []

    // The inspector lives in its own corner of this route and shares this token: it is the same
    // trust boundary (a page allowed to spend this plugin's credentials), and one token is one
    // thing to reason about.
    const inspector = createInspector(ctx, config, llm)

    // The token reaches the page and nothing else: it is not a secret the user
    // has to manage, it exists for one boot and dies with it.
    //
    // It travels as a structured injection row instead of a `tapIndex` string
    // transform, because only rows reach every page a host serves: a served
    // index.html renders them, and the desktop shell — which never renders an
    // index server-side — hands the same rows to the page-side interpreter.
    // `tapIndex` runs on the served form only, which would leave the desktop
    // page with no token and every request on this route answered with 403.
    ;(inner as Context & IndexInjectionEvents).on('webserver/index-inject', (table) => {
      table.push({ kind: 'global', name: TOKEN_GLOBAL, value: token })
    })

    disposers.push(
      webServer.register({
        kind: 'prefix',
        path: ROUTE,
        handler: (req, res) => handle(req, res, ctx, config, token, llm, inspector),
      }),
    )

    ctx.effect(
      () => () => {
        for (const dispose of disposers) dispose()
      },
      'dsh-jev-ultrafast: settings page route',
    )
  })
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: Context,
  config: ConfigShape,
  token: string,
  llm: ReturnType<typeof captureLlm>,
  inspector: Inspector,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  const offered = String(req.headers[TOKEN_HEADER] ?? url.searchParams.get('token') ?? '')
  const path = url.pathname.slice(ROUTE.length)

  // The inspector's corner, dispatched before the token check: the page document itself is the
  // one thing served without a token, because a page cannot carry one it has not been given.
  if (path === '/inspector' || path.startsWith('/inspector/')) {
    await inspector.handle(path.slice('/inspector'.length), req, res, token, offered)
    return
  }

  if (offered !== token) {
    send(res, 403, { error: '这个请求没有带对令牌。请从 DSH 的设置页打开本插件页面。' })
    return
  }

  try {
    if (path === '/status') {
      // `?browser=skip` answers from everything but the browser probe, for the cheap
      // refreshes the page does after a save; opening a tab on every save would be noise.
      send(res, 200, await status(ctx, config, url.searchParams.get('browser') !== 'skip', llm))
      return
    }
    if (path === '/credential') {
      if (req.method !== 'POST') {
        send(res, 405, { error: '这个接口只接受 POST。' })
        return
      }
      const body = await readJson(req)
      const name = typeof body.name === 'string' ? body.name.trim() : ''
      const allowed = storableNames(routeOf(config).keyRef, textRouteOf(config).keyRef)
      if (!allowed.some((entry) => entry.name === name)) {
        send(res, 403, {
          error: `这一页只给它正在用的名字存值，「${name}」不在其中。想用它，先在「配置」里把相应的密钥名改成它并保存。`,
        })
        return
      }
      await changeKey(
        ctx,
        name,
        body.clear === true
          ? { kind: 'clear' }
          : { kind: 'store', value: typeof body.value === 'string' ? body.value : '' },
        credentialsFile(),
      )
      // The page updates its rows from this: one answer, no second round trip.
      send(res, 200, { ok: true, keys: await keyStates(ctx, config) })
      return
    }
    if (path === '/test-decision') {
      if (req.method !== 'POST') {
        send(res, 405, { error: '这个接口只接受 POST。' })
        return
      }
      send(res, 200, await testDecision(ctx, config))
      return
    }
    if (path === '/launch-browser') {
      if (req.method !== 'POST') {
        send(res, 405, { error: '这个接口只接受 POST。' })
        return
      }
      const body = await readJson(req)
      // What the reader has chosen in the dropdown, which may not be saved yet; the saved
      // setting is the fallback for a caller that sends nothing.
      const kind = body.kind === 'edge' || body.kind === 'chrome' ? body.kind : config.browserKind.get()
      const launched = await launchBrowser(kind, { exeOverride: config.browserPath.get() || undefined })
      const report: LaunchReport = { ...launched, browser: await browserReport(config) }
      send(res, 200, report)
      return
    }
    if (path === '/text-models') {
      // The page sends what its own boxes currently hold, which may not be saved yet: asking the
      // saved address just after someone typed a new one would read as a bug. Anything missing
      // falls back to the saved value inside `resolveTextRoute`.
      const route = resolveTextRoute({
        provider: url.searchParams.get('provider') ?? undefined,
        baseUrl: url.searchParams.get('baseUrl') ?? undefined,
        keyRef: url.searchParams.get('keyRef') ?? undefined,
        model: url.searchParams.get('model') ?? undefined,
      })
      send(res, 200, await textModelReport(ctx, llm, route))
      return
    }
    if (path === '/test-text') {
      if (req.method !== 'POST') {
        send(res, 405, { error: '这个接口只接受 POST。' })
        return
      }
      const body = await readJson(req)
      const drafted = (key: string): string | undefined => {
        const value = body[key]
        return typeof value === 'string' && value.trim() ? value.trim() : undefined
      }
      const reasoning = drafted('reasoning')
      // What the reader's boxes currently hold, falling back to what is saved: pressing the test
      // button before saving should test what they are looking at, not what they are leaving.
      send(
        res,
        200,
        await testText(ctx, llm, {
          textProvider: drafted('provider') ?? config.textProvider.get(),
          textBaseUrl: drafted('baseUrl') ?? config.textBaseUrl.get(),
          textModel: drafted('model') ?? config.textModel.get(),
          textKeyRef: drafted('keyRef') ?? config.textKeyRef.get(),
          textReasoning: reasoning === 'auto' || reasoning === 'none' ? reasoning : config.textReasoning.get(),
        }),
      )
      return
    }
    send(res, 404, { error: `没有这个接口：${path}` })
  } catch (error) {
    send(res, 500, { error: describe(error) })
  }
}

/**
 * Everything the page needs to show a state rather than a guess: whether a browser
 * can be reached, where each credential name stands, and which names may be written
 * from the page. Opening and closing one background tab is local and free, so the
 * browser half runs on page load.
 */
async function status(
  ctx: Context,
  config: ConfigShape,
  withBrowser: boolean,
  llm: ReturnType<typeof captureLlm>,
): Promise<StatusReport> {
  const route = routeOf(config)
  const textRoute = textRouteOf(config)
  const [browser, decisionKey, keys, providers] = await Promise.all([
    withBrowser ? browserReport(config) : Promise.resolve(undefined),
    describeKey(ctx, route.keyRef),
    keyStates(ctx, config),
    providerOptions(llm.get()),
  ])
  // A built-in route's key belongs to DSH, so the only honest thing this page can report
  // about it is whether DSH still serves that route at all.
  const textKey =
    textRoute.kind === 'dsh'
      ? { configured: providers.some((entry) => entry.id === textRoute.provider), writable: false }
      : await describeKey(ctx, textRoute.keyRef)
  return {
    ...(browser === undefined ? {} : { browser }),
    decision: {
      credential: route.keyRef,
      ...decisionKey,
      endpoint: route.endpoint,
      model: route.model,
      provider: route.provider,
      providerLabel: route.label,
    },
    text: {
      credential: textRoute.keyRef,
      ...textKey,
      model: textRoute.model,
      provider: textRoute.provider,
      providerLabel: textRoute.label,
      kind: textRoute.kind,
    },
    providers,
    keys,
  }
}

/** Every name the page may write, with the state the store reports for each. */
async function keyStates(ctx: Context, config: ConfigShape): Promise<StorableKey[]> {
  const names = storableNames(routeOf(config).keyRef, textRouteOf(config).keyRef)
  return Promise.all(names.map(async (entry) => ({ ...entry, state: await describeKey(ctx, entry.name) })))
}

/** What the settings add up to right now — the same resolution a run would do. */
function routeOf(config: ConfigShape): DecisionRoute {
  return resolveDecisionRoute({
    provider: config.decisionProvider.get(),
    endpoint: config.decisionEndpoint.get(),
    model: config.decisionModel.get(),
    keyRef: config.decisionKeyRef.get(),
  })
}

/** The text half of the same resolution: what a run would use for typed values. */
function textRouteOf(config: ConfigShape): TextRoute {
  return resolveTextRoute({
    provider: config.textProvider.get(),
    baseUrl: config.textBaseUrl.get(),
    model: config.textModel.get(),
    keyRef: config.textKeyRef.get(),
    reasoning: config.textReasoning.get(),
  })
}

/**
 * Where a credential name would be written.
 *
 * Named here, and not in the page, because only this half knows the machine: the
 * page can then tell the user the exact file instead of a `~` it cannot resolve.
 */
function credentialsFile(): string {
  const home = process.env.DSH_HOME?.trim()
  return join(home && home.length > 0 ? home : join(homedir(), '.dsh'), '.credentials.yaml')
}

async function browserReport(config: ConfigShape): Promise<BrowserReport> {
  const options = {
    cdpUrl: config.cdpUrl.get() || undefined,
    userDataDir: config.userDataDir.get() || undefined,
    preferredKind: config.browserKind.get(),
  }
  try {
    const endpoint = await discoverBrowser(options)
    const session = await BrowserSession.open('about:blank', options)
    try {
      // Observing the blank page is the cheap proof that the connection is not just
      // answering /json/version: it round-trips the snapshot script through a real
      // tab and one attached session.
      const page = await session.observe()
      return {
        ok: true,
        endpoint: endpoint.httpUrl,
        version: endpoint.browser,
        source: endpoint.source,
        title: page.title,
        elements: page.actions.length,
      }
    } finally {
      await session.close()
    }
  } catch (error) {
    return { ok: false, message: describe(error) }
  }
}

/**
 * One real decision call, against a throwaway two-element table.
 *
 * Nothing cheaper proves the same thing: an endpoint, a model name and a key are
 * only known to work together when a decision comes back validated. It is a button
 * rather than something the page does on its own because it spends the user's quota.
 */
async function testDecision(ctx: Context, config: ConfigShape): Promise<DecisionTestReport> {
  const route = routeOf(config)
  const apiKey = await resolveKey(ctx, route.keyRef, `决策服务（${route.label}）`)
  const space = actionSpace([
    { id: 'e1', kind: 'click', node: 1, label: '示例按钮：确认' },
    { id: 'e2', kind: 'fill', node: 2, label: '示例输入框：备注', value: '' },
  ])
  const decision = await choose(
    { endpoint: route.endpoint, model: route.model, apiKey, wrapFallback: route.wrapFallback },
    space,
    {
      goal: '在示例页面上点一下「确认」按钮。',
      page: {
        url: 'about:blank',
        title: '连通性测试页（不是真实网页）',
        text: '这是一个只用来测试连通性的假页面。',
      },
      history: [],
    },
  )
  return {
    ok: true,
    model: decision.model,
    choice: decision.choice,
    operation: decision.operation,
    latencyMs: decision.latencyMs,
  }
}

/**
 * Ask one text door what models it serves.
 *
 * A DSH route is not asked at all: its roster already comes from DSH with the status, and the
 * address and credential behind it are DSH's business rather than this plugin's. A preset is asked
 * over HTTP with the credential this plugin holds, so the key stays on this side of the wire — the
 * page only ever sees names. A failure comes back as a normal answer, because "no list could be
 * read" is something the reader has to see: it is also the plainest evidence that the key or the
 * address is wrong.
 */
async function textModelReport(
  ctx: Context,
  llm: ReturnType<typeof captureLlm>,
  route: TextRoute,
): Promise<TextModelReport> {
  if (route.kind === 'dsh') {
    // DSH owns that roster, but it is re-read here rather than echoed back: a button has to do real
    // work to deserve its feedback, and a roster can change under a host that keeps running.
    try {
      const models =
        (await providerOptions(llm.get())).find((entry) => entry.id === route.provider)?.models ?? []
      return models.length > 0
        ? { ok: true, models, note: `已问过 DSH，这条路现在有 ${models.length} 个模型。` }
        : {
            ok: false,
            models: [],
            note: 'DSH 没有报出这条路能用的模型清单；可以直接在「模型」那一栏里手填一个名字。',
          }
    } catch (error) {
      return { ok: false, models: [], note: `没能从 DSH 取回模型清单：${describe(error)}` }
    }
  }
  try {
    const apiKey = await resolveKey(ctx, route.keyRef, `文本模型（${route.label}）`)
    const models = await fetchModelList({ baseUrl: route.baseUrl, apiKey })
    return { ok: true, models, note: `已问过「${route.label}」，取回 ${models.length} 个模型。` }
  } catch (error) {
    return { ok: false, models: [], note: `没能取回模型清单：${describe(error)}` }
  }
}

/**
 * One real text call, against the smallest question this door can be asked.
 *
 * Nothing cheaper proves the same thing: an address, a model name and a key are only known to work
 * together when an answer comes back — and this asks for the same one-key JSON shape a real field
 * does, because what breaks in a run is a model that will not answer in JSON or one that thinks
 * until its budget is gone. It is a button rather than something the page does on its own, because
 * it spends the reader's quota.
 */
async function testText(
  ctx: Context,
  llm: ReturnType<typeof captureLlm>,
  settings: TextSettings,
): Promise<TextTestReport> {
  const route = resolveTextRoute({
    provider: settings.textProvider,
    baseUrl: settings.textBaseUrl,
    model: settings.textModel,
    keyRef: settings.textKeyRef,
    reasoning: settings.textReasoning,
  })
  const source = await resolveTextSource(ctx, llm, settings)
  const began = Date.now()
  const answer = await askText(source, TEXT_PROBE, '连通性测试：请按上面的要求回答。')
  const latencyMs = Date.now() - began
  const content = answer.content.trim()
  if (!probeOk(content)) {
    throw new Error(`文本模型回了话，但不是要求的那个 JSON：${content.slice(0, 80) || '（回的是空的）'}`)
  }
  return { ok: true, model: route.model, answer: '{"ok":true}', latencyMs }
}

/**
 * Whether one answer is the `{"ok":true}` the probe asked for.
 *
 * Read through the same tolerance the site resolver uses: a fenced or chatty answer is still an
 * answer, and refusing it would report a working door as broken.
 */
export function probeOk(content: string): boolean {
  const start = content.indexOf('{')
  const end = content.lastIndexOf('}')
  if (start < 0 || end <= start) return false
  try {
    const parsed = JSON.parse(content.slice(start, end + 1)) as { ok?: unknown }
    return parsed.ok === true || parsed.ok === 'true'
  } catch {
    return false
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
