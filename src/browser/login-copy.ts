/**
 * Fill the plugin's own browser with the logins the reader's own browser is holding.
 *
 * The probe next door counts what is there; this one takes it along. The reading half is the same
 * act as the probe — the browser-level socket, `Storage.getCookies`, no target and so no tab — and
 * the writing half is that same shape pointed at the browser this plugin started itself, where
 * `Storage.setCookies` puts the cookies in. Neither half touches the reader's profile: the source is
 * only ever read, and the destination is the plugin's own directory (see `pluginProfileDir`).
 *
 * What crosses is a *reduced* cookie. `Storage.getCookies` answers with fields `Storage.setCookies`
 * will not take back — `size`, `priority`, `session` — and one field the browser refuses makes it
 * reject the whole call rather than that one cookie, so the list is rebuilt field by field
 * (`toCookieParam`) instead of handed back the way it arrived.
 *
 * `sourceScheme` and `sourcePort` are carried across rather than dropped, because they are on
 * `CookieParam` too — and because dropping them changes what the cookie *is*: Chromium files a
 * cookie by the scheme of the origin that set it, and one written as `secure: true` from an
 * unstated source is a cookie a secure origin may still refuse. `Storage.setCookies` reports
 * nothing back, so a refused cookie is not an error — it is simply absent from the read-back,
 * which is what a large per-domain difference in the tally looks like.
 *
 * Nothing here writes a cookie down. No trace, no log, no file; the answer that goes back to the
 * page is counts and domain names, and a cookie's name and value never leave this module.
 */
import type { BrowserKind } from './discover'
import { holdConnection } from './held'
import { ensureBrowser, type EnsureOptions, type EnsuredBrowser } from './launch'
import {
  cookiesFrom,
  openDailyConnection,
  type ProbeConnection,
  type ProbeConnector,
} from './login-probe'

/**
 * One cookie as `Storage.getCookies` hands it over, read-back fields and all.
 *
 * Deliberately open: the source is the browser's own answer rather than anything this plugin drew
 * up, and naming every field it may carry would claim a completeness the protocol does not promise.
 * The fields that are used are the ones `toCookieParam` reads; everything else is dropped there.
 */
export interface SourceCookie {
  name?: unknown
  value?: unknown
  domain?: unknown
  path?: unknown
  secure?: unknown
  httpOnly?: unknown
  sameSite?: unknown
  expires?: unknown
  partitionKey?: unknown
  [field: string]: unknown
}

/**
 * One cookie to write, in the fields `Storage.setCookies` accepts.
 *
 * That domain's `CookieParam` and nothing else: no `size`, no `priority` and no `session`, because
 * those are what the browser reports about a cookie it already holds rather than what it takes to
 * make one. `sourceScheme` and `sourcePort` are the two read-back-looking fields the protocol does
 * take, so they are carried over as they arrived; see `toCookieParam`.
 */
export interface CookieParam {
  name: string
  value: string
  domain: string
  path: string
  secure?: boolean
  httpOnly?: boolean
  sameSite?: 'Strict' | 'Lax' | 'None'
  /** Unix seconds. Absent on a session cookie, which is a cookie with no expiry. */
  expires?: number
  /** The scheme of the origin the cookie came from: what the browser files it under. */
  sourceScheme?: 'Secure' | 'NonSecure' | 'Unset'
  /** The port of that origin, when the answer named one. */
  sourcePort?: number
}

/** The three kinds of cookie this copy deliberately leaves behind. */
export type SkipReason = 'expired' | 'partitioned' | 'noDomain'

/** What a whole cookie list comes to: what will be written, and what will not. */
export interface CopyPlan {
  /** The cookies to write, in the order they arrived. */
  params: CookieParam[]
  /** How many were left behind, by reason. */
  skipped: Record<SkipReason, number>
}

/** Why one cookie is not written, as itself rather than as a missing cookie. */
export type CookieVerdict =
  | { kind: 'write'; param: CookieParam }
  | { kind: 'skip'; reason: SkipReason }

/** How many cookies go into one `Storage.setCookies` call. */
export const BATCH_SIZE = 200

/** The `sameSite` values the protocol has; anything else is dropped rather than guessed at. */
const SAME_SITE = new Set(['Strict', 'Lax', 'None'])

/** A string, as a string; anything else is the empty one. */
function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/**
 * One cookie from the reader's browser, as the cookie to write — or the reason it is not written.
 *
 * The order of the three refusals is deliberate. A cookie with no domain cannot be addressed at all,
 * a partitioned cookie belongs to a partition this copy has no way to name, and an expired one would
 * be written only to be dropped again. A cookie that is true of two of them is counted once, under
 * the refusal that comes first here.
 *
 * The session cookie is the one difference worth naming: `expires` is carried only when it is
 * positive, so a cookie with no expiry is written without one, which is what makes it a session
 * cookie in the destination too. A negative or zero `expires` is the protocol's other way of saying
 * the same thing, and neither is written.
 *
 * A name is not checked for emptiness on purpose: a browser's own store cannot hold a cookie with
 * no name, so the answer this reads can never contain one.
 *
 * `sourceScheme` is always written. When the answer named one it is carried over as it stands;
 * when it did not, it is derived from `secure` — a cookie the browser marks secure came from a
 * secure origin, and one written without that claim would make Chromium refuse a cookie it was
 * quite happy to hand over. `sourcePort` is carried over only when the answer held one, because
 * there is nothing to derive it from.
 */
