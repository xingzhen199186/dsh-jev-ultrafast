/**
 * A page that wants a person: what is recognised, what is not, and what an observation does with it.
 *
 * The check itself is a page-side expression (`browser/challenge.ts`), so it is run here the way the
 * browser runs it — through `new Function`, against a stand-in document that answers only the
 * questions the expression asks. There is no DOM in this project's test environment, so the pages
 * below are built out of the least that can carry a marker: a title, the text of the body, elements
 * with an id or a class, an open shadow root, and a frame whose document is either readable or
 * deliberately unreadable, which is what another origin is.
 *
 * The last group drives a real `BrowserSession` over a scripted CDP connection, because what a
 * challenge is *not* allowed to do — fail an observation — happens in `browser/session.ts` rather
 * than in the expression.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { asChallenge, CHALLENGE_SOURCE, type PageChallenge } from '../src/browser/challenge'
import { clearAttached } from '../src/browser/attached'
import { clearHeld, setHeldConnector, type HeldSocket } from '../src/browser/held'
import { BrowserSession, type PageState } from '../src/browser/session'
import { SNAPSHOT_SOURCE } from '../src/browser/snapshot'

/** One element of a stand-in page: what the check may ask it, and nothing else. */
interface Element {
  id?: string
  classes?: string[]
  tagName?: string
  src?: string
  /** Its text, as a shadow root hands it over. */
  text?: string
  /** Its open shadow root, as a stand-in document of its own. */
  shadow?: StandIn
  /** Its own document, for a frame — or `'cross'`, which is a frame from another origin. */
  frame?: StandIn | 'cross'
}

/** A stand-in document: what the expression reads off the top document, a shadow root or a frame. */
interface StandIn {
  title?: string
  text?: string
  elements?: Element[]
}

/** The selectors the check names, matched the way a browser would: `#id`, `.class`, and comma lists. */
function matches(element: Element, selector: string): boolean {
  return selector.split(',').some((one) => {
    const part = one.trim()
    if (part.startsWith('#')) return element.id === part.slice(1)
    if (part.startsWith('.')) return (element.classes ?? []).includes(part.slice(1))
    return (element.tagName ?? 'DIV').toLowerCase() === part.toLowerCase()
  })
}

/** The stand-in document the expression is handed, with the elements it can find turned into nodes. */
function documentOver(page: StandIn): Record<string, unknown> {
  const found = page.elements ?? []
  const nodes = found.map((element) => ({
    tagName: element.tagName ?? 'DIV',
    src: element.src ?? '',
    textContent: element.text ?? '',
    get shadowRoot() {
      return element.shadow ? documentOver(element.shadow) : null
    },
    get contentDocument() {
      if (element.frame === 'cross') throw new Error('读不到另一个来源的 frame 文档')
      return element.frame ? documentOver(element.frame) : null
    },
  }))
  return {
    title: page.title ?? '',
    textContent: page.text ?? '',
    body: page.text === undefined ? null : { innerText: page.text },
    querySelectorAll: (selector: string) =>
      selector === 'iframe' ? nodes.filter((node) => node.tagName === 'IFRAME') : nodes,
    querySelector: (selector: string) => {
      const index = found.findIndex((element) => matches(element, selector))
      return index < 0 ? null : nodes[index]
    },
  }
}

/** A frame address, as the check reads it off the top document's own iframes. */
function frameAt(src: string): Element {
  return { tagName: 'IFRAME', src }
}

/** The challenge a stand-in page answers with. */
function detect(
  page: StandIn,
  globals: { hcaptcha?: unknown; grecaptcha?: unknown; turnstile?: unknown } = {},
): PageChallenge | null {
  const run = new Function('window', 'document', `return (${CHALLENGE_SOURCE})`)
  return asChallenge(run(globals, documentOver(page)))
}

