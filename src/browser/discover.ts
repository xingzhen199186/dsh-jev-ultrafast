/**
 * Find a Chromium-based browser's DevTools endpoint.
 *
 * The order is deliberate: an explicit setting wins over the environment, which
 * wins over whatever the browser itself wrote to disk, which wins over the two
 * conventional debugging ports. Every candidate is resolved through the HTTP
 * `/json/version` endpoint, because that is what reports the browser's own
 * version string and the exact WebSocket URL to use.
 */
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

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

/** The browsers this plugin can start itself. */
export type BrowserKind = 'chrome' | 'edge'

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
}

/** Ports the conventional `--remote-debugging-port` recipes use. */
const CONVENTIONAL_PORTS = [9222, 9223]

/** Resolve the browser endpoint, or explain what to start. */
export async function discoverBrowser(options: DiscoverOptions = {}): Promise<BrowserEndpoint> {
  const seen = new Set<string>()
  const candidates: Array<{ httpUrl: string; source: string }> = []
  const rawWebSockets: Array<{ wsUrl: string; source: string }> = []

  const addCandidate = (httpUrl: string, source: string): void => {
    const normalized = httpUrl.replace(/\/+$/, '')
    if (seen.has(normalized)) return
    seen.add(normalized)
    candidates.push({ httpUrl: normalized, source })
  }

  if (options.cdpUrl) {
    const derived = asHttpUrl(options.cdpUrl)
    if (derived) addCandidate(derived, `配置里的 cdpUrl（${options.cdpUrl}）`)
    else if (options.cdpUrl.startsWith('ws')) rawWebSockets.push({ wsUrl: options.cdpUrl, source: '配置里的 cdpUrl' })
  }

  for (const name of ['BU_CDP_URL', 'BU_CDP_WS'] as const) {
    const value = process.env[name]?.trim()
    if (!value) continue
    const derived = asHttpUrl(value)
    if (derived) addCandidate(derived, `环境变量 ${name}`)
    else if (value.startsWith('ws')) rawWebSockets.push({ wsUrl: value, source: `环境变量 ${name}` })
  }

  for (const dir of userDataDirs(options.userDataDir, options.preferredKind)) {
    const active = await readActivePort(dir)
    if (active) addCandidate(`http://127.0.0.1:${active.port}`, `浏览器自己写下的 DevToolsActivePort（${dir}）`)
  }

  for (const port of CONVENTIONAL_PORTS) addCandidate(`http://127.0.0.1:${port}`, `常用的调试端口 ${port}`)

  for (const candidate of candidates) {
    const version = await readVersion(candidate.httpUrl)
    if (version?.webSocketDebuggerUrl) {
      return {
        wsUrl: version.webSocketDebuggerUrl,
        httpUrl: candidate.httpUrl,
        browser: version.Browser ?? '未知浏览器',
        source: candidate.source,
      }
    }
  }

  for (const raw of rawWebSockets) {
    return { wsUrl: raw.wsUrl, httpUrl: '', browser: '未知浏览器', source: raw.source }
  }

  throw new Error(
    '没有找到可用的浏览器调试端口。设置页里的「启动并连接」可以由插件自己启动一个 Chrome 或 Edge；' +
      '也可以自己先带调试端口启动一个，例如\n' +
      '  chrome.exe --remote-debugging-port=9222 --user-data-dir="C:\\chrome-cdp"\n' +
      '然后在插件设置页（设置 → Jev 浏览器）把「浏览器调试端口」填成 http://127.0.0.1:9222；' +
      '如果浏览器已经开着调试端口，请确认它没有把端口写在别的用户数据目录里。',
  )
}

/** Directories where a Chromium-based browser keeps `DevToolsActivePort`. */
function userDataDirs(explicit?: string, preferred?: BrowserKind): string[] {
  const dirs: string[] = []
  if (explicit) dirs.push(explicit)
  const home = homedir()
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local')
    dirs.push(
      join(local, 'Google', 'Chrome', 'User Data'),
      join(local, 'Microsoft', 'Edge', 'User Data'),
      join(local, 'Chromium', 'User Data'),
      join(local, 'BraveSoftware', 'Brave-Browser', 'User Data'),
    )
  } else if (process.platform === 'darwin') {
    const support = join(home, 'Library', 'Application Support')
    dirs.push(
      join(support, 'Google', 'Chrome'),
      join(support, 'Microsoft Edge'),
      join(support, 'Chromium'),
      join(support, 'BraveSoftware', 'Brave-Browser'),
    )
  } else {
    const config = process.env.XDG_CONFIG_HOME ?? join(home, '.config')
    dirs.push(
      join(config, 'google-chrome'),
      join(config, 'microsoft-edge'),
      join(config, 'chromium'),
      join(config, 'BraveSoftware', 'Brave-Browser'),
    )
  }
  // The browsers this plugin started itself, from the settings page's own button. They
  // may have been given a free port rather than a conventional one, and the profile
  // directory is the only place that port is written down — so looking here is what lets
  // a later run (or a restarted host) find them again without any configuration.
  dirs.push(...pluginProfileDirs(preferred))
  return dirs
}

/**
 * Where this plugin keeps the browsers it started itself: one profile per browser, under
 * the harness home.
 *
 * Deliberately not the user's own profile directory. Chrome and Edge refuse a debugging
 * port on the default profile since version 136, and pointing a launched browser at the
 * daily profile would either fail or take over the tabs the user is working in.
 */
export function pluginProfileDir(kind: BrowserKind): string {
  const home = process.env.DSH_HOME?.trim()
  return join(home && home.length > 0 ? home : join(homedir(), '.dsh'), 'jev-ultrafast', 'browser', kind)
}

/** The same directories as a candidate list, with the chosen browser first. */
export function pluginProfileDirs(preferred?: BrowserKind): string[] {
  const kinds: BrowserKind[] = preferred === 'edge' ? ['edge', 'chrome'] : ['chrome', 'edge']
  return kinds.map((kind) => pluginProfileDir(kind))
}

/** Read the port and WebSocket path a browser wrote next to its profile. */
export function parseActivePort(text: string): number | null {
  const [portLine] = text.split('\n')
  const port = Number.parseInt(portLine ?? '', 10)
  return Number.isInteger(port) && port > 0 && port < 65_536 ? port : null
}

export async function readActivePort(dir: string): Promise<{ port: number } | null> {
  try {
    const port = parseActivePort(await readFile(join(dir, 'DevToolsActivePort'), 'utf8'))
    return port === null ? null : { port }
  } catch {
    return null
  }
}

interface VersionInfo {
  Browser?: string
  webSocketDebuggerUrl?: string
}

/** Ask an endpoint for its identity; a silent endpoint simply is not a candidate. */
async function readVersion(httpUrl: string, timeoutMs = 2_000): Promise<VersionInfo | null> {
  try {
    const response = await fetch(`${httpUrl}/json/version`, { signal: AbortSignal.timeout(timeoutMs) })
    if (!response.ok) return null
    return (await response.json()) as VersionInfo
  } catch {
    return null
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
