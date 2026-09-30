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
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import {
  discoverBrowser,
  pluginProfileDir,
  readActivePort,
  type BrowserEndpoint,
  type BrowserKind,
  type DiscoverOptions,
} from './discover'

export type { BrowserKind }

export const BROWSER_KINDS: readonly BrowserKind[] = ['chrome', 'edge']

/** The name each browser is called on the page. */
export const BROWSER_LABELS: Record<BrowserKind, string> = { chrome: 'Chrome', edge: 'Edge' }

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

/** Injectable for tests: nothing in this file should ever really start a browser under vitest. */
export interface EnsureDeps {
  discover: (options: DiscoverOptions) => Promise<BrowserEndpoint>
  launch: (kind: BrowserKind, options: LaunchOptions) => Promise<LaunchedBrowser>
}

const ENSURE_DEPS: EnsureDeps = { discover: discoverBrowser, launch: launchBrowser }

/**
 * The browser a task will drive: the one already there, or one started because there was none.
 *
 * Two things it deliberately does *not* do, both to keep a task from driving a browser the
 * reader did not choose. A pinned endpoint (`cdpUrl`) or a named profile directory
 * (`userDataDir`) is an instruction, not a hint: when one of those is set and unreachable,
 * the failure is reported as it is, because starting a different browser would be answering
 * a question nobody asked. And when there is nothing pinned and nothing running, the
 * browser that starts is the one the settings page already says — same executable lookup,
 * same profile directory, same port-file trick, and the same idempotence: a second task
 * finds the browser the first one started instead of opening a second window.
 */
export async function ensureBrowser(
  options: EnsureOptions = {},
  deps: EnsureDeps = ENSURE_DEPS,
): Promise<EnsuredBrowser> {
  try {
    return { endpoint: await deps.discover(options), launched: null }
  } catch (error) {
    if (options.cdpUrl?.trim() || options.userDataDir?.trim()) throw error
    const launched = await deps.launch(options.preferredKind ?? 'chrome', {
      exeOverride: options.exeOverride,
      timeoutMs: options.timeoutMs,
    })
    // Discovery again, against the endpoint that was just written to the profile
    // directory: this returns the same shape (socket URL, version, provenance) the
    // found-browser path returns, so the caller cannot tell the two apart by accident.
    return { endpoint: await deps.discover({ ...options, cdpUrl: launched.endpoint }), launched }
  }
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
