/**
 * The whole "use the logins I already have" sequence: count down, close the reader's browser,
 * copy the logins into the profile this plugin drives, start that browser, put the reader's
 * browser back.
 *
 * It runs here, in the host, rather than in the settings page — and that is the point. The
 * browser being copied from is usually the very browser the settings page is open in, so a
 * sequence driven by the page would close the page's own countdown along with it. The host is
 * a separate process on the machine and keeps going; the page watches the countdown while it
 * lasts, and after the browser comes back it just reads the state the host left behind.
 *
 * The countdown is not decoration. Closing a browser can cost the reader whatever they had
 * half-typed, so the sequence says how long they have to stop it and offers a way to stop it.
 */
import type { AdoptRunStatus, ProfileAdoptReport } from '../protocol'
import type { BrowserKind } from './discover'

export interface AdoptRunDeps {
  /** Close the browser the logins are coming from; `ok` means its cookie store can be read. */
  close: (kind: BrowserKind, label: string) => Promise<{ ok: boolean; note?: string }>
  /** Copy the logins. */
  adopt: (kind: BrowserKind, label: string) => Promise<ProfileAdoptReport>
  /** Start the browser this plugin will drive, on the adopted profile. */
  startPluginBrowser: (kind: BrowserKind) => Promise<void>
  /** Put the reader's own browser back, at the page they were looking at. */
  reopenReaderBrowser: (kind: BrowserKind, page?: string) => Promise<void>
  sleep: (ms: number) => Promise<void>
  now: () => number
}

export interface AdoptRunOptions {
  /** Seconds between the press and the browser being closed. Default 10. */
  countdownSeconds?: number
  deps: Omit<AdoptRunDeps, 'sleep' | 'now'> & Partial<Pick<AdoptRunDeps, 'sleep' | 'now'>>
}

export interface AdoptRun {
  /** Begin the countdown. Returns the status the page should show straight away. */
  start: (input: { kind: BrowserKind; label: string; page?: string }) => AdoptRunStatus
  /** What the page shows while it polls; `undefined` when nothing is running. */
  status: () => AdoptRunStatus | undefined
  /** Stop the countdown before anything has been closed. Returns whether there was one. */
  cancel: () => boolean
  /** Resolves when the whole sequence has settled, for whoever wants to wait for it. */
  settled: () => Promise<void>
}

interface Run {
  kind: BrowserKind
  label: string
  page?: string
  deadline: number
  state: AdoptRunStatus['state']
  report?: ProfileAdoptReport
  note?: string
}

export function createAdoptRun(options: AdoptRunOptions): AdoptRun {
  const deps: AdoptRunDeps = {
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
    ...options.deps,
  }
  const countdownMs = Math.max(0, options.countdownSeconds ?? 10) * 1000
  let run: Run | undefined
  let done: Promise<void> = Promise.resolve()

  const status = (): AdoptRunStatus | undefined => {
    if (!run) return undefined
    return {
      state: run.state,
      browser: run.label,
      secondsLeft: Math.max(0, Math.ceil((run.deadline - deps.now()) / 1000)),
      report: run.report,
      note: run.note,
    }
  }

  const start: AdoptRun['start'] = (input) => {
    // One run at a time, and a second press restarts the countdown: that is what a second
    // press looks like it should do, and the first sequence notices it is no longer current.
    const mine: Run = { ...input, deadline: deps.now() + countdownMs, state: 'counting' }
    run = mine
    done = (async () => {
      await deps.sleep(countdownMs)
      if (run !== mine) return
      mine.state = 'closing'
      const closed = await deps.close(mine.kind, mine.label)
      if (run !== mine) return
      if (!closed.ok) {
        mine.state = 'failed'
        mine.note = closed.note ?? `没能关掉 ${mine.label}。`
        // Whatever happened, the browser that was closed is the reader's and gets put back.
        await deps.reopenReaderBrowser(mine.kind, mine.page).catch(() => undefined)
        return
      }
      mine.state = 'copying'
      const report = await deps.adopt(mine.kind, mine.label)
      if (run !== mine) return
      if (!report.ok) {
        mine.state = 'failed'
        mine.note = report.note ?? '没能把登录数据搬过来。'
        await deps.reopenReaderBrowser(mine.kind, mine.page).catch(() => undefined)
        return
      }
      mine.report = report
      // The browser this plugin drives comes up on the adopted profile, so the next task finds
      // the logins; then the reader's own browser is put back where they left it.
      await deps.startPluginBrowser(mine.kind).catch(() => undefined)
      if (run !== mine) return
      await deps.reopenReaderBrowser(mine.kind, mine.page).catch(() => undefined)
      if (run !== mine) return
      mine.state = 'done'
    })()
    return status() as AdoptRunStatus
  }

  return {
    start,
    status,
    cancel: () => {
      if (!run || run.state !== 'counting') return false
      run = undefined
      return true
    },
    settled: () => done,
  }
}
