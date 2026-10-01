/**
 * Find a Chromium-based browser's DevTools endpoint.
 *
 * Two browsers can be reached, and everything past this file is the same either way: the one
 * this plugin started itself, and the one the reader is already using. Which of the two a run
 * may drive is the 「连接方式」 setting, decided here — see `discoverBrowser`.
 *
 * Within a route the order is deliberate: an explicit setting wins over the environment, which
 * wins over whatever the browser itself wrote to disk, which wins over the two conventional
 * debugging ports. Every candidate is resolved through the HTTP `/json/version` endpoint,
 * because that is what reports the browser's own version string and the exact WebSocket URL to
 * use — except on Chrome/Edge 147+, where a default profile answers 404 there and the two lines
 * the browser wrote next to its profile are the endpoint instead (see `wsUrlFromActivePort`).
 */
import { readFile } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { inspectPageUrl } from '../protocol'

/** One working browser DevTools endpoint, plus where it came from. */
export interface BrowserEndpoint {
  /** WebSocket URL of the browser-level DevTools endpoint. */
  wsUrl: string
  /** HTTP base URL of the same endpoint. */
  httpUrl: string
  /** Version string the endpoint reported, for example `Chrome/140.0.7339.128`. */
  browser: string
  /** Human-readable provenance, shown in diagnostics. */
  source: string
}

/** The browsers this plugin can start itself, and the ones it can attach to. */
export type BrowserKind = 'chrome' | 'edge'

/** Which browser a run may drive. See `Config.browserConnection`. */
export type BrowserConnection = 'plugin' | 'daily'

/** The two routes, in the order the settings page offers them. */
export const BROWSER_CONNECTIONS: readonly BrowserConnection[] = ['daily', 'plugin']

/** The browsers, in the order the settings page offers them. */
export const BROWSER_KINDS: readonly BrowserKind[] = ['edge', 'chrome']

/** The name each browser is called on the page. */
export const BROWSER_LABELS: Record<BrowserKind, string> = { chrome: 'Chrome', edge: 'Edge' }

export interface DiscoverOptions {
  /** Explicit endpoint from plugin config: an `http(s)://host:port` or `ws(s)://` URL. */
  cdpUrl?: string
  /** Explicit browser user-data directory, for a browser started with `--user-data-dir`. */
  userDataDir?: string
  /**
   * The browser the reader chose on the settings page.
   *
   * Both may be running at once — one press of 「启动并连接」 each — so the order of these
   * two candidates is the only thing that decides which one a task drives. Without it, a
   * task would drive whichever was launched first, whatever the page says.
   */
  preferredKind?: BrowserKind
  /**
   * Which browser this endpoint may be: the plugin's own, or the reader's daily one.
   *
   * Absent means the plugin's own, which is what every caller written before the setting
   * meant. On `daily` nothing is ever started, closed or written — see `discoverDailyBrowser`.
   */
  connection?: BrowserConnection
}

/** Ports the conventional `--remote-debugging-port` recipes use. */
const CONVENTIONAL_PORTS = [9222, 9223]

/** Resolve the browser endpoint, or explain what to start. */
export async function discoverBrowser(options: DiscoverOptions = {}): Promise<BrowserEndpoint> {
  const explicit = await discoverExplicit(options)
  if (explicit !== null) return explicit

  if (options.connection === 'daily') {
    return discoverDailyBrowser(options.preferredKind ?? 'edge', {
      profileDir: options.userDataDir?.trim() || undefined,
    })
  }
  return discoverOwnBrowser(options)
}

/**
 * An endpoint the reader named, or one the environment named.
 *
 * Upstream's own order, kept: a WebSocket address is an instruction and is used as it stands,
 * while an HTTP address is resolved through `/json/version` like every other candidate.
 */
async function discoverExplicit(options: DiscoverOptions): Promise<BrowserEndpoint | null> {
  const named: Array<{ httpUrl: string; source: string }> = []
  const sockets: Array<{ wsUrl: string; source: string }> = []
  const add = (value: string, source: string): void => {
    const trimmed = value.trim()
    if (trimmed.startsWith('ws://') || trimmed.startsWith('wss://')) {
      sockets.push({ wsUrl: trimmed, source })
      return
    }
    const derived = asHttpUrl(trimmed)
    if (derived) named.push({ httpUrl: derived.replace(/\/+$/, ''), source })
  }

  if (options.cdpUrl) add(options.cdpUrl, `配置里的 cdpUrl（${options.cdpUrl}）`)
  for (const name of ['BU_CDP_WS', 'BU_CDP_URL'] as const) {
    const value = process.env[name]?.trim()
    if (value) add(value, `环境变量 ${name}`)
  }

  for (const candidate of named) {
    const answer = await askVersion(candidate.httpUrl)
    const wsUrl = answer.info?.webSocketDebuggerUrl
    if (wsUrl) {
      return {
        wsUrl,
        httpUrl: candidate.httpUrl,
        browser: answer.info?.Browser ?? '未知浏览器',
        source: candidate.source,
      }
    }
  }

  for (const socket of sockets) {
    return { wsUrl: socket.wsUrl, httpUrl: '', browser: '未知浏览器', source: socket.source }
  }
  return null
}

