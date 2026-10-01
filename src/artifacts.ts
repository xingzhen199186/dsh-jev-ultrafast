/**
 * What one run leaves behind on disk: the raw exchanges with the two model services,
 * and — only when screenshots are on — one frame per step together with its timing.
 *
 * Upstream wrote a frame per step when it was handed a record directory, and kept the
 * raw traces in a file it told git to ignore. Both are useful for the same reason: when
 * a run does something surprising, the only honest answer comes from what was actually
 * sent and actually shown, not from a summary written after the fact.
 *
 * Off unless the caller asks. Writing files turns the loop into something with a side
 * effect, and the unit tests drive `runTask` with scripted pages and expect nothing to
 * appear on disk.
 *
 * Nothing here may break a run: every write is best-effort. And no credential is ever
 * written — the callers hand their key in so it is scrubbed out of anything recorded, and
 * the values a login callback leaves in an address are blanked out by `redactUrl` — which
 * is the one promise this plugin makes about secrets.
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Where one call's raw exchange goes. The loop passes this down; nothing else reads it. */
export interface TraceSink {
  write(record: Record<string, unknown>): void
}

/** Bodies are the bulk of a trace, and a page snapshot is big; 20k characters is plenty to read. */
const MAX_BODY = 20_000

export interface RunArtifacts {
  /** The run's own directory, reported to the user so they can open it. */
  dir: string
  trace: TraceSink
  /**
   * One frame of the controlled browser, base64 JPEG, taken after the step it belongs to.
   * Ignored when frames are off. `step` 0 is the page the run started on, and `action` is the
   * short name of what the step did (see `frameAction`), which is also what the file is named
   * after.
   */
  frame(jpeg: unknown, step: number, action: string, atMs: number): void
  /** Last word: the frame manifest with the run's total length. */
  finish(runMs: number): void
}

/**
 * The short English name a frame carries for the step that produced it.
 *
 * The step number is what a reader comes looking for — "what did step 3 look like" — and the
 * action is what turns a wall of numbered files into something skimmable. The names come from a
 * closed set, so nothing a page (or a model) says can end up in a file name.
 */
const FRAME_ACTIONS: Record<string, string> = {
  click: 'click',
  fill: 'type',
  select: 'select',
  press_key: 'press',
  scroll: 'scroll',
  wait: 'wait',
}

/** `frameAction`, for a kind this plugin does not have a word for: an action still happened. */
export function frameAction(kind: string): string {
  return FRAME_ACTIONS[kind] ?? 'act'
}

/**
 * Open the directory for one run.
 *
 * `frames` mirrors the settings page's screenshot switch: that switch already made every
 * observation carry a JPEG, and until now nothing kept it. One frame per step is what
 * makes a run reviewable afterwards, so it is the same switch rather than a new one.
 */
export function openArtifacts(frames: boolean): RunArtifacts {
  // A short random tail as well as the clock: two runs started in the same millisecond
  // would otherwise share a directory and interleave their frames.
  const dir = join(tmpdir(), 'dsh-jev-ultrafast', `run-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`)
  const framesDir = join(dir, 'frames')
  try {
    mkdirSync(frames ? framesDir : dir, { recursive: true })
  } catch {
    // A directory we cannot create is a run without artifacts, not a failed run.
  }

  const traceFile = join(dir, 'trace.jsonl')
  const manifest = join(dir, 'frames.json')
  const kept: Array<{ file: string; step: number; action: string; at_ms: number }> = []

  const trace: TraceSink = {
    write(record) {
      try {
        appendFileSync(traceFile, `${JSON.stringify(record)}\n`)
      } catch {
        // Diagnostics never fail a run.
      }
    },
  }

  return {
    dir,
    trace,
    frame(jpeg, step, action, atMs) {
      if (!frames || typeof jpeg !== 'string' || !jpeg) return
      // Named by the step it belongs to, so the question a reader actually has — did this
      // picture come before or after the key press on step 3? — is answered by the file name
      // itself. The three-digit padding keeps them in step order on disk.
      const file = `step-${String(step).padStart(3, '0')}-${action}.jpg`
      try {
        writeFileSync(join(framesDir, file), Buffer.from(jpeg, 'base64'))
        kept.push({ file, step, action, at_ms: atMs })
        writeFileSync(manifest, JSON.stringify({ frames: kept }, null, 2))
      } catch {
        // Same as above: a frame we could not write is not a reason to stop working.
      }
    },
    finish(runMs) {
      if (!frames) return
      try {
        writeFileSync(manifest, JSON.stringify({ run_ms: runMs, frames: kept }, null, 2))
      } catch {
        // Best-effort.
      }
    },
  }
}

