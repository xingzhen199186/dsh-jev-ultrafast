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
 *    stops it as well, saying which action it was stuck on instead of burning the budget;
 *  - a step that acted on an element and did not move the screen makes that element a dead end. The
 *    judgement is the plugin's own, and where the run should go instead is not part of it: see
 *    `./dead-ends.ts`. Whether that dead end is then taken out of every copy of the candidate table
 *    before the next request is built is the `excludeDeadEndElements` setting's business — off by
 *    default, and while it is off the run judges the dead ends, reports them, and takes nothing away.
 */
import type { ActionSpace, ElementEntry, TrimmedSpace } from './decision/action-space'
import { actionSpace, trimActionSpace, withoutElements } from './decision/action-space'
import { nextDeadEnds, type DeadEndRecord } from './dead-ends'
import type { FieldContext, TextHelperSource, TextResult } from './decision/text-helper'
import { fieldContext, fieldText } from './decision/text-helper'
import type { Decision, DecisionContext, DecisionSource, HistoryEntry } from './decision/typesafe'
import { InvalidDecision, choose, requestChars, textLeftOut } from './decision/typesafe'
import { CONFIDENCE_FLOOR, MAX_ELEMENTS, MAX_REQUEST_CHARS, MAX_STEPS } from './prompts'
import type { BrowserPort, NewPage, PageState, SnapshotAction } from './browser/session'
import { BrowserSession, StalePage, type SnapshotOptions } from './browser/session'
import { nestedNote } from './browser/nested'
import type { ActResult, CoverRecord } from './browser/act'
import { TargetCovered, act, coverAfter, withCoverActions, withCoverCandidates } from './browser/act'
import type { DiscoverOptions } from './browser/discover'
import { frameAction, openArtifacts, recordable, type TraceSink } from './artifacts'
import { verify, type Verification } from './verify'

/** How a run ended. `blocked` means the loop stopped itself, `failed` means the environment did. */
export type RunStatus = 'done' | 'blocked' | 'failed'

/** One paid text-model call. */
export interface TextCall {
  model: string
  latency_ms: number
  usage: Record<string, unknown>
  field: string
  value: string
}

/** One answer to the operation question, kept so a re-asked step can show what was said. */
export interface AnswerRecord {
  /** The action id the answer would execute, or `DONE` / `BLOCKED`. */
  choice: string
  confidence: number
  /** Probability per operation the question offered. */
  probabilities: Record<string, number>
}

/** One asking of the operation question: an answer, or the service's own words for why it is not one. */
interface Attempt {
  decision: Decision | null
  /** What the decision layer said about an answer that cannot be acted on; empty when it gave one. */
  unusable: string
}

/** Why the first answer of a step did not stand on its own. */
export type ReaskReason = 'low-confidence' | 'unusable'

/**
 * One step whose operation answer could not be stood behind on the first asking and was therefore
 * asked a second time: the service was unsure of it, or what came back could not be read as an
 * answer at all. Recorded whether or not the second asking helped, because a run that stops this way
 * has to be able to show what the service said each time rather than only that it was unsure.
 */
export interface ReaskRecord {
  step: number
  /** Why the first answer did not stand: below the confidence floor, or not an answer that could be read. */
  reason: ReaskReason
  /** Whether the first answer was one that could be read and both askings named the same choice. */
  agreed: boolean
  /** What the first asking said, or `null` when what came back could not be read as an answer. */
  first: AnswerRecord | null
  /** What the second asking said, or `null` when what came back could not be read as an answer. */
  second: AnswerRecord | null
  /**
   * The service's own sentence about an asking that could not be read, per side. Absent when both
   * could be read, which is the ordinary re-ask.
   */
  unusable?: { first?: string; second?: string }
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
   * Whether an element the run judged a dead end is taken out of the candidates. Off by default, and
   * the judgement is made and reported either way — see `./dead-ends.ts` for why the removal waits for
   * a stronger test than the one that produces the judgement. The tool and the inspector take this from
   * the settings page; a caller that leaves it out gets the recorded-only behaviour.
   */
  excludeDeadEndElements?: boolean
  /**
   * Whether an element a page made clickable with its own script — a plain `div` or `span` with a
   * click listener, which is how React and Vue render most of a page — is offered as a candidate
   * alongside the native controls. On unless this says otherwise, because the evidence for it is the
   * browser's own answer to "does this node respond to a click" rather than a guess of ours; off is
   * the reading every page had before the deep scan existed (see `browser/snapshot.ts`).
   */
  guessClickableElements?: boolean
  /**
   * Whether a target the page would not be clicked through becomes something the model can choose,
   * instead of only something it is told. On unless this says otherwise, because the fact alone does
   * not move a choice: the side-by-side comparison run against this option space (2026-10) found the
   * answer unchanged in 15 of 15 requests when the fact was written into the state, and changed in 10
   * of 10 when a candidate was added to or taken out of the question instead. Off is the old
   * behaviour outright — the refusal reaches the next request as the sentence it always was, and no
   * candidate is added to the table (see `browser/act.ts`).
   */
  dismissCoveredTarget?: boolean
  /**
   * Whether a step that opened new windows moves onto the one it was aiming at, when the look finds
   * more than one page it could move onto. On unless this says otherwise: the run then tells the
   * browser what the step was aiming at (the element's label and the goal), and the browser picks the
   * newcomer that shares the most with it — staying put when nothing does, or when two are tied. Off
   * is the old behaviour outright, because the run then says nothing to choose with (see
   * `browser/session.ts`).
   */
  preferRelevantTab?: boolean
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
  open: (url: string, options?: DiscoverOptions, snapshot?: SnapshotOptions) => Promise<BrowserPort>
  decide: (source: DecisionSource, space: ActionSpace, context: DecisionContext) => Promise<Decision>
  typeText: (source: TextHelperSource, context: FieldContext) => Promise<TextResult>
  /**
   * `trace` is the run's own channel again, handed over so an action can write down what only the
   * action knows — a press's focus reading, which nothing on the page keeps afterwards. It is the
   * same sink the model exchanges ride on, and absent exactly when the run is not recording.
   */
  execute: (
    session: BrowserPort,
    page: PageState,
    action: SnapshotAction,
    text?: string,
    trace?: TraceSink,
  ) => Promise<ActResult>
}

