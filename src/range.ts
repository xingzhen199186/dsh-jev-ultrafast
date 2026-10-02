/**
 * The range a run is working inside, read off the address it first met it on — and, once that range
 * is lost, the few controls that could bring it back.
 *
 * A range is what a task like the one in the audit is about: "the hotels in this city, filtered like
 * this" lives in the address, as a path plus the query parameters the page put there to say what it
 * is showing. The sixth run of 2026-10-02 reached its hotel list through `?city=1&landmark=58397117`,
 * clicked the sort option the goal itself asked for, and the address that came back was the whole
 * city's list — the page had thrown the filter away, and nothing on the page said it ever had one.
 * That run went on to finish; the range it was asked about was simply gone from every step after.
 *
 * This module is both halves of the answer to that. The first half reads an address into a shape —
 * where the page is, and which parameters it carries — so a run can pin the range it first met and
 * notice the moment an address stops matching it. The second half is the only way anything is done
 * about it: the run's candidates are cut to the controls that could put the range back.
 *
 * Cutting candidates is the one output that has been measured to work in this project (see
 * `./dead-ends.ts` for the two rounds of 2026-10 that established it, and `withoutElements` for why
 * the element entries stay while the choices go). What is new here is only *when* it is cut: never
 * before the range is actually lost. By then the step the goal asked for has already been taken —
 * the sort click that dropped the range was executed from a table that still had everything in it —
 * so this rule cannot take away the candidate a task itself depended on.
 *
 * Three things this deliberately is not:
 *
 *  - It does not decide where to go. The narrowed table is put in front of the same model, which
 *    still chooses freely among what is left; nothing here names a target or an operation.
 *  - It is not a brake. Nothing in this module can stop a run, spend a decision or add a limit; the
 *    worst it does is offer fewer choices than it otherwise would have.
 *  - It never runs before a range has been pinned. A run whose addresses never carry a range is in
 *    the state this project was in before any of it existed, and stays there: `rangeOf` answers
 *    `null` and everything downstream is the table the page itself produced.
 */

import { elementIndexOf, trimActionSpace, withoutElements, type ActionSpace } from './decision/action-space'
import { MIN_OPEN_ELEMENTS } from './dead-ends'

/**
 * What an address looks like when it carries a range: where the page is, and which parameters it
 * carries. The values are deliberately not part of it — `city=1` and `city=2` are two ranges of the
 * same shape, and the run only ever notices that a shape it was pinned to has stopped matching.
 */
export interface RangeShape {
  /** Host and path, with the scheme dropped and a trailing slash trimmed: `/list/` is `/list`. */
  where: string
  /** The query parameter names, de-duplicated and sorted so one shape has one spelling. */
  keys: readonly string[]
}

/**
 * The range an address carries, or `null` when it carries nothing worth pinning.
 *
 * Three judgement calls, each of which could reasonably have gone the other way:
 *
 *  - **Where** is the host and the path together, host lower-cased (a host is case-insensitive by
 *    the web's own rules) and one trailing slash trimmed (a site that writes `/list/` on one page
 *    and `/list` on the next has not moved). The scheme is dropped, because a site that sends the
 *    same list over https has not sent the run somewhere else. The path's own case is kept: two
 *    paths differing in case are two addresses as far as anything here can tell.
 *  - **Keys** are the parameter names, read as the text before the first `=` and compared without
 *    percent-decoding, because both sides of every comparison come from the same site. Order does
 *    not count: the set is what makes a shape. A name that appears twice counts once.
 *  - **The fragment** (`#…`) is not part of the address on its own and is cut before anything is
 *    read, so `a=1#top` and `a=1#list` are one shape.
 *
 * `null` is returned for either of the two ways an address is not a range at all, which is what
 * keeps the whole rule inert until a run has really met one: an address with no parameters, and an
 * address at the front door (`/`) — a run pinned to a home page has not narrowed anything yet, and
 * a home page that carries a tracking parameter is still a home page.
 */