/**
 * Parameter names whose value is a credential wearing a different hat. A login callback
 * arrives with one of these in the address bar — `?code=…` is an authorization code — and
 * the address is what a trace keeps for every step, so these are the names `redactUrl`
 * blanks out.
 */
const SECRET_PARAMETERS = new Set([
  'code',
  'access_token',
  'id_token',
  'refresh_token',
  'token',
  'assertion',
  'client_secret',
  'session_state',
  'api_key',
  'apikey',
  'sig',
  'signature',
  'auth',
  'authorization',
  'password',
  'passwd',
  'pwd',
  'secret',
])

/**
 * Blank out the value of every credential-carrying parameter in `text`, in the query
 * string and in the fragment alike. Pure, and deliberately narrow: a parameter only
 * counts when it follows `?`, `&` or `#` and is followed by `=`, and only the exact
 * names above match — `score`, `codex` and `key` are not touched. The name's own case is
 * ignored (`?CODE=` is blanked, and keeps its spelling); a parameter written without a
 * value (`?code`) has nothing to blank and comes back as it was.
 */
export function redactUrl(text: string): string {
  return text.replace(/([?&#])([A-Za-z0-9_.-]+)=([^&#\s"'<>]*)/g, (whole, separator: string, name: string) =>
    SECRET_PARAMETERS.has(name.toLowerCase()) ? `${separator}${name}=REDACTED` : whole,
  )
}

/**
 * Every string inside a recorded body, through `redactUrl`.
 *
 * The address a step was on is not a field of its own in a trace: the decision request
 * carries it inside `state.page.url`, and a service's own answer can carry addresses of
 * its own, so blanking "the url field" would miss both. Walking the body is what makes
 * the promise true for every address, wherever it sits. Values that are not plain
 * objects or arrays are handed back untouched, so `JSON.stringify` still sees the dates
 * and buffers it already knew what to do with.
 */
function redactDeep(value: unknown): unknown {
  if (typeof value === 'string') return redactUrl(value)
  if (Array.isArray(value)) return value.map(redactDeep)
  if (value !== null && typeof value === 'object') {
    const proto: unknown = Object.getPrototypeOf(value)
    if (proto === Object.prototype || proto === null) {
      const walked: Record<string, unknown> = {}
      for (const [key, item] of Object.entries(value)) walked[key] = redactDeep(item)
      return walked
    }
  }
  return value
}

/**
 * Make a value safe to write into a trace: JSON-shaped, every address in it stripped of
 * the credentials a login callback leaves in the URL, scrubbed of one key, and cut off if
 * it is enormous. The credential is passed rather than found here so that this module
 * never needs to know where a key comes from.
 */
export function recordable(value: unknown, secret?: string): unknown {
  let text: string
  try {
    text = JSON.stringify(redactDeep(value)) ?? 'null'
  } catch {
    return '[无法序列化的内容]'
  }
  if (secret) text = text.split(secret).join('***')
  if (text.length > MAX_BODY) return `${text.slice(0, MAX_BODY)}…（原是 ${text.length} 字，已截断）`
  return JSON.parse(text) as unknown
}
