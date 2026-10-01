/**
 * What the top document can see of itself, and what it cannot.
 *
 * The snapshot walks the top document only: `document.querySelectorAll` and a
 * `TreeWalker(document.body)` reach neither into an `iframe` nor into an open shadow root.
 * A page whose content lives in one of those therefore reads as an almost empty page — no
 * controls, no text — and nothing downstream can tell that apart from a page that really
 * is empty. The run then stalls on a page that is full of things it cannot see, or clicks
 * whatever chrome the frame left on top.
 *
 * This module is the honest half of that gap: the snapshot counts the structures it cannot
 * enter, and `nestedNote` turns those counts into one plain sentence for the model and for
 * the reader. Detection only — no frame is entered, no shadow root is opened, no element is
 * invented, and nothing here changes what the snapshot offers to act on.
 */

/**
 * What the snapshot counted in the top-level document. The names are the page script's own
 * (`snapshot.ts`), the same as `PageState`'s other raw fields.
 */
export interface NestedFacts {
  /** Visible `iframe` elements in the top document. */
  frames: number
  /** The address of the first of those that has one, or empty. */
  frame_url: string
  /** Open shadow roots in the top document that hold at least one element. */
  shadow_roots: number
  /** Element actions the top document itself offered, before the synthetic ones. */
  elements: number
}

/**
 * Below this many controls the top document has no surface of its own worth working with.
 * It is not zero: a page built around a frame still keeps one or two things outside it — a
 * cookie banner's button, a menu toggle — and those are exactly the ones a run should not
 * be left pushing while the content sits out of reach.
 */
const FEW_TOP_LEVEL_ELEMENTS = 3

/**
 * One sentence about a page whose main content the snapshot cannot reach, or an empty
 * string when the page offers something of its own to work with. Pure, so what the model
 * and the reader are told is decided without a browser anywhere near it.
 */
export function nestedNote(facts: NestedFacts | undefined): string {
  if (!facts || facts.elements >= FEW_TOP_LEVEL_ELEMENTS) return ''
  const inside = [
    facts.frames > 0 ? `${facts.frames} 个 iframe` : '',
    facts.shadow_roots > 0 ? `${facts.shadow_roots} 个网页自己封起来的内容块` : '',
  ]
    .filter(Boolean)
    .join('、')
  if (!inside) return ''
  const wayOut = facts.frame_url
    ? `可以试试直接打开里面的地址：${facts.frame_url}`
    : '如果知道里面那个页面自己的地址，可以直接打开它再试。'
  return `这个页面的主要内容在嵌套的框架里（${inside}），插件看不到里面的内容，所以这里推不动。${wayOut}`
}
