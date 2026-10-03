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
  dailyProfileDir,
  discoverBrowser,
  pluginProfileDir,
  readActivePort,
  remoteDebuggingEnabled,
  type BrowserEndpoint,
  type BrowserKind,
  type DiscoverOptions,
} from './discover'
import { inspectPageUrl } from '../protocol'

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
 * The browser this plugin started earlier, still up in its own profile directory — or null.
 *
 * Both doors ask this question: the launcher asks it to avoid starting a second copy over the
 * same profile, and the daily route asks it before refusing over a window, because a browser
 * of ours is not the reader's window — it already carries a debugging port, and driving it
 * opens nothing.
 */
async function runningOwnBrowser(kind: BrowserKind): Promise<LaunchedBrowser | null> {
  const label = BROWSER_LABELS[kind]
  const profileDir = pluginProfileDir(kind)
  const endpoint = await liveEndpoint(profileDir)
  if (endpoint === null) return null
  return {
    kind,
    label,
    exe: '（之前启动的那个还开着）',
    endpoint,
    profileDir,
    source: `${label}：上一次启动的那个（${profileDir} 里的 DevToolsActivePort）`,
  }
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

  const running = await runningOwnBrowser(kind)
  if (running !== null) return running

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

/**
 * The reader's own browser, started the way they would start it themselves.
 *
 * The ruling of 2026-10-03 removed the rule that this plugin must never start the everyday
 * profile: a task that finds no browser open now opens *theirs* first — their logins, their
 * windows, the browser they know — and only falls back to the plugin's own copy when theirs
 * cannot be driven. Two properties keep that safe. No argument is passed at all: Chrome/Edge
 * 136+ refuse a debug flag on the default profile, so the port has to come from the profile's
 * own 「允许远程调试」switch, which is checked first here — without the switch the browser would
 * open with nothing to connect to, and starting one is left to the fallback instead. And
 * nothing is written to the profile: the browser manages its own exactly as it does under a
 * double-click.
 *
 * Null is the answer "no debug port appeared" — switch off, executable missing, or a browser
 * slower than the deadline — which the caller reads as *start the plugin's own instead*. A
 * failure that is really a question for the reader never lands here: discovery is the one that
 * words a box, and the caller re-runs it for that sentence.
 */
export async function launchDailyBrowser(
  kind: BrowserKind,
  options: LaunchOptions = {},
): Promise<LaunchedBrowser | null> {
  const label = BROWSER_LABELS[kind]
  const profileDir = dailyProfileDir(kind)
  if ((await remoteDebuggingEnabled(profileDir)) !== true) return null
  const exe = findBrowserExecutable(kind, options.exeOverride?.trim())
  if (exe === null) return null
  spawn(exe, [], { detached: true, stdio: 'ignore' }).unref()
  const deadline = Date.now() + (options.timeoutMs ?? 30_000)
  const record = (endpoint: string): LaunchedBrowser => ({
    kind,
    label,
    exe,
    endpoint,
    profileDir,
    source: `你正在用的 ${label}（${profileDir} 里的 DevToolsActivePort）`,
  })
  for (;;) {
    try {
      const found = await discoverBrowser({ connection: 'daily', preferredKind: kind })
      return record(found.httpUrl)
    } catch (error) {
      // The switch is off in the profile this browser just started with: no port will ever come
      // from it, so stop rather than wait out the deadline — the fallback can have it now.
      if (error instanceof DailyBrowserError && error.problem === 'switch-off') return null
      // The box is up inside the window that now exists. Hand back what the port file says so the
      // connection waits on the click — waiting there is its own behaviour, and the note already
      // tells the reader to click 「允许」.
      if (error instanceof DailyBrowserError && error.problem === 'not-authorized') {
        const active = await readActivePort(profileDir)
        return active === null ? null : record(`http://127.0.0.1:${active.port}`)
      }
      if (Date.now() >= deadline) return null
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
  }
}

/** What Windows calls each browser's process, for a machine where the executable was not found. */
const WINDOWS_IMAGE: Record<BrowserKind, string> = { chrome: 'chrome.exe', edge: 'msedge.exe' }

const runShell = promisify(execFile)

/**
 * Whether a window that is not this plugin's own is showing on this machine.
 *
 * A window, not a process: closing Edge leaves a dozen of its processes alive in the background,
 * so asking "is msedge.exe running" answers yes on a machine where the reader closed everything —
 * and that wrong yes is the whole reason the daily route refused to start a browser of its own.
 * And a window of *ours* does not count either: the plugin's own browser is ours to drive, never
 * a reason to refuse or to open anything, so each windowed process's command line — the only
 * place `--user-data-dir` shows — is asked which profile it belongs to. Windows is asked through
 * PowerShell, which reports a main-window handle per process and the command line per PID: a
 * windowless process carries 0, including the hidden windows that `tasklist /V` reports as titles
 * (`OleMainThreadWndName`), so the check cannot be satisfied by a browser running in the tray.
 *
 * Windows only: this launcher is aimed at the machine the reader is sitting at. Everywhere else —
 * and on any failure of the command itself, including a machine where PowerShell is not on `PATH`
 * — the answer is "no window". That is the answer that opens a browser rather than refusing to:
 * a wrong "no" costs one window, while a wrong "yes" would leave the reader with a sentence and
 * no browser at all.
 *
 * The name asked about is the executable's own (`msedge.exe`), or the name Windows gives that
 * browser when the executable could not be found anywhere. PowerShell names processes without the
 * extension, so the query drops it; a quote in either the name or the profile path is doubled so
 * it stays inside its literal.
 */
export async function browserRunning(
  kind: BrowserKind,
  exe: string | null,
  platform: NodeJS.Platform = process.platform,
): Promise<boolean> {
  if (platform !== 'win32') return false
  const image = exe === null ? WINDOWS_IMAGE[kind] : basename(exe)
  const name = image.replace(/\.exe$/i, '').replace(/'/g, "''")
  const own = pluginProfileDir(kind).replace(/'/g, "''")
  try {
    const { stdout } = await runShell(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        `@(Get-Process -Name '${name}' -ErrorAction SilentlyContinue | ` +
          `Where-Object { $_.MainWindowHandle -ne 0 } | ` +
          `Where-Object { $c = (Get-CimInstance Win32_Process -Filter ('ProcessId=' + $_.Id) -ErrorAction SilentlyContinue).CommandLine; ` +
          `$null -ne $c -and ($c -notlike '*${own}*') }).Count`,
      ],
      { timeout: 5_000, windowsHide: true },
    )
    return Number.parseInt(stdout.trim(), 10) > 0
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
 * The sentence for a browser that is up without a working debugging port: the only case where the
 * daily route refuses to open anything.
 *
 * Both halves happen outside this page and lead to different outcomes — closing the windows hands
 * the next run to the launcher (the reader's own when its switch is on, the plugin's copy when it
 * is not), while the inspect page fixes the browser as it stands — so both are named rather than
 * one being chosen for them.
 */
function dailyRunningMessage(kind: BrowserKind): string {
  const label = BROWSER_LABELS[kind]
  const page = inspectPageUrl(kind)
  return (
    `${label} 正开着，但它没有开着调试端口（或者它记着的那个已经失效了），插件连不上它。两条办法：把 ${label} 的窗口全部关掉，再跑一次` +
    `——插件会替你打开一个能用的；` +
    `或者在 ${label} 里打开 ${page}，勾上「允许远程调试」，插件就能直接连上它。`
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
 * or shell out to PowerShell under vitest.
 */
export interface EnsureDeps {
  discover: (options: DiscoverOptions) => Promise<BrowserEndpoint>
  launch: (kind: BrowserKind, options: LaunchOptions) => Promise<LaunchedBrowser>
  /** Whether an endpoint that was discovered still answers. */
  endpointAlive: (endpoint: BrowserEndpoint) => Promise<boolean>
  /** Whether the chosen browser is already running on this machine. */
  browserRunning: (kind: BrowserKind, exe: string | null) => Promise<boolean>
  /** The browser this plugin started earlier, still up in its own profile — or null. */
  ownBrowser: (kind: BrowserKind) => Promise<LaunchedBrowser | null>
  /** The reader's own browser started for this run, or null when no debug port appeared. */
  launchDaily: (kind: BrowserKind, options: LaunchOptions) => Promise<LaunchedBrowser | null>
}

const ENSURE_DEPS: EnsureDeps = {
  discover: discoverBrowser,
  launch: launchBrowser,
  endpointAlive,
  browserRunning,
  ownBrowser: runningOwnBrowser,
  launchDaily: launchDailyBrowser,
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
 * nobody asked. On the 「你正在用的浏览器」 route a browser that is *not running* is opened the way
 * the reader opens it themselves — the ruling of 2026-10-03: no debug flag, the profile's own
 * 「允许远程调试」switch asked first, and the plugin's own copy only as the fallback for when that
 * port never comes (`launchDailyBrowser`) — while a window of theirs that discovery could not
 * speak to is never opened over: starting another would not hand it a port, so the failure says
 * what to do there instead (see `dailyRunningMessage`), except when a browser of this plugin's
 * own can serve, which already carries a debugging port and is connected to rather than refused
 * over (`runningOwnBrowser`; `browserRunning` does not count our own windows). Everything else
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
      const exe = findBrowserExecutable(kind, options.exeOverride)
      // A window of theirs that discovery could not speak to is never opened over: another window
      // would not hand it a port, so the failure says what to do instead. A browser of our own may
      // still serve — it is not the reader's window, and `browserRunning` does not count it.
      if (await deps.browserRunning(kind, exe)) {
        const own = await deps.ownBrowser(kind)
        if (own !== null) {
          return { endpoint: await deps.discover({ ...options, cdpUrl: own.endpoint }), launched: own }
        }
        throw new Error(dailyRunningMessage(kind))
      }
      // Nothing of theirs is on screen: open theirs first — the ruling of 2026-10-03 removed the
      // rule that this plugin must never start the everyday profile. The endpoint is not asked
      // whether it answers: the launch waited for the port itself, and a pending 「允许远程调试？」
      // is the connection's own wait, not a dead address.
      const daily = await deps.launchDaily(kind, {
        exeOverride: options.exeOverride,
        timeoutMs: options.timeoutMs,
      })
      if (daily !== null) {
        try {
          return { endpoint: await deps.discover(options), launched: daily }
        } catch (found) {
          // Only the box sentence is passed through — it is the reader's to act on. Anything else
          // is a browser that went away between the launch and this look; the fallback can have it.
          if (answeredInTheBrowser(found)) throw found
        }
      }
      // The plugin's own, already running: connect to it rather than open a second one of anything.
      const own = await deps.ownBrowser(kind)
      if (own !== null) {
        return { endpoint: await deps.discover({ ...options, cdpUrl: own.endpoint }), launched: own }
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
 * Whether a discovered endpoint still answers, asked of the doors it has.
 *
 * A recorded address outlives the browser that wrote it: the port file next to a profile keeps
 * naming a socket that was closed hours ago, and the port it names may by then belong to something
 * that is not a browser at all. A step that starts from such an address dies on its first move, so
 * an endpoint counts as alive only when it answers *as DevTools* — either `/json/version` with the
 * browser's own name, or `/json/list` with a target list, or — when both of those HTTP doors are
 * shut — by opening the socket door itself, which is the one a step enters by. A service that
 * merely holds the port and refuses all three is dead here, which is the point: a needless second
 * window is a smaller loss than a task that cannot take its first step.
 *
 * Exported for its own test: this is the question that decides whether the reported failure — a
 * remembered address that no longer works — reaches a step or the launcher instead.
 */
export async function endpointAlive(endpoint: BrowserEndpoint): Promise<boolean> {
  const httpUrl = httpBaseOf(endpoint)
  if (httpUrl === null) return true
  if ((await readVersion(httpUrl)) !== null) return true
  if (await answersDevTools(httpUrl)) return true
  return await answersWebSocket(endpoint.wsUrl)
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

/**
 * Does the debug socket itself accept a handshake — the door a step walks through first?
 *
 * Edge 147+ answers 404 to every `/json/*` path on the default profile (`discoverDailyBrowser`
 * leans on the port file's second line there), so HTTP silence is the normal state of a perfectly
 * usable daily browser. Measured on 2026-10-03: the default-profile Edge refused both HTTP
 * questions while accepting a WebSocket at the address its own file recorded.
 *
 * The third answer is silence, and what silence means depends on where it comes from. On this
 * machine, a handshake that is neither accepted nor refused is the browser *holding* it for its
 * 「允许远程调试？」 box — measured on 2026-10-03, window open, eight seconds without a word — and
 * that is a live browser waiting for the one click only the reader can make: the connection step
 * then holds the same question open until they do (its timeout is 0), which is the behaviour the
 * note promises. A grant binds to the connection it was clicked for, so an answer that arrives
 * after this probe's socket is gone counts for nothing — which is why the probe must not be the
 * one that gives up on a browser. Somewhere else, silence is a black hole, and a black hole is
 * not a browser: dead there. A squatter that actually speaks — an HTTP server saying 404 to the
 * upgrade — still fails fast, so nothing dead becomes alive on a port.
 */
async function answersWebSocket(wsUrl: string, timeoutMs = 1_500): Promise<boolean> {
  const url = wsUrl.trim()
  // A door needs both halves: a host, and the room number (`/devtools/browser/<uuid>`) inside it.
  if (!/^wss?:\/\/[^/]+\/\S/.test(url)) return false
  return await new Promise<boolean>((resolve) => {
    let settled = false
    const settle = (answer: boolean): void => {
      if (settled) return
      settled = true
      resolve(answer)
    }
    let socket: WebSocket
    try {
      socket = new WebSocket(url)
    } catch {
      settle(false)
      return
    }
    const timer = setTimeout(() => {
      try {
        socket.close()
      } catch {
        // Already gone; the answer below is what counts.
      }
      settle(/^wss?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?\//.test(url))
    }, timeoutMs)
    socket.addEventListener(
      'open',
      () => {
        clearTimeout(timer)
        try {
          socket.close()
        } catch {
          // Closing a socket that just opened cannot fail the answer.
        }
        settle(true)
      },
      { once: true },
    )
    socket.addEventListener(
      'error',
      () => {
        clearTimeout(timer)
        settle(false)
      },
      { once: true },
    )
    socket.addEventListener(
      'close',
      () => {
        clearTimeout(timer)
        settle(false)
      },
      { once: true },
    )
  })
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
