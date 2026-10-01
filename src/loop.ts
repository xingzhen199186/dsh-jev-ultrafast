/**
 * The run loop: observe, decide, act, observe.
 *
 * Ported from jev-ultrafast `jev_ultrafast/agent.py` (`command` / `run`)
 * (https://github.com/browser-use/jev-ultrafast, MIT, Copyright (c) 2026 Browser
 * Use). Upstream exposed this loop as a small request/response protocol so an
 * external harness could step it; here the loop is simply the code, which takes
 * the protocol out of the picture while keeping every stopping rule:
 *
 *  - a decision is consumed before anything can mutate, so a retry cannot
 *    double-click;
 *  - the page is re-checked for freshness both before the decision and before the
 *    input, and a stale check costs a re-observation, never a mutation;
 *  - a typed value is generated at most once per identical field context, so a
 *    stale retry does not pay for the text model twice;
 *  - the budget is bounded twice, once in actions and once in model calls;
 *  - a page a click opened in a new tab is where that step's effect is, so the run
 *    moves onto it and says so, instead of reading "nothing happened";
 *  - a decision that names an element this observation does not have is not the run's
 *    failure: the page is observed again and the model is asked again, with one plain
 *    sentence saying why, and only a run of them stops the run;
 *  - three consecutive steps that left the page unchanged stop the run, and a run of steps on
 *    one and the same target that only ever brings back page states the run has already shown
 *    stops it as well, saying which action it was stuck on instead of burning the budget.
 */
import type { ActionSpace, ElementEntry } from './decision/action-space'
import { actionSpace } from './decision/action-space'
import type { FieldContext, TextHelperSource, TextResult } from './decision/text-helper'
import { fieldContext, fieldText } from './decision/text-helper'
import type { Decision, DecisionContext, DecisionSource, HistoryEntry } from './decision/typesafe'
import { choose } from './decision/typesafe'
import { MAX_STEPS } from './prompts'
import type { BrowserPort, NewPage, PageState, SnapshotAction } from './browser/session'
import { BrowserSession, StalePage } from './browser/session'
import { nestedNote } from './browser/nested'
import type { ActResult } from './browser/act'
import { act } from './browser/act'
import type { DiscoverOptions } from './browser/discover'
import { openArtifacts } from './artifacts'
import { verify, type Verification } from './verify'

/** How a run ended. `blocked` means the loop stopped itself, `failed` means the environment did. */
export type RunStatus = 'done' | 'blocked' | 'failed'

/** One decision, as it was made against one observed page. */
export interface DecisionRecord extends Decision {
  fingerprint: string
  elapsed_ms: number
}

/** One paid text-model call. */
export interface TextCall {
  model: string
  latency_ms: number
  usage: Record<string, unknown>
  field: string
  value: string
}

/** One step that opened pages in new tabs, as the run found them. */
export interface FollowRecord {
  step: number
  /** Pages that appeared during this step, in the order the browser listed them. */
  appeared: NewPage[]
  /** The page the run moved onto, when it moved. */
  adopted: NewPage | null
}

/** What the loop reports while it runs, for a progress card or the inspector page. */
export type LoopEvent =
  | { type: 'observed'; step: number; url: string; elements: number }
  /** Where this run's frames and trace are being written, said while the run is still going. */
  | { type: 'recording'; dir: string }
  | {
      type: 'decided'
      step: number
      operation: string
      action: string
      confidence: number
      /**
       * Every element this decision could choose from, with the probability the service gave
       * its target in the chosen operation. The inspector shows this table; nothing else reads
       * it, which is why it is built here rather than assembled from the run history later.
       */
      table: Array<{ index: string; label: string; operations: string[]; probability: number | null }>
      /** Probability per operation, so the page can show what the runner-up was. */
      operationProbabilities: Record<string, number>
    }
  | { type: 'executed'; step: number; action: string; elapsedMs: number; pageChanged: boolean }
  | { type: 'followed'; step: number; url: string; title: string }
  | { type: 'finished'; status: RunStatus; reason: string }

