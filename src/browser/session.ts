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
import { SNAPSHOT_SOURCE, SNAPSHOT_SOURCE_PLAIN } from './snapshot'

/** A decision no longer refers to the page it was made for. */
export class StalePage extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StalePage'
  }
}

/** The viewport the upstream project used; kept identical so the guards behave the same. */
export const VIEWPORT = { width: 1120, height: 780 } as const

/**
 * The one choice about how a page is read that does not belong to discovery: whether an element the
 * page made clickable with its own script is offered as a candidate as well (see `./snapshot.ts`).
 *
 * It is a per-session choice rather than a per-observation one, because the freshness marker is the
 * semantic half of the very table this decides: a page read one way and checked the other way is
 * "changed" every time, and the run would re-observe forever without ever acting.
 */
export interface SnapshotOptions {
  /** Off means the native controls alone, which is what every page read before the deep scan existed. */
  guessClickableElements?: boolean
}

/** One entry of the indexed element table the snapshot returns. */
export interface SnapshotAction {
  /** Code-owned index such as `e7`, or a fixed name such as `scroll_down`. */
  id: string
  kind: 'click' | 'fill' | 'select' | 'press_key' | 'scroll' | 'wait'
  /** Code-owned node identity; present for element-level actions. */
  node?: number
  label: string
  value?: string
  /** For `press_key`: one of `browser/act.ts`'s key names, such as `arrowdown`. */
  key?: string
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
   * Look for pages that appeared since the last look, and move onto the one worth moving onto.
   *
   * A site that answers a click by opening a new tab leaves the page this session is
   * on untouched, so without this the run reads "nothing happened" while the effect
   * sits in another tab. `onlyIfSameUrl` is the caller's own verdict on that page:
   * if this tab's address moved, the step happened *here* and following the other tab
   * would hand the run to whatever else the site opened. The verdict is the address
   * rather than the whole page because a site may well redraw the page it stays on —
   * a search result turning "visited", say — and that is still not where the click went.
   *
   * `aimedAt` is what the step that just ran was aiming at — the label of the element it acted on,
   * and the goal — and it is read only when the look finds more than one page it could move onto
   * (see `chosenToFollow`). Absent is the old behaviour exactly, which is how the setting that
   * decides whether to say it turns this off.
   *
   * Optional because a browser that cannot open tabs (a test double) simply has none.
   */
  adoptNewPage?(options?: { onlyIfSameUrl?: boolean; aimedAt?: string }): Promise<AdoptResult | null>
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
  /** Which of the two scripts reads this session's pages; fixed for the tab's whole life. */
  #guessClickableElements = true
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
  static async open(url: string, options: DiscoverOptions = {}, snapshot: SnapshotOptions = {}): Promise<BrowserSession> {
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
    session.#guessClickableElements = snapshot.guessClickableElements !== false
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
   *
   * `commandLineApi` asks the browser for the console API inside this one evaluation. It is a real
   * need rather than a convenience: the only honest answer to "does this node respond to a click"
   * is `getEventListeners`, which is part of that API. What the flag does is put those names in the
   * scope of the evaluated code and nothing else — no global is created, no page state is touched —
   * which the browser's own behaviour shows: without the flag the name is `undefined` in the
   * evaluation, where an API installed on the page's global object would answer either way.
   */
  async evaluate<T = unknown>(
    expression: string,
    options: { awaitPromise?: boolean; commandLineApi?: boolean } = {},
  ): Promise<T> {
    const response = await this.call<{ result?: { value?: T }; exceptionDetails?: unknown }>('Runtime.evaluate', {
      expression,
      returnByValue: true,
      ...(options.awaitPromise ? { awaitPromise: true } : {}),
      ...(options.commandLineApi ? { includeCommandLineAPI: true } : {}),
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
   * Every action aimed at one element — click, select, press_key and fill — compares the target's
   * own guard, which is cheap and scoped to the control: it asks whether the element the action was
   * aimed at is still that element, in that state, instead of whether the whole page is unchanged.
   * The distinction is the point for a key, and it is the same one for a field: the pages that keep
   * repainting around the control — an autocomplete list redrawn while it is being typed into, a home
   * page whose recommendation blocks rewrite themselves on every look — are exactly where a whole-page
   * marker throws away a step that was still valid. On 携程 the marker moved on nearly every step, and
   * a field is what those pages still hand the run: on 2026-10-02 a run spent seven TYPE_TEXT
   * decisions on the same search box, paid for five of them, and sent no keystroke at all.
   * A control that really was redrawn is still refused — its own guard is what changed — and the
   * element the action names is looked up by identity, so a moved or replaced control fails here.
   * `scroll` and `wait` are aimed at no element and compare the full semantic marker.
   */
  async fresh(page: PageState, action?: SnapshotAction): Promise<boolean> {
    if (
      action &&
      (action.kind === 'click' ||
        action.kind === 'select' ||
        action.kind === 'press_key' ||
        action.kind === 'fill')
    ) {
      const node = action.node
      if (typeof node !== 'number') return false
      const current = await this.evaluate<unknown[] | null>(
        `(() => { const c=window.__jevFast; return c ? [c.pageKey(),c.guard(c.nodes.get(${node}))] : null; })()`,
      )
      return (
        Array.isArray(current) && JSON.stringify(current) === JSON.stringify([page.page_key, page.guards[String(node)]])
      )
    }
    const marker = await this.evaluate(markerSource(this.#guessClickableElements), { commandLineApi: true })
    return JSON.stringify(marker) === JSON.stringify(page.marker)
  }

  /** Record that a mutation just executed, so the next observation waits for it. */
  noteInput(action: SnapshotAction): void {
    this.#afterInput = action.kind === 'wait' ? null : action
  }

  /**
   * Move onto the page that appeared and is worth moving onto.
   *
   * A tab the site has only just opened often still reads as `about:blank`, and the browser
   * lists a target before it has committed a navigation with no address at all, and the URL
   * is what decides whether it is worth following, so a newcomer that has not said where it
   * is going yet is given a short moment to say it. Everything that appeared is remembered
   * either way, so a page the run deliberately does not follow is not reported twice —
   * everything with an address, that is: a target that still has none is not remembered,
   * because a page that cannot be named yet is not a page this session has seen (below).
   *
   * Which one of them is moved onto, and what `aimedAt` decides about it, is
   * `chosenToFollow`'s business below.
   */
  async adoptNewPage(options: { onlyIfSameUrl?: boolean; aimedAt?: string } = {}): Promise<AdoptResult | null> {
    let pages = await this.#pageTargets()
    let appeared = this.#unseen(pages)
    if (appeared.some((page) => addressless(page.url))) {
      const deadline = Date.now() + 1_000
      while (Date.now() < deadline && appeared.some((page) => addressless(page.url))) {
        await delay(100)
        pages = await this.#pageTargets()
        appeared = this.#unseen(pages)
      }
    }
    // Remembered as a page this session has seen only when it has an address to be seen at. A target
    // the browser has listed before it has committed a navigation answers with an empty address, and
    // remembering one here loses it for good: `#unseen` skips every known target, so a page that was
    // still blank when the run first looked can never be picked up once it lands — which is how a
    // window a click opened went missing (携程, 2026-10: the page the run was on had moved, the new
    // window's address read as an empty string, and the record of having seen it left it out of every
    // later look). Left out of that record instead, it appears as a newcomer on the first look that
    // finds it with an address, and can be followed then. What it costs: a window that stays blank is
    // reported as appeared on each look until it gets an address, so a run that opened one counts it
    // more than once — the alternative was not reporting it at all, and the record of a click that
    // opened a window the run did not follow is worth more than the count being exact.
    //
    // The grace period above was widened to match on 2026-10-02, and for exactly this window: it asked
    // for `about:blank` and nothing else, so the addressless page this run lost never got the moment
    // that was meant for it — the record reads `new_tabs: [""]`, a look that gave it no grace, no
    // second look, and a run that went on to stop on two operations that disagreed. "Has an empty
    // address" and "reads as `about:blank`" are the same statement — the page has not said where it is
    // going yet — so both are waited on now, and both still leave here unfollowed until they have an
    // address that `followable` accepts.
    for (const page of pages) if (page.url !== '') this.#knownPages.add(page.targetId)
    if (appeared.length === 0) return null
    // One list of reportable pages, and `adopted` is the very object listed in it, so a
    // caller can tell which of them the session moved onto without comparing URLs.
    const listed = appeared.map(toNewPage)
    const adopted = chosenToFollow(appeared, options.aimedAt)
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
    const state = await this.evaluate<PageState | null>(this.#snapshotSource(), { commandLineApi: true })
    if (state === null) throw new StalePage('页面正在跳转')
    state.fingerprint = fingerprint(state)
    if (screenshot) {
      const shot = await this.call<{ data: string }>('Page.captureScreenshot', { format: 'jpeg', quality: 72 })
      state.screenshot = shot.data
    }
    return state
  }

  /** The injected script this session reads pages with, chosen once by the setting. */
  #snapshotSource(): string {
    return this.#guessClickableElements ? SNAPSHOT_SOURCE : SNAPSHOT_SOURCE_PLAIN
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

/**
 * The whole snapshot, reduced to the freshness marker alone.
 *
 * Read with the very script the page was observed with: the marker carries the element table, so a
 * marker read by the other variant would answer "changed" on every page it is asked about.
 */
function markerSource(guessClickableElements: boolean): string {
  const state = guessClickableElements ? SNAPSHOT_SOURCE : SNAPSHOT_SOURCE_PLAIN
  return `(() => { const state=${state}; return state?.marker ?? null; })()`
}

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

/**
 * Whether a page has not said where it is going yet.
 *
 * Two spellings of one thing: the browser lists a target before it has committed a navigation with an
 * empty address, and a window a site has only just opened reads as `about:blank`. Neither address can
 * answer whether the page is worth following, so both are given the moment that answer needs — the
 * grace period in `adoptNewPage`, which asks this and nothing else (2026-10-02).
 */
function addressless(url: string): boolean {
  return url === '' || url === 'about:blank'
}

/**
 * Which of the pages that appeared a step should move onto.
 *
 * The ordinary answer is the last one the browser lists, which is the newest, and that is the right
 * answer when a look sees one page: a page a click opens is what that click produced. It is the
 * wrong answer when a look sees more than one, because what the look returns is every page target
 * this session has not seen — not only the ones this click opened. A window that was left without an
 * address is deliberately not remembered (`adoptNewPage` above), so it is a newcomer again on the
 * first look that finds it with one, and a click that opens a window while an older one lands is
 * then reported as two. "The newest" is a coin toss between them, and on 携程 (2026-10) the hotel
 * list page the run had been sent to lost it to an ad page: `hotels.ctrip.com/hotels/list…`, opened
 * by the step before, against `ct.ctrip.com/official…`, opened by the step that looked, both listed
 * for the same look, and the second one moved onto.
 *
 * So when the caller says what the step was aiming at, and there is more than one page it could move
 * onto, the choice is made on that instead: the page whose address and title share the most with the
 * label of the element the step acted on and with the goal. Nothing in common on any of them, or two
 * of them tied for the most, means no single page can be told apart as the one the step was aiming
 * at, and the run stays where it is. Staying is the answer to prefer: a run that stayed is on a page
 * it can read and can try again from, where a run that followed a page it cannot name has handed
 * itself to something the step never asked for — the ad page here is exactly that, and it cost the
 * whole run.
 *
 * A single candidate is followed as it always was, with nothing to choose between, and a caller that
 * says nothing about what it was aiming at gets the old behaviour outright. That last case is the
 * setting's own switch rather than an accident: the run only says what it was aiming at when the
 * preference is on.
 */
function chosenToFollow(appeared: TargetInfo[], aimedAt: string | undefined): TargetInfo | undefined {
  const reachable = appeared.filter((page) => followable(page.url))
  if (aimedAt === undefined || reachable.length < 2) return reachable.at(-1)
  return mostRelevant(reachable, aimedAt)
}

/**
 * The one page of `pages` whose address and title share the most with `aimedAt`, or nothing.
 *
 * A count rather than a yes or no, because the two questions are not the same one. The goal names
 * the site as well as the thing wanted — 携程 … 酒店 — and a page that merely carries the site's
 * name is not the page the step was aiming at, which is exactly the case this run is: the hotel list
 * page shared three tokens with the goal (北京, 酒店, 携程) where the ad page shared one (携程), so
 * the count is what tells them apart and a bare "does it look related" is not.
 *
 * A tie is nothing: two pages as close to the goal as each other are two pages this cannot choose
 * between, and guessing between them is the mistake being fixed.
 */
function mostRelevant(pages: TargetInfo[], aimedAt: string): TargetInfo | undefined {
  const wanted = tokens(aimedAt)
  if (wanted.size === 0) return undefined
  let best: TargetInfo | undefined
  let bestScore = 0
  let tied = false
  for (const page of pages) {
    const score = sharedTokens(wanted, page)
    if (score === 0) continue
    if (score > bestScore) {
      best = page
      bestScore = score
      tied = false
    } else if (score === bestScore) {
      tied = true
    }
  }
  return tied ? undefined : best
}

/** How many of `wanted` a page's own address and title carry. */
function sharedTokens(wanted: Set<string>, page: TargetInfo): number {
  let count = 0
  for (const token of tokens(`${page.url} ${page.title}`)) if (wanted.has(token)) count += 1
  return count
}

/**
 * What a piece of text is compared by: its whole words, and the two-character slices of its Chinese.
 *
 * Sliced rather than compared whole because the two sides of this are never worded the same way: what
 * a reader would call "the hotel list page" is a sentence in the goal and an address ending
 * `hotels/list` on the page, and neither is a substring of the other. A run of Chinese characters
 * contributes every two-character slice of itself (酒店列表页 → 酒店, 店列, 列表, 表页) and a run of
 * letters or digits contributes itself when it is at least three characters long. Two is the
 * shortest slice that still carries meaning in Chinese — one character matches nearly every page —
 * and three is long enough that an English address segment is a word rather than a fragment.
 *
 * The known cost, stated rather than hidden: a goal mentions its site by name, so an unrelated page
 * on that same site shares a token with it. That is why the count decides and a tie does not, and
 * why a page that shares more than the one the step was aiming at still wins — a case this rule
 * cannot settle, and one that ends with the run staying put rather than moving somewhere it cannot
 * justify. It is also blind to a page whose address and title are the only things it reads: a
 * newcomer that is the right page but has not been given its title yet shares less than it will a
 * moment later.
 */
function tokens(text: string): Set<string> {
  const found = new Set<string>()
  for (const word of text.toLowerCase().match(/[a-z0-9]+|[\u4e00-\u9fff]+/g) ?? []) {
    if (/^[a-z0-9]+$/.test(word)) {
      if (word.length >= 3) found.add(word)
      continue
    }
    for (let i = 0; i + 2 <= word.length; i++) found.add(word.slice(i, i + 2))
  }
  return found
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
