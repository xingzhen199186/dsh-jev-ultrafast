/**
 * Finding the address inside a sentence someone typed.
 *
 * The command used to demand an address as its first word. People do not talk that way:
 * "上百度查一下明天北京的天气" is one sentence, and the address is not in it at all — that case
 * belongs to the text model (`resolve-start.ts`). The two shapes worth recognising without a
 * model are here: a full `http(s)://…` anywhere in the sentence, and a bare domain such as
 * `example.com`, which is how people write an address when they are not being formal.
 *
 * One rule is shared by both callers: what comes out has to be a real-looking address on a
 * host with a dot in it. A model that answers "百度" is answering nothing.
 */

/** A full address. It ends at whitespace, at a quote, or at Chinese punctuation (「看 https://a.com，价格」). */
const FULL = /https?:\/\/[^\s<>"'`，。；：！？、）】」』]+/iu

/**
 * A bare domain, only when it stands alone: not part of a longer word, and not the tail of an
 * address that was already matched above. `1.5折` and `我.你` are not domains (the ending has to
 * be letters), and `example.com/path` keeps its path.
 */
const BARE = /(?<![a-z0-9.@_-])(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,24}(?:[/?#][^\s<>"'`，。；：！？、）】」』]*)?/iu

/** Punctuation that may trail an address without belonging to it. */
const TRAILING = /[.,;:!?、。，；：！？）】」』"']+$/u

/** The address in a sentence, plus what was around it, so the caller can keep the rest as the goal. */
export interface FoundUrl {
  url: string
  before: string
  after: string
}

/**
 * The first address in `text`, or nothing.
 *
 * A full address wins over a bare domain, and only the first of either is used: a sentence with
 * two addresses is ambiguous, and the loop's own follow-the-click handling is the right place for
 * the second one.
 */
export function findUrl(text: string): FoundUrl | null {
  for (const pattern of [FULL, BARE]) {
    const match = pattern.exec(text)
    if (match === null) continue
    const raw = match[0].replace(TRAILING, '')
    const url = normalizeUrl(raw)
    if (url === null) continue
    return { url, before: text.slice(0, match.index), after: text.slice(match.index + raw.length) }
  }
  return null
}

/**
 * One reported address, tightened into something the browser can open, or nothing.
 *
 * A missing scheme is added (people write `example.com`), wrapping punctuation is dropped, and a
 * host without a dot is refused — that last rule is what keeps a model's "百度" or "首页" from
 * becoming a run that opens a nonsense address.
 */
export function normalizeUrl(value: string): string | null {
  const trimmed = value.trim().replace(/^[<("'\[]+/u, '').replace(/[>)"'\]]+$/u, '')
  if (trimmed === '' || /\s/u.test(trimmed)) return null
  const withScheme = /^https?:\/\//iu.test(trimmed) ? trimmed : `https://${trimmed}`
  if (!/^https?:\/\/[^\s/?#]+/iu.test(withScheme)) return null
  const host = /^https?:\/\/([^/?#]+)/iu.exec(withScheme)?.[1] ?? ''
  if (host.length < 4 || !host.includes('.')) return null
  return withScheme
}
