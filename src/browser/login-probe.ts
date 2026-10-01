/**
 * How much login the reader's own browser is holding — a survey, not a copy.
 *
 * The reader presses one button and this counts what is in the browser they are already using:
 * how many cookies, over how many sites, and how many of those a closed browser may drop. The
 * numbers go back to the page; the cookies themselves never leave the browser, and nothing here
 * is written down — no trace, no log, no file. That is the whole point of doing this as a read of
 * the browser level rather than as a page session: `Storage.getCookies` on the browser socket
 * takes no target, so no tab is created in front of the reader, and nothing about the browser's own
 * state changes.
 *
 * That socket is the host's, not this request's: it is asked for from ./held.ts and left open, so
 * the 「允许远程调试？」 this press causes is the only one the reader has to answer for every task
 * that follows.
 *
 * The three files this route reads are the ones `discoverDailyBrowser` already reads, and the ways
 * it can fail are that route's — same class, same sentences, plus one the files cannot show: a
 * connection this host was holding that has gone away. Only the last step differs: that route
 * resolves `/json/version` and drives a page, while this one opens the browser socket the profile's
 * own `DevToolsActivePort` names and sends one command.
 *
 * The opening half is exported on its own (`openDailyConnection`) because the copy that fills the
 * plugin's own browser with these logins reaches the same browser the same way; see ./login-copy.ts.
 */
import {
  DailyBrowserError,
  dailyFailure,
  dailyProfileDir,
  isPortListening,
  readActivePort,
  remoteDebuggingEnabled,
  wsUrlFromActivePort,
  type BrowserKind,
} from './discover'
import { holdConnection } from './held'

/** The only three things this probe reads off a cookie: where it is, and whether it outlives the browser. */
export interface ProbeCookie {
  /** The domain the browser filed it under. */
  domain?: unknown
  /** Unix seconds, or -1 for a cookie with no expiry. */
  expires?: unknown
  /** The browser's own statement that it has no expiry. */
  session?: unknown
}

/** One site in the answer: a domain name and how many cookies sit under it. */
export interface LoginProbeSite {
  domain: string
  count: number
}

/** What the probe found: counts and domain names, and nothing a cookie is. */
export interface LoginProbeSummary {
  total: number
  /** How many distinct domains the cookies span. */
  sites: number
  /** How many are session cookies — the ones a closed browser may drop. */
  sessionCookies: number
  /** One entry per domain, longest list first. */
  bySite: LoginProbeSite[]
}

/** The name a cookie with no domain is counted under; it is still one cookie. */
export const NO_DOMAIN = '（没有域名）'

/**
 * Fold a browser's cookie list into the four numbers the page shows.
 *
 * Pure, and the only place a cookie is looked at: the count, the site it belongs to, and whether
 * it has an expiry. Everything else on a cookie — its name, its value, its flags — is never read
 * here, which is what makes it impossible for one to reach the answer.
 */
export function summarizeLoginProbe(cookies: readonly ProbeCookie[]): LoginProbeSummary {
  const counts = new Map<string, number>()
  let sessionCookies = 0
  for (const cookie of cookies) {
    const domain =
      typeof cookie.domain === 'string' && cookie.domain.trim() !== '' ? cookie.domain.trim() : NO_DOMAIN
    counts.set(domain, (counts.get(domain) ?? 0) + 1)
    if (isSessionCookie(cookie)) sessionCookies += 1
  }
  const bySite = [...counts].map(([domain, count]) => ({ domain, count }))
  // Most cookies first; the name breaks a tie so the same cookies always produce the same list.
  bySite.sort((left, right) => right.count - left.count || left.domain.localeCompare(right.domain))
  return { total: cookies.length, sites: bySite.length, sessionCookies, bySite }
}

/**
 * Whether a closed browser may drop this cookie.
 *
 * A session cookie is one with no expiry, and the protocol says so twice: `session: true`, or an
 * `expires` of -1. Either statement is enough, and a cookie that carries neither — nothing parsed
 * out of the answer — counts as one too, because "no expiry recorded" is the fact being asked for.
 */
function isSessionCookie(cookie: ProbeCookie): boolean {
  if (cookie.session === true) return true
  const expires = typeof cookie.expires === 'number' ? cookie.expires : 0
  return !(expires > 0)
}

/**
 * The cookies out of one `Storage.getCookies` answer; anything else is no cookies at all.
 *
 * Generic because two readers look at the same answer for different reasons: the probe reads three
 * fields off a cookie, while the copy that fills the plugin's own browser needs the whole thing.
 * The default stays the narrow one, so nothing the probe does changes here.
 */
export function cookiesFrom<T = ProbeCookie>(answer: unknown): T[] {
  const cookies = (answer as { cookies?: unknown } | null | undefined)?.cookies
  return Array.isArray(cookies) ? (cookies as T[]) : []
}

