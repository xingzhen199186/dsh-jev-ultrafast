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
  /** Every target this session attached to, in order — which is how it moves onto a page. */
  attachedTo: string[] = []

  async send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    if (method === 'Target.createTarget') return { targetId: 'owned' } as T
    if (method === 'Target.attachToTarget') {
      const targetId = params?.targetId
      if (typeof targetId === 'string') this.attachedTo.push(targetId)
      return { sessionId: 'session-1' } as T
    }
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

/**
 * Which of several newcomers one step moves onto.
 *
 * The look returns every page target this session has not seen, not only the ones this click opened,
 * so two windows can be listed for one step and the older of them can be the page the step was aiming
 * at — which is how the run these fixtures come from moved onto an ad page instead of the hotel list
 * it had been sent to (携程, 2026-10). These checks pin the choice made when the caller says what it
 * was aiming at, the choice made when it says nothing, and the cases the rule must leave alone.
 */
const AD = { targetId: 'ad', type: 'page', url: 'https://ct.ctrip.com/official?ctm_ref=xckbb', title: '携程商旅_差旅管理_TMC商旅平台' }
const HOTELS = {
  targetId: 'hotels',
  type: 'page',
  url: 'https://hotels.ctrip.com/hotels/list?city=1&landmark=2501722&v2_mod=73&v2_version=E',
  title: '北京酒店,北京酒店预订查询,北京宾馆住宿【携程酒店】',
}
/** The step's own account of what it was doing: the element it acted on, and the goal. */
const AIMED_AT = 'link 在携程网上找一家距离「中关村生命科学园」（北京昌平）最近的酒店，会跳到酒店列表页'

describe('several windows appeared at once', () => {
  it('moves onto the one the step was aiming at', async () => {
    const { session, connection } = await attached([OWNED])
    try {
      // The hotel list page was opened by the step before and was left without an address then, so it
      // is a newcomer again; the ad page is what the step that looked opened. Both are listed.
      connection.pages = [OWNED, HOTELS, AD]
      const found = await session.adoptNewPage({ onlyIfSameUrl: true, aimedAt: AIMED_AT })

      expect(found?.adopted?.url).toBe(HOTELS.url)
      expect(found?.appeared.map((page) => page.url)).toEqual([HOTELS.url, AD.url])
      expect(connection.attachedTo.at(-1)).toBe(HOTELS.targetId)
    } finally {
      await session.close()
    }
  })

  it('stays where it is when none of them is what the step was aiming at', async () => {
    // Staying put is the point: the run keeps a page it can read and can try again from, where
    // following a page nothing connects to the goal hands it to whatever the site felt like opening.
    const { session, connection } = await attached([OWNED])
    try {
      const one = { targetId: 'one', type: 'page', url: 'https://ads.test/one', title: 'One' }
      const two = { targetId: 'two', type: 'page', url: 'https://ads.test/two', title: 'Two' }
      connection.pages = [OWNED, one, two]
      const found = await session.adoptNewPage({ onlyIfSameUrl: true, aimedAt: AIMED_AT })

      expect(found?.adopted).toBeNull()
      // Both are still reported, so the record of a click that opened windows survives the choice.
      expect(found?.appeared.map((page) => page.url)).toEqual([one.url, two.url])
      expect(connection.attachedTo.at(-1)).toBe('owned')
    } finally {
      await session.close()
    }
  })

  it('stays where it is when two of them are just as close to the goal as each other', async () => {
    const { session, connection } = await attached([OWNED])
    try {
      const a = { targetId: 'a', type: 'page', url: 'https://one.test/hotel', title: '酒店' }
      const b = { targetId: 'b', type: 'page', url: 'https://two.test/hotel', title: '酒店' }
      connection.pages = [OWNED, a, b]
      const found = await session.adoptNewPage({ onlyIfSameUrl: true, aimedAt: '找一个酒店' })

      expect(found?.adopted).toBeNull()
      expect(found?.appeared).toHaveLength(2)
    } finally {
      await session.close()
    }
  })

  it('follows the only one it could move onto, whatever it is and whenever it is asked', async () => {
    // Nothing to choose between, so nothing to decide: one newcomer is followed as it always was,
    // and which page it is does not come into it — the ad page here is shared by all of these
    // fixtures precisely because it is the one nobody would pick.
    const { session, connection } = await attached([OWNED])
    try {
      connection.pages = [OWNED, AD]
      const aimed = await session.adoptNewPage({ onlyIfSameUrl: true, aimedAt: AIMED_AT })
      expect(aimed?.adopted?.url).toBe(AD.url)

      const elsewhere = { targetId: 'elsewhere', type: 'page', url: 'https://elsewhere.test/x', title: 'Elsewhere' }
      connection.pages = [OWNED, AD, elsewhere]
      const silent = await session.adoptNewPage({ onlyIfSameUrl: true })

      expect(silent?.appeared.map((page) => page.url)).toEqual([elsewhere.url])
      expect(silent?.adopted?.url).toBe(elsewhere.url)
    } finally {
      await session.close()
    }
  })

  it('picks up a window that was blank when it was first seen and can still be chosen once it lands', async () => {
    // The previous rule's own case, kept working under this one: a blank window is not remembered, so
    // it is a newcomer when it lands — and when it lands in the same look as another window, it is the
    // relevance rule that has to choose it rather than the order the browser happened to list them.
    const { session, connection } = await attached([OWNED])
    try {
      connection.pages = [OWNED, { targetId: 'popup', type: 'page', url: '', title: '' }]
      expect((await session.adoptNewPage({ onlyIfSameUrl: true, aimedAt: AIMED_AT }))?.adopted).toBeNull()

      connection.pages = [OWNED, AD, { ...HOTELS, targetId: 'popup' }]
      const found = await session.adoptNewPage({ onlyIfSameUrl: true, aimedAt: AIMED_AT })

      expect(found?.adopted?.url).toBe(HOTELS.url)
      expect(connection.attachedTo.at(-1)).toBe('popup')
    } finally {
      await session.close()
    }
  })

  it('falls back to the last one of them when no step says what it was aiming at', async () => {
    // What "off" means, exactly: the choice the browser made before any of this existed, on the very
    // windows where the relevance rule would have chosen otherwise.
    const { session, connection } = await attached([OWNED])
    try {
      connection.pages = [OWNED, HOTELS, AD]
      const found = await session.adoptNewPage({ onlyIfSameUrl: true })

      expect(found?.adopted?.url).toBe(AD.url)
      expect(connection.attachedTo.at(-1)).toBe('ad')
    } finally {
      await session.close()
    }
  })
})
