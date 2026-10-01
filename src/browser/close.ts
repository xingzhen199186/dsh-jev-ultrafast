/**
 * Close the reader's own browser, so the cookie store it holds exclusively can be read.
 *
 * Finding that browser is the whole difficulty, and the first attempt here got it wrong. The
 * profile directory looks like the obvious handle to match on, but a browser started on its
 * *default* profile says nothing about where its data is: listing the processes on the machine
 * this was written against shows the plugin's own windows naming their directory and the
 * reader's windows naming none at all. What does separate the two is exactly that difference,
 * so the rule runs the other way — every window process of that browser, except this plugin's.
 *
 * It is ended outright rather than asked to close, and that is the uncomfortable part of this
 * file. Asking politely — `taskkill /PID` without `/F` — lets the browser save its session,
 * which is what offers the tabs back afterwards. Saving that session is also exactly what
 * throws away every session cookie it holds, and a login kept in one of those is gone by the
 * time the copy is made. That failure is silent: the copied profile looks complete and signs
 * the reader out of every site that works that way, GitHub among them. Keeping the tabs would
 * mean giving up the logins, and the logins are the whole reason this exists. The browser comes
 * back with the browser's own "restore pages" prompt instead.
 *
 * Whether this worked is not "did something get killed" but "can the store be read now". The
 * call reports the store, and the caller copies only when it says yes.
 */
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { storeIsLocked } from './adopt'
import type { BrowserKind } from './discover'

const execFileAsync = promisify(execFile)

/** The name this browser's processes carry, per platform. */
export function browserProcessName(kind: BrowserKind, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') return kind === 'edge' ? 'msedge.exe' : 'chrome.exe'
  return kind === 'edge' ? 'msedge' : 'chrome'
}

/**
 * The script that finds that browser's window processes.
 *
 * Three details are deliberate, and each one comes from something that went wrong once.
 *
 * It reads its two inputs from environment variables instead of having them pasted into the
 * script text, because a command string carrying quotes does not survive the trip through a
 * Windows command line — one attempt at that arrived as a syntax error instead of a list.
 *
 * It filters inside PowerShell, because echoing whole command lines back through a pipe means
 * PowerShell's own output formatter rewraps them at its own width, and a rewrapped line no
 * longer contains the path it was about.
 *
 * And it prints nothing but pids, so there is nothing long to wrap in the first place.
 */
export const LIST_WINDOW_PROCESSES = [
  "$filter = 'Name=' + [char]39 + $env:JEV_PROCESS + [char]39",
  '$own = $env:JEV_OWN',
  'Get-CimInstance Win32_Process -Filter $filter |',
  '  Where-Object {',
  '    $c = $_.CommandLine',
  "    $c -ne $null -and $c.IndexOf('--type=', [System.StringComparison]::Ordinal) -lt 0 -and" +
    " ($own -eq $null -or $own -eq '' -or $c.IndexOf($own, [System.StringComparison]::OrdinalIgnoreCase) -lt 0)",
  '  } |',
  '  ForEach-Object { [Console]::Out.WriteLine($_.ProcessId) }',
].join('\n')

export interface CloseOptions {
  /** The profile directory whose logins are wanted. */
  profileDir: string
  /** This plugin's own data root: its browser windows must survive, so they are excluded. */
  ownRoot?: string
  /** How long to wait for a polite close, and then for a forced one, in milliseconds. */
  waitMs?: number
  /** Injectable for tests: the lock check that decides whether to try once more. */
  locked?: (path: string) => Promise<boolean>
  /** Injectable for tests: running one external command. */
  run?: (file: string, args: string[], env?: NodeJS.ProcessEnv) => Promise<{ stdout: string; stderr: string }>
  /** Injectable for tests: the platform to pretend to be. */
  platform?: NodeJS.Platform
}

export interface CloseReport {
  ok: boolean
  /** How many processes were asked to close politely, and how many then had to be forced. */
  asked: number
  forced: number
  note?: string
}

/**
 * Ask that browser's windows to close, then end whatever is left if the cookie store is
 * still held.
 */
export async function closeBrowser(kind: BrowserKind, options: CloseOptions): Promise<CloseReport> {
  const platform = options.platform ?? process.platform
  const locked = options.locked ?? storeIsLocked
  const run =
    options.run ??
    ((file: string, args: string[], env?: NodeJS.ProcessEnv) => execFileAsync(file, args, { env }))
  const waitMs = options.waitMs ?? 10_000
  const store = join(options.profileDir, 'Default', 'Network', 'Cookies')
  const name = browserProcessName(kind, platform)

  if (platform !== 'win32') {
    return {
      ok: !(await locked(store)),
      asked: 0,
      forced: 0,
      note: '自动关闭浏览器目前只在 Windows 上做了，这一步得你自己关掉它。',
    }
  }

  const env: NodeJS.ProcessEnv = { ...process.env, JEV_PROCESS: name, JEV_OWN: options.ownRoot ?? '' }
  const list = async (): Promise<number[]> => {
    const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', LIST_WINDOW_PROCESSES], env)
    return stdout
      .split(/\r?\n/)
      .map((line) => Number(line.trim()))
      .filter((pid) => Number.isInteger(pid) && pid > 0)
  }

  const kill = async (pids: number[], force: boolean): Promise<void> => {
    if (pids.length === 0) return
    const args: string[] = []
    for (const pid of pids) args.push('/PID', String(pid))
    if (force) args.push('/F')
    try {
      await run('taskkill', args)
    } catch {
      // A process that exited between listing and killing makes taskkill report a failure.
      // That is the outcome that was wanted, and the lock check below is what decides.
    }
  }

  const windows = await list()
  await kill(windows, true)
  const ok = await waitForUnlocked(store, locked, waitMs)
  return {
    ok,
    asked: 0,
    forced: windows.length,
    note: ok ? undefined : `没能让 ${name} 退出：找到 ${windows.length} 个窗口进程，登录数据仍被占着。`,
  }
}

/** Poll the cookie store until it can be read, or the deadline passes. */
async function waitForUnlocked(
  store: string,
  locked: (path: string) => Promise<boolean>,
  waitMs: number,
): Promise<boolean> {
  const deadline = Date.now() + waitMs
  for (;;) {
    if (!(await locked(store))) return true
    if (Date.now() >= deadline) return false
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
}
