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
import { lastAttached } from './browser/attached'
import {
  BROWSER_LABELS,
  DailyBrowserError,
  dailyFailure,
  discoverDailyBrowser,
  localBrowserStatus,
} from './browser/discover'
import { heldStatus, reconnectConnection } from './browser/held'
import { launchBrowser } from './browser/launch'
import { CopyTargetError, copyDailyLoginsIntoPluginBrowser } from './browser/login-copy'
import { probeDailyLogins } from './browser/login-probe'
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
  ConnectReport,
  DecisionTestReport,
  LaunchReport,
  LoginCopyReport,
  LoginProbeReport,
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
    if (path === '/connect-browser') {
      if (req.method !== 'POST') {
        send(res, 405, { error: '这个接口只接受 POST。' })
        return
      }
      // The mirror image of the refusal below: this button is about the reader's own browser, and it
      // is the only thing in the plugin that may open a connection to it. On the plugin's own route
      // there is nothing to connect to until 「启动并连接」 has started a browser, so it is refused
      // there rather than left looking like a button that does nothing.
      if (config.browserConnection.get() !== 'daily') {
        send(res, 409, {
          error:
            '现在的「连接方式」是「插件自己的浏览器」：那一个由「启动并连接」负责启动和连接，不需要这个按钮。' +
            '要连你正在用的浏览器，先把「连接方式」改成「你正在用的浏览器」。',
        })
        return
      }
      send(res, 200, await connectDailyBrowser(config))
      return
    }
    if (path === '/launch-browser') {
      if (req.method !== 'POST') {
        send(res, 405, { error: '这个接口只接受 POST。' })
        return
      }
      // The reader's own browser is not this plugin's to start or close. Refusing here is what
      // keeps the page's button from becoming a press that quietly does nothing.
      if (config.browserConnection.get() === 'daily') {
        send(res, 409, {
          error:
            '现在的「连接方式」是「你正在用的浏览器」：插件不启动、也不关闭任何浏览器——那一个是你自己的。' +
            '要让插件自己起一个，先把「连接方式」改成「插件自己的浏览器」，再按这个按钮。',
        })
        return
      }
      const body = await readJson(req)
      // What the reader has chosen in the dropdown, which may not be saved yet; the saved
      // setting is the fallback for a caller that sends nothing.
      const kind = body.kind === 'edge' || body.kind === 'chrome' ? body.kind : config.browserKind.get()
      const launched = await launchBrowser(kind, { exeOverride: config.browserPath.get() || undefined })
      const report: LaunchReport = {
        ...launched,
        browser: await browserReport(config),
      }
      send(res, 200, report)
      return
    }
    if (path === '/login-probe') {
      // Read-only, and it stays that way: it counts what the reader's own browser is holding and
      // opens nothing. It is a GET because it changes nothing on either side.
      if (req.method !== 'GET') {
        send(res, 405, { error: '这个接口只接受 GET。' })
        return
      }
      send(res, 200, await loginProbe(config))
      return
    }
    if (path === '/login-copy') {
      // POST rather than GET because this one changes something: the plugin's own browser is written
      // to. The reader's own browser is only read — no tab in it, no write to its profile — and the
      // answer carries counts rather than cookies.
      if (req.method !== 'POST') {
        send(res, 405, { error: '这个接口只接受 POST。' })
        return
      }
      send(res, 200, await loginCopy(config))
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

/**
 * Where the browser stands, judged from this machine and never by connecting to it.
 *
 * The page asks this every time it opens, and a connection is what makes Chrome/Edge put
 * 「允许远程调试？」 on screen — so a status line that connected once per page load asked the reader
 * for permission every single time, and left a background tab in a browser this plugin does not
 * own. Everything here is a file read or a loopback check (`localBrowserStatus`), plus what the
 * holder remembers about the connection it is keeping (`heldStatus`, which is memory and nothing
 * else); the one piece of connected-after knowledge is `lastAttached`, noted by whoever really did
 * connect during this run.
 *
 * A launch reports through this too, for the same reason: after the plugin's own browser has been
 * started, what the page needs is its address, and the port file already says that.
 *
 * Exported because "this never connects" is a property worth a test of its own: a status line that
 * quietly connected again would put 「允许远程调试？」 back on screen every time the page opens.
 */
export async function browserReport(config: ConfigShape): Promise<BrowserReport> {
  const connection = config.browserConnection.get()
  const kind = config.browserKind.get()
  const local = await localBrowserStatus({
    cdpUrl: config.cdpUrl.get() || undefined,
    userDataDir: config.userDataDir.get() || undefined,
    preferredKind: kind,
    connection,
  })
  const attached = lastAttached(connection)
  const held = heldStatus(connection)
  // A state that names an address carries two sentences: where the browser is, and that this page
  // has not connected to it. The second is only true while nothing is held, so it — and only it —
  // is dropped once there is a connection, while the address sentence is kept because it is still
  // the right answer to "where is it?". A browser that is not even running keeps its whole
  // sentence: that one is the first thing to act on, whatever is held for it.
  const addressKnown = local.state === 'listening' || local.state === 'pinned'
  const localSaid =
    !addressKnown || held.state === 'idle'
      ? local.message
      : held.state === 'connected'
        ? firstSentence(local.message)
        : // A broken connection: the sentence that matters is the held one, which says what to press.
          ''
  const heldSaid =
    held.state === 'disconnected'
      ? dailyFailure(kind, 'disconnected').message
      : held.state === 'connected'
        ? HELD_SAID
        : ''
  return {
    ...local,
    connection,
    ...(attached === undefined ? {} : { attached }),
    held,
    // The state's own sentence first, then what is held, then — only when this host has really
    // connected on this route — the one line of connected-after information this report may carry.
    message:
      localSaid +
      heldSaid +
      (attached === undefined ? '' : `本次 DSH 启动以来连过一次：${attached.endpoint}（${ago(attached.at)}）。`),
  }
}

/** What the page says while a connection really is being held: the whole point of holding it. */
const HELD_SAID =
  '这条连接正握着，之后跑任务不会再弹「允许远程调试？」；宿主进程重启后才需要重新连。'

/**
 * The first sentence of a state line, which is the sentence that names the address.
 *
 * What follows it is about connecting — "this page has not connected to it, so nothing pops up" — and
 * once a connection is held that is the wrong story while the address is still the right answer.
 */
function firstSentence(text: string): string {
  const stop = text.indexOf('。')
  return stop === -1 ? text : text.slice(0, stop + 1)
}

/**
 * Open the reader's own browser because the reader pressed the button.
 *
 * This is the only place a connection to that browser is ever opened by asking, and the asking is
 * the point: Chrome/Edge 144+ put 「允许远程调试？」 on screen once per connection, so the connection
 * is opened once and kept (see ./browser/held.ts) rather than per task. Nothing else in the plugin
 * presses this button for the reader — not page load, not a task — which is what makes the box
 * appear at a moment the reader is looking.
 *
 * A page load does not do this, and must not start doing it: the state line is drawn from the files
 * on this machine, and connecting there would put the box on screen every time the page opened —
 * the exact regression this release fixes.
 */
async function connectDailyBrowser(config: ConfigShape): Promise<ConnectReport> {
  const kind = config.browserKind.get()
  try {
    // The address is read fresh rather than remembered: after a browser restart the port is a new
    // one, and reconnecting means going to wherever that browser now is.
    const endpoint = await discoverDailyBrowser(kind, { profileDir: config.userDataDir.get() || undefined })
    // `reconnectConnection` rather than `holdConnection`: this press is the reader's own decision to
    // try again, so a connection the holder remembers as broken is forgotten first instead of being
    // reported back at them.
    await reconnectConnection(endpoint.wsUrl, { route: 'daily', kind })
    return { ok: true, browser: await browserReport(config) }
  } catch (error) {
    if (error instanceof DailyBrowserError) {
      return { ok: false, browser: await browserReport(config), message: error.message }
    }
    throw error
  }
}

/** How long ago a connection happened, in words a reader can use. */
function ago(at: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000))
  if (seconds < 90) return '刚刚'
  const minutes = Math.round(seconds / 60)
  return minutes < 60 ? `${minutes} 分钟前` : `${Math.round(minutes / 60)} 小时前`
}