export interface TaskOptions {
  goal: string
  /** The page to open first. */
  startUrl: string
  decision: DecisionSource
  text: TextHelperSource
  browser?: DiscoverOptions
  maxSteps?: number
  screenshots?: boolean
  /**
   * Write this run's raw model exchanges into a directory under the system temp
   * directory, together with one frame per step when `screenshots` is on, and report
   * that directory in the result. Off by default: the loop stays free of side effects
   * unless the caller asks, which is what lets a test script a page and assert on the
   * result alone.
   */
  record?: boolean
  /**
   * Strings the finished page must show — and, with a leading `!`, strings it must not show.
   * Written down by the caller before the run starts and checked by `./verify` after it, so
   * that "done" is not the last word of the model that did the work.
   */
  expect?: string[]
  /** Cancellation from the caller; checked between steps and forwarded to every request. */
  signal?: AbortSignal
  onEvent?: (event: LoopEvent) => void
  /**
   * Awaited once per step, after the decision is made and before anything is typed or
   * clicked. The inspector holds the run here: pausing costs nothing, changes nothing,
   * and still lets the whole screen state be read first.
   */
  gate?: (state: { step: number; action: string }) => Promise<void>
  /** Seams a test replaces. Left alone, these are the real browser and services. */
  deps?: Partial<TaskDeps>
}

/**
 * The four things the loop does to the outside world. They are a seam rather than
 * an extension point: with them, the stopping rules below can be tested in
 * milliseconds against a scripted page instead of a real one.
 */
export interface TaskDeps {
  open: (url: string, options?: DiscoverOptions) => Promise<BrowserPort>
  decide: (source: DecisionSource, space: ActionSpace, context: DecisionContext) => Promise<Decision>
  typeText: (source: TextHelperSource, context: FieldContext) => Promise<TextResult>
  execute: (session: BrowserPort, page: PageState, action: SnapshotAction, text?: string) => Promise<ActResult>
}

const REAL_DEPS: TaskDeps = {
  open: (url, options) => BrowserSession.open(url, options),
  decide: choose,
  typeText: fieldText,
  execute: act,
}

/**
 * How many decisions in a row may name an element the observation they were given does not
 * have, before the run gives up. One is the ordinary case — the page redrew between the
 * snapshot and the answer (a banner, a popup, a countdown) — and looking again is all it
 * takes; the answer after a fresh observation that still names a missing element is the
 * first of the two. Two in a row, with a fresh observation in between each time, means the
 * answer and the page are out of step by construction rather than by a repaint, and every
 * further round spends another decision out of the run's own budget.
 */
const MAX_LOST_TARGETS = 2

/**
 * How many steps in a row may act on one and the same target while showing the run nothing it
 * has not already seen, before the run stops and names the action it was stuck on.
 *
 * The rule below counts steps that changed nothing at all, which is enough for a page that
 * simply sits still. The loop that actually burns a budget is busier than that: it clicks the
 * same box again and again, the click opens and closes the same layer, and the page is a
 * different state on almost every step. What gives it away is not that a step changed nothing
 * but that the run keeps coming back to states it has already shown — the page cycles through a
 * handful of states and never produces a new one. Six is that many because the run this rule was
 * written for cycled through six such states, so the second time round the cycle is counted;
 * the window is deliberately the length of a full round, and every step in it has to be a
 * replay, so an ordinary run that keeps producing new pages (paging, scrolling through results)
 * never reaches it. The target is what has to stay the same — the model alternating a click and
 * a type on one input is one stuck loop, not two actions — and the sentence names the operation
 * of the step that stopped the run.
 */
const MAX_REPEATED_STEPS = 6

