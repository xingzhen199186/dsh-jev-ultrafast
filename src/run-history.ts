/**
 * What the runs left on disk say about the runs that never finished.
 *
 * The loop's last word is a trace record of kind `run` (see `loop.ts`): status, steps, decisions,
 * elapsed time. A run that is killed together with the process — a DSH restart, a crash, a forced
 * quit — never writes it, because there is nothing left alive to write it. That absence is the
 * only honest evidence available, and until now nobody read it: the answer promised a result, the
 * session went quiet, and "still working" looked exactly like "already dead".
 *
 * So this module answers one question with that evidence: which runs started before this process
 * did and never reached their end? Reading only — the artifacts belong to `openArtifacts`.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Where `openArtifacts` writes; the same layout `inspector.ts` reads. */
export const ARTIFACTS_ROOT = join(tmpdir(), 'dsh-jev-ultrafast')
/** Exactly the names `openArtifacts` writes. A directory this module did not create is not read. */
const RUN_NAME = /^run-([0-9]+)-[a-z0-9]{4}$/

/** One run still on disk, with the start time its own directory name carries. */
export interface PastRun {
  name: string
  startedAt: number
}

/** The runs still on disk, oldest first. An unreadable root is simply no runs. */
export function pastRuns(root: string = ARTIFACTS_ROOT): PastRun[] {
  let names: string[]
  try {
    names = readdirSync(root)
  } catch {
    return []
  }
  return names
    .flatMap((name) => {
      const matched = RUN_NAME.exec(name)
      return matched === null ? [] : [{ name, startedAt: Number(matched[1]) }]
    })
    .sort((left, right) => left.startedAt - right.startedAt)
}

/** Did this run write the loop's last word? Garbage lines are ignored, not treated as an end. */
export function hasLastWord(dir: string): boolean {
  let text: string
  try {
    text = readFileSync(join(dir, 'trace.jsonl'), 'utf8')
  } catch {
    return false
  }
  return text.split('\n').some((line) => {
    if (!line.trim()) return false
    try {
      const record = JSON.parse(line) as { kind?: unknown }
      return record !== null && typeof record === 'object' && record.kind === 'run'
    } catch {
      return false
    }
  })
}

/**
 * Runs that started before this process and never finished: they were killed with the process
 * that was running them. This process's own runs are excluded — a run in flight right now has no
 * last word yet either, and reporting it as dead would be the opposite of the point.
 */
export function interruptedRuns(
  root: string = ARTIFACTS_ROOT,
  bootedAt: number = Date.now() - process.uptime() * 1000,
): PastRun[] {
  return pastRuns(root).filter((run) => run.startedAt < bootedAt && !hasLastWord(join(root, run.name)))
}

/**
 * The deaths still worth mentioning: runs that started after the newest run that did finish.
 *
 * A successful run since then means the older loss is stale news — it has been paid for already —
 * and repeating it on every command would be nagging rather than informing. When nothing has ever
 * finished, every death is still news. Pure: this reads, and writes nothing.
 */
export function unfinishedDeaths(
  root: string = ARTIFACTS_ROOT,
  bootedAt: number = Date.now() - process.uptime() * 1000,
): PastRun[] {
  const deaths = interruptedRuns(root, bootedAt)
  if (deaths.length === 0) return []
  const finished = pastRuns(root).filter((run) => hasLastWord(join(root, run.name)))
  const newestWin = finished.length === 0 ? 0 : finished[finished.length - 1]!.startedAt
  return deaths.filter((run) => run.startedAt > newestWin)
}
