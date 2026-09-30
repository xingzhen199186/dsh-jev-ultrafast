/**
 * The second route: read a page from top to bottom.
 *
 * The decision loop only ever sees the current screen. That is deliberate — the in-page
 * snapshot drops every line that is off screen and caps what is left at 6000 characters,
 * and that same text is sent with *every* decision request, so widening it would raise the
 * price of every single step. Reading a long document is a different job with a different
 * shape, so it gets its own path here, and it spends no decision request at all.
 *
 * The method is the one the page itself understands:
 *
 *   1. collect the visible text of the screen it is on,
 *   2. scroll down by less than a viewport, so the screens overlap,
 *   3. collect again and drop the lines the two screens share,
 *   4. repeat until the bottom, or until a cap says stop.
 *
 * The overlap is what makes the stitching reliable: a text node that straddles the fold is
 * reported *whole* by both screens (the walker pushes a node's whole text once any part of
 * it is on screen), so the two screens share whole lines rather than half-lines, and the
 * shared tail is exactly what must not be written twice.
 */
import type { BrowserPort, PageState } from './session'
import { BrowserSession } from './session'
import type { DiscoverOptions } from './discover'
import { WHEEL } from './act'

/** What one screen contributed to the whole. */
export interface ReadScreen {
  /** 1-based, in collection order. */
  index: number
  /** Scroll offset this screen was read at. */
  y: number
  /** Lines on screen, how many of them the previous screens did not already have, and the shared tail. */
  lines: number
  added: number
  overlap: number
  /** Running total of characters after this screen. */
  chars: number
  atBottom: boolean
  /** Sat exactly on the snapshot's 6000-character ceiling, so this screen may be cut short. */
  capped: boolean
}

/** Why the reading stopped. */
export type ReadStop = 'bottom' | 'screens' | 'chars' | 'stalled' | 'cancelled' | 'error'

export interface ReadOptions {
  url: string
  browser?: DiscoverOptions
  /** Stop after this many screens. Defaults to 20. */
  maxScreens?: number
  /** Stop once this many characters have been collected. Defaults to 60000. */
  maxChars?: number
  signal?: AbortSignal
}

/** The one thing reading needs from the outside world; a test replaces it with a scripted page. */
export interface ReadDeps {
  open: (url: string, options?: DiscoverOptions) => Promise<BrowserPort>
}

export interface ReadResult {
  url: string
  title: string
  text: string
  chars: number
  screens: ReadScreen[]
  stop: ReadStop
  /** Why it stopped, in the user's language. */
  reason: string
  /** How many screens sat on the 6000-character ceiling. */
  capped: number
}

export const DEFAULT_MAX_SCREENS = 20
export const DEFAULT_MAX_CHARS = 60_000

/** The snapshot's own ceiling, in `viewportText` inside SNAPSHOT_SOURCE. */
const SNAPSHOT_CEILING = 6000
/** The scroll step the snapshot offers as `scroll_down`; smaller than the viewport, on purpose. */
const SCREEN_STEP = 560

const REAL_DEPS: ReadDeps = {
  open: (url, options) => BrowserSession.open(url, options),
}

/** The snapshot's text is one text node per line, already trimmed; blank lines carry nothing. */
export function toLines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

/**
 * What to append from the next screen: everything after the longest run of lines that the
 * two screens share, tail against head. A whole screen that repeats adds nothing.
 */
export function stitchLines(accumulated: string[], incoming: string[]): { added: string[]; overlap: number } {
  const longest = Math.min(accumulated.length, incoming.length)
  for (let size = longest; size > 0; size -= 1) {
    let same = true
    for (let index = 0; index < size; index += 1) {
      if (accumulated[accumulated.length - size + index] !== incoming[index]) {
        same = false
        break
      }
    }
    if (same) return { added: incoming.slice(size), overlap: size }
  }
  return { added: incoming, overlap: 0 }
}

