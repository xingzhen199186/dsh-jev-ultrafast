/**
 * Start a browser for the user, so the settings page can offer one button instead of a
 * command line.
 *
 * Everything here is the deterministic half of that: which executable, which profile
 * directory, which port, and waiting until the port actually answers. No model takes part
 * — a model writes text, and this needs a process started on this machine — and none of
 * it is a guess the second time: the same machine gives the same answers.
 *
 * The port is requested as 0, which is not a typo. That tells the browser to pick a free
 * port and write it into `DevToolsActivePort` next to its profile, so a busy 9222 cannot
 * make this fail. That file is also what makes the launched browser findable again later,
 * including after this host restarts, without a port number ever being written into the
 * user's configuration.
 *
 * `ensureBrowser` below is the same act reached from the other door: a task that finds no
 * browser at all, rather than a reader pressing the button. The deciding is still this
 * file's — a model that asked for a task never gets to name an executable or a port.
 */
import { execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { promisify } from 'node:util'
import {
  BROWSER_LABELS,
  DailyBrowserError,
  discoverBrowser,
  pluginProfileDir,
  readActivePort,
  type BrowserEndpoint,
  type BrowserKind,
  type DiscoverOptions,
} from './discover'

// The browser union and the names it is called by live in ./discover, next to the two routes
// that have to name a browser in a sentence; they are re-exported here because this is where
// the settings page and its tests have always looked for them.
export type { BrowserConnection, BrowserKind } from './discover'
export { BROWSER_CONNECTIONS, BROWSER_KINDS, BROWSER_LABELS } from './discover'

/**
 * Where each browser usually installs itself, most likely first.
 *
 * Windows paths come first because this machine is Windows, but the other two platforms
 * are listed as well: a wrong-looking entry costs nothing, and a list that pretended to
 * be Windows-only would fail silently on a Mac or Linux host.
 */
export function browserExecutableCandidates(
  kind: BrowserKind,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const programFiles = env.ProgramFiles ?? 'C:\\Program Files'
  const programFilesX86 = env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'
  const local = env.LOCALAPPDATA ?? ''
  const windows =
    kind === 'chrome'
      ? [
          join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
          join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
          ...(local ? [join(local, 'Google', 'Chrome', 'Application', 'chrome.exe')] : []),
        ]
      : [
          join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
          join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
          ...(local ? [join(local, 'Microsoft', 'Edge', 'Application', 'msedge.exe')] : []),
        ]
  const other =
    kind === 'chrome'
      ? [
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
          '/usr/bin/google-chrome',
          '/usr/bin/chromium',
          '/snap/bin/chromium',
        ]
      : [
          '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
          '/usr/bin/microsoft-edge',
          '/usr/bin/microsoft-edge-stable',
        ]
  return [...windows, ...other]
}

/** The first candidate that really exists on disk; `exists` is injectable for tests. */
export function findBrowserExecutable(
  kind: BrowserKind,
  override?: string,
  exists: (path: string) => boolean = existsSync,
): string | null {
  const explicit = override?.trim()
  if (explicit) return exists(explicit) ? explicit : null
  return browserExecutableCandidates(kind).find((path) => exists(path)) ?? null
}

/**
 * Make the profile keep the logins it holds when the browser closes.
 *
 * Most logins are ordinary cookies with an expiry date and survive a close unharmed. Some are
 * session cookies — GitHub's is one — which a browser keeps only for the run that created them
 * unless it is set to reopen the last session. That setting lives in the profile's own
 * preferences, and a profile that has never been told otherwise does not have it. Without this
 * step a reader logs in once and finds themselves signed out the next time the window opens,
 * which is exactly the thing this is here to prevent.
 *
 * Called on every launch, before the browser opens, so it holds for a profile that already
 * exists as well as for one being made for the first time.
 */
export async function keepSessionCookies(profileDir: string): Promise<void> {
  const file = join(profileDir, 'Default', 'Preferences')
  let preferences: Record<string, unknown> = {}
  try {
    preferences = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>
  } catch {
    // Preferences that are missing or unreadable are not a reason to abandon the launch: this
    // only adds one setting, and everything else the browser keeps there is unaffected.
  }
  const session =
    typeof preferences.session === 'object' && preferences.session !== null
      ? (preferences.session as Record<string, unknown>)
      : {}
  session.restore_on_startup = 1
  preferences.session = session
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify(preferences))
}