/**
 * The browser this plugin started, found by whatever it left on disk.
 *
 * Only the plugin's own profile directories are read here. The reader's daily browser has its
 * own route — `discoverDailyBrowser` — and reading its profile from this one would let a run
 * labelled 「插件自己的浏览器」 quietly drive the browser the reader is working in.
 */
async function discoverOwnBrowser(options: DiscoverOptions): Promise<BrowserEndpoint> {
  const seen = new Set<string>()
  const candidates: Array<{ httpUrl: string; source: string; fallbackWs?: string }> = []

  const addCandidate = (httpUrl: string, source: string, fallbackWs?: string): void => {
    const normalized = httpUrl.replace(/\/+$/, '')
    if (seen.has(normalized)) return
    seen.add(normalized)
    candidates.push(fallbackWs === undefined ? { httpUrl: normalized, source } : { httpUrl: normalized, source, fallbackWs })
  }

  for (const dir of pluginUserDataDirs(options.userDataDir, options.preferredKind)) {
    const active = await readActivePort(dir)
    if (!active) continue
    addCandidate(
      `http://127.0.0.1:${active.port}`,
      `浏览器自己写下的 DevToolsActivePort（${dir}）`,
      wsUrlFromActivePort(active) ?? undefined,
    )
  }

  for (const port of CONVENTIONAL_PORTS) addCandidate(`http://127.0.0.1:${port}`, `常用的调试端口 ${port}`)

  for (const candidate of candidates) {
    const answer = await askVersion(candidate.httpUrl)
    const wsUrl = answer.info?.webSocketDebuggerUrl
    if (wsUrl) {
      return {
        wsUrl,
        httpUrl: candidate.httpUrl,
        browser: answer.info?.Browser ?? '未知浏览器',
        source: candidate.source,
      }
    }
    // 147+ answers 404 for `/json/*` on a default profile, and only a candidate that came
    // from a `DevToolsActivePort` file has the second line to fall back to.
    if (answer.status === 404 && candidate.fallbackWs !== undefined) {
      return {
        wsUrl: candidate.fallbackWs,
        httpUrl: candidate.httpUrl,
        browser: '版本未知',
        source: candidate.source,
      }
    }
  }

  throw new Error(unreachableMessage())
}

/** What to say when neither route produced a browser this plugin could have started itself. */
function unreachableMessage(): string {
  return (
    '没有找到可连的浏览器。设置页「浏览器」那一块里：选「插件自己的浏览器」时，按一次「启动并连接」，插件会自己起一个；' +
    '选「你正在用的浏览器」时，要先在那个浏览器里打开 chrome://inspect/#remote-debugging 勾上「允许远程调试」。' +
    '也可以在「高级设置」里填一个自己起的调试端口。'
  )
}

/**
 * Where the plugin's own browsers keep their profiles, with the chosen one first.
 *
 * `explicit` is the 数据目录 setting, for a browser that was started with `--user-data-dir`.
 */
export function pluginUserDataDirs(explicit?: string, preferred?: BrowserKind): string[] {
  const dirs: string[] = []
  const custom = explicit?.trim()
  if (custom) dirs.push(custom)
  dirs.push(...pluginProfileDirs(preferred))
  return dirs
}

/**
 * The profile this plugin gives a browser it starts itself.
 *
 * One per browser, under this plugin's own root, so a login made here survives a restart and
 * never touches the reader's own profile.
 */
export function pluginProfileDir(kind: BrowserKind): string {
  const home = process.env.DSH_HOME
  return join(home && home.length > 0 ? home : join(homedir(), '.dsh'), 'jev-ultrafast', 'browser', kind)
}

/** The same directories as a candidate list, with the chosen browser first. */
export function pluginProfileDirs(preferred?: BrowserKind): string[] {
  const kinds: BrowserKind[] = preferred === 'chrome' ? ['chrome', 'edge'] : ['edge', 'chrome']
  return kinds.map((kind) => pluginProfileDir(kind))
}

/** What `DevToolsActivePort` holds: the port on the first line, the WebSocket path on the second. */
export interface ActivePort {
  port: number
  /** `/devtools/browser/<uuid>`, or empty when the file has only the port line. */
  path: string
}

