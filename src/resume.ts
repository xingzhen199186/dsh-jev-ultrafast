/**
 * Continuing the run that just ended.
 *
 * What a continuation can honestly reuse is narrower than it first looks. The run's own tab is
 * closed with it, so the address is opened again and unsubmitted fields are gone; the element
 * indices a dead-end judgement carries are minted per frame, so carrying them into a page opened
 * afterwards would exclude whatever happens to sit at those numbers now. That leaves two things:
 * where the run stopped, and what it did on the way. The first is the start address; the second is
 * one sentence in the first request, because the page cannot say which steps were already taken.
 *
 * Said once and not repeated: it is context, not a rule. The offline comparison behind
 * `dead-ends.ts` found that sentences in the state change almost nothing, so this is not relied on
 * to steer a choice — it is there so a run that was half done is not quietly started over.
 */
import type { RunStatus } from './loop'
import type { LastRun } from './run-slot'

/** What a continuing run takes from the one before it. */
export interface ResumeSeed {
  /** The address the previous run stopped on; the continuation opens it again. */
  url: string
  prior: { actions: readonly string[]; status: RunStatus; reason: string }
}

/** How many of the previous run's actions the first request carries. */
const PRIOR_ACTIONS = 8

/**
 * Turn the last run into a seed, or say why there is nothing to continue.
 *
 * Both refusals are sentences a caller can act on rather than an empty run: a process that has run
 * nothing yet, and a run that never reported where it stopped.
 */
export function seedFromLastRun(
  last: LastRun | null,
): { ok: true; seed: ResumeSeed } | { ok: false; error: string } {
  if (last === null) {
    return {
      ok: false,
      error: '这个进程里还没有可以接着继续的运行。要接着做，就自己给出网址——或者先跑一次。',
    }
  }
  if (last.url === '') {
    return { ok: false, error: '上一次运行没留下它停在哪个地址，没法接着继续。给一个网址就能开跑。' }
  }
  return {
    ok: true,
    seed: { url: last.url, prior: { actions: last.actions, status: last.status, reason: last.reason } },
  }
}

/**
 * One sentence for the first request of a continued run: what was already done, and why it stopped.
 *
 * The tail of the action list rather than all of it: a long run's first steps are the ones the page
 * already reflects, and a request that carries forty of them spends the room the page's own table
 * needs. The count is the one the sentence shows, not a second fact to reconcile.
 */
export function priorNote(prior: ResumeSeed['prior']): string {
  const actions = prior.actions.slice(-PRIOR_ACTIONS)
  const done = actions.length === 0 ? '' : `上一次已经做过：${actions.map((action) => `「${action}」`).join('；')}。`
  const why = prior.reason ? `它停下的原因：${prior.reason}。` : ''
  return `这次是接着上一次没做完的运行继续，从当前页面往下做，不要从头重来。${done}${why}`
}