/**
 * Count the logins the reader's own browser could bring along, and touch nothing else.
 *
 * A read, not a copy: the browser is asked how many cookies it holds and which domains they belong
 * to, and no cookie value ever leaves it — the answer is four counts and a list of domain names, so
 * there is nothing in it worth writing down, and nothing here writes anything down. No tab is
 * opened either: see src/browser/login-probe.ts for why that is a property of the route rather than
 * a promise.
 *
 * The ways the reader's own browser cannot be reached come back as an answer rather than as an
 * error, because each one is a sentence about something to do in that browser — or, when the
 * connection this host was holding has gone away, about the button that opens it again. The page
 * shows it under the button that asked.
 */
async function loginProbe(config: ConfigShape): Promise<LoginProbeReport> {
  const kind = config.browserKind.get()
  const label = BROWSER_LABELS[kind]
  try {
    // 数据目录 is honoured here for the same reason the daily route honours it: a browser started
    // with `--user-data-dir` keeps its profile — and its `DevToolsActivePort` — somewhere else.
    const summary = await probeDailyLogins({ kind, profileDir: config.userDataDir.get() || undefined })
    return { ok: true, label, ...summary }
  } catch (error) {
    if (error instanceof DailyBrowserError) {
      return {
        ok: false,
        label,
        total: 0,
        sites: 0,
        sessionCookies: 0,
        bySite: [],
        message: error.message,
      }
    }
    throw error
  }
}

/**
 * Carry the logins of the reader's own browser into the browser this plugin started.
 *
 * The reader asked for every site and no filtering, so nothing here picks: what cannot be carried
 * is counted by reason, and what was meant to land is checked against what the plugin's browser
 * says it now holds — per domain, which is the finest thing the page may be told. No cookie's name
 * or value is in this answer, in a log, or in a trace.
 *
 * The four ways the reader's own browser cannot be reached come back as an answer rather than as an
 * error, in the same words the probe uses, because each one is a sentence about something to do in
 * that browser. A plugin browser that will not come up is a sentence too: the button says what
 * happened instead of the page showing a stack trace.
 */
async function loginCopy(config: ConfigShape): Promise<LoginCopyReport> {
  const kind = config.browserKind.get()
  const label = BROWSER_LABELS[kind]
  const nothing = {
    domains: { expected: 0, landed: 0 },
    cookiesLanded: 0,
    skipped: { expired: 0, partitioned: 0, noDomain: 0 },
    mismatched: [],
  }
  try {
    return {
      ok: true,
      label,
      ...(await copyDailyLoginsIntoPluginBrowser({
        kind,
        // 数据目录 is honoured for the source for the same reason the probe honours it: a browser
        // started with `--user-data-dir` keeps its profile, and its `DevToolsActivePort`, elsewhere.
        profileDir: config.userDataDir.get() || undefined,
        exeOverride: config.browserPath.get() || undefined,
      })),
    }
  } catch (error) {
    if (error instanceof DailyBrowserError || error instanceof CopyTargetError) {
      return { ok: false, label, ...nothing, message: error.message }
    }
    throw error
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