/** One browser-level DevTools socket, narrowed to what this probe does with it. */
export interface ProbeConnection {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>
  close(): void
}

/** How a socket is opened. Injectable, because a test must never touch a real browser. */
export type ProbeConnector = (wsUrl: string) => Promise<ProbeConnection>

/** One open socket to the reader's own browser, and the address it was opened at. */
export interface DailyConnection {
  connection: ProbeConnection
  /** The browser-level socket address, named so a caller can tell two browsers apart. */
  wsUrl: string
  /**
   * True when this is the host's connection rather than one this call opened.
   *
   * A held connection is the reader's one allowed permission, and putting it away at the end of a
   * probe or a copy would make the next task ask for it again — so the caller must leave it alone.
   */
  held: boolean
}

/**
 * The real connector — a browser-level WebSocket with no timeout at all — is the holder's
 * (`held.ts`). It is not written down here any more, because nothing opens one directly: every path
 * asks the holder for the connection the reader already allowed.
 */

/** What this probe reads off the machine, and how it reaches the browser. */
export interface LoginProbeOptions {
  /** Which browser's profile to read. */
  kind: BrowserKind
  /** The profile root, when 数据目录 names one. Defaults to the standard location. */
  profileDir?: string
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  home?: string
  /** The socket to use. Defaults to the real one; a test supplies its own. */
  connect?: ProbeConnector
}

/**
 * Reach the reader's own browser at the browser level, or say which of the five things is wrong.
 *
 * Split out of `probeDailyLogins` because the copy that fills the plugin's own browser starts the
 * same way — same files, same failures, same socket — and then does something else with it. Both
 * callers get the same `DailyBrowserError`, because one place for the wording is what keeps the two
 * routes from drifting apart.
 *
 * There is only one socket behind this: the reader's connection is asked for from the holder rather
 * than opened here, so a probe and a task cannot each raise 「允许远程调试？」. A caller that supplies
 * its own connector is opening its own socket, and owns putting it away (that is the only thing
 * `connect` is for, and it is what the tests use it as).
 *
 * The address comes back with the connection so a caller can tell whether it has reached the same
 * browser twice, which is a question the copy has to answer before it writes anything.
 */
export async function openDailyConnection(options: LoginProbeOptions): Promise<DailyConnection> {
  const { kind } = options
  const dir = options.profileDir ?? dailyProfileDir(kind, options)
  if ((await remoteDebuggingEnabled(dir)) !== true) throw dailyFailure(kind, 'switch-off')

  const active = await readActivePort(dir)
  if (active === null) throw dailyFailure(kind, 'no-port')
  // A port with no socket path is not an address; it is the same nothing as no port at all.
  const wsUrl = wsUrlFromActivePort(active)
  if (wsUrl === null) throw dailyFailure(kind, 'no-port')

  // A file a closed browser left behind is not an instance: the port has to answer, or the next
  // step would be waiting on a permission box that cannot exist.
  if (!(await isPortListening(active.port))) throw dailyFailure(kind, 'not-running')

  if (options.connect !== undefined) {
    try {
      const connection = await options.connect(wsUrl)
      return { connection, wsUrl, held: false }
    } catch {
      throw dailyFailure(kind, 'not-authorized')
    }
  }

  try {
    // A browser-level connection is a connection: it is what raises 「允许远程调试？」 and what a
    // later page load may report as "this host has already been here" — see ./attached.ts and
    // ./held.ts, which notes it and keeps it.
    const connection = await holdConnection(wsUrl, { route: 'daily', kind })
    return { connection, wsUrl, held: true }
  } catch (error) {
    // The holder's own sentence — "the connection you were holding went away, press 重新连接" — is
    // the answer for that case and is left exactly as it is. Everything else that failed here is a
    // handshake the reader did not allow.
    if (error instanceof DailyBrowserError) throw error
    throw dailyFailure(kind, 'not-authorized')
  }
}

/**
 * Count what the reader's own browser is holding, and take nothing away from it.
 *
 * The failures are `discoverDailyBrowser`'s, in the same words: the profile's switch, the port it
 * wrote down, whether that port still answers, whether this connection was allowed, and — the one
 * that is not a file — a connection this host was holding that has since gone away. A socket that
 * cannot be opened at all is the fourth of those: refusing the box, or closing the browser before it
 * was answered, arrives here the same way.
 */
export async function probeDailyLogins(options: LoginProbeOptions): Promise<LoginProbeSummary> {
  const daily = await openDailyConnection(options)
  try {
    // No `browserContextId`: with none, the command means the whole browser. It is a read, and it
    // is the only command sent — nothing here creates a target, and no tab may appear.
    return summarizeLoginProbe(cookiesFrom(await daily.connection.send('Storage.getCookies', {})))
  } finally {
    // The reader's connection stays open — that one permission is meant to cover every later task.
    // Only a socket this call opened itself goes away with the request that opened it.
    if (!daily.held) daily.connection.close()
  }
}