export function rangeOf(url: string): RangeShape | null {
  const bare = url.split('#')[0] ?? ''
  const cut = bare.indexOf('?')
  const head = cut === -1 ? bare : bare.slice(0, cut)
  const query = cut === -1 ? '' : bare.slice(cut + 1)

  const keys = new Set<string>()
  for (const pair of query.split('&')) {
    const at = pair.indexOf('=')
    const key = at === -1 ? pair : pair.slice(0, at)
    if (key !== '') keys.add(key)
  }
  if (keys.size === 0) return null

  const scheme = head.indexOf('://')
  const at = scheme === -1 ? head : head.slice(scheme + 3)
  const slash = at.indexOf('/')
  const host = slash === -1 ? at.toLowerCase() : at.slice(0, slash).toLowerCase()
  const path = slash === -1 ? '' : at.slice(slash).replace(/\/+$/, '')
  // Nothing but the host, or nothing behind the host's own `/`: the front door, with or without the
  // tracking parameters a home page tends to carry.
  if (path === '') return null

  return { where: host + path, keys: [...keys].sort() }
}

/**
 * Whether an address is still inside the range that was pinned.
 *
 * The pinned keys all have to be there; parameters the address has picked up since (a page number,
 * a sort order) are none of this rule's business, because they are additions to the same range
 * rather than a different one. A value that changed is the same range too — that is the whole reason
 * only the names are compared. An address that is no longer a range at all (back at the front door,
 * or with its parameters gone) is outside it by definition.
 */
export function inRange(shape: RangeShape, url: string): boolean {
  const now = rangeOf(url)
  return now !== null && now.where === shape.where && shape.keys.every((key) => now.keys.includes(key))
}

/** How a pinned range is written in a sentence: `hotels.test/list（city、landmark）`. */
export function shapeName(shape: RangeShape): string {
  return `${shape.where}（${shape.keys.join('、')}）`
}

/**
 * The words a control can carry that mean "this one changes what is being looked at": the way back
 * to a range, and the way to search for one.
 *
 * A control whose own label says one of these is kept as a candidate while the range is lost. The
 * Latin words are matched whole (`\b`), because `go` inside `Google` is not a search button; the Han
 * ones are matched as substrings, which is how they are written — `返回`, `重置筛选` and `清除筛选`
 * all contain one of them, and a Chinese label has no word boundaries to trust.
 */
const BACK_WORDS = /回|重置|清空|清除|\b(?:back|return|reset|clear)\b/i
const SEARCH_WORDS = /搜|查|\b(?:search|find|go|submit|query)\b/i

/**
 * The elements worth offering while the range is lost, by display index.
 *
 * Three sources, and only the middle one needs a word of its own:
 *
 *  1. every element that can be typed into. A page's own search is the ordinary way a range is put
 *     back, and the plugin cannot tell a search box from the comment box next to it by label alone —
 *     `请输入目的地` and `写下你的评论` are the same shape of string. Erring wide is the right way to
 *     err here: what this rule takes away is every other candidate, so a typeable control kept by
 *     mistake costs one candidate, and one dropped by mistake costs the way back.
 *  2. the controls next to those, which is the submit button of a search box: a magnifier icon is
 *     often labelled by nothing at all, so the field's own neighbours are kept as well.
 *  3. anything whose label carries one of the words above — `返回`, `重置筛选`, `清除筛选`, `Search`.
 *
 * Nothing here reads a candidate, and an element with no operation of its own is fine to keep: the
 * set only decides what survives `narrowToRange`, which counts what a table really offers.
 */
export function rangeReturners(space: ActionSpace): Set<string> {
  const keep = new Set<string>()
  const order = space.elements.map((element) => element.index)

  for (const element of space.elements) {
    if (
      element.operations.includes('TYPE_TEXT') ||
      BACK_WORDS.test(element.label) ||
      SEARCH_WORDS.test(element.label)
    ) {
      keep.add(element.index)
    }
  }
  for (const [at, element] of space.elements.entries()) {
    if (!element.operations.includes('TYPE_TEXT')) continue
    for (const side of [order[at - 1], order[at + 1]]) {
      if (side !== undefined) keep.add(side)
    }
  }
  return keep
}

