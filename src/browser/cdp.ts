/**
 * A minimal Chrome DevTools Protocol client: JSON messages over the browser's
 * DevTools WebSocket. Node's built-in `WebSocket` (Node 22+) carries the frames,
 * so the plugin needs no transport dependency of its own.
 *
 * CDP semantics used here: every command carries a numeric `id` and is answered
 * by exactly one message with the same `id`, while events carry `method` and no
 * `id`. A command sent with `sessionId` targets one attached page (flattened
 * mode), which is how the `Target` domain works.
 */

/** An error the browser itself reported for one CDP command. */
export class CdpError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly method: string,
  ) {
    super(`${method} 被浏览器拒绝：${message}（${code}）`)
    this.name = 'CdpError'
  }
}

interface Pending {
  method: string
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

type CdpEventListener = (method: string, params: Record<string, unknown>, sessionId?: string) => void

/** One live connection to a browser's DevTools endpoint. */
export class CdpConnection {
  readonly #socket: WebSocket
  readonly #pending = new Map<number, Pending>()
  readonly #listeners = new Set<CdpEventListener>()
  /** Whoever is holding this socket open, told once when it goes away and why. */
  readonly #closers = new Set<(reason: Error) => void>()
  #nextId = 1
  #closed = false
  #notified = false

  private constructor(socket: WebSocket) {
    this.#socket = socket
    socket.addEventListener('message', (event) => this.#receive(event.data))
    socket.addEventListener('close', () => this.#fail(new Error('与浏览器的调试连接已断开')))
    socket.addEventListener('error', () => this.#fail(new Error('与浏览器的调试连接出错')))
  }

  /**
   * Open a connection, rejecting if the endpoint does not answer in time.
   *
   * `timeoutMs` of 0 waits as long as it takes, and the route that connects to the reader's own
   * browser asks for exactly that: Chrome/Edge 144+ ask permission on every connection, and a
   * timer that fires while that box is on screen would close the very connection the box is
   * about. Retrying is no better — killing the connection takes the box away with it, and a
   * second connection raises a second box — so waiting is the whole behaviour, not a fallback.
   */
  static async connect(wsUrl: string, timeoutMs = 15_000): Promise<CdpConnection> {
    const socket = new WebSocket(wsUrl)
    await new Promise<void>((resolve, reject) => {
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              socket.close()
              reject(new Error(`连接浏览器调试端口超时（${timeoutMs} 毫秒）：${wsUrl}`))
            }, timeoutMs)
          : null
      const answered = (): void => {
        if (timer !== null) clearTimeout(timer)
      }
      socket.addEventListener(
        'open',
        () => {
          answered()
          resolve()
        },
        { once: true },
      )
      socket.addEventListener(
        'error',
        () => {
          answered()
          reject(new Error(`无法连接浏览器调试端口：${wsUrl}`))
        },
        { once: true },
      )
    })
    return new CdpConnection(socket)
  }

  /** Send one command and resolve with its result. */
  send<T = unknown>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
    if (this.#closed) return Promise.reject(new Error('与浏览器的调试连接已关闭'))
    const id = this.#nextId++
    return new Promise<T>((resolve, reject) => {
      this.#pending.set(id, { method, resolve: resolve as (value: unknown) => void, reject })
      try {
        this.#socket.send(JSON.stringify(sessionId === undefined ? { id, method, params } : { id, method, params, sessionId }))
      } catch (error) {
        this.#pending.delete(id)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  /** Subscribe to CDP events; the returned function unsubscribes. */
  onEvent(listener: CdpEventListener): () => void {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  /**
   * Be told when this socket goes away, and why — once, however it went.
   *
   * This is what a long-held connection needs and nothing before it did: a socket that outlives
   * the request that opened it may die while nobody is asking it anything, and the only moment
   * that is knowable is when the browser's own `close`/`error` arrives. The reason is the same
   * sentence the in-flight commands were rejected with.
   */
  onClose(listener: (reason: Error) => void): () => void {
    this.#closers.add(listener)
    return () => {
      this.#closers.delete(listener)
    }
  }

  /**
   * Ask the browser, every so often, whether this connection is still there.
   *
   * A connection held across tasks sits idle for minutes at a time, and an idle socket that has
   * quietly died is indistinguishable from a live one until the next command fails — which, for a
   * task, is the middle of the work. The interval only asks; it never closes anything, because the
   * policy for a connection that has gone is the holder's (see ./held.ts).
   *
   * Returns the way to stop asking. `timer` is unref'd: a keepalive must never be the reason a
   * host process stays alive.
   */
  keepalive(intervalMs: number): () => void {
    const timer = setInterval(() => this.#ping(), intervalMs)
    ;(timer as unknown as { unref?: () => void }).unref?.()
    return () => clearInterval(timer)
  }

  #ping(): void {
    // The WHATWG `WebSocket` Node ships has no `ping()`, so when the transport offers one it is
    // sent; otherwise the same question is asked over the protocol this plugin actually speaks,
    // which proves the browser is answering rather than merely that the socket is open. Either way
    // a failure is not reported here: `close`/`error` is what reports it, through `onClose`.
    const socket = this.#socket as unknown as { ping?: () => void }
    if (typeof socket.ping === 'function') {
      try {
        socket.ping()
        return
      } catch {
        // The socket is already gone; the close handler is on its way.
      }
    }
    void this.send('Browser.getVersion').catch(() => {})
  }

  /** Close the socket and reject everything still in flight. */
  close(): void {
    if (this.#closed) return
    this.#closed = true
    this.#socket.close()
    this.#fail(new Error('与浏览器的调试连接已关闭'))
  }

  #receive(raw: unknown): void {
    const text = toText(raw)
    if (text === null) return
    let message: Record<string, any>
    try {
      message = JSON.parse(text)
    } catch {
      return
    }
    if (typeof message.id === 'number') {
      const pending = this.#pending.get(message.id)
      if (!pending) return
      this.#pending.delete(message.id)
      if (message.error) pending.reject(new CdpError(message.error.code, message.error.message, pending.method))
      else pending.resolve(message.result)
      return
    }
    if (typeof message.method === 'string') {
      for (const listener of this.#listeners) listener(message.method, message.params ?? {}, message.sessionId)
    }
  }

  #fail(error: Error): void {
    this.#closed = true
    for (const pending of this.#pending.values()) pending.reject(error)
    this.#pending.clear()
    // Once, and only once: `close`, `error` and a closing socket all arrive at this method, and a
    // holder that heard "it died" three times would be told nothing new.
    if (this.#notified) return
    this.#notified = true
    for (const listener of this.#closers) listener(error)
  }
}

function toText(raw: unknown): string | null {
  if (typeof raw === 'string') return raw
  if (raw instanceof ArrayBuffer) return new TextDecoder().decode(raw)
  if (ArrayBuffer.isView(raw)) {
    return new TextDecoder().decode(new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength))
  }
  return null
}
