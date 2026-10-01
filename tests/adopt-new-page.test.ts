/**
 * The window a click opened is not thrown away before it says where it is going.
 *
 * `adoptNewPage` remembers every page it has looked at so that a page the run deliberately stayed away
 * from is not reported twice (`browser/session.ts`). A target the browser lists before it has committed
 * a navigation answers with an *empty* address, and it is not a page the run can judge or move onto: it
 * fails the very test that decides whether a page is worth following. Remembering one of those as seen
 * loses it for good, because the "seen" set is what says which pages are new — which is how a window a
 * click opened went missing on 携程 (2026-10): the page the run was on had moved, the new window's
 * address read as an empty string, and from then on every look skipped it.
 *
 * These checks drive the real `adoptNewPage` over a scripted CDP connection: nothing here touches a
 * browser, and the tab bookkeeping it asks for is answered with empty objects.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { clearAttached } from '../src/browser/attached'
import { clearHeld, setHeldConnector, type HeldSocket } from '../src/browser/held'
import { BrowserSession } from '../src/browser/session'

const CDP = 'ws://127.0.0.1:9222/devtools/browser/adopt-new-page'

/** A page target as `Target.getTargets` reports it, with only the fields this code reads. */
interface TargetLike {
  targetId: string
  type: string
  url: string
  title: string
}

/**
 * One CDP connection, answering the tab bookkeeping `BrowserSession.open` and `adoptNewPage` ask for.
 * The page list is a property a test replaces between looks, which is what "a window appeared" and "that
 * window has now landed" are from here.
 */
class ScriptedConnection implements HeldSocket {
  /** What `Target.getTargets` answers with; replaced by a test between looks. */
  pages: TargetLike[] = []

  async send<T = unknown>(method: string): Promise<T> {
    if (method === 'Target.createTarget') return { targetId: 'owned' } as T
    if (method === 'Target.attachToTarget') return { sessionId: 'session-1' } as T
    if (method === 'Target.getTargets') return { targetInfos: this.pages } as T
    // `document.readyState`, which is the one evaluation the open path and a switch make.
    if (method === 'Runtime.evaluate') return { result: { value: 'complete' } } as T
    return {} as T
  }

  onClose(): () => void {
    return () => {}
  }

  close(): void {}
}

const OWNED: TargetLike = { targetId: 'owned', type: 'page', url: 'https://example.test/', title: 'Owned' }

/** A session attached over the scripted connection, with the page list a test can move. */
async function attached(pages: TargetLike[]): Promise<{ session: BrowserSession; connection: ScriptedConnection }> {
  const connection = new ScriptedConnection()
  connection.pages = [...pages]
  setHeldConnector(async () => connection)
  const session = await BrowserSession.open('https://example.test/', { cdpUrl: CDP, connection: 'daily' })
  return { session, connection }
}

afterEach(() => {
  // The holder is module state: a test that left a connection in it would decide the next one.
  clearHeld()
  setHeldConnector(null)
  clearAttached()
})

describe('a window that appeared before it had an address', () => {
  it('is not remembered as seen, so the look that finds it with an address can still follow it', async () => {
    const { session, connection } = await attached([OWNED])
    try {
      // A click opens a window, and the browser lists it before it has committed a navigation.
      connection.pages = [OWNED, { targetId: 'popup', type: 'page', url: '', title: '' }]
      const first = await session.adoptNewPage({ onlyIfSameUrl: true })

      // Nothing to move onto: an address is what decides whether a page is worth following, and this
      // one has none. It is still reported for what it is, so the record of a click that opened a
      // window the run did not follow survives.
      expect(first?.adopted).toBeNull()
      expect(first?.appeared.map((page) => page.url)).toEqual([''])

      // The window then lands where the click was really going. It has never been remembered as seen,
      // so this look finds it as a newcomer and moves onto it.
      connection.pages = [OWNED, { targetId: 'popup', type: 'page', url: 'https://example.test/landed', title: 'Landed' }]
      const second = await session.adoptNewPage({ onlyIfSameUrl: true })

      expect(second?.adopted?.url).toBe('https://example.test/landed')
    } finally {
      await session.close()
    }
  })

  it('leaves a page that already had an address remembered, so it is never reported twice', async () => {
    const landed: TargetLike = {
      targetId: 'tab',
      type: 'page',
      url: 'https://example.test/results',
      title: 'Results',
    }
    const { session, connection } = await attached([OWNED])
    try {
      connection.pages = [OWNED, landed]
      const found = await session.adoptNewPage({ onlyIfSameUrl: false })

      expect(found?.adopted).toBeNull()
      expect(found?.appeared.map((page) => page.url)).toEqual(['https://example.test/results'])

      const again = await session.adoptNewPage({ onlyIfSameUrl: true })
      expect(again).toBeNull()
    } finally {
      await session.close()
    }
  })

  it('reports a window that never gets an address on every look, rather than forgetting it happened', async () => {
    // The cost of leaving such a page out of the record, stated as the behaviour it is: while it stays
    // addressless it is a newcomer every time. A window the run cannot name is not one it can judge or
    // move onto, so what the record is worth here is that the window was opened at all.
    const { session, connection } = await attached([OWNED])
    try {
      const blank: TargetLike = { targetId: 'popup', type: 'page', url: '', title: '' }
      connection.pages = [OWNED, blank]

      expect((await session.adoptNewPage({ onlyIfSameUrl: true }))?.appeared).toHaveLength(1)
      expect((await session.adoptNewPage({ onlyIfSameUrl: true }))?.appeared).toHaveLength(1)
    } finally {
      await session.close()
    }
  })
})
