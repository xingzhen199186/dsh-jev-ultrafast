/**
 * The contract between the plugin's two halves.
 *
 * The settings page (browser) asks; the host answers. Everything here is a plain
 * constant or a plain type, so both bundles can import it: the node half registers
 * a route under `ROUTE`, the browser half fetches it, and neither has to remember
 * a string the other one wrote.
 */

/** Route prefix the host half registers, and the page prefixes its fetches with. */
export const ROUTE = '/jev-ultrafast'

/**
 * Where the inspector page lives, under the same prefix as everything else here.
 *
 * Both halves need it: the settings page draws a button to it, and the slash command names
 * it in words. One string, so a rename cannot leave one of them pointing at nothing.
 */
export const INSPECTOR_PATH = ROUTE + '/inspector'

/**
 * The inspector's full address on whichever host is showing the page.
 *
 * Built from the origin in front of the reader rather than from a port written down here:
 * `dsh web` and the desktop app listen on different ports, and a page that guessed would
 * send half its readers nowhere.
 */
export function inspectorUrl(origin: string): string {
  return new URL(INSPECTOR_PATH, origin).toString()
}

/** Header carrying the per-boot token; the host also accepts `?token=`. */
export const TOKEN_HEADER = 'x-jev-ultrafast-token'

/** Global the host injects the token into, for the page to read. */
export const TOKEN_GLOBAL = '__JEV_ULTRAFAST_TOKEN__'

/** The cordis row this plugin's settings belong to: the bundle's package name. */
export const ENTRY_ID = 'dsh-jev-ultrafast'

/**
 * Where a browser stands, judged from what is on this machine rather than by connecting to it.
 *
 * `switch-off`, `no-port`, `not-running` and `listening` are the four things the reader's own
 * browser says about itself in the files it writes: the switch is off, the switch is on with no port
 * written down, the port file is there but nobody is listening, or the port is there and answers.
 * `pinned` is a browser named by hand (the `cdpUrl` setting or the environment), where whether it
 * can be reached is not this machine's to answer.
 *
 * It lives here rather than next to the reading code because it is a contract: the page draws a
 * different line for each one, and both halves have to mean the same thing by the same word.
 */
export type BrowserLocalState = 'switch-off' | 'no-port' | 'not-running' | 'listening' | 'pinned'

/**
 * Whether the host is holding a live connection to a browser.
 *
 * `idle` is "nothing held" rather than "it failed": this host may simply not have connected yet.
 * `disconnected` is the one that matters to the page — a connection the host *was* holding went
 * away, and the host will not open another one on its own. It lives here because it is a contract:
 * the page draws a different verdict and a different button for each value, and the host's answer
 * has to mean the same thing by the same word.
 */
export type BrowserHeldState = 'idle' | 'connected' | 'disconnected'

/** What is held right now, if anything. Never a credential or a cookie: addresses and sentences only. */
export interface BrowserHeldReport {
  state: BrowserHeldState
  /** The WebSocket address the connection was opened at, when one was. */
  endpoint?: string
  /** Milliseconds since the epoch: when this connection was established. */
  connectedAt?: number
  /** Why it went away, in the browser's own words, when it did. */
  reason?: string
}

/**
 * Where the browser stands, and only what can be said without connecting to it.
 *
 * The page asks this on open, and the whole shape follows from that: connecting is what makes
 * Chrome/Edge 144+ ask 「允许远程调试？」, so a status line must never be the reason for a connection.
 * Nothing here claims a version, a page title or an element count — none of those exist without a
 * connection — and `attached` is the one field that carries connected-after information, present
 * only when this host really did connect during this run.
 */
export interface BrowserReport {
  /** Which of the five local states this is. See `BrowserLocalState`. */
  state: BrowserLocalState
  /** Which route this judgement is about: the plugin's own, or the reader's. */
  connection: 'plugin' | 'daily'
  /** The address the local state named, when it named one. */
  endpoint?: string
  /** Where that address came from: setting, environment, the browser's own file, a default port. */
  source?: string
  /** The last connection this host really made on this route, if it made one. */
  attached?: { endpoint: string; at: number }
  /** What this host is holding open for this route right now. Pure memory: reading it connects to nothing. */
  held: BrowserHeldReport
  /** The state in words, as one or more sentences with no connected-only claim in them. */
  message: string
}