/**
 * Read a `DevToolsActivePort` file's two lines.
 *
 * They are one endpoint, not two facts: the port it answers on and the path the WebSocket lives
 * at. Both are needed on Chrome/Edge 147+, where `/json/version` refuses to answer for a default
 * profile and this file is the only place the socket address was written down.
 */
export function parseDevToolsActivePort(text: string): ActivePort | null {
  const [portLine = '', pathLine = ''] = text.split('\n')
  const port = Number.parseInt(portLine.trim(), 10)
  // 0 is the value that *asks* for a port rather than reporting one, so a profile claiming 0
  // means the browser never wrote a real one; anything out of range or unparsable is the same
  // kind of nothing.
  if (!Number.isInteger(port) || port <= 0 || port >= 65_536) return null
  const path = pathLine.trim()
  return { port, path: path.startsWith('/') ? path : '' }
}

/** The port alone, for callers that only need to ask it something. */
export function parseActivePort(text: string): number | null {
  return parseDevToolsActivePort(text)?.port ?? null
}

/** The port and the socket path a browser wrote next to its profile, or null for no usable file. */
export async function readActivePort(dir: string): Promise<ActivePort | null> {
  try {
    return parseDevToolsActivePort(await readFile(join(dir, 'DevToolsActivePort'), 'utf8'))
  } catch {
    return null
  }
}

/**
 * The WebSocket address the two lines spell out: `ws://127.0.0.1:<port><path>`.
 *
 * Null when the file carries no path, because a socket address without one is not an address.
 */
export function wsUrlFromActivePort(active: ActivePort): string | null {
  return active.path.startsWith('/') ? `ws://127.0.0.1:${active.port}${active.path}` : null
}

/** Which of the four things is wrong when the reader's own browser cannot be reached. */
export type DailyBrowserProblem = 'switch-off' | 'no-port' | 'not-running' | 'not-authorized'

/**
 * The reader's own browser could not be reached, and which of the four things is wrong.
 *
 * Four, because they are fixed in four different places, and one sentence for all of them would
 * send the reader to check something that is not the problem. See `dailyFailure` for the wording.
 */
export class DailyBrowserError extends Error {
  readonly problem: DailyBrowserProblem

  constructor(problem: DailyBrowserProblem, message: string) {
    super(message)
    this.name = 'DailyBrowserError'
    this.problem = problem
  }
}

/** What the daily route reads off this machine; injectable, because a test must not touch the real one. */
export interface DailyBrowserOptions {
  /** The profile root to read. Defaults to the one `dailyProfileDir` names. */
  profileDir?: string
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  home?: string
}

/**
 * The browser the reader is already using, over the debugging port it opened itself.
 *
 * Nothing here starts, closes or writes anything: the whole point of this route is that the
 * window, and every login in it, is already the reader's own. The switch that opens the port
 * lives in the browser (`chrome://inspect/#remote-debugging`), is recorded in the profile's
 * `Local State` as `devtools.remote_debugging.user-enabled`, and the port it opens is written —
 * with the WebSocket path — into `DevToolsActivePort` next to the profile.
 *
 * Waiting is deliberate. Chrome/Edge 144+ ask permission on every connection, and that box stays
 * on screen only while the connection that raised it is alive, so there is no approval deadline
 * here and no retry: see `CdpConnection.connect` and the sentence the settings page shows.
 */
export async function discoverDailyBrowser(
  kind: BrowserKind,
  options: DailyBrowserOptions = {},
): Promise<BrowserEndpoint> {
  const dir = options.profileDir ?? dailyProfileDir(kind, options)

  // The browser's own record of the switch. A profile that records nothing counts as off:
  // without the switch the browser writes no port, so there is nothing here to connect to.
  if ((await remoteDebuggingEnabled(dir)) !== true) throw dailyFailure(kind, 'switch-off')

  const active = await readActivePort(dir)
  if (active === null) throw dailyFailure(kind, 'no-port')

  // A file a closed browser left behind is not an instance: the port itself has to answer, or
  // the next step would be waiting on a permission box that cannot exist.
  if (!(await isPortListening(active.port))) throw dailyFailure(kind, 'not-running')

  const httpUrl = `http://127.0.0.1:${active.port}`
  const source = `你正在用的 ${BROWSER_LABELS[kind]}（${dir}）`
  const answer = await askVersion(httpUrl)
  const wsUrl = answer.info?.webSocketDebuggerUrl
  if (wsUrl) {
    return { wsUrl, httpUrl, browser: answer.info?.Browser ?? '版本未知', source }
  }

  // 147+ answers 404 for `/json/*` on a default profile. Both halves of the endpoint are in the
  // file the browser wrote, so the second line is what the HTTP door withheld — not a reason to
  // give up.
  if (answer.status === 404) {
    const fromFile = wsUrlFromActivePort(active)
    if (fromFile !== null) return { wsUrl: fromFile, httpUrl, browser: '版本未知', source }
    throw dailyFailure(kind, 'no-port')
  }

  // 403 is what an unaccepted 「允许远程调试？」 box answers, and a dropped request is the same
  // story told less clearly. Either way the next move is a click in the reader's browser, not
  // another attempt from here.
  throw dailyFailure(kind, 'not-authorized')
}

