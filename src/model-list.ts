/**
 * Asking a provider what models it serves.
 *
 * The text model's pick-list used to be hand-written per vendor, which drifts the moment a vendor
 * publishes or retires a name — and a name that looks plausible but is not served is exactly the
 * failure the reader hit while trying to choose one. A provider speaking the OpenAI-compatible
 * shape can be asked for its own list at `GET {baseUrl}/models`, and that answer is the only one
 * that cannot be stale at the moment it is read.
 *
 * The key never leaves the host half: the caller passes one in, and only model names come back to
 * the page. Nothing is cached here — a list that was true yesterday is not evidence for today, and
 * one request each time the reader opens the page is cheap enough to always ask again.
 */
import { requestSignal } from './net'

/** Model names out of one provider's `/models` answer, deduplicated and sorted. */
export function parseModelList(payload: unknown): string[] {
  const rows = Array.isArray(payload)
    ? payload
    : record(payload) && Array.isArray(payload.data)
      ? payload.data
      : record(payload) && Array.isArray(payload.models)
        ? payload.models
        : []
  const names = new Set<string>()
  for (const row of rows) {
    if (typeof row === 'string') {
      add(names, row)
      continue
    }
    if (!record(row)) continue
    add(names, row.id)
    add(names, row.name)
    add(names, row.model)
  }
  return [...names].sort((left, right) => left.localeCompare(right))
}

/**
 * Ask one provider for its model list.
 *
 * Throws with a sentence the settings page can show as-is. An authentication failure deliberately
 * does not repeat the provider's own body: that is the one answer likely to quote the credential
 * back, and this text travels into a page.
 */
export async function fetchModelList(options: {
  baseUrl: string
  apiKey: string
  timeoutMs?: number
  signal?: AbortSignal
}): Promise<string[]> {
  const url = `${options.baseUrl.replace(/\/+$/, '')}/models`
  let response: Response
  try {
    response = await fetch(url, {
      headers: { authorization: `Bearer ${options.apiKey}` },
      signal: requestSignal(options.timeoutMs ?? 15_000, options.signal),
    })
  } catch {
    throw new Error(`连不上「${hostOf(options.baseUrl)}」，模型清单没取到`)
  }
  const text = await response.text()
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new Error(`供应商没认这把密钥（HTTP ${response.status}），清单没取到`)
    }
    throw new Error(`供应商回了 HTTP ${response.status}${detail(text)}`)
  }
  let payload: unknown
  try {
    payload = JSON.parse(text)
  } catch {
    throw new Error('供应商回的清单不是 JSON，读不出来')
  }
  const models = parseModelList(payload)
  if (models.length === 0) throw new Error('供应商回了话，但清单里没有一个模型名')
  return models
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function add(names: Set<string>, value: unknown): void {
  if (typeof value === 'string' && value.trim()) names.add(value.trim())
}

/** The host of a base URL, for a sentence that says where the failure was. */
function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host
  } catch {
    return baseUrl
  }
}

/** A short piece of the provider's own explanation, when it sent one. */
function detail(text: string): string {
  const trimmed = text.trim().replace(/\s+/gu, ' ').slice(0, 160)
  return trimmed ? `：${trimmed}` : ''
}