export interface TaskResult {
  goal: string
  status: RunStatus
  /** Why the run stopped, in the user's language. Empty when it reached DONE. */
  reason: string
  elapsedMs: number
  steps: number
  decisions: number
  history: HistoryEntry[]
  textCalls: TextCall[]
  /** Steps that opened new tabs, and which of those pages the run moved onto. */
  follows: FollowRecord[]
  /** The independent check of the run's own claim, always present and never assumed. */
  verification: Verification
  /**
   * Why the page the run stopped on could not be worked further, when it could not — its
   * content sits in a frame or a shadow root the snapshot cannot reach into. Empty usually.
   */
  pageNote: string
  /** Element actions the snapshot dropped because the page offered more than 250. */
  omittedActions: number
  /** The final page's screenshot, base64, and only when the caller asked for screenshots. */
  screenshot: string | null
  /** This run's directory of artifacts (the trace, and the frames when they are on). Empty when nothing was recorded. */
  recordDir: string
  /** The last page the run saw, so the caller can answer from evidence rather than from the goal. */
  page: { url: string; title: string; text: string } | null
  elements: ElementEntry[]
}

/**
 * Run one task to a stop. It never throws for a run that merely failed: a browser
 * that will not start, a decision service that will not answer and a task that ran
 * out of budget all come back as a result with a reason.
 */