export interface LaunchOptions {
  /** The 「浏览器程序」 setting, for a portable install that is not where we look. */
  exeOverride?: string
  /** How long to wait for the browser to report its port. */
  timeoutMs?: number
}

export interface LaunchedBrowser {
  kind: BrowserKind
  label: string
  /** The executable that was started, or a note when it was already running. */
  exe: string
  /** HTTP base URL the launched browser listens on. */
  endpoint: string
  /** The profile directory this plugin owns for that browser. */
  profileDir: string
  /** Where the endpoint came from, in the same wording the status line uses. */
  source: string
}

/**
 * Start the chosen browser with a debugging port, or return the one started earlier.
 *
 * Pressing the button twice is meant to be harmless: the second press finds the endpoint
 * the first one left in the profile directory instead of starting a second copy that would
 * fight over the same profile.
 */
export async function launchBrowser(
  kind: BrowserKind,
  options: LaunchOptions = {},
): Promise<LaunchedBrowser> {
  const label = BROWSER_LABELS[kind]
  // One profile per browser, under this plugin's own root: see `pluginProfileDir`, which is
  // also where a run looks for a browser that is already running.
  const profileDir = pluginProfileDir(kind)

  const running = await liveEndpoint(profileDir)
  if (running !== null) {
    return {
      kind,
      label,
      exe: '（之前启动的那个还开着）',
      endpoint: running,
      profileDir,
      source: `${label}：上一次启动的那个（${profileDir} 里的 DevToolsActivePort）`,
    }
  }

  const override = options.exeOverride?.trim()
  const exe = findBrowserExecutable(kind, override)
  if (exe === null) {
    throw new Error(
      override
        ? `「浏览器程序」填的是 ${override}，但这个文件不存在。请检查那个路径，或者把它清空、让插件自己去标准位置找。`
        : `没有找到 ${label} 的程序。找过这些位置：\n${browserExecutableCandidates(kind)
            .map((path) => `  ${path}`)
            .join('\n')}\n` +
            `装好之后按一次重试；便携版之类装在别处的，点开「高级设置」，把「浏览器程序」填成它的完整路径。`,
    )
  }

  await mkdir(profileDir, { recursive: true })
  // Best effort on purpose: a profile this cannot be written to is still one worth starting,
  // and a login the reader can make beats a window that never opened.
  await keepSessionCookies(profileDir).catch(() => {})
  const child = spawn(
    exe,
    [
      '--remote-debugging-port=0',
      `--user-data-dir=${profileDir}`,
      // Two first-run habits that would otherwise open windows the user did not ask for.
      '--no-first-run',
      '--no-default-browser-check',
    ],
    { detached: true, stdio: 'ignore' },
  )
  // Detached so the browser outlives this host: closing the harness should not close the
  // window the user is now working in.
  child.unref()
  let exited: number | null = null
  child.on('exit', (code) => {
    exited = code
  })

  const timeoutMs = options.timeoutMs ?? 30_000
  const endpoint = await waitForEndpoint(profileDir, timeoutMs, () => exited)
  if (endpoint === null) {
    throw new Error(
      exited !== null
        ? `${label} 没有新开窗口（进程启动后立刻退出，退出码 ${exited}）。多半是已经有一个 ${label} 正用着这个数据目录在跑——把那些窗口全部关掉，再按一次。`
        : `${label} 已经启动，但 ${Math.round(timeoutMs / 1000)} 秒内没有把调试端口报上来。它的窗口现在开着，可以正常使用；` +
          `如果设置页还是显示连不上，把那个窗口关掉再按一次「启动并连接」。`,
    )
  }
  return { kind, label, exe, endpoint, profileDir, source: `插件启动的 ${label}（${profileDir}）` }
}