/**
 * Where the reader's own browser keeps its profile.
 *
 * The same three platforms the launcher knows, and only the chosen browser of each: the reader
 * picked Chrome or Edge on the page, and reading the other one's profile would report the wrong
 * browser's switch and the wrong browser's port.
 */
export function dailyProfileDir(kind: BrowserKind, options: DailyBrowserOptions = {}): string {
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  const home = options.home ?? homedir()
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA ?? join(home, 'AppData', 'Local')
    return kind === 'edge'
      ? join(local, 'Microsoft', 'Edge', 'User Data')
      : join(local, 'Google', 'Chrome', 'User Data')
  }
  if (platform === 'darwin') {
    const base = join(home, 'Library', 'Application Support')
    return kind === 'edge' ? join(base, 'Microsoft Edge') : join(base, 'Google', 'Chrome')
  }
  const config = env.XDG_CONFIG_HOME ?? join(home, '.config')
  return join(config, kind === 'edge' ? 'microsoft-edge' : 'google-chrome')
}

/** The browser's own record of 「允许远程调试」; null when this profile records no answer. */
export async function remoteDebuggingEnabled(dir: string): Promise<boolean | null> {
  try {
    const state = JSON.parse(await readFile(join(dir, 'Local State'), 'utf8')) as {
      devtools?: { remote_debugging?: { 'user-enabled'?: unknown } }
    }
    const enabled = state.devtools?.remote_debugging?.['user-enabled']
    return typeof enabled === 'boolean' ? enabled : null
  } catch {
    return null
  }
}

/** The one sentence that sends the reader to the place this failure is fixed in. */
function dailyFailure(kind: BrowserKind, problem: DailyBrowserProblem): DailyBrowserError {
  const label = BROWSER_LABELS[kind]
  const page = inspectPageUrl(kind)
  const messages: Record<DailyBrowserProblem, string> = {
    'switch-off':
      `你正在用的 ${label} 还没打开远程调试。在它的地址栏里打开 ${page}，勾上「允许远程调试」，再回到这里重新检查。`,
    'no-port':
      `没找到 ${label} 写下的调试端口。确认 ${label} 正开着，并且在 ${page} 里勾上了「允许远程调试」——` +
      '那个勾打开之后，它才会把这个端口写出来。',
    'not-running':
      `端口文件还在，但已经没人监听：${label} 现在没开着（或刚关过，这是上一次留下的）。把 ${label} 打开，再重新检查。`,
    'not-authorized':
      `${label} 在，端口也在，但这次连接没被允许：它弹了一个「允许远程调试？」的框，需要在上面点「允许」。` +
      '这个框每次连接都会出现，插件不会替你点，会一直等在那里。',
  }
  return new DailyBrowserError(problem, messages[problem])
}

/** Whether something is listening on a loopback port right now. */
async function isPortListening(port: number, timeoutMs = 500): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port })
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.on('error', () => {
      socket.destroy()
      resolve(false)
    })
    socket.on('timeout', () => {
      socket.destroy()
      resolve(false)
    })
  })
}

interface VersionInfo {
  Browser?: string
  webSocketDebuggerUrl?: string
}

/** What one ask of `/json/version` came back with: its body, its status, or nothing at all. */
interface VersionAnswer {
  info: VersionInfo | null
  /** HTTP status, or 0 when nothing answered. */
  status: number
}

/** Ask an endpoint for its identity; a silent endpoint is not a candidate. */
async function askVersion(httpUrl: string, timeoutMs = 2_000): Promise<VersionAnswer> {
  try {
    const response = await fetch(`${httpUrl}/json/version`, { signal: AbortSignal.timeout(timeoutMs) })
    if (!response.ok) return { info: null, status: response.status }
    return { info: (await response.json()) as VersionInfo, status: response.status }
  } catch {
    return { info: null, status: 0 }
  }
}

/** Turn a `ws://host:port/path` URL into the `http://host:port` endpoint behind it. */
function asHttpUrl(value: string): string | null {
  const trimmed = value.trim()
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) return trimmed
  if (trimmed.startsWith('ws://')) return `http://${trimmed.slice('ws://'.length).split('/')[0]}`
  if (trimmed.startsWith('wss://')) return `https://${trimmed.slice('wss://'.length).split('/')[0]}`
  if (/^\d+$/.test(trimmed)) return `http://127.0.0.1:${trimmed}`
  return null
}
