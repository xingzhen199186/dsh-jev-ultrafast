/**
 * Independent verification: what the run claims, checked against what the page says.
 *
 * Upstream states the principle plainly — DONE is not success — and its own example verifies
 * a result by looking again rather than by trusting the answer. The model that drove the run
 * is the last thing that should be asked whether it worked, so the check here is mechanical:
 * the caller writes down, *before* the run starts, the strings that must be on the page when
 * it is finished, and this code goes looking for them.
 *
 * It searches the final screen the run saw — the same text the last decision was made against,
 * capped at 6000 characters like every other observation. That covers the usual success markers
 * (a confirmation line, an order number, a result count). It does not cover a marker parked
 * further down a very long page, which is why a failed check means "not confirmed here" rather
 * than "not true": the caller can read the page with the reading route and look again.
 *
 * One item is one string. A leading `!` asks for the opposite — that string must *not* be on
 * the page — which is how a caller rules out "no results found" being reported as success.
 * Matching ignores case and collapses whitespace, because a page is free to break a phrase
 * across lines while the intent is the same.
 */
export interface VerifyItem {
  /** The string the caller asked for, exactly as it was given. */
  expect: string
  kind: 'must' | 'mustNot'
  found: boolean
  passed: boolean
  /** The line it was found on, or an honest "not found". */
  where: string
}

export interface Verification {
  /** False when the caller supplied no items at all: the run's claim is then unverified. */
  checked: boolean
  passed: boolean
  items: VerifyItem[]
  /** One sentence, in the user's language, for the caller to show. */
  note: string
}

/**
 * Check the run's own claim against the page it stopped on.
 *
 * `judgedAsDone` is whether this run is going to be reported as one that finished, and only the
 * sentence for the case where the caller gave nothing to check reads it: that one names the claim
 * （「完成」…）, and on a run reported as not having done the job — stopped on its own, or let through
 * with its checklist still unmet — naming a finish would contradict the judgement above it. The other
 * two notes are about a check that really ran, and read the same either way.
 */
export function verify(text: string, expect: string[] | undefined, judgedAsDone = true): Verification {
  const wanted = (expect ?? []).map((item) => item.trim()).filter((item) => item.length > 0)
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  const normalized = lines.map(normalize)
  const whole = normalized.join(' ')
  const items: VerifyItem[] = []

  for (const raw of wanted) {
    const mustNot = raw.startsWith('!')
    const needle = normalize(mustNot ? raw.slice(1) : raw)
    if (!needle) continue
    const onLine = normalized.findIndex((line) => line.includes(needle))
    // A phrase broken across two text nodes is still one phrase to the reader, so the whole
    // page is the fallback; the line is only there to show where it was seen.
    const found = onLine >= 0 || whole.includes(needle)
    items.push({
      expect: raw,
      kind: mustNot ? 'mustNot' : 'must',
      found,
      passed: mustNot ? !found : found,
      where: found ? excerpt(lines[onLine] ?? text) : mustNot ? '没有出现' : '没有找到',
    })
  }

  const missing = items.filter((item) => item.kind === 'must' && !item.found)
  const present = items.filter((item) => item.kind === 'mustNot' && item.found)
  const checked = items.length > 0
  if (!checked) {
    return {
      checked,
      passed: true,
      items,
      // The same fact twice over: a run reported as a finish can be told which claim went unchecked,
      // one reported as not having done the job cannot, because there is no 「完成」 to point at.
      note: judgedAsDone
        ? '没有给核验项，所以「完成」只是模型的声明，本次未经核实'
        : '没有给核验项，所以这次的结果只是模型自己的说法，本次未经核实',
    }
  }
  const problems = [
    ...missing.map((item) => `没找到「${item.expect}」`),
    ...present.map((item) => `出现了不该出现的「${item.expect}」`),
  ]
  return {
    checked,
    passed: problems.length === 0,
    items,
    note:
      problems.length === 0
        ? `核验通过：${items.length} 项都在最终页面上找到了`
        : `核验未通过：${problems.join('；')}`,
  }
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim()
}

function excerpt(line: string): string {
  const flat = line.replace(/\s+/g, ' ').trim()
  return flat.length > 120 ? `${flat.slice(0, 120)}…` : flat
}
