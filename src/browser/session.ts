/**
 * One owned browser tab, driven over CDP.
 *
 * Ported from jev-ultrafast `jev_ultrafast/browser.py`
 * (https://github.com/browser-use/jev-ultrafast, MIT, Copyright (c) 2026 Browser
 * Use). The Python `browser-harness` transport is replaced by ./cdp.ts, ./discover.ts
 * and ./held.ts — the connection is the host's, held across tasks; what this file owns
 * is one tab. The rest follows the upstream behaviour deliberately: an owned
 * background tab rather than the user's active tab, the same fixed viewport, the
 * same focus emulation, and the same two-layer freshness check (a cheap per-node
 * guard before a click or select, the full semantic marker otherwise).
 */
import { createHash } from 'node:crypto'
import type { DiscoverOptions } from './discover'
import { acquireConnection, type HeldSocket } from './held'
import type { NestedFacts } from './nested'
import { SNAPSHOT_SOURCE } from './snapshot'

/** A decision no longer refers to the page it was made for. */
export class StalePage extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StalePage'
  }
}

/** The viewport the upstream project used; kept identical so the guards behave the same. */
export const VIEWPORT = { width: 1120, height: 780 } as const

/** One entry of the indexed element table the snapshot returns. */
export interface SnapshotAction {
  /** Code-owned index such as `e7`, or a fixed name such as `scroll_down`. */
  id: string
  kind: 'click' | 'fill' | 'select' | 'scroll' | 'wait'
  /** Code-owned node identity; present for element-level actions. */
  node?: number
  label: string
  value?: string
  delta?: number
  [key: string]: unknown
}

/** One full page observation. */
export interface PageState {
  url: string
  title: string
  w: number
  h: number
  text: string
  scroll: { y: number; height: number }
  actions: SnapshotAction[]
  marker: unknown
  page_key: unknown[]
  guards: Record<string, unknown>
  omitted_actions: number
  fingerprint: string
  screenshot?: string
  /**
   * What this snapshot could not reach into: visible frames, open shadow roots with content,
   * and how many controls the top document itself offered. Optional, and absent from a
   * snapshot that did not count them (a test double, or a page built before this was added).
   */
  nested?: NestedFacts
}

interface VersionResult {
  product?: string
  protocolVersion?: string
}

/** A page that was not open the last time this session looked. */
export interface NewPage {
  url: string
  title: string
}

/** What one look for pages that just appeared found. */
export interface AdoptResult {
  /**
   * The page this session moved onto, or null when it stayed where it was. It is the
   * same object as its entry in `appeared`, so the caller can point at which one.
   */
  adopted: NewPage | null
  /** Every page that appeared since the last look, the adopted one included. */
  appeared: NewPage[]
}

/** A target as `Target.getTargets` reports it. */
interface TargetInfo {
  targetId: string
  type: string
  url: string
  title: string
}

/** The browser surface the run loop needs; `BrowserSession` is the real implementation. */
export interface BrowserPort {
  call<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>
  observe(options?: { screenshot?: boolean }): Promise<PageState>
  fresh(page: PageState, action?: SnapshotAction): Promise<boolean>
  noteInput(action: SnapshotAction): void
  /**
   * Look for pages that appeared since the last look, and move onto the newest one.
   *
   * A site that answers a click by opening a new tab leaves the page this session is
   * on untouched, so without this the run reads "nothing happened" while the effect
   * sits in another tab. `onlyIfSameUrl` is the caller's own verdict on that page:
   * if this tab's address moved, the step happened *here* and following the other tab
   * would hand the run to whatever else the site opened. The verdict is the address
   * rather than the whole page because a site may well redraw the page it stays on —
   * a search result turning "visited", say — and that is still not where the click went.
   *
   * Optional because a browser that cannot open tabs (a test double) simply has none.
   */
  adoptNewPage?(options?: { onlyIfSameUrl?: boolean }): Promise<AdoptResult | null>
  /**
   * Wait for the page a step just changed to finish painting, before it is observed again.
   *
   * `document.readyState` reaches `complete` long before a site that fetches its results has put
   * them on the page: measured on Baidu, the shell is 54 characters of chrome (「请按“回车”键发起
   * 检索」) and the results arrive a moment later. The decision taken in between saw nothing, called
   * the search finished, and the run ended with a page it had never read (2026-09-30). `before` is
   * the page as it was before the action, which is what makes "has the content arrived?" answerable.
   *
   * Optional because a browser that paints nothing (a test double) has nothing to wait for.
   */
  settle?(before: PageState, options?: { maxMs?: number; quietMs?: number; noChangeMs?: number }): Promise<void>
  close(): Promise<void>
}

