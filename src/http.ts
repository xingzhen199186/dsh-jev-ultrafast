/**
 * The two request helpers both host-side surfaces need.
 *
 * They started out inside the settings route and are used verbatim by the inspector next
 * door; sharing them is what keeps "what a body may be" and "what a reply looks like"
 * answered once. Nothing here knows about this plugin.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'

/**
 * Read a small JSON body. The page sends a credential name and, at most, one value;
 * anything larger than a key is a mistake or an attack, and is refused rather than
 * buffered.
 */
export async function readJson(req: IncomingMessage, limit = 64 * 1024): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > limit) throw new Error('请求体比一个密钥该有的大得多，已拒绝。')
    chunks.push(buffer)
  }
  if (size === 0) return {}
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  } catch {
    throw new Error('请求体不是合法的 JSON。')
  }
}

export function send(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(body))
}

export function sendBytes(res: ServerResponse, status: number, type: string, body: Buffer): void {
  res.statusCode = status
  res.setHeader('content-type', type)
  res.setHeader('cache-control', 'no-store')
  res.setHeader('content-length', String(body.length))
  res.end(body)
}
