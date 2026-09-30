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
  #nextId = 1
  #closed = false

  private constructor(socket: WebSocket) {
    this.#socket = socket
    socket.addEventListener('message', (event) => this.#receive(event.data))
    socket.addEventListener('close', () => this.#fail(new Error('与浏览器的调试连接已断开')))
    socket.addEventListener('error', () => this.#fail(new Error('与浏览器的调试连接出错')))
  }

  /** Open a connection, rejecting if the endpoint does not answer in time. */
  static async connect(wsUrl: string, timeoutMs = 15_000): Promise<CdpConnection> {
    const socket = new WebSocket(wsUrl)
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.close()
        reject(new Error(`连接浏览器调试端口超时（${timeoutMs} 毫秒）：${wsUrl}`))
      }, timeoutMs)
      socket.addEventListener(
        'open',
        () => {
          clearTimeout(timer)
          resolve()
        },
        { once: true },
      )
      socket.addEventListener(
        'error',
        () => {
          clearTimeout(timer)
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
