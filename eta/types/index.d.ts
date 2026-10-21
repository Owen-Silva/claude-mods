/**
 * The plan the model declared through the Eta tool. `minutes` is how many
 * more minutes the model said at `declaredAt`; `originalMinutes` is the
 * first estimate of the plan (what calibration compares with the real time),
 * given at `estimatedAt`. `seq` changes only when new minutes are given, so
 * the overdue nudge fires once per estimate.
 */
export type EtaPlan = {
  id: number
  startedAt: number
  estimatedAt: number | null
  originalMinutes: number | null
  minutes: number | null
  declaredAt: number
  steps: string[]
  step: number | string | null
  note: string | null
  seq: number
  nudgedFor: number | null
  /**
   * Every estimate of the plan, the first included: when, how many minutes,
   * and the calibration factor the band applied to it (null: shown as said).
   * Optional: plans saved before it existed lack it.
   */
  estimates?: EtaEstimate[]
  /** The finish range the band showed for the first estimate, in minutes (null: one number). */
  firstRange?: [number, number] | null
}

/** One estimate of a plan: when it was given, its minutes, and the factor the band applied. */
export type EtaEstimate = { at: number; min: number; f: number | null }

/**
 * One finished plan in eta's append-only history (history.jsonl, one JSON
 * line each). Numbers and times only: no prompt text, notes, steps or file
 * names. `took` is minutes from the first estimate to the finish (what
 * calibration compares with `first`); `factor` is the calibration ratio the
 * band applied to the first estimate (null: shown as said), `range` the
 * finish range it showed in minutes when it showed one. `factorSrc` is
 * `replayed` for backfilled records (the factor recomputed under the rules
 * of the backfill, since the one shown was never written down).
 */
export type EtaHistoryRecord = {
  v: 1
  id: string
  session: string | null
  project: string | null
  startedAt: number
  firstAt: number
  finishedAt: number
  first: number
  estimates: EtaEstimate[]
  took: number
  factor: number | null
  range?: [number, number] | null
  factorSrc: 'shown' | 'replayed'
  end: 'done' | 'idle'
  src: 'live' | 'transcript' | 'store'
}

/**
 * One subagent run eta tracks. `isExactStart` is false when eta first saw it
 * already running (its start is then the sighting); `kind` is `resume` when a
 * finished agent ran again (SendMessage).
 */
export type EtaAgent = {
  id: string
  type: string
  label: string
  startedAt: number
  isExactStart: boolean
  kind: 'run' | 'resume'
  status: string
  endedAt: number | null
}

/**
 * A stretch of work: from the turn that began it until no turn, agent or
 * background task is left. `lastActiveAt` is when the last of those ended.
 */
export type EtaWork = {
  id: number
  startedAt: number
  isTurnRunning: boolean
  lastActiveAt: number
  backgroundTasks: number
  firstEstimateMs: number | null
  isDone: boolean
  isToasted: boolean
  /** The last main turn was interrupted: its end is no finish (no toast, no calibration). */
  wasAborted?: boolean
}

/** One finished declared estimate: what was said and what it took, in minutes. */
export type EtaCalSample = { said: number; took: number; at: number }

/**
 * What eta has learned: finished agent runs (seconds) by type, calibration
 * samples, and fix cycles (seconds from a failed test/build run to the next
 * passing one). `fixCycles` is optional: state saved before it existed lacks it.
 */
export type EtaLearned = {
  durations: Record<string, number[]>
  calibration: EtaCalSample[]
  fixCycles?: number[]
  /** Past re-estimates (what remained, said, against what it took), from history.jsonl: the re-estimate range. */
  reSamples?: EtaCalSample[]
}

/**
 * A push-out of the finish since the model's last estimate: a failed test or
 * build run. `floorAt` is the earliest finish shown until the model calls Eta
 * with fresh minutes; `reason` says why (`test failed`), `extendedMs` by how
 * much the failures pushed it in total, `count` how many failed runs.
 */
export type EtaBump = { floorAt: number; reason: string; extendedMs: number; at: number; count: number }

/** This session as the snapshot names it. */
export type EtaSelf = { sessionId: string; project: string; cwd: string }

/**
 * Everything the band, the pane and the snapshot are drawn from. `problems`
 * holds each failing data source with its reason, keyed by source.
 */
export type EtaLive = {
  work: EtaWork | null
  plan: EtaPlan | null
  agents: Record<string, EtaAgent>
  learned: EtaLearned
  label: string
  self: EtaSelf | null
  tzOffsetMin: number | null
  tzSource: string
  problems: Record<string, string>
  seq: number
  tick: number
  /** The finish pushed out by failures since the last estimate (optional: older state lacks it). */
  bump?: EtaBump | null
  /** The last Eta tool call from the main session, of any kind. */
  lastEtaAt?: number | null
  /** The last re-estimate nudge (failure, the user's message, stale, overdue): rate-limits them. */
  lastNudgeAt?: number | null
  /** The first failed test/build run not yet followed by a passing one: a fix cycle in progress. */
  fixStartedAt?: number | null
}

/** One session's snapshot file in the shared folder (one per session). */
export type EtaSnapshot = {
  v: 1
  sessionId: string
  project: string
  cwd: string
  label: string
  state: 'working' | 'idle' | 'ended'
  summary: string
  etaAt: number | null
  /** The shown finish (`etaAt`) has passed and the work is not done: show "over by", never "~0 min". */
  isOverdue: boolean
  agentsRunning: number
  workStartedAt: number | null
  updatedAt: number
  /** Why the number went up, display-ready (`test failed · +10m`, `2 agents past usual · +8m`); null when it has not. */
  reason?: string | null
  /** Whole minutes the finish was pushed past the model's estimate (or the first agent-based one); 0 when not. */
  extendedBy?: number
}

/** A row of the all-sessions list. */
export type EtaSessionRow = {
  sessionId: string
  isSelf: boolean
  project: string
  label: string
  state: EtaSnapshot['state']
  summary: string
  etaAt: number | null
  isOverdue: boolean
  updatedAt: number
  isSilent: boolean
}

/** The all-sessions list, with what was left out and why. */
export type EtaSessions = {
  at: number
  rows: EtaSessionRow[]
  hidden: { idle: number; ended: number; dead: number }
  errors: string[]
}

declare module 'claude-code' {
  interface PluginState {
    eta: { live: EtaLive | null; sessions: EtaSessions | null }
  }
}