/** Send one wheel step to the page, at the fixed point the snapshot uses. Scroll position is not a target. */
function wheel(session: BrowserPort): Promise<unknown> {
  return session.call('Input.dispatchMouseEvent', {
    type: 'mouseWheel',
    x: WHEEL.x,
    y: WHEEL.y,
    deltaX: 0,
    deltaY: SCREEN_STEP,
  })
}

/**
 * Read one page to the bottom. Like the task loop, it never throws for a page it could not
 * read: a browser that will not start and a page that will not scroll both come back as a
 * result with a reason and whatever was collected before it stopped.
 */
export async function readPage(options: ReadOptions, deps: Partial<ReadDeps> = {}): Promise<ReadResult> {
  const open = deps.open ?? REAL_DEPS.open
  const maxScreens = Math.max(1, Math.floor(options.maxScreens ?? DEFAULT_MAX_SCREENS))
  const maxChars = Math.max(1, Math.floor(options.maxChars ?? DEFAULT_MAX_CHARS))
  const lines: string[] = []
  const screens: ReadScreen[] = []
  let session: BrowserPort | null = null
  let stop: ReadStop = 'stalled'
  let reason = '页面没有可读的正文'
  let url = options.url
  let title = ''

  try {
    session = await open(options.url, options.browser)
    let page: PageState = await session.observe()
    url = page.url
    title = page.title

    for (;;) {
      if (options.signal?.aborted) {
        stop = 'cancelled'
        reason = '任务已被取消'
        break
      }
      const incoming = toLines(page.text)
      const { added, overlap } = stitchLines(lines, incoming)
      lines.push(...added)
      const atBottom = page.scroll.y + page.h >= page.scroll.height - 2
      screens.push({
        index: screens.length + 1,
        y: page.scroll.y,
        lines: incoming.length,
        added: added.length,
        overlap,
        chars: lengthOf(lines),
        atBottom,
        capped: page.text.length >= SNAPSHOT_CEILING,
      })

      if (atBottom) {
        stop = 'bottom'
        reason = '已到页面底部'
        break
      }
      if (screens.length >= maxScreens) {
        stop = 'screens'
        reason = `到达屏数上限（${maxScreens} 屏），后面还有内容没读`
        break
      }
      if (lengthOf(lines) >= maxChars) {
        stop = 'chars'
        reason = `到达字数上限（${maxChars} 字），后面还有内容没读`
        break
      }

      const before = page.scroll.y
      await wheel(session)
      page = await session.observe()
      if (page.scroll.y <= before) {
        // One more nudge, then one more look. The first wheel after a tab opens is sometimes
        // swallowed while the tab finishes becoming visible — measured on a real browser: lost
        // at a point well inside the viewport, with the very next event moving the page. Until
        // now that cost the whole read: the code looked again but never scrolled again, so a
        // page that would have moved was reported as no longer scrolling.
        await delay(250)
        await wheel(session)
        page = await session.observe()
        if (page.scroll.y <= before) {
          // Either the content sits in a scroll container of its own, or there is really
          // nothing left below. Stop rather than spin here forever.
          stop = 'stalled'
          reason = '页面不再向下滚动（正文可能在一个内部滚动区里，或者上面已经是最后一段）'
          break
        }
      }
    }
  } catch (error) {
    stop = 'error'
    reason = error instanceof Error ? error.message : String(error)
  } finally {
    await session?.close()
  }

  const text = cutTo(lines, maxChars)
  return {
    url,
    title,
    text,
    chars: text.length,
    screens,
    stop,
    reason,
    capped: screens.filter((screen) => screen.capped).length,
  }
}

function lengthOf(lines: string[]): number {
  let total = 0
  for (const line of lines) total += line.length + 1
  return Math.max(0, total - 1)
}

/** Cut at a line boundary, so the text ends where a line ends rather than mid-sentence. */
function cutTo(lines: string[], maxChars: number): string {
  const kept: string[] = []
  let length = 0
  for (const line of lines) {
    const next = kept.length === 0 ? line.length : length + 1 + line.length
    if (next > maxChars) break
    kept.push(line)
    length = next
  }
  if (kept.length === 0 && lines.length > 0) return lines[0]!.slice(0, maxChars)
  return kept.join('\n')
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
