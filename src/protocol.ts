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

/** Whether a browser could be reached, and what it was. */
export interface BrowserReport {
  ok: boolean
  /** HTTP base URL of the DevTools endpoint that answered. */
  endpoint?: string
  /** Version string the endpoint reported, for example `Chrome/140.0.7339.128`. */
  version?: string
  /** Where the endpoint was found: setting, environment, browser file, default port. */
  source?: string
  title?: string
  /** How many operatable elements the test page offered. */
  elements?: number
  /** Why it failed, in the words the discovery code would use. */
  message?: string
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
