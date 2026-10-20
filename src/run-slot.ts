/**
 * The one run this process is driving, whoever started it.
 *
 * Three doors can start a browser run — the tool, the slash command, and the inspector page — and
 * before this module only the third could be paused, stepped or stopped. Two runs at once would
 * drive the same browser window and neither could say which click belonged to which goal, so the
 * slot is one deep on purpose: a second caller is refused with a sentence a reader can act on,
 * rather than silently queued behind work it cannot see.
 *
 * The same table also remembers the run that just ended, in the shape `resume.ts` needs: where it
 * stopped, what it did, and why it stopped. That is the whole of what a continuation can honestly
 * reuse — the page was closed with the run, and the element indices a dead-end judgement carries
 * are minted per frame, so they say nothing about a page opened afterwards.
 *
 * Nothing here reaches into the loop or the browser: it holds a controller, a pause flag and one
 * sentence of progress, and the loop asks it before each step. That is what lets all three doors
 * share it without any of them knowing about the others.
 */
import type { RunStatus, TaskResult } from './loop'

/** Which door started the run. The inspector uses it to tell its own run from somebody else's. */
export type SlotOwner = 'tool' | 'command' | 'inspector'

/** What the inspector page's four buttons say. */
export type SlotControl = 'pause' | 'resume' | 'step' | 'stop'

/**
 * What a finished run leaves for the next one. Facts the loop already reported, and only those:
 * no page text, no goal text, nothing about credentials.
 */
export interface LastRun {
  /** Where the run stopped. A continuation opens this address again. */
  url: string
  status: RunStatus
  reason: string
  /** The actions it took, in order, as the run reported them. */
  actions: readonly string[]
  steps: number
  decisions: number
}

/** A caller's handle on the run it claimed. Giving it back is `release`. */
export interface RunLease {
  readonly owner: SlotOwner
  readonly goal: string
  readonly controller: AbortController
  /**
   * Awaited once per step, after the decision and before anything is typed or clicked. Returning
   * from here is what lets either one step through or the whole run carry on.
   */
  gate: (state: { step: number; action: string }) => Promise<void>
  /** One line of progress, for a page that is not this run's own. */
  progress: (line: string) => void
  control: (action: SlotControl) => boolean
  /** Give the slot back; passing the finished run is what makes it available to `resume`. */
  release: (finished?: LastRun) => void
  state: () => SlotState
}

/** What a page can say about a run without owning it. */
export interface SlotState {
  owner: SlotOwner
  goal: string
  paused: boolean
  waiting: boolean
  line: string
}

interface Active {
  owner: SlotOwner
  goal: string
  controller: AbortController
  paused: boolean
  stepped: boolean
  waiting: boolean
  hold: (() => void) | null
  line: string
  /** Told when the gate starts holding, so a page can log the step it is holding. */
  onHold?: (state: { step: number; action: string }) => void
}

let active: Active | null = null
let last: LastRun | null = null

/**
 * Take the slot. A second caller while one is running gets a sentence, not a queue: both would
 * drive the same window, and "it is waiting for the other one" is not something a reader can see.
 */
export function claimRun(input: {
  owner: SlotOwner
  goal: string
  controller?: AbortController
  onHold?: (state: { step: number; action: string }) => void
}): { ok: true; lease: RunLease } | { ok: false; error: string } {
  if (active !== null) {
    return {
      ok: false,
      error: `已经有一次运行在跑（${active.goal}）。等它结束，或者在检查器里按「停止」再试。`,
    }
  }
  const run: Active = {
    owner: input.owner,
    goal: input.goal,
    controller: input.controller ?? new AbortController(),
    paused: false,
    stepped: false,
    waiting: false,
    hold: null,
    line: '',
  }
  if (input.onHold !== undefined) run.onHold = input.onHold
  active = run

  const lease: RunLease = {
    owner: run.owner,
    goal: run.goal,
    controller: run.controller,
    gate: (state) => gate(run, state),
    progress: (line) => {
      run.line = line
    },
    control: (action) => control(run, action),
    release: (finished) => {
      if (active === run) active = null
      if (finished !== undefined) last = finished
    },
    state: () => stateOf(run),
  }
  return { ok: true, lease }
}

/** The slot's own state, for a page that did not claim it. Null when nothing is running. */
export function activeState(): SlotState | null {
  return active === null ? null : stateOf(active)
}

/** Drive the run somebody else claimed: the inspector's /control, whatever door started it. */
export function controlActive(action: SlotControl): boolean {
  return active === null ? false : control(active, action)
}

/** The run that most recently ended, for `resume`. Null before the first one in this process. */
export function lastRun(): LastRun | null {
  return last
}

/** Test seam: forget the memory. Nothing in the plugin calls this. */
export function forgetLastRun(): void {
  last = null
}

/** What a finished task leaves behind for the next one. */
export function lastRunOf(result: TaskResult): LastRun {
  return {
    url: result.page?.url ?? '',
    status: result.status,
    reason: result.reason,
    actions: result.history.map((entry) => entry.action),
    steps: result.steps,
    decisions: result.decisions,
  }
}

async function gate(run: Active, state: { step: number; action: string }): Promise<void> {
  if (!run.paused || run.stepped) {
    run.stepped = false
    return
  }
  run.waiting = true
  run.onHold?.(state)
  await new Promise<void>((resolve) => {
    run.hold = resolve
  })
  run.waiting = false
  run.hold = null
  run.stepped = false
}

function control(run: Active, action: SlotControl): boolean {
  const release = (): void => {
    run.hold?.()
    run.hold = null
  }
  if (action === 'pause') {
    run.paused = true
    return true
  }
  if (action === 'resume') {
    run.paused = false
    release()
    return true
  }
  if (action === 'step') {
    run.stepped = true
    release()
    return true
  }
  if (action === 'stop') {
    // Cancellation, not a nudge: the loop checks the signal right after the hold, so a paused run
    // stops without executing the action it was holding.
    run.controller.abort()
    release()
    return true
  }
  return false
}

function stateOf(run: Active): SlotState {
  return {
    owner: run.owner,
    goal: run.goal,
    paused: run.paused,
    waiting: run.waiting,
    line: run.line,
  }
}