describe('the page-side check', () => {
  it('is one expression that can be parsed and carries no backtick and no interpolation', () => {
    // The same two properties the snapshot is held to, and for the same reason: the body is injected
    // as text through a raw template, which is byte-faithful only while both are absent.
    expect(CHALLENGE_SOURCE).not.toContain('`')
    expect(CHALLENGE_SOURCE).not.toContain('${')
    expect(() => new Function(`return ${CHALLENGE_SOURCE}`)).not.toThrow()
  })

  it('recognises the Cloudflare interstitial by its own words and its own ids', () => {
    expect(detect({ title: 'Just a moment...', text: 'Verifying you are human' })).toEqual({
      kind: 'cloudflare',
      reason: 'Cloudflare interstitial ("Just a moment")',
    })
    // The wording is not the only marker: the page's own container id says the same thing.
    expect(
      detect({ title: '请稍候', text: '正在检查您的浏览器', elements: [{ id: 'challenge-running' }] }),
    ).toEqual({ kind: 'cloudflare', reason: 'Cloudflare interstitial ("Just a moment")' })
  })

  it('recognises hCaptcha, from the widget, from the script, and from the frame it is served by', () => {
    expect(detect({ elements: [{ classes: ['h-captcha'] }] })?.kind).toBe('hcaptcha')
    expect(detect({ text: '请完成下面的验证' }, { hcaptcha: {} })?.kind).toBe('hcaptcha')
    expect(detect({ elements: [frameAt('https://newassets.hcaptcha.com/captcha/v1/abc')] })?.kind).toBe(
      'hcaptcha',
    )
  })

  it('recognises reCAPTCHA, from the widget, from the script, and from the frame it is served by', () => {
    expect(detect({ elements: [{ classes: ['g-recaptcha'] }] })?.kind).toBe('recaptcha')
    expect(detect({}, { grecaptcha: {} })?.kind).toBe('recaptcha')
    expect(
      detect({
        elements: [frameAt('https://www.google.com/recaptcha/api2/anchor?k=site-key')],
      })?.kind,
    ).toBe('recaptcha')
  })

  it('recognises Turnstile, from the script and from the frame it is served by', () => {
    expect(detect({}, { turnstile: {} })?.kind).toBe('turnstile')
    expect(
      detect({
        elements: [frameAt('https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile')],
      })?.kind,
    ).toBe('turnstile')
  })

  it('recognises the wording a Chinese page uses for the same thing', () => {
    expect(detect({ title: '安全验证', text: '请完成安全验证后继续访问' })?.kind).toBe('generic')
    expect(detect({ title: '人机验证', text: '请输入下方字符' })?.kind).toBe('generic')
  })

  it('reads into an open shadow root and into a same-origin frame to find one', () => {
    expect(detect({ elements: [{ shadow: { text: '请完成安全验证' } }] })?.kind).toBe('generic')
    expect(detect({ elements: [{ tagName: 'IFRAME', frame: { text: 'Just a moment' } }] })?.kind).toBe(
      'cloudflare',
    )
  })

  it('never fails on a frame from another origin, and finds nothing there', () => {
    // Reading `contentDocument` of a cross-origin frame is a throw in a real browser, which is what
    // the stand-in reproduces. The check has to come back with an answer either way.
    expect(detect({ title: '首页', text: '欢迎', elements: [frameAt('https://elsewhere.test/widget')] })).toBeNull()
    expect(
      detect({ elements: [{ tagName: 'IFRAME', frame: 'cross' }] }),
    ).toBeNull()
  })

  it('reports nothing for a page that is simply a page', () => {
    const login = {
      title: '登录',
      text: '用户名 密码 登录 忘记密码',
      elements: [{ tagName: 'INPUT' }, { tagName: 'INPUT' }, { tagName: 'BUTTON' }],
    }
    expect(detect(login)).toBeNull()
    // And a page with no body at all, which is what a document between two of them looks like.
    expect(detect({ title: '', elements: [] })).toBeNull()
  })

  it('is caught by a working login page that merely carries a reCAPTCHA badge', () => {
    // The known misfire, pinned here on purpose: the markers cannot tell a badge standing in a corner
    // from a challenge standing in the way. What keeps that from ending a working run is the loop's
    // own question, asked of what the page still offers the run to do — see `challengeStopping` in
    // `src/loop.ts`, and the run-loop tests beside this file.
    expect(
      detect({
        title: '登录',
        text: '用户名 密码 登录',
        elements: [{ classes: ['g-recaptcha'] }, { tagName: 'INPUT' }, { tagName: 'BUTTON' }],
      })?.kind,
    ).toBe('recaptcha')
  })

  it('reads an answer it cannot use as no challenge at all', () => {
    expect(asChallenge({ blocked: false })).toBeNull()
    expect(asChallenge({ blocked: true })).toBeNull()
    expect(asChallenge({ blocked: true, kind: 'nonsense' })).toBeNull()
    expect(asChallenge({ blocked: true, kind: 'turnstile' })).toEqual({ kind: 'turnstile', reason: 'turnstile' })
    expect(asChallenge(null)).toBeNull()
    expect(asChallenge('blocked')).toBeNull()
    expect(asChallenge(undefined)).toBeNull()
  })
})