/** A single owned tab, with one CDP session attached to it. */
export class BrowserSession implements BrowserPort {
  /**
   * The host's connection, not this session's. It is the one the reader allowed and the one the next
   * task will reuse, so nothing here closes it; what this session owns is the tab below.
   */
  readonly #connection: HeldSocket
  /** The tab this session is attached to now; it changes when the run follows a new one. */
  #targetId: string
  #sessionId: string
  /** The tab this session created. It is the only one `close` takes away. */
  readonly #originTargetId: string
  /** Every page target seen so far, so "a page appeared" means one that was not here before. */
  readonly #knownPages = new Set<string>()
  /** Set right after a mutation, so the next observation can wait for it to land. */
  #afterInput: SnapshotAction | null = null
  #closed = false

  private constructor(connection: HeldSocket, targetId: string, sessionId: string) {
    this.#connection = connection
    this.#targetId = targetId
    this.#sessionId = sessionId
    this.#originTargetId = targetId
  }

  /**
   * Attach a background tab to the browser, and load `url` in it.
   *
   * The connection is not opened here. It is asked for, and the holder answers with the one that is
   * already open when there is one — attaching to a tab is what a task does to a connection the
   * reader allowed once. Only when there is none does this end in a new handshake, and the reader's
   * own browser asks permission on every one of those.
   */
  static async open(url: string, options: DiscoverOptions = {}): Promise<BrowserSession> {
    const { connection } = await acquireConnection(options)
    const { targetId } = await connection.send<{ targetId: string }>('Target.createTarget', {
      url: 'about:blank',
      background: true,
    })
    const { sessionId } = await connection.send<{ sessionId: string }>('Target.attachToTarget', {
      targetId,
      flatten: true,
    })
    const session = new BrowserSession(connection, targetId, sessionId)
    try {
      await session.#applyViewport()
      await session.call('Page.navigate', { url })
      await session.#waitForLoad()
      // Seeded after the first load: whatever was already open (the user's tabs and
      // this tab) is the baseline, and only pages after it count as "appeared".
      await session.#rememberPages()
      return session
    } catch (error) {
      // The tab goes back here; the connection stays. It is live and already allowed, and only the
      // holder decides when one stops being worth keeping (see ./held.ts).
      await session.close()
      throw error
    }
  }

  /** The browser's own version string, for diagnostics. */
  async version(): Promise<string> {
    const result = await this.#connection.send<VersionResult>('Browser.getVersion')
    return result.product ?? 'unknown'
  }