/** What Windows calls each browser's process, for a machine where the executable was not found. */
const WINDOWS_IMAGE: Record<BrowserKind, string> = { chrome: 'chrome.exe', edge: 'msedge.exe' }

const runTasklist = promisify(execFile)

/**
 * Whether the chosen browser is already running on this machine.
 *
 * Windows only: `tasklist` is Windows' own process list, and this launcher is aimed at the machine
 * the reader is sitting at. Everywhere else — and on any failure of the command itself, including a
 * machine where it is not on `PATH` — the answer is "not running". That is the answer that opens a
 * window rather than refusing to: a wrong "no" costs one window with the plugin's own profile,
 * while a wrong "yes" would leave the reader with a sentence and no browser at all.
 *
 * The name asked about is the executable's own (`msedge.exe`), or the name Windows gives that
 * browser when the executable could not be found anywhere.
 */
export async function browserRunning(
  kind: BrowserKind,
  exe: string | null,
  platform: NodeJS.Platform = process.platform,
): Promise<boolean> {
  if (platform !== 'win32') return false
  const image = exe === null ? WINDOWS_IMAGE[kind] : basename(exe)
  try {
    const { stdout } = await runTasklist('tasklist', ['/FI', `IMAGENAME eq ${image}`, '/FO', 'CSV', '/NH'], {
      timeout: 5_000,
      windowsHide: true,
    })
    return stdout.toLowerCase().includes(image.toLowerCase())
  } catch {
    return false
  }
}

/**
 * Whether the chosen browser is up but cannot be reached for a reason that is fixed *inside* it.
 *
 * One of the daily route's failures is not about a missing port: the browser is up with its port
 * open and is waiting on a 「允许远程调试？」 box the reader has not clicked yet. Replacing that
 * answer with "close every window" would send them to the wrong place, so it is kept as it is.
 * `disconnected` is here for the same reason, though a discovery never produces it — only a
 * connection that was being held does.
 */
function answeredInTheBrowser(error: unknown): boolean {
  return (
    error instanceof DailyBrowserError && (error.problem === 'not-authorized' || error.problem === 'disconnected')
  )
}

/**
 * The sentence for a browser that is up without a debugging port: the only case where the daily
 * route refuses to start a second window.
 *
 * Both halves of the answer happen outside this page, and they lead to different browsers — the
 * first to one with the plugin's own profile, the second to the reader's own with its logins — so
 * both are named rather than one being chosen for them.
 */
function dailyRunningMessage(kind: BrowserKind): string {
  const label = BROWSER_LABELS[kind]
  return (
    `${label} 正开着，但它没有开调试端口（或者那个端口已经不是它现在用的了），插件连不上它。两条办法：把 ${label} 的窗口全部关掉，再跑一次` +
    `——插件会替你打开一个（用它自己那份数据目录，和你日常那个分开）；` +
    `或者用它自带的、带调试端口的那个快捷方式打开 ${label}，插件会去连它。`
  )
}

/** The sentence for an address that was found and no longer answers, on a route that may not replace it. */
function staleEndpointMessage(endpoint: BrowserEndpoint): string {
  const where = endpoint.httpUrl || endpoint.wsUrl
  return (
    `找到的调试地址 ${where}（${endpoint.source}）已经没有回应了——多半是那个浏览器已经关掉，或者它换了一个新的调试地址。` +
    '「调试端口」和「数据目录」是你明确填的，插件就按它去找，不会替你换成别的浏览器：把填的那些清空，' +
    '或者改成这个浏览器现在真正在用的地址，再跑一次。'
  )
}

