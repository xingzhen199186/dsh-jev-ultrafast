import { describe, expect, it } from 'vitest'
import type { BrowserPort, PageState } from '../src/browser/session'
import { readPage, stitchLines, toLines } from '../src/browser/read'

/**
 * The reading route, tested against a scripted page: what matters here is how screens are
 * stitched and when the reading stops, not how a wheel event reaches a real browser.
 */

function screen(text: string, y: number, height: number): PageState {
  return {
    url: 'https://example.test/doc',
    title: 'Doc',
    w: 1120,
    h: 780,
    text,
    scroll: { y, height },
    actions: [],
    marker: null,
    page_key: [],
    guards: {},
    omitted_actions: 0,
    fingerprint: `f${y}`,
  }
}

function reader(pages: PageState[]) {
  const seen = { scrolled: 0, closed: false, observes: 0 }
  let index = 0
  const session: BrowserPort = {
    async call<T>(): Promise<T> {
      seen.scrolled += 1
      return undefined as T
    },
    async observe(): Promise<PageState> {
      seen.observes += 1
      const page = pages[Math.min(index, pages.length - 1)]!
      index += 1
      return page
    },
    async fresh(): Promise<boolean> {
      return true
    },
    noteInput(): void {},
    async close(): Promise<void> {
      seen.closed = true
    },
  }
  return { seen, deps: { open: async () => session } }
}

const flags = (lines: string[]) => ['one', 'two', 'three', 'four', 'five', 'six', 'seven']

describe('stitching screens', () => {
  it('keeps every line once when consecutive screens share a tail', () => {
    expect(stitchLines(['1', '2', '3'], ['2', '3', '4'])).toEqual({ added: ['4'], overlap: 2 })
    expect(stitchLines(['1', '2'], ['2', '3'])).toEqual({ added: ['3'], overlap: 1 })
  })

  it('adds nothing when a screen repeats the one before it', () => {
    expect(stitchLines(['a', 'b'], ['a', 'b'])).toEqual({ added: [], overlap: 2 })
  })

  it('adds everything when the two screens share nothing', () => {
    expect(stitchLines(['a', 'b'], ['c', 'd'])).toEqual({ added: ['c', 'd'], overlap: 0 })
    expect(stitchLines([], ['c'])).toEqual({ added: ['c'], overlap: 0 })
  })

  it('reads the snapshot text as trimmed, non-empty lines', () => {
    expect(toLines('  a \n\n b\n')).toEqual(['a', 'b'])
  })
})

describe('reading a page', () => {
  it('stitches three overlapping screens into one text and stops at the bottom', async () => {
    const pages = [
      screen(['1', '2', '3', '4'].join('\n'), 0, 1900),
      screen(['4', '5', '6', '7'].join('\n'), 560, 1900),
      screen(['7', '8', '9'].join('\n'), 1120, 1900),
    ]
    const h = reader(pages)
    const result = await readPage({ url: 'https://example.test/doc' }, h.deps)

    expect(result.text).toBe(['1', '2', '3', '4', '5', '6', '7', '8', '9'].join('\n'))
    expect(result.screens.map((s) => s.overlap)).toEqual([0, 1, 1])
    expect(result.stop).toBe('bottom')
    expect(result.reason).toContain('底部')
    expect(result.capped).toBe(0)
    expect(h.seen.closed).toBe(true)
    expect(h.seen.scrolled).toBe(2)
  })

  it('writes a line that two screens share only once', async () => {
    const shared = 'shared line'
    const pages = [
      screen(['head', shared].join('\n'), 0, 1900),
      screen([shared, 'tail'].join('\n'), 560, 1900),
    ]
    const result = await readPage({ url: 'https://example.test/doc' }, reader(pages).deps)

    expect(result.text.split('\n').filter((line) => line === shared)).toHaveLength(1)
    expect(result.text).toBe(['head', shared, 'tail'].join('\n'))
  })

  it('stops at the screen limit and says so', async () => {
    const pages = [
      screen(['1', '2', '3', '4'].join('\n'), 0, 5000),
      screen(['4', '5', '6', '7'].join('\n'), 560, 5000),
      screen(['7', '8', '9'].join('\n'), 1120, 5000),
    ]
    const result = await readPage({ url: 'https://example.test/doc', maxScreens: 2 }, reader(pages).deps)

    expect(result.stop).toBe('screens')
    expect(result.reason).toContain('2 屏')
    expect(result.text).toBe(['1', '2', '3', '4', '5', '6', '7'].join('\n'))
  })

  it('stops at the character limit and cuts at a line boundary', async () => {
    const pages = [screen(['aaaa', 'bbbb', 'cccc'].join('\n'), 0, 5000)]
    const result = await readPage({ url: 'https://example.test/doc', maxChars: 9 }, reader(pages).deps)

    expect(result.stop).toBe('chars')
    expect(result.text).toBe('aaaa\nbbbb')
    expect(result.chars).toBe(9)
  })

  it('stops instead of spinning when the page will not scroll', async () => {
    const pages = [screen(flags([]).join('\n'), 0, 5000)]
    const h = reader(pages)
    const result = await readPage({ url: 'https://example.test/doc' }, h.deps)

    expect(result.stop).toBe('stalled')
    expect(result.reason).toContain('不再向下滚动')
    expect(result.screens).toHaveLength(1)
    // Two wheels, not one: the page ignored the first, so it is nudged once more before the
    // reading gives up — that second chance is what keeps a swallowed event from ending a read.
    expect(h.seen.scrolled).toBe(2)
    expect(h.seen.closed).toBe(true)
  })

  it('tries the wheel again when the first one is ignored', async () => {
    // A real browser swallows the first wheel after a tab opens: measured, nothing moves at a
    // point well inside the viewport while the next event moves the page. Reading on there is
    // the difference between one screen and the rest of the document.
    const pages = [screen('aaaa', 0, 5000), screen('aaaa', 0, 5000), screen('bbbb', 560, 5000)]
    const h = reader(pages)
    const result = await readPage({ url: 'https://example.test/doc' }, h.deps)

    expect(result.text).toContain('aaaa')
    expect(result.text).toContain('bbbb')
    expect(h.seen.scrolled).toBe(4)
  })

  it('counts the screens that sat on the snapshot ceiling', async () => {
    const ceil = 'x'.repeat(6000)
    const result = await readPage({ url: 'https://example.test/doc' }, reader([screen(ceil, 0, 780)]).deps)

    expect(result.stop).toBe('bottom')
    expect(result.capped).toBe(1)
    expect(result.chars).toBe(6000)
  })

  it('reports the browser it could not open instead of throwing', async () => {
    const result = await readPage(
      { url: 'https://example.test/doc' },
      {
        open: async () => {
          throw new Error('浏览器起不来')
        },
      },
    )

    expect(result.stop).toBe('error')
    expect(result.reason).toBe('浏览器起不来')
    expect(result.text).toBe('')
  })
})