/**
 * What the browser block's connect button did, on the route the reader is already using.
 *
 * A failed connect is an answer, not an error response: "it asked, and this is what the browser
 * said" is exactly what the reader needs to see, and it is also what the button is for.
 */
export interface ConnectReport {
  ok: boolean
  /** The state line as it stands after the attempt, so the page never has to ask twice. */
  browser: BrowserReport
  /** Why it could not connect, in the same words a run would use. Absent on success. */
  message?: string
}

/**
 * The words the browser block uses for a held connection, and the button that changes it.
 *
 * They live in the protocol rather than in the page because both halves have to mean the same thing
 * by them (`idle` is not `disconnected`), and because a test can then hold the wording to account
 * without rendering a React tree. `disconnected` keeps the whole phrase because it is the verdict
 * under which the page also says what to do about it.
 */
export const HELD_LABELS: Record<BrowserHeldState, string> = {
  connected: '已连接',
  idle: '未连接',
  disconnected: '连接已断开',
}

/** The connect button before this host has ever connected. */
export const CONNECT_BUTTON = '连接你的浏览器'

/** The same button once a held connection has gone away. */
export const RECONNECT_BUTTON = '重新连接'

/** What that one button says in the state the page is showing. */
export function connectButtonLabel(state: BrowserHeldState): string {
  return state === 'disconnected' ? RECONNECT_BUTTON : CONNECT_BUTTON
}

/**
 * What the browser block's own button did.
 *
 * The launched browser reports where it listens and which profile directory it was given,
 * and carries the probe that followed, so the page can update its state line from this one
 * answer instead of asking again.
 */
export interface LaunchReport {
  kind: 'chrome' | 'edge'
  /** The browser's name, for the sentence the page shows. */
  label: string
  /** The executable that was started, or a note when one from an earlier press was reused. */
  exe: string
  endpoint: string
  profileDir: string
  source: string
  browser: BrowserReport
}

/** Whether one credential reference resolves, from where, and whether the page may write it. Never the value. */
export interface KeyReport {
  credential: string
  configured: boolean
  /** Source layer id: `env`, `file`, `project-env` or `user-env`. */
  source?: string
  /** False while the launching environment supplies it: that layer is read-only. */
  writable: boolean
}

/**
 * Where one credential name stands.
 *
 * The store answers this without ever handing over the value — which is the whole
 * reason a configuration surface can show credential state at all.
 */
export interface KeyState {
  configured: boolean
  source?: string
  writable: boolean
}

/** One credential name the settings page may store a value for, and what it is for. */
export interface StorableKey {
  name: string
  purpose: string
  state: KeyState
}

/**
 * The page inside the reader's own browser that carries 「允许远程调试」.
 *
 * It is a `chrome://`-family address, so nothing on this machine can open it from the
 * outside — a command line cannot reach those pages — which is why it appears in sentences
 * the reader acts on rather than in a call this plugin could make.
 */
export function inspectPageUrl(kind: 'chrome' | 'edge'): string {
  return `${kind === 'chrome' ? 'chrome' : 'edge'}://inspect/#remote-debugging`
}

/**
 * What a run that stopped short gets told when the page it stopped on may want a login.
 *
 * A hint, not a diagnosis: a `blocked` run has many causes, and the one thing the reader
 * cannot see from the report is where their logins live — in a profile of the plugin's own,
 * or in the browser they use every day.
 */
export const LOGIN_HINT =
  '如果卡在要登录的页面：连的是你正在用的浏览器时，登录状态本该就在；连的是插件自己那份数据目录时，它和你日常那个互相独立，' +
  '需要登录的网站得先在它开出来的窗口里登录一次。'

/** Chinese wording for a store source id; an unknown id is shown as it came. */
export function sourceLabel(source: string): string {
  switch (source) {
    case 'env':
      return '启动时的环境变量'
    case 'file':
      return 'DSH 的凭据文件'
    case 'project-env':
      return '启动目录的 .env'
    case 'user-env':
      return '~/.dsh/.env'
    default:
      return source
  }
}

/** One text door the settings page can offer: a plugin preset, or a route DSH serves. */
export interface TextProviderOption {
  /** The value the config holds: a preset id, or `dsh:<provider id>`. */
  id: string
  label: string
  kind: 'preset' | 'dsh'
  /** Model names to offer. Empty when a route publishes no list. */
  models: string[]
}

