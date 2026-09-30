/**
 * Close the reader's own browser, so the cookie store it holds exclusively can be read.
 *
 * The polite way first. On Windows, `taskkill /PID` without `/F` asks the window to close,
 * which is what lets Edge save its session and offer the tabs back afterwards; a forced kill
 * would not. A browser that keeps a background process alive anyway — Edge's startup boost
 * does exactly that — still holds the cookie store, so the same processes get a second and
 * forceful pass, but only if the store is still locked and only for the profile being
 * adopted, so no other browser window is touched.
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

export interface CloseOptions {
  /** The profile directory whose processes may be closed; every other profile is left alone. */
  profileDir: string
  /** How long to wait for a polite close, and then for a forced one, in milliseconds. */
  waitMs?: number
  /** Injectable for tests: the lock check that decides whether to try once more. */
  locked?: (path: string) => Promise<boolean>
  /** Injectable for tests: running one external command. */
  run?: (file: string, args: string[]) => Promise<{ stdout: string; stderr: string }>
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
  const run = options.run ?? ((file: string, args: string[]) => execFileAsync(file, args))
  const waitMs = options.waitMs ?? 10_000
  const store = join(options.profileDir, 'Default', 'Network', 'Cookies')

  if (platform !== 'win32') {
    return {
      ok: !(await locked(store)),
      asked: 0,
      forced: 0,
      note: '自动关闭浏览器目前只在 Windows 上做了，这一步得你自己关掉它。',
    }
  }

  const name = browserProcessName(kind, platform)
  const list = async (): Promise<number[]> => {
    const script =
      `Get-CimInstance Win32_Process -Filter "Name='${name}'" | ` +
      'ForEach-Object { "$($_.ProcessId)`t$($_.CommandLine)" }'
    const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script])
    return stdout
      .split(/\r?\n/)
      .map((line) => line.split('\t'))
      .filter(([pid, command]) => {
        if (!pid || !command) return false
        // Only the browser process of the profile being adopted. Killing a renderer would just
        // make the browser start another one, and another profile is none of our business.
        return command.includes(options.profileDir) && !command.includes('--type=')
      })
      .map(([pid]) => Number(pid))
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

  const first = await list()
  await kill(first, false)
  if (await waitForUnlocked(store, locked, waitMs)) return { ok: true, asked: first.length, forced: 0 }

  const left = await list()
  await kill(left, true)
  const ok = await waitForUnlocked(store, locked, waitMs)
  return {
    ok,
    asked: first.length,
    forced: left.length,
    note: ok
      ? undefined
      : first.length + left.length === 0
        ? `没有找到用着 ${options.profileDir} 的进程，但登录数据还是读不了。`
        : `${name} 还占着登录数据，没能让它退出。`,
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