/** How many elements a table offers as choices: the ones at least one candidate is keyed to. */
function offeredIn(space: ActionSpace): number {
  const offered = new Set<string>()
  for (const group of Object.values(space.targets)) {
    for (const target of Object.keys(group)) offered.add(elementIndexOf(target))
  }
  return offered.size
}

/**
 * A page's elements in `trimActionSpace`'s own order of relevance, most relevant first.
 *
 * That function answers with a *set* — the survivors, still in the page's own order, because the
 * entries it hands back are the table the model reads the screen from. What the floor needs is the
 * order those survivors were chosen in, so this asks for the first one, then the first two, and so
 * on, and reads each answer as the element the last one had not chosen yet. A table that fits an
 * answer whole is handed back whole, which ends the walk: past that point there is no ranking left
 * to read, and the page's own order is the only order the table has.
 */
function byRelevance(
  space: ActionSpace,
  goal: string,
  recent: ReadonlyArray<string | null | undefined>,
  limit: number,
): string[] {
  const seen = new Set<string>()
  const order: string[] = []
  for (let take = 1; take <= limit; take += 1) {
    const next = trimActionSpace(space, goal, recent, take).space.elements
    for (const element of next) {
      if (seen.has(element.index)) continue
      seen.add(element.index)
      order.push(element.index)
    }
    if (next.length >= space.elements.length) break
  }
  return order
}

/** What a narrowing did, which is also what the run's own line about it needs to say. */
export interface Narrowed {
  /** The table to build the request from: the same candidates, minus the ones that cannot help. */
  space: ActionSpace
  /** How many elements this rule's own pick offered, before the floor put anything back. */
  picked: number
  /** How many the narrowed table offers: what the request really has to choose from. */
  offered: number
  /** Whether the pick fell short of the floor and the most relevant elements went back in. */
  rescued: boolean
}

/**
 * The table as it stands, narrowed to the controls that could bring a lost range back.
 *
 * `space` is the table the request would otherwise be built from — the page's own, less whatever
 * the dead-end rule has already taken out — and `whole` is the page's own, which is what the pick
 * and the floor's ranking read: the dead-end rule has its own reasons for what it removes, and this
 * rule has no business ranking against a table that is already missing pieces of it.
 *
 * The floor is the one `./dead-ends.ts` set for its own removals, `MIN_OPEN_ELEMENTS`, and it is
 * measured the same way here: on how many elements the table really offers as choices. When the
 * pick comes up short, the floor is met by putting back the most relevant elements of the page by
 * the same ordering `trimActionSpace` already uses for a table too large for one request — the
 * element the run has just acted on, then a visible label, then closeness to the goal's own words.
 * A page that has fewer than that many elements to offer cannot be narrowed at all, and is left
 * whole: the floor is a floor, not a target.
 */
export function narrowToRange(
  space: ActionSpace,
  whole: ActionSpace,
  goal: string,
  recent: ReadonlyArray<string | null | undefined>,
): Narrowed {
  const keep = rangeReturners(whole)
  const cut = (kept: ReadonlySet<string>): ActionSpace =>
    withoutElements(
      space,
      new Set(whole.elements.map((element) => element.index).filter((index) => !kept.has(index))),
    )

  const picked = cut(keep)
  const offered = offeredIn(picked)
  const floor = Math.min(MIN_OPEN_ELEMENTS, offeredIn(whole))
  if (offered >= floor) return { space: picked, picked: offered, offered, rescued: false }

  // The floor is met by putting back the page's most relevant elements, by the ordering
  // `trimActionSpace` already uses for a table too large for one request — the element the run has
  // just acted on, then a visible label, then closeness to the goal's own words — and by stopping the
  // moment it is met, so no more than the floor's worth goes back. More entries are asked for than
  // the floor needs, because some of what comes back are elements this rule already keeps: a field is
  // both the way back and a good element to offer, and asking for exactly five would spend those
  // slots on it. At most `keep.size` of what it returns can be such an element.
  let rescued = picked
  let count = offered
  for (const index of byRelevance(whole, goal, recent, floor + keep.size)) {
    if (count >= floor) break
    keep.add(index)
    rescued = cut(keep)
    count = offeredIn(rescued)
  }
  return { space: rescued, picked: offered, offered: count, rescued: true }
}