export interface StatusReport {
  /** Absent when the caller asked to skip the browser probe (`?browser=skip`). */
  browser?: BrowserReport
  /** Which door the decision service is set to, and what that choice comes to. */
  decision: KeyReport & { endpoint: string; model: string; provider: string; providerLabel: string }
  /**
   * Which door the text model is set to, and what that choice comes to.
   *
   * For a built-in route `configured` means the route is one DSH currently serves, not
   * that this plugin holds a key: DSH resolves the credential for its own routes.
   */
  text: KeyReport & { model: string; provider: string; providerLabel: string; kind: 'preset' | 'dsh' }
  /** Every text door the page may offer, DSH's own routes first. */
  providers: TextProviderOption[]
  /** Every name this page is allowed to store a value for, with its current state. */
  keys: StorableKey[]
}

/** One site in the login probe's answer: a domain name and how many cookies sit under it. */
export interface LoginProbeSite {
  domain: string
  count: number
}

/**
 * What the browser block's 「看看能带走多少登录」 button found in the reader's own browser.
 *
 * Counts and domain names only. The cookies themselves stay in that browser — this is a survey of
 * how much login is there, not a copy of it — and the answer exists only in this one response: the
 * probe writes no trace, no log and no file. A failure is a normal answer rather than an error
 * response, because each of the four ways the daily route cannot be reached is something the reader
 * fixes in their own browser; `message` then carries that sentence and every count is zero.
 */
export interface LoginProbeReport {
  ok: boolean
  /** Which browser was probed, so the page's sentence can name it. */
  label: string
  /** How many cookies the browser handed over. */
  total: number
  /** How many distinct domains those cookies span. */
  sites: number
  /** How many are session cookies, which a closed browser may drop. */
  sessionCookies: number
  /** One entry per domain, most cookies first. */
  bySite: LoginProbeSite[]
  /** Why nothing could be read, in the same four sentences the daily route uses. */
  message?: string
}

/**
 * What the browser block's 「把登录灌进插件自己的浏览器」 button did.
 *
 * Counts and domain names only. The cookies were carried straight from one browser to the other and
 * are not in this answer: the page is told how many landed and which domains came up short, never a
 * cookie's name or value. A failure is a normal answer rather than an error response, because the
 * four ways the reader's own browser cannot be reached are things the reader fixes in that browser,
 * and a browser that will not start is a sentence to read rather than a stack trace.
 */
export interface LoginCopyReport {
  ok: boolean
  /** Which browser was read, so the page's sentence can name it. */
  label: string
  /**
   * Domain tally: how many distinct domains were meant to be written, and how many of them came
   * back with exactly the count that was expected.
   */
  domains: { expected: number; landed: number }
  /** How many cookies were read back under those domains. */
  cookiesLanded: number
  /** What was deliberately not written, by reason. */
  skipped: { expired: number; partitioned: number; noDomain: number }
  /** Only the domains whose landed count differs from the expected one, in name order. */
  mismatched: Array<{ domain: string; expected: number; landed: number }>
  /** Why nothing was written, in the same four sentences the daily route uses. */
  message?: string
}

/** One real decision round trip, for the page's connectivity button. */
export interface DecisionTestReport {
  ok: boolean
  model: string
  choice: string
  operation: string
  latencyMs: number
}

/**
 * What one provider answered when asked for its model list.
 *
 * The page shows `models` as the model box's candidates and `note` as the line under it. A failure
 * is not an error response: "the list could not be read" is a normal answer the reader needs to
 * see, because it is also the plainest evidence that the key or the address is wrong.
 */
export interface TextModelReport {
  ok: boolean
  /** Model names, empty when nothing could be read. */
  models: string[]
  /** One sentence for the reader: how many came back, or why none did. */
  note: string
}

/**
 * One real text round trip, for the text block's connectivity button.
 *
 * A failure is reported the way a failing run reports one — as a thrown error the page shows —
 * because the point of the button is exactly that: to hear now what a run would say.
 */
export interface TextTestReport {
  ok: boolean
  model: string
  /** What the door actually answered, kept short. */
  answer: string
  latencyMs: number
}
