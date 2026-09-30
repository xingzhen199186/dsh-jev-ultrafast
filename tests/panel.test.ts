import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import type { Config as ConfigShape } from '../src/config'
import { Config } from '../src/index'
import { registerPanel } from '../src/panel'
import { ROUTE, TOKEN_GLOBAL, TOKEN_HEADER } from '../src/protocol'

/**
 * The token the settings page needs, and the one channel that has to carry it.
 *
 * A served index.html can be rewritten by `webServer.tapIndex`, but a host that
 * hands the page a prebuilt bundle never renders an index server-side — it ships
 * the structured injection table to a page-side interpreter instead. A token
 * carried only by a `tapIndex` rewrite therefore reaches the browser and not the
 * desktop shell: the tool keeps working, and every request from the desktop
 * settings page is answered with 403, which reads as a broken page rather than a
 * web-only one. This is the guard for that.
 */

type Row = { kind: string; name: string; value: unknown }

interface FakeRoute {
  kind: string
  path: string
  handler: (req: unknown, res: unknown) => void | Promise<void>
}

function panelHarness() {
  const routes: FakeRoute[] = []
  const listeners: Array<(table: Row[]) => void> = []
  let tapIndexCalls = 0
  const inner = {
    webServer: {
      register: (route: FakeRoute) => {
        routes.push(route)
        return () => {}
      },
      tapIndex: () => {
        tapIndexCalls += 1
        return () => {}
      },
    },
    on: (event: string, listener: (table: Row[]) => void) => {
      if (event === 'webserver/index-inject') listeners.push(listener)
      return () => {}
    },
  }
  const ctx = {
    inject: (_keys: string[], callback: (scope: unknown) => void) => callback(inner),
    effect: () => () => {},
  } as unknown as Context
  registerPanel(ctx, (Config as unknown as (data: unknown) => ConfigShape)({}))
  return { routes, listeners, tapIndexCalls: () => tapIndexCalls }
}

function handedToPage(listeners: Array<(table: Row[]) => void>): Row[] {
  const table: Row[] = []
  for (const listener of listeners) listener(table)
  return table
}

async function ask(
  handler: FakeRoute['handler'],
  headers: Record<string, string>,
): Promise<{ statusCode: number; body: string }> {
  const res = { statusCode: 0, body: '', setHeader: () => {}, end: (body: string) => void (res.body = body) }
  await handler({ url: `${ROUTE}/nope`, method: 'GET', headers }, res)
  return res
}

describe('settings page token', () => {
  it('hands the boot page its token as an injection row, without rewriting any html', () => {
    const harness = panelHarness()
    const rows = handedToPage(harness.listeners)

    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ kind: 'global', name: TOKEN_GLOBAL })
    expect(typeof rows[0]!.value).toBe('string')
    expect(rows[0]!.value).not.toBe('')
    // The rewrite path is the one a desktop shell never runs, so it must not be
    // the only thing carrying the token — better still, not be used at all.
    expect(harness.tapIndexCalls()).toBe(0)
  })

  it('accepts exactly the token it handed out and refuses every other request', async () => {
    const harness = panelHarness()
    const route = harness.routes.find((entry) => entry.path === ROUTE)
    expect(route).toBeDefined()
    const token = handedToPage(harness.listeners)[0]!.value as string

    const refused = await ask(route!.handler, {})
    expect(refused.statusCode).toBe(403)
    expect(refused.body).toContain('令牌')

    // Past the token check the request reaches the real router, which answers an
    // unknown path with 404 — so a 404 here means the token was accepted.
    const accepted = await ask(route!.handler, { [TOKEN_HEADER]: token })
    expect(accepted.statusCode).toBe(404)
    expect(accepted.body).toContain('没有这个接口')
  })

  it('mints a token per registration rather than reusing a constant', () => {
    const first = handedToPage(panelHarness().listeners)[0]!.value
    const second = handedToPage(panelHarness().listeners)[0]!.value
    expect(first).not.toBe(second)
  })
})