  /** Send one CDP command inside this tab's session. */
  call<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    return this.#connection.send<T>(method, params, this.#sessionId)
  }

  /**
   * Evaluate an expression in the page and return its value.
   * A document that changed under the evaluation reads as a stale page, exactly
   * as upstream, because acting on the result would be acting on a page that is
   * no longer there.
   */
  async evaluate<T = unknown>(expression: string, options: { awaitPromise?: boolean } = {}): Promise<T> {
    const response = await this.call<{ result?: { value?: T }; exceptionDetails?: unknown }>('Runtime.evaluate', {
      expression,
      returnByValue: true,
      ...(options.awaitPromise ? { awaitPromise: true } : {}),
    })
    if (response.exceptionDetails) throw new StalePage('页面在取值过程中发生了变化')
    return response.result?.value as T
  }

  /** Take a full observation; retries while the document is still settling. */
  async observe(options: { screenshot?: boolean } = {}): Promise<PageState> {
    const pending = this.#afterInput
    if (pending) {
      this.#afterInput = null
      // Read-only, and it runs after the executed action was already logged, so a
      // navigation interrupting the wait cannot erase what happened.
      try {
        await this.#settle(pending)
      } catch {
        // The snapshot below is what reports an unsettled page.
      }
    }
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.#readState(options.screenshot === true)
      } catch (error) {
        if (!(error instanceof StalePage) || attempt >= 9) throw error
        await delay(20)
      }
    }
  }

  /**
   * Whether the observed page still matches the decision.
   * Click and select compare the target's own guard, which is cheap and scoped to
   * the control; everything else compares the full semantic marker.
   */
  async fresh(page: PageState, action?: SnapshotAction): Promise<boolean> {
    if (action && (action.kind === 'click' || action.kind === 'select')) {
      const node = action.node
      if (typeof node !== 'number') return false
      const current = await this.evaluate<unknown[] | null>(
        `(() => { const c=window.__jevFast; return c ? [c.pageKey(),c.guard(c.nodes.get(${node}))] : null; })()`,
      )
      return (
        Array.isArray(current) && JSON.stringify(current) === JSON.stringify([page.page_key, page.guards[String(node)]])
      )
    }
    const marker = await this.evaluate(MARKER_SOURCE)
    return JSON.stringify(marker) === JSON.stringify(page.marker)
  }

  /** Record that a mutation just executed, so the next observation waits for it. */
  noteInput(action: SnapshotAction): void {
    this.#afterInput = action.kind === 'wait' ? null : action
  }

  /**
   * Move onto the newest page that appeared since the last look.
   *
   * A tab the site has only just opened often still reads as `about:blank`, and its
   * URL is what decides whether it is worth following, so a blank newcomer is given
   * a short moment to say where it is going. Everything that appeared is remembered
   * either way, so a page the run deliberately does not follow is not reported twice.
   */
  async adoptNewPage(options: { onlyIfSameUrl?: boolean } = {}): Promise<AdoptResult | null> {
    let pages = await this.#pageTargets()
    let appeared = this.#unseen(pages)
    if (appeared.some((page) => page.url === 'about:blank')) {
      const deadline = Date.now() + 1_000
      while (Date.now() < deadline && appeared.some((page) => page.url === 'about:blank')) {
        await delay(100)
        pages = await this.#pageTargets()
        appeared = this.#unseen(pages)
      }
    }
    for (const page of pages) this.#knownPages.add(page.targetId)
    if (appeared.length === 0) return null
    // One list of reportable pages, and `adopted` is the very object listed in it, so a
    // caller can tell which of them the session moved onto without comparing URLs.
    const listed = appeared.map(toNewPage)
    const adopted = appeared.filter((page) => followable(page.url)).at(-1)
    if (options.onlyIfSameUrl === false || !adopted) return { adopted: null, appeared: listed }
    await this.#switchTo(adopted.targetId)
    return { adopted: listed[appeared.indexOf(adopted)]!, appeared: listed }
  }

  /**
   * Close the tab this session created. The connection stays open.
   *
   * That is the whole point of holding it: one permission box covers every task until this host
   * restarts, so a task that put its connection away would make the next one ask again. A browser
   * that has gone away closes its own side, and the holder hears about it there.
   */
  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    try {
      await this.#connection.send('Target.closeTarget', { targetId: this.#originTargetId })
    } catch {
      // The browser may already be gone; nothing left to release.
    }
  }

  /** Page targets, as the browser reports them. */
  async #pageTargets(): Promise<TargetInfo[]> {
    const result = await this.#connection.send<{ targetInfos?: TargetInfo[] }>('Target.getTargets')
    return (result.targetInfos ?? []).filter((info) => info.type === 'page')
  }

  /** The page targets in this list that this session has not seen before. */
  #unseen(pages: TargetInfo[]): TargetInfo[] {
    return pages.filter((page) => !this.#knownPages.has(page.targetId))
  }

  /** Take the current page targets as the baseline. */
  async #rememberPages(): Promise<void> {
    for (const page of await this.#pageTargets()) this.#knownPages.add(page.targetId)
  }

  /** Attach to another page the same browser already has open, and set it up like ours. */
  async #switchTo(targetId: string): Promise<void> {
    const { sessionId } = await this.#connection.send<{ sessionId: string }>('Target.attachToTarget', {
      targetId,
      flatten: true,
    })
    this.#sessionId = sessionId
    this.#targetId = targetId
    await this.#applyViewport()
    try {
      await this.#waitForLoad(10_000)
    } catch {
      // Left to the snapshot below: a page that will not settle reports itself there.
    }
  }

  /**
   * Wait for a page a step just changed to finish painting its content.
   *
   * `#waitForLoad` only waits for `document.readyState`, and a site that renders its results from a
   * request reaches `complete` while the body is still the empty shell. Measured on Baidu: the shell
   * is 54 characters of chrome (「请按“回车”键发起检索」) and the results arrive a moment later; the
   * decision taken in between saw nothing, called the search finished, and the run ended with a page
   * it had never read (2026-09-30).
   *
   * It waits for the page's text to stop changing and to have grown past `before`, which is the
   * observable difference between "the results have arrived" and "this is still the shell". A page
   * that never grows is not waited on indefinitely: after `noChangeMs` with nothing new, the run
   * looks anyway, because a step that changed nothing visible (a checkbox, a dropdown) has no
   * content coming and must not cost `maxMs`. It never throws — a page that cannot be read while it
   * is moving is the next observation's business, not the run's failure.
   *
   * Known limit: this is text, not the network. A page that paints its results with no text change
   * at all (only an image, say) is indistinguishable from a finished one, and gets `noChangeMs`.
   */
  async settle(before: PageState, options: { maxMs?: number; quietMs?: number; noChangeMs?: number } = {}): Promise<void> {
    const maxMs = options.maxMs ?? 4_000
    const quietMs = options.quietMs ?? 200
    const noChangeMs = options.noChangeMs ?? 1_500
    try {
      await this.#waitForLoad(5_000)
    } catch {
      // Left to the observation that follows, which reports a page that will not settle.
    }
    const started = Date.now()
    const deadline = started + maxMs
    let previous: PageState
    try {
      previous = await this.#readState(false)
    } catch {
      return
    }
    while (Date.now() < deadline) {
      await delay(quietMs)
      let now: PageState
      try {
        now = await this.#readState(false)
      } catch {
        return
      }
      const steady = now.text === previous.text
      previous = now
      if (!steady) continue
      if (now.text.length > before.text.length) return
      if (Date.now() - started >= noChangeMs) return
    }
  }

  /** The fixed viewport and the focus emulation every page this session drives gets. */
  async #applyViewport(): Promise<void> {
    await this.call('Emulation.setDeviceMetricsOverride', {
      width: VIEWPORT.width,
      height: VIEWPORT.height,
      deviceScaleFactor: 1,
      mobile: false,
    })
    // Keep animation frames and menus rendering in a background tab, without
    // stealing focus from whatever the user is doing in their own tab.
    await this.call('Emulation.setFocusEmulationEnabled', { enabled: true })
  }

  async #waitForLoad(timeoutMs = 15_000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if ((await this.evaluate<string>('document.readyState')) === 'complete') return
      await delay(20)
    }
    throw new StalePage(`页面在 ${timeoutMs} 毫秒内没有加载完成`)
  }

  async #readState(screenshot: boolean): Promise<PageState> {
    const state = await this.evaluate<PageState | null>(SNAPSHOT_SOURCE)
    if (state === null) throw new StalePage('页面正在跳转')
    state.fingerprint = fingerprint(state)
    if (screenshot) {
      const shot = await this.call<{ data: string }>('Page.captureScreenshot', { format: 'jpeg', quality: 72 })
      state.screenshot = shot.data
    }
    return state
  }

  /**
   * Wait for an executed mutation to show up: two animation frames, plus up to
   * 200 ms extra when the field is an editable combobox whose options are still
   * arriving. Paying for a decision before autocomplete suggests anything would
   * be wasted work.
   */
  async #settle(action: SnapshotAction): Promise<void> {
    await this.call('Runtime.evaluate', {
      expression: `(action => new Promise(resolve => {
        const field=window.__jevFast?.nodes.get(action.node);
        const autocomplete=action.kind==='fill' && field?.getAttribute('role')==='combobox';
        let frames=0, stopped=false;
        const finish=()=>{stopped=true;resolve()};
        setTimeout(finish,autocomplete ? 200 : 50);
        const ready=()=>{
          if (stopped) return;
          const ids=(field?.getAttribute('aria-controls')||field?.getAttribute('aria-owns')||'')
            .split(/\\s+/).filter(Boolean);
          const roots=ids.length ? ids.map(id=>document.getElementById(id)).filter(Boolean) : [document];
          const options=roots.flatMap(root=>[...root.querySelectorAll('[role="option"]')]);
          if (++frames>=2 && (!autocomplete || options.some(e=>{
            const r=e.getBoundingClientRect();
            return r.width && r.height && r.bottom>0 && r.top<innerHeight &&
              e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true});
          }))) finish();
          else requestAnimationFrame(ready);
        };
        requestAnimationFrame(ready);
      }))(${JSON.stringify(action)})`,
      awaitPromise: true,
      returnByValue: true,
    })
  }
}

/** The whole snapshot, reduced to the freshness marker alone. */
const MARKER_SOURCE = `(() => { const state=${SNAPSHOT_SOURCE}; return state?.marker ?? null; })()`

/** Content hash of everything that should be true about a page and its controls. */
export function fingerprint(state: PageState): string {
  const content = { url: state.url, text: state.text, actions: state.actions, scroll: state.scroll }
  return createHash('sha256').update(JSON.stringify(content)).digest('hex')
}

/** The reportable half of a target: enough to say which page appeared. */
function toNewPage(info: TargetInfo): NewPage {
  return { url: info.url, title: info.title }
}

/**
 * Whether a page is worth moving onto. Stated as what counts (a web page or a local
 * file) rather than what does not, so the browser's own surfaces — `chrome://`,
 * extension pages, the DevTools front end, a tab still sitting on `about:blank` —
 * are all out by construction instead of by remembering to list them.
 */
function followable(url: string): boolean {
  return /^(https?|file):/i.test(url)
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