const REAL_DEPS: TaskDeps = {
  open: (url, options, snapshot) => BrowserSession.open(url, options, snapshot),
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

/**
 * How many retries that bought no step may happen in a row before the run stops and names the
 * target it could not get past.
 *
 * Three places re-observe the page and go round again without recording a step: a terminal answer
 * (`DONE` / `BLOCKED`) that the page has moved out from under before it is believed, a field that
 * is stale the moment before it is typed into, and an action `act` refused to execute because the
 * page no longer matched it — a repaint, or a target that cannot be found or is covered. Each of
 * them pays for a fresh decision out of the same budget an ordinary step spends, and none of them
 * was bounded on its own before this count. They share one count rather than three separate limits,
 * which is what lets the sentence below name the one target that kept the run from moving.
 *
 * Six, and not two, is the number because the first step of the run this was written for was
 * refused four times before its input went through — an ordinary page repainting under a live run —
 * and a bound of two would have killed it. This is not a rule saying that a page which moves should
 * not be retried: it should be, and it is. It is a rule saying that a retry has to end somewhere,
 * and that where it ended has to be sayable.
 */
const MAX_STALE_RETRIES = 6

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
  /**
   * Steps where the operation answer came back unsure and the same question was asked again, with
   * what it said each time. Empty on a run the service was confident about throughout.
   */
  reasks: ReaskRecord[]
  /** Elements the last request before the run stopped carried. */
  sentElements: number
  /** How many of the page's own elements that request left out; `0` when it carried them all. */
  omittedElements: number
  /** Page-text characters that request had to leave out; `0` when the whole text went. */
  textCut: number
  /** Steps that opened new tabs, and which of those pages the run moved onto. */
  follows: FollowRecord[]
  /**
   * The elements this run judged to be dead ends, in the order it judged them, each with the step that
   * produced the judgement. Recorded whether or not they were taken out of the candidates, so a run can
   * be reviewed for a judgement that set aside the one element that mattered.
   */
  deadEnds: DeadEndRecord[]
  /** Whether those elements were taken out of the candidates, or only written down. */
  deadEndsExcluded: boolean
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
 * One screen, as the repeated-action rule below tells two of them apart: the address, plus the
 * element table reduced to where each element sits, the role it plays and the name it carries.
 *
 * The page's own text is deliberately not in here. A site whose banner carousel rewrites the body
 * on every paint hands the run a different text on every step, and a state keyed on that text
 * therefore looks new every time — on a real hotel-search home page (携程, 2026-10) the run clicked
 * one and the same field 31 times before the rule could see the page come round again, where six
 * was the number it was written to stop on. What a reader would call "the same screen" is the
 * controls standing on it and the address it is at, not the words inside the ads.
 *
 * The entries the deep scan guessed at are left out for the same reason, carried one step further
 * out. A guessed entry is our own inference rather than the page declaring a control, and what it
 * points at can be a carousel slide, an ad, or a price rewritten in place under it — and because
 * those entries are appended after the native controls, one of them churning is exactly the entry
 * most likely to move while nothing a reader would call the screen does. What makes the exclusion
 * worth it is that this state is not only the repeated-action rule's input: `page_changed` is read
 * from it as well (`record.page_changed` below), and the two brakes that read those two things
 * judge the same string — three steps in a row that changed nothing, and the dead ends those steps
 * produce. One guessed row that moves on every paint therefore takes out both at once: no step ever
 * reads as unchanged, the three-in-a-row brake never sees three quiet steps, and the run spends its
 * whole budget on a page that stood still the entire time. The cost is taken knowingly. Movement
 * that happened among the guessed entries alone is invisible here, so a click that only moved such
 * a row reads as having moved nothing — accepted because the address and the native controls are
 * still there to say when the screen really moved, and a guessed row rewriting its own words is the
 * very case this judgement is written to see past.
 */
function repeatedActionState(page: PageState): string {
  return JSON.stringify({
    url: page.url,
    elements: page.actions
      .filter((action) => action.guess === undefined)
      .map((action) => [action.id, action.role ?? '', action.label]),
  })
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
  // Whether a dead end the run judges is taken out of the candidate table or only written down. Off
  // unless it is asked for: the judgement behind it is weaker than the removal it feeds (see
  // `./dead-ends.ts`), so the removal waits behind a switch while the judgement is always made.
  const excludeDeadEnds = options.excludeDeadEndElements === true
  // Whether a step that opened new windows is told to the browser as something to choose among by
  // relevance, or whether the browser keeps making that choice on its own. On unless it is refused,
  // because the choice it replaces was "the last page the browser lists" — the bug it is here for.
  const aimAtRelevantTab = options.preferRelevantTab !== false
  // Whether a cover the page put over a target is answered as a candidate or only as a sentence. On
  // unless it is refused, for the reason on the option above.
  const dismissCover = options.dismissCoveredTarget !== false
  const artifacts = options.record ? openArtifacts(screenshots) : null
  // The trace sink rides along on the sources the caller already built, so recording
  // needs no second plumbing path into the decision or text layers.
  const decisionSource = artifacts ? { ...options.decision, trace: artifacts.trace } : options.decision
  const textSource = artifacts ? { ...options.text, trace: artifacts.trace } : options.text

  const history: HistoryEntry[] = []
  // Every question this run paid for, counted rather than only listed: an answer that comes back
  // unusable was paid for exactly like one that can be acted on, so it spends the same budget.
  let decisionCalls = 0
  const textCalls: TextCall[] = []
  const follows: FollowRecord[] = []
  const reasks: ReaskRecord[] = []
  // What the last request the run made had to leave out. All zero on a page small enough to send
  // whole, which is the ordinary case.
  let sentElements = 0
  let omittedElements = 0
  let textCut = 0
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
  // Retries that re-observed the page and asked again without recording a step, counted across all
  // three paths that do that and cleared by the first step that is recorded. See
  // `MAX_STALE_RETRIES` for what it is bounded at, and why.
  let staleRetries = 0
  // The element that stood over a target the run could not click through, for as long as the run has
  // not moved on from that screen. The refusal is a fact the next request is told (`hint`); this is
  // the same fact in the shape a model can choose, and it is spent with `staleRetries` — the first
  // step that lands means the cover is either gone or no longer in the way.
  let cover: CoverRecord | null = null

  // Every screen the repeated-action rule has shown so far — the address and the element table, as
  // `repeatedActionState` reads them — and the last few steps with the target each one acted on and
  // whether its state was a replay of an earlier one. Together these are what tells a page that
  // keeps producing something new apart from one that is going round in circles.
  const seenStates = new Set<string>()
  const recentSteps: Array<{ replayed: boolean; target: string | null }> = []
  // The elements this run has found to be dead ends: a step acted on one and the screen did not move
  // for it. Read once per request, by `nextDeadEnds`, and emptied by a screen that really changed.
  // The judgement is the plugin's own rather than a sentence to the model — see `./dead-ends.ts` for
  // why, and for what this rule deliberately does not do. The set is what a request is built from when
  // the removal is on; `deadEndsJudged` is the same knowledge in the shape the run reports, and is kept
  // whether or not anything is taken away.
  let deadEnds = new Set<string>()
  const deadEndsJudged: DeadEndRecord[] = []
  // The action the run stopped on because it kept repeating it, when it stopped that way. It
  // rides along into the run's trace, so the file explains the stop without the conversation.
  let stuckOn: { operation: string; target: string | null; action: string; times: number } | null = null

  /**
   * The screen after a step that failed, taken because that step is the last thing this run will
   * do: the action threw, so the observation of its aftermath that every ordinary step makes never
   * happened. Best-effort twice over — the observation that produces the picture can fail as the
   * action did, and the write can fail — and neither is allowed to replace the failure already on
   * its way out with a second one.
   */
  const frameFailedStep = async (step: number, kind: string): Promise<void> => {
    if (!artifacts || !screenshots || !session) return
    try {
      const shot = await session.observe({ screenshot: true })
      artifacts.frame(shot.screenshot, step, frameAction(kind), elapsedMs())
    } catch {
      // Nothing to write; the run's own failure is the story.
    }
  }

  /**
   * Count one retry that re-observed the page and asked again without recording a step, and say why
   * the run stops once there have been too many. See `MAX_STALE_RETRIES` for why the three paths
   * that do this share this one count, and for the number itself. The sentence names the target the
   * run could not get past, the way the repeated-action rule names the action it was stuck on, and
   * takes `why` — what the page said about the refusal it just made, in one short phrase — for the
   * case where there is more to say than "it did not work": the count is the same either way, and
   * a refusal with nothing to add leaves the sentence exactly as it was.
   */
  const staleRetryStop = (operation: string, target: string | null, label: string, why = ''): string | null => {
    staleRetries += 1
    if (staleRetries <= MAX_STALE_RETRIES) return null
    const what = `${operation}${target ? ` 目标 ${target}` : ''}${label ? `「${label}」` : ''}`
    return (
      `在你要执行的目标上连着试了 ${MAX_STALE_RETRIES + 1} 次，每次重新看过都没能执行，` +
      (why ? `这次是${why}，` : '') +
      `先停下——它卡在这个目标上了：${what}`
    )
  }

  try {
    session = await deps.open(options.startUrl, options.browser, {
      guessClickableElements: options.guessClickableElements !== false,
    })
    page = await session.observe({ screenshot: screenshots })
    emit({ type: 'observed', step: 0, url: page.url, elements: page.actions.length })
    // The page the run started on is a state it has now shown, like every state after a step.
    seenStates.add(repeatedActionState(page))
    // The starting frame: without it a replay begins at the first action's aftermath. Step 0,
    // named as such, so the first picture is never read as the first step's result.
    artifacts?.frame(page.screenshot, 0, 'start', 0)
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
      if (decisionCalls >= maxDecisions) {
        status = 'blocked'
        reason = `达到本次运行的模型调用上限（${maxDecisions} 次），已停止`
        break
      }
      // A page that is no longer what the last decision saw is re-observed, and the
      // step continues with the fresh page. Retrying the freshness check instead
      // would spin forever on a page that never settles.
      if (!(await session.fresh(page))) page = await session.observe({ screenshot: screenshots })
      // The page's own table can be far larger than one decision can carry — the GitHub run of the
      // 2026-10 audit grew it from 14 elements to 97 inside one run — so what is sent is a
      // selection. The selection is said out loud rather than passed off as the whole page.
      const note = [nestedNote(page.nested), hint].filter(Boolean).join(' ')
      // What the model is shown, as opposed to what the run judges itself by: the page's own table,
      // plus the element that stood over a target it could not click through and the one press that
      // gets rid of it, while that cover is still the thing in the way (see `withCoverActions`). A
      // page with nothing to add is the very object the browser returned, so the switch's "off" is
      // the behaviour this loop had before any of it existed, byte for byte. Fixed here rather than
      // read again below, so the table the request is measured on is the table it is sent with.
      const viewed = dismissCover ? withCoverActions(page, cover) : page
      const full = actionSpace(viewed.actions)
      // ---- what is already a dead end? ----
      // Asked here, about the state this request is about to carry: the last step acted on an element
      // and its own honest reading says the screen did not move for it, so that element is a dead end,
      // and a step that really moved the screen empties the set (see `./dead-ends.ts`). Recomputed from
      // the step that really preceded this request rather than remembered apart from it, so the two
      // cannot drift. The judgement is made whether or not it is acted on: with the setting off, the set
      // is what the run reports instead of what it takes away.
      const lastStep = history[history.length - 1]
      const judged = nextDeadEnds(deadEnds, lastStep, full.elements.length)
      for (const element of judged) {
        if (deadEnds.has(element)) continue
        // Written down as it is judged, with the step it came from, because that is the only thing that
        // lets a reader check the judgement later — and with the setting off it is the only trace it
        // leaves at all.
        deadEndsJudged.push({
          step: lastStep?.step ?? 0,
          element,
          target: lastStep?.target ?? '',
          label: full.elements.find((entry) => entry.index === element)?.label ?? '',
        })
      }
      deadEnds = judged
      // Taken out of the questions before the cap and the request budget below read the table, so the
      // room one request has is never spent on a candidate the run has already ruled out. Only the
      // candidates go: the element entries stay, because the page's own structure is what the model
      // reads the screen from, and the comparison behind this rule found the question to be the half
      // that decides whether the number is chosen (see `withoutElements`). Which elements they are is
      // never said — they are simply not offered — and they are not counted as left out either: the
      // table still carries every element the page had, so the count below is the cap's own arithmetic
      // and `sentElements + omittedElements` is still the table's own element count — the table the
      // cut was handed, which is the page's own plus the cover's row where a cover added one. With the
      // removal off, nothing is taken away at all and the request is the page's own table.
      const live = excludeDeadEnds ? withoutElements(full, deadEnds) : full
      const recent = history.map((entry) => entry.target)
      // What the service is told about a page the snapshot could only partly see, plus the one-off
      // sentence the last answer earned. Built from the count because the table may still be cut
      // again below; nothing at all on an ordinary step.
      const contextFor = (omitted: number): DecisionContext => ({
        goal: options.goal,
        page: viewed,
        history,
        ...(note ? { note } : {}),
        ...(omitted > 0 ? { omittedElements: omitted } : {}),
      })
      let limit = MAX_ELEMENTS
      // The one thing the cut is not allowed to take: the cover's own two candidates. They sit at the
      // end of the page's own table — the run appended them — so a table that reaches the cap is the
      // table that loses them, and it is exactly the table they are for. They go back in after the cut
      // rather than before it (see `withCoverCandidates`), which is also why the measurement below is
      // made on the table that is really sent: the cap the request body is held to has to see them.
      const fitted = (cut: TrimmedSpace): TrimmedSpace => withCoverCandidates(cut, live)
      let trimmed = fitted(trimActionSpace(live, options.goal, recent, limit))
      // Counting elements is arithmetic, and arithmetic cannot see how long the page's own labels
      // are. What has to fit is the body the service receives, so it is measured and the table is
      // cut again — in the same order, a few entries at a time — until it does. A page light enough
      // for the caps never comes through here; one element is where it stops, because the element
      // that is sent is sent whole.
      while (
        limit > 1 &&
        requestChars(trimmed.space, contextFor(trimmed.omitted), decisionSource.model) > MAX_REQUEST_CHARS
      ) {
        limit -= 4
        trimmed = fitted(trimActionSpace(live, options.goal, recent, limit))
      }
      const { space, omitted } = trimmed
      // Kept for the run's own report, so a reader can see that the last page the run decided on was
      // bigger than one request could carry instead of having to take it on trust.
      sentElements = space.elements.length
      omittedElements = omitted
      textCut = textLeftOut(viewed.text)
      // Built once because the same question may be asked twice: a re-ask is the same request
      // against the same page, not a new one.
      const asked = contextFor(omitted)
      // One asking of the question. An answer the decision layer refuses to hand over — a
      // distribution whose stated winner is not its most probable choice, a field the service left
      // out — is neither a crash nor a page failure: it is the same "ask once more" as a confidence
      // under the floor, and it goes through the same seam and the same budget as one.
      const ask = async (): Promise<Attempt> => {
        decisionCalls += 1
        try {
          const answer = await deps.decide({ ...decisionSource, signal: options.signal }, space, asked)
          return { decision: answer, unusable: '' }
        } catch (error) {
          if (!(error instanceof InvalidDecision)) throw error
          return { decision: null, unusable: error.message }
        }
      }
      const first = await ask()
      hint = ''

      // ---- did it know, or did it guess? ----
      // A confidence under the floor is the service saying it is not sure, and this run used to
      // record that and then act on it anyway — 49 of the 71 decisions in the 2026-10 audit came
      // back this way. The same question is asked once more instead, and only an answer that can
      // stand is executed; a second asking that cannot be read leaves the step nothing to act on
      // at all. Two answers that disagree are a conflict about the operation, not about the target:
      // naming one operation with two different elements is the jitter this second question exists
      // for — the service's two best elements sat 0.01–0.05 apart in the audit — so the first
      // answer is executed and the brakes below judge the step that was actually taken. Only two
      // different operations still stop the run, because that is a disagreement about what to do,
      // which no cheaper rule can settle. This is judged here, before the answers are acted on and
      // before the brakes below: the question is what the service thinks, not what the page did.
      //
      // The narrowing is measured rather than supposed. On the 携程 home page (2026-10) one step was
      // asked the same question twice, byte for byte: the first answer named element 17 (the search
      // button), the second element 16 (the search field itself), both under 0.5 and both CLICK, and
      // the disagreement voided the whole run at its third step after 24.4 seconds of a planned 60.
      // The page did not move for either element and the dead-end rule had already written the target
      // down, so the cheaper brake was the one that should have settled it.
      let decision = first.decision
      if (decision === null || decision.confidence < CONFIDENCE_FLOOR) {
        // The second question is a second decision like any other, so it is only asked while the
        // run still has both a decision and a step to spend; running out here stops the run with
        // the budget's own sentence rather than acting on an answer nobody stands behind.
        if (decisionCalls >= maxDecisions) {
          status = 'blocked'
          reason = `达到本次运行的模型调用上限（${maxDecisions} 次），已停止`
          break
        }
        if (history.length >= maxSteps) {
          status = 'blocked'
          reason = `达到本次运行的动作上限（${maxSteps} 步），已停止`
          break
        }
        const second = await ask()
        const agreed =
          first.decision !== null && second.decision !== null && second.decision.choice === first.decision.choice
        reasks.push({
          step: history.length + 1,
          // What the first answer was stopped by: it was unsure, or it could not be read at all.
          reason: first.decision === null ? 'unusable' : 'low-confidence',
          agreed,
          first: first.decision ? answerRecord(first.decision) : null,
          second: second.decision ? answerRecord(second.decision) : null,
          ...(first.unusable || second.unusable
            ? {
                unusable: {
                  ...(first.unusable ? { first: first.unusable } : {}),
                  ...(second.unusable ? { second: second.unusable } : {}),
                },
              }
            : {}),
        })
        if (second.decision === null) {
          status = 'blocked'
          // The decision layer's own sentence, which names what the service chose, that choice's
          // probability and the choice that was more probable than it. The same sentence answers
          // whether it was the first asking or the second that could not be read: what the reader
          // needs is what the service said, not how many times it was asked.
          reason = second.unusable
          break
        }
        if (first.decision !== null && !agreed) {
          // Two answers that name different operations are a real conflict about what the step
          // should do, and no rule below can settle that: the run stops, with the sentence it always
          // used. Said about the first answer's confidence, because the second one may well be sure
          // — certain and different is exactly the disagreement this stops on.
          if (second.decision.operation !== first.decision.operation) {
            status = 'blocked'
            reason = `决策服务两次给的操作不一样（第一次把握低于 ${CONFIDENCE_FLOOR}），先停下`
            break
          }
          // Same operation, different target: the two answers agree about what to do and disagree
          // only about where. That is the answer the step already had — the first one, the unsure
          // one — and it is executed rather than thrown away. Whether it moves the goal forward is
          // then judged by the rules that cost less than the whole run: the dead end the element
          // earns when the screen does not move for it, the repeated-action rule, and the three
          // steps that changed nothing.
          decision = first.decision
        } else {
          // The second answer is the one that stands: either the two name the same choice, or the
          // first one could not be read at all and this is the only answer the step has.
          decision = second.decision
        }
      }

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
          // A terminal answer names no element of its own, so a stop here can only say which
          // operation the run kept answering with.
          const stopped = staleRetryStop(decision.operation, decision.target, '')
          if (stopped) {
            status = 'blocked'
            reason = stopped
            break
          }
          page = await session.observe({ screenshot: screenshots })
          continue
        }
        status = chosen === 'DONE' ? 'done' : 'blocked'
        reason = chosen === 'DONE' ? '' : '模型判断页面上已没有可以推进目标的操作'
        break
      }
      // Looked up in the table the answer was given, not in the observation alone: a candidate the
      // run added itself (`viewed` above) is a choice like any other, and one that could be answered
      // and then not found would be the "number it chose is not in the table" failure instead.
      const action = viewed.actions.find((candidate) => candidate.id === chosen)
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
          // The fact is only that the number the answer named is not in the table it was given —
          // whether the page redrew under the answer or the number was never there is not something
          // this branch can tell apart, so the sentence says what was seen and leaves the cause a
          // possibility, the way the hint below does.
          reason = `你选的编号在页面里找不到，页面可能自己刷新过，连续 ${MAX_LOST_TARGETS + 1} 次都没对上，这次先停下`
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
            const stopped = staleRetryStop(decision.operation, decision.target, action.label)
            if (stopped) {
              status = 'blocked'
              reason = stopped
              break
            }
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
        // The page the decision was shown, which is the observation plus any candidate the run added
        // to it: a freshness check compares the target's own guard, and the guard of an element the
        // snapshot did not offer is only in the copy (see `withCoverActions`).
        await deps.execute(session, viewed, action, text ?? undefined, artifacts?.trace)
      } catch (error) {
        if (error instanceof StalePage) {
          // A target something else is standing over is the one refusal a fresh look cannot explain:
          // the next screen has the same element, the same number and the same hit test, so the
          // sentence the refusal carries is the only new fact the model can be given. It goes into
          // the existing one-off hint, which is what the next request carries as its note — and, for
          // as long as the run has not moved on from that screen, the same fact goes into the next
          // request as a choice as well (see `cover` below and `withCoverActions`). Nothing here
          // presses Escape or clicks anything: what is added is a candidate, and picking it stays the
          // model's decision to make from the next screen.
          const covered = error instanceof TargetCovered ? error : null
          const stopped = staleRetryStop(
            decision.operation,
            decision.target,
            action.label,
            covered ? `目标被${covered.coverNote}盖住了` : '',
          )
          if (stopped) {
            status = 'blocked'
            reason = stopped
            break
          }
          if (covered) {
            hint = covered.message
            // The same target refused the same way again is the run this is here for; a refusal of a
            // different target starts the count over, and a step that lands clears the whole record.
            cover = coverAfter(cover, covered.covering, decision.target ?? '')
          }
          // Reset and re-observe. The paid value is kept: the same field, the same
          // goal, so the same text is still the right answer.
          emit({ type: 'executed', step: history.length + 1, action: action.label, elapsedMs: elapsedMs(), pageChanged: true })
          page = await session.observe({ screenshot: screenshots })
          continue
        }
        // The action failed and the run ends here, but a step that threw is exactly the one a
        // reader most wants to look at, so the screen it left is taken before the error goes on.
        await frameFailedStep(history.length + 1, action.kind)
        throw error
      }
      // Cleared only on a successful mutation, which is what makes the retry above cheap.
      pendingText = null

      // The screen this step started from, read the way the repeated-action rule reads a screen:
      // the address and the element table, never the page's own text (see `repeatedActionState`).
      const previous = repeatedActionState(page)
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
        // The clue that made this element a guess, when the deep scan was the one that offered it;
        // `null` for a control the page declared. The element table itself cannot carry the marker —
        // it goes into the request body whole — so the step record says it, and the run's last word
        // says it again for the steps that acted on one (see `HistoryEntry.guess`).
        guess: typeof action.guess === 'string' ? action.guess : null,
        page_changed: null,
        url: observed,
        usage: decision.usage,
        executed_ms: elapsedMs(),
        elapsed_ms: elapsedMs(),
      })
      const record = history[history.length - 1]!
      // The step is recorded, so the retry count starts over: what `MAX_STALE_RETRIES` bounds is
      // retries that bought no step, not retries in a run. The cover goes with it, for the same
      // reason: a step that landed is a screen the run has moved on from, and an element that stood
      // over a target two steps ago is not something the next question should still offer.
      staleRetries = 0
      cover = null
      // The step has landed, but the page it landed on may still be painting. A site that fetches
      // its results reaches `readyState: complete` while the body is still an empty shell, and a
      // decision taken there sees nothing to satisfy — that is how a run once answered with a search
      // it had never read (2026-09-30). `page` is still the state from before the action, which is
      // what tells "the content has arrived" apart from "this page looks unchanged".
      await session.settle?.(page)
      page = await session.observe({ screenshot: screenshots })
      // One frame per step, taken after the step landed and named by the step it belongs to.
      // It is what lets a finished run be replayed at its real speed instead of imagined, and
      // the step in the name is what answers "was this before or after the key press?" without
      // the reader having to line two files up themselves.
      artifacts?.frame(page.screenshot, step, frameAction(action.kind), elapsedMs())
      // A step whose effect landed in a tab the site opened leaves this page as it
      // was. Following it is what makes the next decision see the click's result;
      // when this tab's address moved instead, the step happened here, and the run
      // only reports what appeared. The address is the test rather than the whole
      // page, because a site may redraw the page it stays on: a search result turning
      // "visited" is not where the click went, but it does change the page.
      //
      // What the step was aiming at rides along for the case where the look finds more than one page
      // it could move onto — the element it acted on, and the goal — and is left out entirely when
      // the preference is off, which is what makes that switch the old behaviour rather than a second
      // rule that has to agree with it (see `browser/session.ts`).
      const found = await session.adoptNewPage?.({
        onlyIfSameUrl: page.url === observed,
        ...(aimAtRelevantTab ? { aimedAt: `${action.label} ${options.goal}` } : {}),
      })
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
        // Which pages the click opened, and whether the run moved onto one of them, is the one
        // thing about a step that nothing on the page keeps: the tab is gone from the page the run
        // stayed on, so a reader asking afterwards "did this click go somewhere else?" has only the
        // step line in the conversation to go by — and the run is diagnosed from the trace, not
        // from the conversation. So it is written down as the step's own record, the way a press
        // writes down the focus reading it is the only witness to (`browser/act.ts`). A step that
        // opened nothing writes nothing, so an ordinary run's trace is exactly what it always was.
        if (found.appeared.length > 0) {
          // The record carries addresses, and an address is where a credential hides — a page that
          // appears can be a login callback, whose own address holds the code that proves the login
          // (`?code=…`). This is a bare write with no request or response body around it to be made
          // safe on the way past, so the whole record goes through `recordable`, which is the same
          // rule `decision/typesafe.ts` and `decision/text-helper.ts` apply to the bodies they write:
          // it strips every address inside the record of its credential-carrying parameters, wherever
          // one sits. Whole record rather than the two fields, so a field added here later cannot
          // quietly arrive unredacted; the shape and the names are exactly what they were.
          artifacts?.trace.write(
            recordable({
              at: Date.now(),
              kind: 'follow',
              step,
              // Every page that appeared, the followed one included, and which of them the run moved
              // onto. `followed_tab: null` is the case worth the record: a window was opened and the
              // run stayed where it was, which is what a run that looks stuck is doing.
              new_tabs: found.appeared.map((opened) => opened.url),
              followed_tab: adopted?.url ?? null,
            }) as Record<string, unknown>,
          )
        }
      }
      // Judged by that same state, not by the whole-page fingerprint: a page whose banner carousel
      // rewrites its own text on every paint is one screen to a reader, and telling the decision
      // service otherwise is what had it click one and the same field 31 times (携程, 2026-10). One
      // case this reads as "no change" and cannot help reading that way: a click that lands in a new
      // tab leaves this page and its table exactly as they were, which is the 2026-09-29 false
      // "three steps changed nothing" — three clicks that had each opened a tab.
      record.page_changed = repeatedActionState(page) !== previous
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
      // against everything the run has shown so far, not against the step before it. The state is
      // the address and the element table rather than the whole page, so a page whose text churns
      // under a carousel is still judged by the controls standing on it.
      const seen = repeatedActionState(page)
      const replayed = seenStates.has(seen)
      seenStates.add(seen)
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
  // Pages this run opened in a window it never moved onto, counted rather than only listed step by
  // step: it is the one number that says whether a run which looked stuck was in fact landing
  // elsewhere, and reading five step records to find that out is how this went unnoticed.
  const unfollowedTabs = follows.reduce(
    (count, record) => count + record.appeared.length - (record.adopted ? 1 : 0),
    0,
  )
  // The run's own last word goes into the trace too, so the file explains how it ended
  // without the reader having to match it against the conversation.
  //
  // Three of its fields are text this plugin did not write. `reason` is an error message on a
  // failed run, and a service's own words ride inside it (`decision/typesafe.ts` puts the
  // server's reply in, `decision/text-helper.ts` the vendor's message). `stuck_on.action` and
  // `dead_ends[].label` are the page's own wording, and a link's label is often the address it
  // points at. Either one can be a login callback's address, whose `?code=…` is the credential
  // it carries, and this is a bare write with no request or response body to be made safe on
  // the way past — so the whole record goes through `recordable`, the rule the step record
  // above and every exchange body already pass. Whole record rather than the three fields, so
  // a field added here later cannot quietly arrive unredacted; the shape and the names are
  // exactly what they were.
  artifacts?.trace.write(
    recordable({
      at: Date.now(),
      kind: 'run',
      status,
      reason,
      steps: history.length,
      decisions: decisionCalls,
      elapsed_ms: elapsedMs(),
      // Only present when that is how it ended: what it was repeating, and how often.
      ...(stuckOn ? { stuck_on: stuckOn } : {}),
      // Likewise: what the service said on the steps it was not sure about, and whether the two
      // answers it gave agreed.
      ...(reasks.length > 0 ? { reasks } : {}),
      // And the dead ends the run judged for itself: which elements, at which step, and whether they
      // were taken out of the candidates or only written down.
      ...(deadEndsJudged.length > 0 ? { dead_ends: deadEndsJudged, dead_ends_excluded: excludeDeadEnds } : {}),
      // Likewise, the steps that acted on an element the page did not declare but the deep scan
      // offered as a guess (`browser/snapshot.ts`), so the record answers on its own which of the
      // table's entries were our own inference — what the 携程 diagnosis of 2026-10 had to work out
      // by comparing the table's tail against a baseline instead, because the marker is left out of
      // the table before the table becomes a request. Written only when there was one, so an
      // ordinary run's last word is what it always was.
      ...(history.some((entry) => entry.guess !== null)
        ? {
            guessed_steps: history
              .filter((entry) => entry.guess !== null)
              .map((entry) => ({
                step: entry.step,
                target: entry.target,
                action: entry.action,
                guess: entry.guess,
              })),
          }
        : {}),
      // Likewise: how many pages it opened in a window it stayed away from, when there were any.
      ...(unfollowedTabs > 0 ? { unfollowed_tabs: unfollowedTabs } : {}),
    }) as Record<string, unknown>,
  )
  artifacts?.finish(elapsedMs())
  return {
    goal: options.goal,
    status,
    reason,
    elapsedMs: elapsedMs(),
    steps: history.length,
    decisions: decisionCalls,
    history,
    textCalls,
    reasks,
    sentElements,
    omittedElements,
    textCut,
    follows,
    deadEnds: deadEndsJudged,
    deadEndsExcluded: excludeDeadEnds,
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

/** The three things a re-ask record keeps about one answer the service gave. */
function answerRecord(decision: Decision): AnswerRecord {
  return {
    choice: decision.choice,
    confidence: decision.confidence,
    probabilities: decision.operationProbabilities,
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