export interface EnsureOptions extends DiscoverOptions {
  /** The 「浏览器程序」 setting, for a portable install that is not where we look. */
  exeOverride?: string
  /** How long to wait for a browser started here to report its port. */
  timeoutMs?: number
}

export interface EnsuredBrowser {
  /** What to connect to. */
  endpoint: BrowserEndpoint
  /** The browser this call started, or `null` when one was already reachable. */
  launched: LaunchedBrowser | null
}

/**
 * Injectable for tests: nothing in this file should ever really start a browser, ask a real socket
 * or run `tasklist` under vitest.
 */
export interface EnsureDeps {
  discover: (options: DiscoverOptions) => Promise<BrowserEndpoint>
  launch: (kind: BrowserKind, options: LaunchOptions) => Promise<LaunchedBrowser>
  /** Whether an endpoint that was discovered still answers. */
  endpointAlive: (endpoint: BrowserEndpoint) => Promise<boolean>
  /** Whether the chosen browser is already running on this machine. */
  browserRunning: (kind: BrowserKind, exe: string | null) => Promise<boolean>
}

const ENSURE_DEPS: EnsureDeps = {
  discover: discoverBrowser,
  launch: launchBrowser,
  endpointAlive,
  browserRunning,
}

/**
 * The browser a task will drive: the one already there, or one started because there was none.
 *
 * Four things it decides, in this order. An address that was found by discovery is asked once more
 * whether it still answers, because a recorded address outlives the browser that wrote it and a
 * step that starts there dies on its first move — a dead one counts as no browser at all and goes
 * back through the rest of this list. A pinned endpoint (`cdpUrl`) or a named profile directory
 * (`userDataDir`) is an instruction, not a hint: when one of those is set and unreachable, the
 * failure is reported as it is, because starting a different browser would be answering a question
 * nobody asked. On the 「你正在用的浏览器」 route a browser that is *not running* is started — the
 * reader left that setting on, and a closed browser is the thing they asked the plugin to open —
 * while one that *is* running is never replaced by a second window: its windows are the reader's,
 * and the failure says what to do there instead (see `dailyRunningMessage`). Everything else
 * starts the browser the settings page names: the same executable lookup, the same profile
 * directory, the same port-file trick, and the same idempotence — a second task finds the browser
 * the first one started instead of opening a second window.
 */
export async function ensureBrowser(
  options: EnsureOptions = {},
  deps: EnsureDeps = ENSURE_DEPS,
): Promise<EnsuredBrowser> {
  try {
    const endpoint = await deps.discover(options)
    if (await deps.endpointAlive(endpoint)) return { endpoint, launched: null }
    // A recorded address outlives the browser that wrote it. One that no longer answers is passed
    // on as "nothing was found" — never as an endpoint a step would die on at its first move.
    throw new Error(staleEndpointMessage(endpoint))
  } catch (error) {
    // A setting the reader typed is an instruction, not a hint, and this comes before the daily
    // route for the same reason: a pinned address or profile directory is not ours to replace.
    if (options.cdpUrl?.trim() || options.userDataDir?.trim()) throw error

    if (options.connection === 'daily') {
      const kind = options.preferredKind ?? 'edge'
      // The reader's own browser is not this plugin's to replace while it is up. Discovery failing
      // there means it holds no debugging port, or is waiting on a 「允许远程调试？」 box — and that
      // second failure has its own answer, inside that window, which is the sentence discovery wrote.
      if (answeredInTheBrowser(error)) throw error
      if (await deps.browserRunning(kind, findBrowserExecutable(kind, options.exeOverride))) {
        throw new Error(dailyRunningMessage(kind))
      }
    }
  }

  const launched = await deps.launch(options.preferredKind ?? 'edge', {
    exeOverride: options.exeOverride,
    timeoutMs: options.timeoutMs,
  })
  // Discovery again, against the endpoint that was just written to the profile
  // directory: this returns the same shape (socket URL, version, provenance) the
  // found-browser path returns, so the caller cannot tell the two apart by accident.
  // It is not asked whether it answers: the launcher waited for that endpoint itself,
  // and there is no second browser left to fall back to.
  return { endpoint: await deps.discover({ ...options, cdpUrl: launched.endpoint }), launched }
}