export function toCookieParam(cookie: SourceCookie, now: number): CookieVerdict {
  const domain = text(cookie.domain).trim()
  if (domain === '') return { kind: 'skip', reason: 'noDomain' }
  if (cookie.partitionKey !== undefined && cookie.partitionKey !== null) {
    return { kind: 'skip', reason: 'partitioned' }
  }
  const expires = typeof cookie.expires === 'number' ? cookie.expires : 0
  if (expires > 0 && expires <= now) return { kind: 'skip', reason: 'expired' }
  const named = text(cookie.sourceScheme).trim()
  const sourceScheme = named !== '' ? (named as CookieParam['sourceScheme']) : cookie.secure === true ? 'Secure' : 'NonSecure'
  const sourcePort = typeof cookie.sourcePort === 'number' && Number.isInteger(cookie.sourcePort) ? cookie.sourcePort : null
  return {
    kind: 'write',
    param: {
      name: text(cookie.name),
      value: text(cookie.value),
      domain,
      // A real cookie always has a path, and the protocol insists on one. The stand-in is the value
      // the browser itself uses when a site leaves the attribute out, so a missing one cannot make
      // the whole batch be refused.
      path: text(cookie.path).trim() || '/',
      sourceScheme,
      ...(sourcePort === null ? {} : { sourcePort }),
      ...(cookie.secure === true ? { secure: true } : {}),
      ...(cookie.httpOnly === true ? { httpOnly: true } : {}),
      ...(SAME_SITE.has(text(cookie.sameSite)) ? { sameSite: text(cookie.sameSite) as CookieParam['sameSite'] } : {}),
      ...(expires > 0 ? { expires } : {}),
    },
  }
}

/** Everything the source list comes to: the cookies to write, and how many were left behind. */
export function planCookieCopy(cookies: readonly SourceCookie[], now: number): CopyPlan {
  const params: CookieParam[] = []
  const skipped: Record<SkipReason, number> = { expired: 0, partitioned: 0, noDomain: 0 }
  for (const cookie of cookies) {
    const verdict = toCookieParam(cookie, now)
    if (verdict.kind === 'write') params.push(verdict.param)
    else skipped[verdict.reason] += 1
  }
  return { params, skipped }
}

/**
 * Cut the cookies into the lists `Storage.setCookies` is asked for, in order and without dropping.
 *
 * Bounded rather than one call for the lot: a browser asked for a few thousand cookies in one
 * message is a browser reading one very long line, and a batch that fails takes its own size down
 * with it instead of everything.
 */
export function batchCookies(cookies: readonly CookieParam[], size: number = BATCH_SIZE): CookieParam[][] {
  const batches: CookieParam[][] = []
  for (let at = 0; at < cookies.length; at += size) batches.push(cookies.slice(at, at + size))
  return batches
}

/** One domain whose landed cookies do not match what was expected for it. */
export interface DomainMismatch {
  domain: string
  expected: number
  landed: number
}

/** What the copy did, in counts: no cookie's name or value is in here. */
export interface CopySummary {
  /** How many distinct domains were meant to be written, and how many of those matched exactly. */
  domains: { expected: number; landed: number }
  /** How many cookies were read back under those domains. */
  cookiesLanded: number
  skipped: Record<SkipReason, number>
  /** Only the domains with a difference, in name order. */
  mismatched: DomainMismatch[]
}

/** The domain a cookie is filed under, or the empty one when it carries none. */
export function domainOf(cookie: SourceCookie): string {
  return text(cookie.domain).trim()
}

/** How many cookies each domain holds. */
function countByDomain(domains: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const domain of domains) counts.set(domain, (counts.get(domain) ?? 0) + 1)
  return counts
}

/**
 * Compare what was meant to be written with what the destination browser hands back.
 *
 * Domain by domain, because that is the finest thing the answer may contain: the copy knows a
 * cookie only by where it lives, and a page that was told a cookie's name would have been told the
 * one thing this whole route exists to keep on this machine.
 *
 * Only the expected domains are looked at. A destination that already holds cookies for a domain of
 * its own — a login the reader made in the plugin's browser — is not a difference in this copy, and
 * a domain expected here whose cookies are all still there is exactly "all matched".
 */