/** The page as the session will read it: something to act on, so nothing here depends on the gate. */
function pageState(overrides: Partial<PageState> = {}): PageState {
  return {
    url: 'https://example.test/',
    title: 'Flights',
    w: 1120,
    h: 780,
    text: 'Where from?',
    scroll: { y: 0, height: 1000 },
    actions: [{ id: 'e1', kind: 'click', node: 1, label: 'Search' }],
    marker: ['m'],
    page_key: [],
    guards: {},
    omitted_actions: 0,
    fingerprint: 'fp-1',
    ...overrides,
  }
}

/**
 * One CDP connection, answering the two expressions a look sends: the snapshot, and the check.
 *
 * They are told apart by their own text, so what this stands in for is exactly what the session sends
 * — a test that changed one of the two would fail here rather than quietly pass.
 */
class ScriptedPage implements HeldSocket {
  /** The page the snapshot answers with. */
  readonly state = pageState()
  /** What the check answers with, when it answers. */
  challenge: unknown = { blocked: true, kind: 'cloudflare', reason: 'Cloudflare interstitial ("Just a moment")' }
  /** Whether the check throws instead of answering, which is what a page that navigated mid-read does. */
  challengeFails = false

  async send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    if (method === 'Target.createTarget') return { targetId: 'target-1' } as T
    if (method === 'Target.attachToTarget') return { sessionId: 'session-1' } as T
    if (method === 'Runtime.evaluate') {
      const expression = String(params?.expression ?? '')
      if (expression === CHALLENGE_SOURCE) {
        if (this.challengeFails) throw new Error('这个替身读不了这一页')
        return { result: { value: this.challenge } } as T
      }
      if (expression === SNAPSHOT_SOURCE) return { result: { value: this.state } } as T
      return { result: { value: 'complete' } } as T
    }
    return {} as T
  }

  onClose(): () => void {
    return () => {}
  }

  close(): void {}
}

/** A session attached over the scripted page. */
async function attached(): Promise<{ session: BrowserSession; connection: ScriptedPage }> {
  const connection = new ScriptedPage()
  setHeldConnector(async () => connection)
  const session = await BrowserSession.open('https://example.test/', {
    cdpUrl: 'ws://127.0.0.1:9222/devtools/browser/challenge',
    connection: 'daily',
  })
  return { session, connection }
}

afterEach(() => {
  // The holder is module state: a connection left in it would decide the next test.
  clearHeld()
  setHeldConnector(null)
  clearAttached()
})

describe('what an observation carries', () => {
  it('rides the challenge along with the page, beside everything the page always had', async () => {
    const { session, connection } = await attached()
    try {
      const page = await session.observe()

      expect(page.challenge).toEqual({
        kind: 'cloudflare',
        reason: 'Cloudflare interstitial ("Just a moment")',
      })
      expect(page.text).toBe(connection.state.text)
      expect(page.fingerprint).toBeTruthy()
      expect(page.actions).toHaveLength(1)
    } finally {
      await session.close()
    }
  })

  it('carries nothing when the check cannot answer, and still reads the page', async () => {
    const { session, connection } = await attached()
    connection.challengeFails = true
    try {
      const page = await session.observe()

      expect(page.challenge).toBeUndefined()
      expect(page.text).toBe('Where from?')
      expect(page.actions).toHaveLength(1)
    } finally {
      await session.close()
    }
  })

  it('leaves the field off entirely on a page that has no challenge', async () => {
    const { session, connection } = await attached()
    connection.challenge = { blocked: false }
    try {
      const page = await session.observe()

      expect(page.challenge).toBeUndefined()
      // Absent, not present-and-empty: nothing downstream has to tell "no challenge" from "not asked".
      expect(Object.keys(page)).not.toContain('challenge')
    } finally {
      await session.close()
    }
  })
})