/**
 * Whether a discovered endpoint still answers, asked of its HTTP door.
 *
 * A recorded address outlives the browser that wrote it: the port file next to a profile keeps
 * naming a socket that was closed hours ago, and the port it names may by then belong to something
 * that is not a browser at all. A step that starts from such an address dies on its first move, so
 * an endpoint counts as alive only when it answers *as DevTools* — either `/json/version` with the
 * browser's own name, or `/json/list` with a target list. A service that merely holds the port and
 * says 404 to both is dead here, which is the point: a needless second window is a smaller loss
 * than a task that cannot take its first step.
 *
 * Exported for its own test: this is the question that decides whether the reported failure — a
 * remembered address that no longer works — reaches a step or the launcher instead.
 */
export async function endpointAlive(endpoint: BrowserEndpoint): Promise<boolean> {
  const httpUrl = httpBaseOf(endpoint)
  if (httpUrl === null) return true
  if ((await readVersion(httpUrl)) !== null) return true
  return await answersDevTools(httpUrl)
}

/** Does this base answer the other DevTools question — a target list rather than a version? */
async function answersDevTools(httpUrl: string, timeoutMs = 1_500): Promise<boolean> {
  try {
    const response = await fetch(`${httpUrl}/json/list`, { signal: AbortSignal.timeout(timeoutMs) })
    if (!response.ok) return false
    return Array.isArray((await response.json()) as unknown)
  } catch {
    return false
  }
}

/** The HTTP door behind an endpoint: its own base, or the one its socket address names. */
function httpBaseOf(endpoint: BrowserEndpoint): string | null {
  const httpUrl = endpoint.httpUrl.trim()
  if (httpUrl.length > 0) return httpUrl
  const socket = endpoint.wsUrl.trim()
  const scheme = socket.startsWith('wss://') ? 'https://' : socket.startsWith('ws://') ? 'http://' : null
  if (scheme === null) return null
  const host = socket.slice(socket.indexOf('//') + 2).split('/')[0] ?? ''
  return host.length > 0 ? `${scheme}${host}` : null
}

/** The loopback port an HTTP base names, or null for anything that is not one. */
function loopbackPort(httpUrl: string): number | null {
  const match = /^https?:\/\/(?:127\.0\.0\.1|localhost):(\d+)/.exec(httpUrl)
  return match === null ? null : Number.parseInt(match[1] ?? '', 10)
}

/** Is a live endpoint recorded in this profile directory? Reads the file, then asks it. */
async function liveEndpoint(profileDir: string): Promise<string | null> {
  const active = await readActivePort(profileDir)
  if (active === null) return null
  const endpoint = `http://127.0.0.1:${active.port}`
  return (await readVersion(endpoint)) === null ? null : endpoint
}

/** Poll the profile directory for the port, then the port for an answer. */
async function waitForEndpoint(
  profileDir: string,
  timeoutMs: number,
  exited: () => number | null,
): Promise<string | null> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const active = await readActivePort(profileDir)
    if (active !== null) {
      const endpoint = `http://127.0.0.1:${active.port}`
      if ((await readVersion(endpoint)) !== null) return endpoint
    }
    if (exited() !== null) return null
    await new Promise((resolve) => setTimeout(resolve, 400))
  }
  return null
}

/** Ask an endpoint for its identity; a silent endpoint is not up yet. */
async function readVersion(endpoint: string, timeoutMs = 1_500): Promise<string | null> {
  try {
    const response = await fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(timeoutMs) })
    if (!response.ok) return null
    const info = (await response.json()) as { Browser?: string }
    return info.Browser ?? '未知浏览器'
  } catch {
    return null
  }
}
