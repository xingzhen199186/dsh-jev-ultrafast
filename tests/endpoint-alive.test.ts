/**
 * The question `ensureBrowser` asks a discovered address before it hands one to a step.
 *
 * This file exists because of a measured failure: a port file next to a profile kept naming a
 * socket whose browser was long gone, the port itself had been picked up by something that was not
 * a browser (it answered 404 to every DevTools path), and the run died on its first move instead of
 * starting a browser of its own. So the cases below are the whole point — a port that only says
 * 404 is dead, a browser that answers any DevTools question is alive, and a default-profile
 * browser whose HTTP doors are all shut (Edge 147+ does this) still counts when its socket door
 * opens, because that is the door a step enters by.
 */
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { endpointAlive } from '../src/browser/launch'
import type { BrowserEndpoint } from '../src/browser/discover'

const servers: Server[] = []

/** An endpoint whose HTTP door is the given base, in the shape discovery returns. */
function endpointAt(httpUrl: string): BrowserEndpoint {
  return { wsUrl: '', httpUrl, browser: '版本未知', source: '测试桩' }
}

/** Start a throwaway loopback server; `answer` decides what every request gets. */
async function listen(answer: (path: string) => { status: number; body: string }): Promise<string> {
  const server = createServer((request, response) => {
    const { status, body } = answer(request.url ?? '/')
    response.writeHead(status, { 'content-type': 'application/json' })
    response.end(body)
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return `http://127.0.0.1:${port}`
}

afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  )
})

describe('endpointAlive', () => {
  it('a port that answers 404 to every DevTools question is dead', async () => {
    const base = await listen(() => ({ status: 404, body: 'Not Found' }))
    expect(await endpointAlive(endpointAt(base))).toBe(false)
  })

  it('a browser that names itself is alive', async () => {
    const base = await listen(() => ({ status: 200, body: '{"Browser":"Edg/130.0"}' }))
    expect(await endpointAlive(endpointAt(base))).toBe(true)
  })

  it('a version door that answers nothing useful is still alive when the target list answers', async () => {
    const base = await listen((path) =>
      path.startsWith('/json/list') ? { status: 200, body: '[]' } : { status: 404, body: 'Not Found' },
    )
    expect(await endpointAlive(endpointAt(base))).toBe(true)
  })

  it('a port with nobody listening is dead', async () => {
    const base = await listen(() => ({ status: 200, body: '{"Browser":"Edg/130.0"}' }))
    expect(await endpointAlive(endpointAt(base))).toBe(true)
    const server = servers.pop()
    await new Promise<void>((resolve) => server?.close(() => resolve()))
    expect(await endpointAlive(endpointAt(base))).toBe(false)
  })

  it('all HTTP doors shut, socket door open: alive', async () => {
    // The default-profile browser measured on 2026-10-03: `/json/version` and `/json/list` both
    // answer 404, the port file's second line names the room, and the handshake there succeeds.
    const base = await listen(() => ({ status: 404, body: 'Not Found' }))
    vi.stubGlobal(
      'WebSocket',
      class {
        addEventListener(type: string, listener: () => void): void {
          if (type === 'open') queueMicrotask(listener)
        }
        close(): void {}
      },
    )
    const endpoint = { ...endpointAt(base), wsUrl: 'ws://127.0.0.1:9222/devtools/browser/abc' }
    expect(await endpointAlive(endpoint)).toBe(true)
  })

  it('all doors shut — HTTP 404 and a handshake that fails: dead', async () => {
    // A squatter that holds the port but is not a browser: it refuses the handshake just as it
    // refused the HTTP questions, so it still cannot hand a step a first move to die on.
    const base = await listen(() => ({ status: 404, body: 'Not Found' }))
    vi.stubGlobal(
      'WebSocket',
      class {
        addEventListener(type: string, listener: () => void): void {
          if (type === 'error') queueMicrotask(listener)
        }
        close(): void {}
      },
    )
    const endpoint = { ...endpointAt(base), wsUrl: 'ws://127.0.0.1:9222/devtools/browser/abc' }
    expect(await endpointAlive(endpoint)).toBe(false)
  })
})