export async function runTask(options: TaskOptions): Promise<TaskResult> {
  const deps: TaskDeps = { ...REAL_DEPS, ...options.deps }
  const started = Date.now()
  const elapsedMs = (): number => Date.now() - started
  const maxSteps = options.maxSteps ?? MAX_STEPS
  const maxDecisions = maxSteps * 2
  const screenshots = options.screenshots === true
  const artifacts = options.record ? openArtifacts(screenshots) : null
  // The trace sink rides along on the sources the caller already built, so recording
  // needs no second plumbing path into the decision or text layers.
  const decisionSource = artifacts ? { ...options.decision, trace: artifacts.trace } : options.decision
  const textSource = artifacts ? { ...options.text, trace: artifacts.trace } : options.text

  const history: HistoryEntry[] = []
  const decisions: DecisionRecord[] = []
  const textCalls: TextCall[] = []
  const follows: FollowRecord[] = []
  const emit = (event: LoopEvent): void => options.onEvent?.(event)

  let session: BrowserPort | null = null
  let page: PageState | null = null
  let status: RunStatus = 'done'
  let reason = ''
  // A generated value, reused only when the whole field context is identical.
  let pendingText: { context: FieldContext; text: string; helper: TextResult } | null = null
  // The sentence the next decision request carries, when there is one: cleared the moment
  // it has been sent, so an ordinary step is an ordinary step.
  let hint = ''
  // Consecutive decisions that named an element their own observation did not have.
  let lostTargets = 0
  // Every page state the run has shown so far, and the last few steps with the target each one
  // acted on and whether its state was a replay of an earlier one. Together these are what tells
  // a page that keeps producing something new apart from one that is going round in circles.
  const seenStates = new Set<string>()
  const recentSteps: Array<{ replayed: boolean; target: string | null }> = []
  // The action the run stopped on because it kept repeating it, when it stopped that way. It
  // rides along into the run's trace, so the file explains the stop without the conversation.
  let stuckOn: { operation: string; target: string | null; action: string; times: number } | null = null

  try {
    session = await deps.open(options.startUrl, options.browser)
    page = await session.observe({ screenshot: screenshots })
    emit({ type: 'observed', step: 0, url: page.url, elements: page.actions.length })
    // The page the run started on is a state it has now shown, like every state after a step.
    seenStates.add(page.fingerprint)
    // The starting frame: without it a replay begins at the first action's aftermath.
    artifacts?.frame(page.screenshot, 0)
    // Said before anything is decided, so something watching the run knows where its frames
    // will appear while it is still running.
    if (artifacts) emit({ type: 'recording', dir: artifacts.dir })

    while (true) {
      // ---- cancelled? ----
      if (options.signal?.aborted) {
        status = 'blocked'
        reason = '任务已被取消'
        break
      }

      // ---- decide ----
      if (decisions.length >= maxDecisions) {
        status = 'blocked'
        reason = `达到本次运行的模型调用上限（${maxDecisions} 次），已停止`
        break
      }
      // A page that is no longer what the last decision saw is re-observed, and the
      // step continues with the fresh page. Retrying the freshness check instead
      // would spin forever on a page that never settles.
      if (!(await session.fresh(page))) page = await session.observe({ screenshot: screenshots })
      const space = actionSpace(page.actions)
      // What the service is told about a page the snapshot could only partly see, plus the
      // one-off sentence the last answer earned. Nothing at all on an ordinary step.
      const note = [nestedNote(page.nested), hint].filter(Boolean).join(' ')
      const decision = await deps.decide({ ...decisionSource, signal: options.signal }, space, {
        goal: options.goal,
        page,
        history,
        ...(note ? { note } : {}),
      })
      hint = ''
      decisions.push({ ...decision, fingerprint: page.fingerprint, elapsed_ms: elapsedMs() })
      emit({
        type: 'decided',
        step: history.length + 1,
        operation: decision.operation,
        action:
          space.elements.find((element) => element.index === decision.target)?.label ??
          decision.target ??
          decision.operation,
        confidence: decision.confidence,
        table: space.elements.map((element) => ({
          index: element.index,
          label: element.label,
          operations: element.operations,
          probability: decision.targetProbabilities[element.index] ?? null,
        })),
        operationProbabilities: decision.operationProbabilities,
      })

      // ---- act ----
      const chosen = decision.choice
      if (chosen === 'DONE' || chosen === 'BLOCKED') {
        // A terminal answer is only trustworthy if the page has not moved since.
        if (!(await session.fresh(page))) {
          page = await session.observe({ screenshot: screenshots })
          continue
        }
        status = chosen === 'DONE' ? 'done' : 'blocked'
        reason = chosen === 'DONE' ? '' : '模型判断页面上已没有可以推进目标的操作'
        break
      }
      const action = page.actions.find((candidate) => candidate.id === chosen)
      if (!action) {
        // The number the decision chose is not in the observation it was given. In practice
        // that is the page redrawing under the answer — a banner, a popup, a countdown —
        // and it is the page's doing, not evidence that the task cannot be done: the page is
        // observed again and the model is asked again, told in one sentence what happened.
        // Each round costs a decision from the same budget the run already has, so it is
        // bounded here as well: a run of them is the run's stop, not an extra allowance.
        lostTargets += 1
        if (lostTargets > MAX_LOST_TARGETS) {
          status = 'failed'
          reason = `页面在你选的元素前后自己刷新了，连续 ${MAX_LOST_TARGETS + 1} 次都没对上，这次先停下`
          break
        }
        hint = '你上次选的编号在页面里已经找不到了，页面可能自己刷新过，请重新选'
        page = await session.observe({ screenshot: screenshots })
        continue
      }
      lostTargets = 0
      if (history.length >= maxSteps) {
        status = 'blocked'
        reason = `达到本次运行的动作上限（${maxSteps} 步），已停止`
        break
      }

      // The inspector's hold. It sits here on purpose: after the decision, so the table and
      // the probabilities are already reported, and before the text model is asked for
      // anything, so a pause costs no money and leaves the page untouched.
      await options.gate?.({ step: history.length + 1, action: action.label })

      // Checked again after the hold: a run stopped while it was paused must not execute the
      // action it was paused in front of.
      if (options.signal?.aborted) {
        status = 'blocked'
        reason = '任务已被取消'
        break
      }

      let text: string | null = null
      let helper: TextResult | null = null
      try {
        if (action.kind === 'fill') {
          if (!(await session.fresh(page))) {
            page = await session.observe({ screenshot: screenshots })
            continue
          }
          const context = fieldContext(options.goal, action, page, history)
          if (pendingText && JSON.stringify(pendingText.context) === JSON.stringify(context)) {
            text = pendingText.text
            helper = pendingText.helper
          } else {
            helper = await deps.typeText({ ...textSource, signal: options.signal }, context)
            text = helper.text
            // Kept so a stale retry of the same field context reuses this value
            // rather than paying the text model again.
            pendingText = { context, text, helper }
            textCalls.push({
              model: helper.model,
              latency_ms: helper.latencyMs,
              usage: helper.usage,
              field: action.label,
              value: text,
            })
          }
        }
        await deps.execute(session, page, action, text ?? undefined)
      } catch (error) {
        if (error instanceof StalePage) {
          // Reset and re-observe. The paid value is kept: the same field, the same
          // goal, so the same text is still the right answer.
          emit({ type: 'executed', step: history.length + 1, action: action.label, elapsedMs: elapsedMs(), pageChanged: true })
          page = await session.observe({ screenshot: screenshots })
          continue
        }
        throw error
      }
      // Cleared only on a successful mutation, which is what makes the retry above cheap.
      pendingText = null

      const previous = page.fingerprint
      const observed = page.url
      const step = history.length + 1
      // Written before the observation, not after it: the action has already landed, so
      // a page that then refuses to settle must not erase the step, nor turn the run
      // into a crash report for something that did happen. The two fields that need the
      // next observation — page_changed and the settled URL — are filled in below.
      history.push({
        step,
        action: action.label,
        kind: action.kind,
        choice: chosen,
        probability: decision.probabilities[chosen] ?? 0,
        confidence: decision.confidence,
        latency_ms: decision.latencyMs,
        text,
        text_helper: helper?.model ?? null,
        text_latency_ms: helper?.latencyMs ?? 0,
        operation: decision.operation,
        target: decision.target,
        page_changed: null,
        url: observed,
        usage: decision.usage,
        executed_ms: elapsedMs(),
        elapsed_ms: elapsedMs(),
      })
      const record = history[history.length - 1]!
      // The step has landed, but the page it landed on may still be painting. A site that fetches
      // its results reaches `readyState: complete` while the body is still an empty shell, and a
      // decision taken there sees nothing to satisfy — that is how a run once answered with a search
      // it had never read (2026-09-30). `page` is still the state from before the action, which is
      // what tells "the content has arrived" apart from "this page looks unchanged".
      await session.settle?.(page)
      page = await session.observe({ screenshot: screenshots })
      // One frame per step, named by elapsed milliseconds — the shape upstream wrote. It
      // is what lets a finished run be replayed at its real speed instead of imagined.
      artifacts?.frame(page.screenshot, elapsedMs())
      // A step whose effect landed in a tab the site opened leaves this page as it
      // was. Following it is what makes the next decision see the click's result;
      // when this tab's address moved instead, the step happened here, and the run
      // only reports what appeared. The address is the test rather than the whole
      // page, because a site may redraw the page it stays on: a search result turning
      // "visited" is not where the click went, but it does change the page.
      const found = await session.adoptNewPage?.({ onlyIfSameUrl: page.url === observed })
      if (found) {
        let adopted = found.adopted
        if (adopted) {
          page = await session.observe({ screenshot: screenshots })
          // A tab can be reported before it has a title. The observation made right
          // after arriving on it knows the name, and the step line is the only place
          // that name is ever shown, so it is worth the one assignment.
          if (!adopted.title && page.title) adopted = { ...adopted, title: page.title }
          emit({ type: 'followed', step, url: adopted.url, title: adopted.title })
        }
        follows.push({ step, appeared: found.appeared, adopted })
      }
      record.page_changed = page.fingerprint !== previous
      record.url = page.url
      record.elapsed_ms = elapsedMs()
      emit({
        type: 'executed',
        step,
        action: action.label,
        elapsedMs: elapsedMs(),
        pageChanged: record.page_changed === true,
      })

      // ---- is the run stuck on one action? ----
      // The rule after this one counts steps that changed nothing at all, which is enough for a
      // page that simply sits still. The loop that spends a whole budget is busier than that: the
      // click reopens the same layer and the page is a different state on nearly every step, so
      // no three steps in a row are untouched and that rule never fires. What such a page cannot
      // hide is that it keeps coming back to states it has already shown — the state is judged
      // against everything the run has shown so far, not against the step before it.
      const replayed = seenStates.has(page.fingerprint)
      seenStates.add(page.fingerprint)
      recentSteps.push({ replayed, target: record.target })
      if (recentSteps.length > MAX_REPEATED_STEPS) recentSteps.shift()
      if (
        recentSteps.length === MAX_REPEATED_STEPS &&
        recentSteps.every((step) => step.replayed && step.target === recentSteps[0]!.target)
      ) {
        status = 'blocked'
        stuckOn = {
          operation: record.operation,
          target: record.target,
          action: record.action,
          times: MAX_REPEATED_STEPS,
        }
        const what = `${record.operation}${record.target ? ` 目标 ${record.target}` : ''}「${record.action}」`
        reason =
          `同一个动作连着做了 ${MAX_REPEATED_STEPS} 次、页面只是在几个老样子之间打转，先停下——` +
          `它卡在这个动作上了：${what}`
        break
      }

      const tail = history.slice(-3)
      if (tail.length === 3 && tail.every((entry) => entry.page_changed === false && entry.kind !== 'wait')) {
        status = 'blocked'
        const first = tail[0]!.step
        const escaped = follows.filter((record) => record.step >= first && record.adopted === null).length
        reason =
          `连续 ${tail.length} 步当前页面没有任何变化，已停止` +
          (escaped > 0 ? `（其中 ${escaped} 步点开了新窗口，但没有跟过去）` : '')
        break
      }
    }
  } catch (error) {
    status = 'failed'
    reason = error instanceof Error ? error.message : String(error)
  } finally {
    await session?.close()
  }

  // The independent check runs before the run is reported, and it can take the run's own
  // claim back: a `done` the page does not support is a run that did not finish.
  const verification = verify(page?.text ?? '', options.expect)
  if (status === 'done' && verification.checked && !verification.passed) {
    status = 'blocked'
    reason = `模型认为已经完成，但${verification.note}`
  }

  emit({ type: 'finished', status, reason })
  // The run's own last word goes into the trace too, so the file explains how it ended
  // without the reader having to match it against the conversation.
  artifacts?.trace.write({
    at: Date.now(),
    kind: 'run',
    status,
    reason,
    steps: history.length,
    decisions: decisions.length,
    elapsed_ms: elapsedMs(),
    // Only present when that is how it ended: what it was repeating, and how often.
    ...(stuckOn ? { stuck_on: stuckOn } : {}),
  })
  artifacts?.finish(elapsedMs())
  return {
    goal: options.goal,
    status,
    reason,
    elapsedMs: elapsedMs(),
    steps: history.length,
    decisions: decisions.length,
    history,
    textCalls,
    follows,
    verification,
    // Read off the page the run actually stopped on, so the sentence is about what the
    // reader is looking at rather than about a page seen three steps ago.
    pageNote: page ? nestedNote(page.nested) : '',
    omittedActions: page?.omitted_actions ?? 0,
    screenshot: page?.screenshot ?? null,
    recordDir: artifacts?.dir ?? '',
    page: page ? { url: page.url, title: page.title, text: page.text } : null,
    elements: page ? safeElements(page) : [],
  }
}

/** The final element table, for a caller that wants to see what was still available. */
function safeElements(page: PageState): ElementEntry[] {
  try {
    return actionSpace(page.actions).elements
  } catch {
    return []
  }
}

/** Re-exported so callers do not need the browser module for a plain type. */
export type { SnapshotAction }