export function summarizeCopy(plan: CopyPlan, landed: readonly SourceCookie[]): CopySummary {
  const expected = countByDomain(plan.params.map((param) => param.domain))
  const arrived = countByDomain(landed.map(domainOf))
  const mismatched: DomainMismatch[] = []
  let cookiesLanded = 0
  let matched = 0
  for (const domain of [...expected.keys()].sort()) {
    const want = expected.get(domain) ?? 0
    const got = arrived.get(domain) ?? 0
    cookiesLanded += got
    if (got === want) matched += 1
    else mismatched.push({ domain, expected: want, landed: got })
  }
  return { domains: { expected: expected.size, landed: matched }, cookiesLanded, skipped: plan.skipped, mismatched }
}

/** The plugin's own browser could not be used, in words the reader can act on. */
export class CopyTargetError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CopyTargetError'
  }
}

/** What a browser is asked for, and how it is reached. Everything injectable is a test seam. */
export interface CopyOptions {
  /** Which browser's profile to read, and which one to start when the plugin has none. */
  kind: BrowserKind
  /** The reader's profile root, when 数据目录 names one. */
  profileDir?: string
  /** The 「浏览器程序」 setting, for a portable install that is not where we look. */
  exeOverride?: string
  /** How long to wait for a browser started here to report its port. */
  timeoutMs?: number
  /** The clock the expiry test uses, in Unix seconds. Defaults to now. */
  now?: number
  /**
   * The two sockets, and the browser lookup.
   *
   * Leaving one out is the normal case and means "use the host's connection": the reader's own
   * browser and the plugin's own browser each have at most one held connection, and a probe, a copy
   * and a task all reach for that same one (see ./held.ts). A connector given here is a socket this
   * call opened itself — a test's stand-in — and the caller that supplied it puts it away.
   */
  connectDaily?: ProbeConnector
  connectPlugin?: ProbeConnector
  ensure?: (options: EnsureOptions) => Promise<EnsuredBrowser>
}

/**
 * Carry every cookie the reader's own browser holds into the plugin's own browser.
 *
 * The reader asked for all of them and for no site to be filtered out, so nothing here chooses: a
 * cookie is written unless the protocol has no way to write it (see `toCookieParam`), and what was
 * left behind is counted and reported rather than quietly dropped.
 *
 * Neither socket is opened here. Both come from the host's held connections, which is what keeps
 * this button from raising a second 「允许远程调试？」 on the reader's browser, and neither is closed
 * at the end — the reader's connection is meant to cover every later task, and the plugin's own
 * browser is meant to outlive the request with the cookies now in it.
 */
export async function copyDailyLoginsIntoPluginBrowser(options: CopyOptions): Promise<CopySummary> {
  const { kind } = options
  const now = options.now ?? Math.floor(Date.now() / 1000)
  const ensure = options.ensure ?? ensureBrowser

  const daily = await openDailyConnection({
    kind,
    profileDir: options.profileDir,
    // Only a caller that brought its own socket bypasses the holder, and only a test does that.
    ...(options.connectDaily === undefined ? {} : { connect: options.connectDaily }),
  })
  let cookies: SourceCookie[]
  try {
    cookies = cookiesFrom<SourceCookie>(await daily.connection.send('Storage.getCookies', {}))
  } finally {
    // No `browserContextId`: with none the command means the whole browser, which is what the reader
    // asked to be carried over. This is the only command sent to their browser, and it is a read.
    if (!daily.held) daily.connection.close()
  }
  const plan = planCookieCopy(cookies, now)

  let plugin: ProbeConnection
  let pluginHeld = false
  let target: string
  try {
    // The plugin's own browser, through the same route every other task uses: the one already
    // running, or one started because there was none. Neither `cdpUrl` nor 数据目录 is passed — the
    // reader's own address is not this copy's destination — so a browser that has to be started is
    // started, and the endpoint that comes back is the plugin's own by construction.
    const ensured = await ensure({
      preferredKind: kind,
      exeOverride: options.exeOverride,
      timeoutMs: options.timeoutMs,
      connection: 'plugin',
    })
    target = ensured.endpoint.wsUrl
    if (target === daily.wsUrl) {
      throw new CopyTargetError(
        `插件自己的浏览器和你正在用的那个是同一个（都指向 ${target}），这次什么都没写——这个按钮只往插件自己的浏览器里灌。`,
      )
    }
    if (options.connectPlugin !== undefined) {
      plugin = await options.connectPlugin(target)
    } else {
      plugin = await holdConnection(target, { route: 'plugin', kind })
      pluginHeld = true
    }
  } catch (error) {
    if (error instanceof CopyTargetError) throw error
    throw new CopyTargetError(`插件自己的浏览器没能用起来，这次没写进去：${describe(error)}`)
  }

  try {
    for (const batch of batchCookies(plan.params)) await plugin.send('Storage.setCookies', { cookies: batch })
    // Read back from the same browser, at the browser level: what it now holds is the only evidence
    // that the write landed, and the page is told how many of them it can see.
    const landed = cookiesFrom<SourceCookie>(await plugin.send('Storage.getCookies', {}))
    return summarizeCopy(plan, landed)
  } finally {
    if (!pluginHeld) plugin.close()
  }
}

/** An error as a sentence. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
