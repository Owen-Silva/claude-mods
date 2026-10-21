// eta core: the countdown math, the wording, calibration, learned agent
// durations and the snapshot rules. Pure functions only (no `$`), so the
// tests drive them directly and the hooks module stays wiring.
import type {
  EtaAgent,
  EtaBump,
  EtaCalSample,
  EtaEstimate,
  EtaHistoryRecord,
  EtaLearned,
  EtaLive,
  EtaPlan,
  EtaSelf,
  EtaSessionRow,
  EtaSessions,
  EtaSnapshot,
  EtaWork,
} from '../types'
import { capital, DEFAULT_NAME, possessive } from './user'

export const MIN = 60_000
/** The main session's own check after the last agent lands. */
export const VERIFY_MS = 3 * MIN
/** An agent type eta has no history or prior for. */
export const DEFAULT_AGENT_MS = 10 * MIN
/** A stretch of work this long or longer ends with a toast. */
export const DONE_TOAST_MIN_MS = 3 * MIN
/** The nudge fires once the declared estimate is passed by more than half. */
export const NUDGE_FACTOR = 1.5
export const CAL_MIN_SAMPLES = 3
export const CAL_MIN_RATIO = 0.75   // never shrink an estimate by more than a quarter: a short number that later jumps up is worse than a slightly long one (2026-10-09)
export const CAL_MAX_RATIO = 3
export const HISTORY_KEEP = 20
export const CAL_KEEP = 30
/** A toast this late after the work really ended would only confuse; it is skipped. */
export const LATE_TOAST_MS = 5 * MIN
/** No turn, no agents: the work is over once this has passed (the re-invocation never came). */
export const IDLE_END_MS = 2 * MIN
/** Background tasks were reported but nothing else runs: give up waiting after this. */
export const BACKGROUND_END_MS = 30 * MIN
/** Agents finishing within this of the declared time do not override it. */
export const SLACK_MS = MIN
/** An idle session's snapshot older than this is dropped from the list. */
export const STALE_IDLE_MS = 15 * MIN
/** A working session that has not written for this long is flagged as maybe closed. */
export const SILENT_WORKING_MS = 3 * MIN
/** A working session silent this long is presumed closed and dropped. */
export const DEAD_WORKING_MS = 60 * MIN
/** A failed test/build run costs a fix cycle: this until eta has learned its own. */
export const FIX_DEFAULT_MS = 10 * MIN
export const FIX_MIN_MS = 3 * MIN
export const FIX_MAX_MS = 30 * MIN
export const FIX_MIN_SAMPLES = 3
/** A failure-to-pass stretch longer than this was not one fix cycle; it is not learned. */
export const FIX_SAMPLE_MAX_MS = 60 * MIN
/** Re-estimate nudges (failure, the user's message, stale, overdue): at most one per this, per session. */
export const NUDGE_EVERY_MS = 10 * MIN
/** Tool calls keep coming and Eta has not been called for this long: nudge. */
export const STALE_ETA_MS = 10 * MIN
/** An agent past its usual time is given at least this much more. */
export const OVER_MIN_MS = 2 * MIN
/** Calibration uses only finished estimates within this factor of the current one's size. */
export const CAL_MATCH = 2

export const TOOL_NAME = 'Eta'
export const TOOL_FULL_NAME = 'mcp__eta__Eta'
/**
 * eta's data folder (snapshots and the history): <CLAUDE_CONFIG_DIR, else
 * <home>/.claude>/mods-data/eta, forward slashes, no trailing slash; null
 * without either. register.tsx reads the variables; tools/* pass process.env.
 */
export function etaDir(env: { configDir?: string | null; home?: string | null }): string | null {
  const clean = (p: string) => p.split('\\').join('/').replace(/\/+$/, '')
  if (env.configDir && env.configDir.trim() !== '') return `${clean(env.configDir.trim())}/mods-data/eta`
  if (env.home && env.home.trim() !== '') return `${clean(env.home.trim())}/.claude/mods-data/eta`
  return null
}
/** What the pane and the history line say when there is no data folder. */
export const NO_DIR = 'no data folder: USERPROFILE and HOME are unset'

/**
 * The system-prompt line. STATIC: a section whose text varies re-caches the
 * whole conversation, so nothing here may depend on state. `name` is the name
 * setting (hooks/user.ts), the same all session unless its file is edited.
 */
export function promptLine(name: string = DEFAULT_NAME): string {
  return `${capital(name)} hates asking how much longer. When work will take more than ~2 minutes, call the Eta tool (mcp__eta__Eta) with an estimate in minutes and the steps; call it again at each milestone or when the estimate changes; call it with done:true when finished. A band above ${possessive(name)} prompt shows the countdown.`
}

export const toolDescription = (name: string = DEFAULT_NAME): string => `${promptLine(name)}

Fields (all optional; send only what changed):
- minutes: how many more minutes from now until the whole task is done, verification included. Your honest estimate.
- steps: the plan's milestones in order, short labels.
- step: the 1-based number (or the label) of the step you are on now.
- note: a few words on what you are doing.
- done: true once finished; ends the countdown.
Running subagents are counted too, by their usual durations, and eta learns how your estimates compare with the time work really takes.`

export const TOOL_SCHEMA = {
  type: 'object',
  properties: {
    minutes: { type: 'number', minimum: 0, description: 'More minutes from now until done.' },
    steps: { type: 'array', items: { type: 'string' }, description: 'Milestones, in order.' },
    step: { anyOf: [{ type: 'number' }, { type: 'string' }], description: 'Current step: 1-based number or label.' },
    note: { type: 'string', description: 'What you are doing now, a few words.' },
    done: { type: 'boolean', description: 'true when the work is finished.' },
  },
} as const

/** Measured runs (seconds) that seed each type's history before eta has its own. */
export const PRIORS: Readonly<Record<string, readonly number[]>> = {
  'opus-high': [650, 686, 733, 762],
  'opus-xhigh': [1300, 1634],
  resume: [150],
}

// ---------- small helpers ----------

export function median(xs: readonly number[]): number {
  const s = [...xs].sort((a, b) => a - b)
  const n = s.length
  if (n === 0) return NaN
  const mid = Math.floor(n / 2)
  return n % 2 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2
}

export function clip(text: string, n: number): string {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length > n ? `${one.slice(0, n - 1).trimEnd()}…` : one
}

/** `<1m`, `14m`, `1h05m`. */
export function fmtDur(ms: number): string {
  const m = Math.round(Math.max(0, ms) / MIN)
  if (m < 1) return '<1m'
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  return `${h}h${String(m % 60).padStart(2, '0')}m`
}

/** Wall-clock `4:32 PM`, `tzOffsetMin` minutes east of UTC. */
export function fmtClock(ms: number, tzOffsetMin: number): string {
  const d = new Date(Math.round(ms / MIN) * MIN + tzOffsetMin * MIN)
  const h24 = d.getUTCHours()
  const h = h24 % 12 === 0 ? 12 : h24 % 12
  return `${h}:${String(d.getUTCMinutes()).padStart(2, '0')} ${h24 < 12 ? 'AM' : 'PM'}`
}

export function laneOf(prompt: string): string | null {
  const m = /\[lane:([^\]\s]+)\]/.exec(prompt)
  return m ? (m[1] as string) : null
}

export function emptyLive(): EtaLive {
  return {
    work: null,
    plan: null,
    agents: {},
    learned: { durations: {}, calibration: [] },
    label: '',
    self: null,
    tzOffsetMin: null,
    tzSource: 'not probed yet',
    problems: {},
    seq: 0,
    tick: 0,
  }
}

export const isRunningStatus = (s: string) => s === 'running' || s === 'pending'

// ---------- learned agent durations ----------

export type Expect = { ms: number; source: 'learned' | 'prior' | 'guess'; n: number; learnedN: number }

/** The runs (seconds) a type's expectation is drawn from: priors then learned, newest 20. */
export function historyFor(key: string, durations: Readonly<Record<string, readonly number[]>>): number[] {
  return [...(PRIORS[key] ?? []), ...(durations[key] ?? [])].slice(-HISTORY_KEEP)
}

/**
 * More time for a run already past its usual: the median of the past runs that
 * lasted longer than this one has so far, less its elapsed time, capped at
 * half the elapsed time (one runaway run must not add an hour at once), and
 * never under OVER_MIN_MS. It grows as the run drags on instead of sitting at
 * a minute.
 */
export function overRemainingMs(historySec: readonly number[], elapsedMs: number): number {
  const longer = historySec.map(s => s * 1000).filter(ms => ms > elapsedMs)
  const cond = longer.length > 0 ? median(longer) - elapsedMs : Infinity
  return Math.round(Math.max(OVER_MIN_MS, Math.min(cond, elapsedMs * 0.5)))
}

/** What a run of this kind usually takes: the median of priors and learned runs, newest 20. */
export function expectedFor(key: string, durations: Readonly<Record<string, readonly number[]>>): Expect {
  const own = durations[key] ?? []
  const all = historyFor(key, durations)
  if (all.length === 0) return { ms: DEFAULT_AGENT_MS, source: 'guess', n: 0, learnedN: 0 }
  return { ms: Math.round(median(all) * 1000), source: own.length > 0 ? 'learned' : 'prior', n: all.length, learnedN: own.length }
}

export const historyKey = (a: Pick<EtaAgent, 'type' | 'kind'>) => (a.kind === 'resume' ? 'resume' : a.type)

export function withDuration(durations: Record<string, number[]>, key: string, seconds: number): Record<string, number[]> {
  return { ...durations, [key]: [...(durations[key] ?? []), Math.round(seconds)].slice(-HISTORY_KEEP) }
}

export type AgentEta = {
  agent: EtaAgent
  elapsedMs: number
  expect: Expect
  remainingMs: number
  isOver: boolean
}

export function agentEtas(live: EtaLive, now: number): AgentEta[] {
  return Object.values(live.agents)
    .filter(a => isRunningStatus(a.status))
    .map(agent => {
      const elapsedMs = Math.max(0, now - agent.startedAt)
      const key = historyKey(agent)
      const expect = expectedFor(key, live.learned.durations)
      const left = expect.ms - elapsedMs
      const isOver = left < MIN
      // Past its usual: push out by what longer runs of its kind took, never a falling minute.
      const remainingMs = isOver ? Math.max(MIN, overRemainingMs(historyFor(key, live.learned.durations), elapsedMs)) : left
      return { agent, elapsedMs, expect, remainingMs, isOver }
    })
    .sort((a, b) => b.remainingMs - a.remainingMs)
}

export type AgentsSummary = {
  count: number
  maxRemainingMs: number
  dueAt: number
  guessed: number
  over: number
  unsure: number
}

/** Agents run in parallel: they are done when the slowest is, then the main session verifies. */
export function agentsSummary(etas: readonly AgentEta[], now: number): AgentsSummary | null {
  if (etas.length === 0) return null
  const maxRemainingMs = Math.max(...etas.map(a => a.remainingMs))
  return {
    count: etas.length,
    maxRemainingMs,
    dueAt: now + maxRemainingMs + VERIFY_MS,
    guessed: etas.filter(a => a.expect.source === 'guess').length,
    over: etas.filter(a => a.isOver).length,
    unsure: etas.filter(a => !a.agent.isExactStart && a.agent.kind === 'run').length,
  }
}

// ---------- calibration ----------

export type Calibration = { n: number; median: number | null; ratio: number | null; matched: number | null }

/**
 * took/said, median over the samples; applied (clamped) only from
 * CAL_MIN_SAMPLES on. Given `forMinutes` (the estimate it is for), only
 * finished estimates of a similar size (within CAL_MATCH×) count, and with
 * fewer than CAL_MIN_SAMPLES of those nothing is applied: a real history showed
 * big estimates finishing at ~0.6× while ones under 45m take ~1.0×, so one
 * global factor shrank the small ones below reality.
 */
export function calibration(samples: readonly EtaCalSample[], forMinutes: number | null = null): Calibration {
  const ok = samples.filter(s => s.said >= 1 && s.took > 0)
  if (ok.length === 0) return { n: 0, median: null, ratio: null, matched: null }
  const med = median(ok.map(s => s.took / s.said))
  if (forMinutes === null || !(forMinutes >= 1)) {
    const ratio = ok.length >= CAL_MIN_SAMPLES ? Math.min(CAL_MAX_RATIO, Math.max(CAL_MIN_RATIO, med)) : null
    return { n: ok.length, median: med, ratio, matched: null }
  }
  const near = ok.filter(s => s.said >= forMinutes / CAL_MATCH && s.said <= forMinutes * CAL_MATCH)
  if (near.length < CAL_MIN_SAMPLES) return { n: ok.length, median: med, ratio: null, matched: near.length }
  const nearMed = median(near.map(s => s.took / s.said))
  return { n: ok.length, median: med, ratio: Math.min(CAL_MAX_RATIO, Math.max(CAL_MIN_RATIO, nearMed)), matched: near.length }
}

export function ratioText(r: number): string {
  const x = (Math.round(r * 10) / 10).toFixed(1).replace(/\.0$/, '')
  return r >= 1 ? `estimates run ~${x}× long` : `work takes ~${x}× the estimate`
}

const factorText = (r: number) => (Math.round(r * 10) / 10).toFixed(1).replace(/\.0$/, '')

/** `similar ones took 0.4–1.5× the estimate`: the shown range as factors of what was said. */
export function rangeText(d: Pick<DeclaredView, 'range' | 'minutes' | 'declaredAt' | 'isRe'>): string {
  if (!d.range || !(d.minutes > 0)) return ''
  const ms = d.minutes * MIN
  const lo = factorText((d.range[0] - d.declaredAt) / ms)
  const hi = factorText((d.range[1] - d.declaredAt) / ms)
  return `${d.isRe ? 're-estimates like it' : 'similar ones'} took ${lo}–${hi}× that`
}

/** `4:15–4:48 PM`; `11:40 AM–12:20 PM` across noon. */
export function clockRange(lo: number, hi: number, tzOffsetMin: number): string {
  const a = fmtClock(lo, tzOffsetMin)
  const b = fmtClock(hi, tzOffsetMin)
  return a.slice(-3) === b.slice(-3) ? `${a.slice(0, -3)}–${b}` : `${a}–${b}`
}

/** Minutes given again after the first estimate. */
export const isReEstimate = (plan: EtaPlan) => plan.estimatedAt !== null && plan.declaredAt > plan.estimatedAt

/**
 * The adjustment the band applies to the plan's current minutes (ADJUST): a
 * first estimate by finished first estimates of its size; a re-estimate as said,
 * with a range from past re-estimates of its size.
 */
export function planAdjustment(live: EtaLive, plan: EtaPlan, minutes: number): Adjustment {
  const first = adjust(live.learned.calibration, plan.originalMinutes ?? minutes, plan.declaredAt, ADJUST)
  if (!isReEstimate(plan)) return first
  return adjustRe(live.learned.reSamples ?? [], minutes, plan.declaredAt, shownFactor(first.factor), ADJUST)
}

// ---------- the view ----------

export type DeclaredView = {
  minutes: number
  declaredAt: number
  dueAt: number
  shownDueAt: number
  ratio: number | null
  /** The finish as a range [lo, hi] (epoch ms) while similar estimates have spread wide; null = one number. */
  range: [number, number] | null
  /** The minutes are a re-estimate (shown as said under ADJUST.re 'raw'). */
  isRe: boolean
  /** Similar finished estimates the factor or range came from. */
  matched: number
}

export type EtaView = {
  isVisible: boolean
  isDone: boolean
  elapsedMs: number | null
  declared: DeclaredView | null
  agents: AgentsSummary | null
  /** What sets the finish: the estimate, the agents, or a push-out after a failure. */
  winner: 'declared' | 'agents' | 'extended' | null
  finishAt: number | null
  remainingMs: number | null
  /** The committed finish (estimate or push-out) has passed: "over by". Agents may still run past it. */
  isOverdue: boolean
  overMs: number
  /** The shown finish itself has passed (what the snapshot's isOverdue says). */
  isPastFinish: boolean
  /** Why the number went up, with by how much (`test failed · +10m`); null when it has not. */
  reason: string | null
  /** How far the finish is past the estimate (or the first agent-based one). */
  extendedMs: number
  stepText: string | null
  note: string | null
  /** Background tasks (not agents) the session waits on between turns. */
  waitingOn: number
  problems: string[]
}

export function stepText(plan: EtaPlan | null): string | null {
  if (!plan) return null
  const n = plan.steps.length
  if (typeof plan.step === 'number' && n > 0) {
    const i = Math.min(Math.max(1, Math.round(plan.step)), n)
    return `step ${i}/${n}: ${plan.steps[i - 1]}`
  }
  if (typeof plan.step === 'string' && plan.step) {
    const i = plan.steps.findIndex(s => s.toLowerCase() === (plan.step as string).toLowerCase())
    return i >= 0 ? `step ${i + 1}/${n}: ${plan.steps[i]}` : `step: ${plan.step}`
  }
  if (n > 0) return `step 1/${n}: ${plan.steps[0]}`
  return null
}

export function etaView(live: EtaLive, now: number): EtaView {
  const agents = agentsSummary(agentEtas(live, now), now)
  const plan = live.plan
  let declared: DeclaredView | null = null
  if (plan && plan.minutes !== null) {
    const ms = plan.minutes * MIN
    const a = planAdjustment(live, plan, plan.minutes)
    const ratio = shownFactor(a.factor)
    const range: [number, number] | null = a.range ? [plan.declaredAt + Math.round(ms * a.range[0]), plan.declaredAt + Math.round(ms * a.range[1])] : null
    declared = { minutes: plan.minutes, declaredAt: plan.declaredAt, dueAt: plan.declaredAt + ms, shownDueAt: plan.declaredAt + Math.round(ms * (ratio ?? 1)), ratio, range, isRe: isReEstimate(plan), matched: a.n }
  }
  let winner: EtaView['winner'] = null
  let finishAt: number | null = null
  if (declared) {
    winner = 'declared'
    finishAt = declared.shownDueAt
    if (agents && agents.dueAt > Math.max(declared.shownDueAt, now) + SLACK_MS) {
      winner = 'agents'
      finishAt = agents.dueAt
    }
  } else if (agents) {
    winner = 'agents'
    finishAt = agents.dueAt
  }
  const bump = live.bump ?? null
  if (bump && (finishAt === null || bump.floorAt > finishAt)) {
    winner = 'extended'
    finishAt = bump.floorAt
  }
  const isDone = live.work?.isDone === true
  if (isDone) {
    winner = null
    finishAt = null
  }
  // The committed finish: the estimate (the top of its range when one is shown), or the push-out after a failure. Agents float.
  const declaredEnd = declared ? (declared.range ? declared.range[1] : declared.shownDueAt) : null
  const committed = bump ? Math.max(bump.floorAt, declaredEnd ?? 0) : declaredEnd
  const isOverdue = !isDone && committed !== null && now > committed
  // How far past the baseline (the estimate, or the first agent-based figure) the finish now is, and why.
  const baseline = declared ? declared.shownDueAt : live.work?.firstEstimateMs != null ? live.work.startedAt + live.work.firstEstimateMs : null
  let extendedMs = 0
  let reasonBase: string | null = null
  if (finishAt !== null && winner === 'extended' && bump) {
    extendedMs = baseline !== null ? finishAt - baseline : bump.extendedMs
    reasonBase = bump.reason
  } else if (finishAt !== null && winner === 'agents' && agents && baseline !== null) {
    extendedMs = finishAt - baseline
    const since = plan?.declaredAt ?? live.work?.startedAt ?? 0
    const launched = Object.values(live.agents).some(a => isRunningStatus(a.status) && a.isExactStart && a.startedAt > since + 5000)
    reasonBase = agents.over ? `${agents.over} agent${agents.over === 1 ? '' : 's'} past usual` : launched ? 'agent launched' : 'agents need longer'
  }
  const reason = reasonBase !== null && extendedMs >= MIN ? `${reasonBase} · +${fmtDur(extendedMs)}` : null
  const problems = Object.entries(live.problems).map(([k, v]) => `${k}: ${v}`)
  return {
    isPastFinish: !isDone && finishAt !== null && now >= (winner === 'declared' && declared?.range ? Math.max(finishAt, declared.range[1]) : finishAt),
    reason,
    extendedMs: reason !== null ? extendedMs : 0,
    isVisible: live.work !== null || plan !== null || agents !== null,
    isDone,
    elapsedMs: live.work ? now - live.work.startedAt : plan ? now - plan.startedAt : null,
    declared,
    agents,
    winner,
    finishAt,
    remainingMs: finishAt === null ? null : Math.max(0, finishAt - now),
    isOverdue,
    overMs: isOverdue && committed !== null ? now - committed : 0,
    stepText: stepText(plan),
    note: plan?.note ?? null,
    waitingOn: live.work && !live.work.isTurnRunning && !agents ? live.work.backgroundTasks : 0,
    problems,
  }
}

// ---------- the band ----------

export type Tone = 'accent' | 'dim' | 'normal' | 'warn'
export type BandSegment = { text: string; tone: Tone }

function agentsPhrase(a: AgentsSummary): string {
  const extra: string[] = []
  if (a.over) extra.push(`${a.over} past usual`)
  if (a.guessed) extra.push(`${a.guessed} guessed`)
  if (a.unsure) extra.push(`${a.unsure} start unknown`)
  return `${a.count} agent${a.count === 1 ? '' : 's'} (longest ~${fmtDur(a.maxRemainingMs)}${extra.length ? `; ${extra.join(', ')}` : ''})`
}

/** The band, as tone-tagged pieces; empty when there is nothing to show. */
export function bandSegments(v: EtaView, now: number, tzOffsetMin: number): BandSegment[] {
  if (!v.isVisible) return []
  const segs: BandSegment[] = [{ text: 'eta ', tone: 'accent' }]
  const sep = (text: string, tone: Tone = 'dim') => segs.push({ text: ` · ${text}`, tone })
  const elapsed = v.elapsedMs !== null ? `${fmtDur(v.elapsedMs)} elapsed` : null
  if (v.isDone) {
    segs.push({ text: `wrapping up${elapsed ? ` · ${elapsed}` : ''}`, tone: 'normal' })
  } else if (v.winner === null || v.finishAt === null) {
    const doing = v.waitingOn > 0 ? `waiting on ${v.waitingOn} background task${v.waitingOn === 1 ? '' : 's'}` : 'working'
    segs.push({ text: `${doing}${elapsed ? ` · ${elapsed}` : ''} · no estimate yet`, tone: 'normal' })
  } else if (v.isOverdue) {
    const d = v.declared
    const est = !d ? 'agent estimate'
      : d.range ? `${fmtDur(d.range[0] - d.declaredAt)}–${fmtDur(d.range[1] - d.declaredAt)} range, said ${fmtDur(d.minutes * MIN)}`
      : d.ratio !== null ? `~${fmtDur(d.shownDueAt - d.declaredAt)} estimate (said ${fmtDur(d.minutes * MIN)})`
      : `${fmtDur(d.minutes * MIN)} estimate`
    if (v.winner === 'agents' && v.finishAt > now) {
      segs.push({ text: `~${fmtDur(v.finishAt - now)} left (over by ${fmtDur(v.overMs)} on the ${est}; agents still running)`, tone: 'warn' })
      sep(`done ~${fmtClock(v.finishAt, tzOffsetMin)}`)
    } else {
      // Never a stale "~0 min": the countdown hit zero and the work goes on.
      const bumped = v.winner === 'extended' && v.reason ? `; ${v.reason}` : ''
      segs.push({ text: `over by ${fmtDur(v.overMs)} (${est}${bumped})`, tone: 'warn' })
    }
  } else {
    let why = ''
    const d = v.declared
    const range = !v.reason && v.winner === 'declared' && d?.range ? d.range : null
    const said = d ? (d.dueAt > now ? fmtDur(d.dueAt - now) : `${fmtDur(d.minutes * MIN)} ${fmtDur(now - d.declaredAt)} ago`) : ''
    if (v.reason) why = ` (${v.reason})`
    else if (range && d) why = ` (said ${said}; ${rangeText(d)})`
    else if (v.winner === 'declared' && d && d.ratio !== null) why = ` (said ${said}; ${ratioText(d.ratio)})`
    if (range) {
      // Honest about the spread: the middle half of how similar estimates really went.
      const lo = range[0] - now
      const hi = range[1] - now
      segs.push({ text: `${lo >= MIN ? `~${fmtDur(lo)}–${fmtDur(hi)}` : `up to ~${fmtDur(hi)}`} left${why}`, tone: 'normal' })
      sep(lo >= MIN ? `done ~${clockRange(range[0], range[1], tzOffsetMin)}` : `done by ~${fmtClock(range[1], tzOffsetMin)}`)
    } else {
      segs.push({ text: `~${fmtDur(v.finishAt - now)} left${why}`, tone: 'normal' })
      sep(`done ~${fmtClock(v.finishAt, tzOffsetMin)}`)
    }
  }
  if (v.stepText) sep(clip(v.stepText, 60), 'normal')
  if (v.agents) sep(agentsPhrase(v.agents))
  if (v.problems.length) sep(`issue: ${clip(v.problems.join('; '), 140)}`, 'normal')
  return segs
}

export const bandText = (segs: readonly BandSegment[]) => segs.map(s => s.text).join('')

// ---------- work and plan lifecycle ----------

/** What ending a plan leaves: the toast, the calibration sample, and the history line. */
export type Ending = { toast: string | null; sample: EtaCalSample | null; record: EtaHistoryRecord | null }

/** Ends the plan, as a calibration sample when it had an estimate. */
export function endPlan(plan: EtaPlan, at: number): EtaCalSample | null {
  if (plan.originalMinutes === null || plan.originalMinutes < 1 || plan.estimatedAt === null) return null
  return { said: plan.originalMinutes, took: Math.round(((at - plan.estimatedAt) / MIN) * 10) / 10, at }
}

/** `done after 23m (estimated 18m)`: the estimate as a total, counting the time before it was given. */
export function doneToast(work: EtaWork | null, plan: EtaPlan | null, at: number): string | null {
  const startedAt = work?.startedAt ?? plan?.startedAt
  if (startedAt === undefined || work?.isToasted) return null
  const took = at - startedAt
  if (took < DONE_TOAST_MIN_MS) return null
  let est = ''
  if (plan?.originalMinutes != null && plan.estimatedAt !== null) {
    est = ` (estimated ${fmtDur(plan.originalMinutes * MIN + Math.max(0, plan.estimatedAt - startedAt))})`
  } else if (work?.firstEstimateMs != null) est = ` (agents suggested ~${fmtDur(work.firstEstimateMs)})`
  return `eta: done after ${fmtDur(took)}${est}`
}

/** Ends the stretch of work at `at`: toast and calibration as due. */
export function endWork(live: EtaLive, at: number): { live: EtaLive } & Ending {
  const isAborted = live.work?.wasAborted === true
  const toast = isAborted ? null : doneToast(live.work, live.plan, at)
  const sample = live.plan && !isAborted ? endPlan(live.plan, at) : null
  const record = live.plan && sample ? historyRecord(live.plan, at, 'idle', live.self) : null
  return { live: { ...live, work: null, plan: null, bump: null, fixStartedAt: null }, toast, sample, record }
}

export function startTurn(live: EtaLive, now: number, text: string): EtaLive {
  const t = text.trim()
  const label = t && !t.startsWith('<') ? clip(t, 60) : live.label
  if (live.work && !live.work.isDone) return { ...live, label, work: { ...live.work, isTurnRunning: true, backgroundTasks: 0, lastActiveAt: now, wasAborted: false } }
  const seq = live.seq + 1
  return {
    ...live,
    label,
    seq,
    work: { id: seq, startedAt: now, isTurnRunning: true, lastActiveAt: now, backgroundTasks: 0, firstEstimateMs: null, isDone: false, isToasted: false },
  }
}

export function runningCount(live: EtaLive): number {
  return Object.values(live.agents).filter(a => isRunningStatus(a.status)).length
}

/**
 * Whether the work is over at `now`: no turn and no agents running, and
 * either nothing else was reported (the turn just ended: `isTurnEnd`) or the
 * re-invocation never came within the grace.
 */
export function isWorkOver(live: EtaLive, now: number, isTurnEnd: boolean): boolean {
  const w = live.work
  if (!w || w.isTurnRunning || runningCount(live) > 0) return false
  if (w.backgroundTasks > 0) return now - w.lastActiveAt >= BACKGROUND_END_MS
  return isTurnEnd || now - w.lastActiveAt >= IDLE_END_MS
}

// ---------- the Eta tool ----------

export type EtaInput = { minutes?: unknown; steps?: unknown; step?: unknown; note?: unknown; done?: unknown }

/** Applies one Eta call: a new plan, an update, or the end of it. */
export function applyEta(live: EtaLive, input: EtaInput, now: number, name: string = DEFAULT_NAME): { live: EtaLive; reply: string } & Ending {
  const minutes = typeof input.minutes === 'number' && Number.isFinite(input.minutes) ? Math.min(Math.max(0, input.minutes), 24 * 60) : null
  const steps = Array.isArray(input.steps) ? input.steps.filter((s): s is string => typeof s === 'string' && s.trim() !== '').slice(0, 20).map(s => clip(s, 60)) : null
  const step = typeof input.step === 'number' && Number.isFinite(input.step) ? input.step : typeof input.step === 'string' && input.step.trim() ? clip(input.step, 60) : null
  const note = typeof input.note === 'string' && input.note.trim() ? clip(input.note, 80) : null

  if (input.done === true) {
    const plan = live.plan
    const toast = doneToast(live.work, plan, now)
    const sample = plan ? endPlan(plan, now) : null
    const record = plan && sample ? historyRecord(plan, now, 'done', live.self) : null
    const work = live.work ? { ...live.work, isDone: true, isToasted: live.work.isToasted || toast !== null } : null
    const took = plan ? fmtDur(now - plan.startedAt) : live.work ? fmtDur(now - live.work.startedAt) : null
    const said = plan?.originalMinutes != null ? `; first estimate ${fmtDur(plan.originalMinutes * MIN)}` : ''
    return {
      live: { ...live, plan: null, work, bump: null, lastEtaAt: now },
      toast,
      sample,
      record,
      reply: `Eta: marked done${took ? ` after ${took}${said}` : ''}.${sample ? ' Recorded for calibration.' : ''}`,
    }
  }

  const old = live.plan
  const isNew = old === null
  // A new estimate (or a new plan) moves the sequence; a step or note alone does not,
  // so the overdue nudge stays once per estimate.
  const seq = isNew || minutes !== null ? live.seq + 1 : live.seq
  const firstEstimate = old?.originalMinutes == null && minutes !== null
  const plan: EtaPlan = {
    id: isNew ? seq : old.id,
    startedAt: isNew ? now : old.startedAt,
    estimatedAt: firstEstimate ? now : (old?.estimatedAt ?? null),
    originalMinutes: firstEstimate ? Math.round((minutes as number) * 10) / 10 : (old?.originalMinutes ?? null),
    minutes: minutes ?? old?.minutes ?? null,
    declaredAt: minutes !== null || isNew ? now : old.declaredAt,
    steps: steps ?? old?.steps ?? [],
    step: step ?? (steps ? null : (old?.step ?? null)),
    note: note ?? old?.note ?? null,
    seq: isNew || minutes !== null ? seq : old.seq,
    nudgedFor: old?.nudgedFor ?? null,
    estimates: old?.estimates ?? [],
    firstRange: old?.firstRange ?? null,
  }
  const work = live.work ?? { id: seq, startedAt: now, isTurnRunning: false, lastActiveAt: now, backgroundTasks: 0, firstEstimateMs: null, isDone: false, isToasted: false }
  // Fresh minutes replace any push-out: the model has re-estimated with the failure in view.
  const bump = minutes !== null ? null : (live.bump ?? null)
  let next: EtaLive = { ...live, seq, plan, work: { ...work, isDone: false }, label: note ?? live.label, bump, lastEtaAt: now }
  let v = etaView(next, now)
  if (minutes !== null && v.declared) {
    // The history keeps every estimate with the factor (and, for the first, the range) the band showed for it.
    const d = v.declared
    const est = { at: now, min: Math.round(minutes * 10) / 10, f: d.ratio === null ? null : Math.round(d.ratio * 1000) / 1000 }
    const r = d.range
    const firstRange: [number, number] | null = r ? [Math.round(((r[0] - now) / MIN) * 10) / 10, Math.round(((r[1] - now) / MIN) * 10) / 10] : null
    next = { ...next, plan: { ...plan, estimates: [...(old?.estimates ?? []), est], ...(firstEstimate ? { firstRange } : {}) } }
    v = etaView(next, now)
  }
  const shown = bandText(bandSegments(v, now, live.tzOffsetMin ?? 0)).replace(/^eta /, '')
  const hint = plan.minutes === null ? ` No minutes given, so ${name} sees elapsed time only; add minutes when you can estimate.` : ''
  return {
    live: next,
    toast: null,
    sample: null,
    record: null,
    reply: `Eta ${isNew ? 'set' : 'updated'}. ${capital(possessive(name))} band now reads: ${shown}.${hint} Call Eta again at each milestone or if the estimate changes, and with done:true when finished.`,
  }
}

// ---------- the overdue nudge ----------

/** Due once per declaration, when the declared minutes are passed by more than half. */
export function isNudgeDue(plan: EtaPlan | null, now: number): boolean {
  if (!plan || plan.minutes === null || plan.nudgedFor === plan.seq) return false
  return now - plan.declaredAt > Math.max(plan.minutes, 0.5) * MIN * NUDGE_FACTOR
}

export function nudgeText(plan: EtaPlan, now: number): string {
  return `[eta] Your Eta estimate (${fmtDur((plan.minutes ?? 0) * MIN)}, set ${fmtDur(now - plan.declaredAt)} ago) has been passed by more than half. Call ${TOOL_FULL_NAME} with a revised minutes estimate and the current step, or with done:true if the work is finished.`
}

// ---------- failed test and build runs ----------

/** A test/build run's verdict: failed (with what failed), passed, or null when it is no such run or cannot be told. */
export type RunVerdict = { kind: 'fail'; what: 'test' | 'build'; detail: string } | { kind: 'pass' } | null

const TEST_CMD = /\b(?:tests?|jest|vitest|pytest|mocha|ava|playwright|cypress|spec)\b|--test\b/i
const BUILD_CMD = /\b(?:tsc|build|lint|eslint|typecheck|type-check|compile|validate|cargo|dotnet|mvn|gradle|make|npm|pnpm|yarn|bun|npx)\b|\bgo (?:build|vet)\b/i
/** Commands that only show text (a grep of a log full of FAIL is no failed run). */
const VIEW_CMD = /^(?:grep|rg|cat|head|tail|less|more|git|sed|awk|ls|dir|find|echo|printf|type|wc|jq|Select-String|Get-Content|Get-ChildItem|Write-Output|Write-Host|code|start|notepad)\b/i
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g

/** The command with leading `cd x &&` / `Set-Location x;` hops removed. */
function mainCommand(command: string): string {
  let c = command.trim()
  for (let i = 0; i < 5; i++) {
    const m = /^(?:cd|pushd|Set-Location|sl)\s+(?:"[^"]*"|'[^']*'|[^;&|\s]+)\s*(?:&&|;)\s*/i.exec(c)
    if (!m) break
    c = c.slice(m[0].length)
  }
  return c
}

export function isRunCommand(command: string): 'test' | 'build' | null {
  const c = mainCommand(command)
  if (!c || VIEW_CMD.test(c)) return null
  if (TEST_CMD.test(c)) return 'test'
  if (BUILD_CMD.test(c)) return 'build'
  return null
}

/**
 * Judges a finished Bash/PowerShell call by its summary line, not the exit
 * code alone: `ℹ fail 2`, `3 failed`, `Tests: 1 failed`, `# fail 1`, a
 * `FAIL` line, `npm ERR!`, `error TS2345`. `0 failed`, `fail 0` and `ℹ fail
 * 0` are passes. Only with no summary at all does a non-zero exit of a
 * test/build command count as a failure.
 */
export function judgeRun(command: string, output: string, isError: boolean): RunVerdict {
  const what = isRunCommand(command)
  if (!what) return null
  const t = (output.length > 200_000 ? output.slice(-200_000) : output).replace(ANSI, '')
  let failN = 0
  let passSummary = false
  const count = (re: RegExp) => {
    for (const m of t.matchAll(re)) {
      const n = Number(m[1])
      if (n > 0) failN = Math.max(failN, n)
      else passSummary = true
    }
  }
  count(/ℹ fail (\d+)/g)
  count(/\b(\d+)\s+(?:failed|failing|fail|failures?)\b/gi)
  count(/^\s*#?\s*fail(?:ed|ures?|s)?\s*[:=]?\s*(\d+)\b/gim)
  count(/\bfail(?:ed|ures?)\s*[:=]\s*(\d+)\b/gi)
  if (failN > 0) return { kind: 'fail', what: 'test', detail: `${failN} failed` }
  if (/^\s*(?:--- )?FAIL\b/m.test(t)) return { kind: 'fail', what: 'test', detail: 'FAIL' }
  if (/^npm (?:ERR!|error)\s/m.test(t)) return { kind: 'fail', what, detail: 'npm error' }
  if (/\berror TS\d{3,5}\b/.test(t) || /\bFound [1-9]\d* errors?\b/.test(t)) return { kind: 'fail', what: 'build', detail: 'type errors' }
  if (/\b(?:build|compilation) failed\b/i.test(t)) return { kind: 'fail', what: 'build', detail: 'build failed' }
  if (passSummary) return { kind: 'pass' }
  const exit = /^Exit code (-?\d+)/m.exec(t)
  const code = exit ? Number(exit[1]) : isError ? 1 : 0
  if (code !== 0 && !/interrupted/i.test(t.slice(0, 300))) return { kind: 'fail', what, detail: `exit ${code}` }
  return isError ? null : { kind: 'pass' }
}

export type FixCycle = { ms: number; source: 'learned' | 'default'; n: number }

/** How long a failed run usually takes to fix: the median of learned cycles once there are 3, else 10m. */
export function fixCycleMs(samplesSec: readonly number[] | undefined): FixCycle {
  const s = (samplesSec ?? []).filter(x => x > 0).slice(-HISTORY_KEEP)
  if (s.length < FIX_MIN_SAMPLES) return { ms: FIX_DEFAULT_MS, source: 'default', n: s.length }
  return { ms: Math.round(Math.min(FIX_MAX_MS, Math.max(FIX_MIN_MS, median(s) * 1000))), source: 'learned', n: s.length }
}

/** An ETA is on the band: a number counting down (or over), not done. */
export function isEtaActive(live: EtaLive, now: number): boolean {
  const v = etaView(live, now)
  return v.isVisible && !v.isDone && v.finishAt !== null
}

export const canNudge = (live: EtaLive, now: number) => live.lastNudgeAt == null || now - live.lastNudgeAt >= NUDGE_EVERY_MS

export function failureNudge(reason: string, addedMs: number): string {
  return `[eta] ${reason}: the ETA was pushed out ${fmtDur(addedMs)}. Call ${TOOL_FULL_NAME} with a fresh minutes estimate that includes the fix.`
}
export function promptNudge(name: string = DEFAULT_NAME): string {
  return `[eta] ${capital(name)} added a message while an ETA is running: call ${TOOL_FULL_NAME} with a fresh minutes estimate that includes it.`
}
export function staleNudge(sinceMs: number): string {
  return `[eta] No Eta update for ${fmtDur(sinceMs)} while working: call ${TOOL_FULL_NAME} with a fresh minutes estimate, or done:true if finished.`
}

export type ToolOutcome = { live: EtaLive; note: string | null; fixSampleSec: number | null }

/**
 * After a main-session tool call: a failed run pushes the finish out by a fix
 * cycle (the first since the last estimate adds a whole cycle; later ones keep
 * at least a cycle from now, so a string of reruns does not compound); a pass
 * after a failure is learned as a fix cycle. Then at most one nudge, rate
 * limited: failure, else the overdue one, else stale.
 */
export function afterToolResult(live: EtaLive, verdict: RunVerdict, now: number): ToolOutcome {
  let l = live
  let fixSampleSec: number | null = null
  let failNote: string | null = null
  if (verdict?.kind === 'pass' && l.fixStartedAt != null) {
    const ms = now - l.fixStartedAt
    if (ms > 0 && ms <= FIX_SAMPLE_MAX_MS) fixSampleSec = Math.round(ms / 1000)
    l = { ...l, fixStartedAt: null }
  }
  if (verdict?.kind === 'fail') {
    if (l.fixStartedAt == null) l = { ...l, fixStartedAt: now }
    const v = etaView(l, now)
    if (v.isVisible && !v.isDone && v.finishAt !== null) {
      const fix = fixCycleMs(l.learned.fixCycles).ms
      const cur = v.finishAt
      const prev = l.bump ?? null
      const floorAt = prev ? Math.max(cur, now + fix) : Math.max(cur, now) + fix
      const added = Math.max(0, floorAt - cur)
      const reason = `${verdict.what} failed${prev ? ' again' : ''}`
      l = {
        ...l,
        bump: { floorAt, reason, extendedMs: (prev?.extendedMs ?? 0) + added, at: now, count: (prev?.count ?? 0) + 1 },
        work: l.work ? { ...l.work, lastActiveAt: now } : l.work,
      }
      failNote = failureNudge(`${reason} (${verdict.detail})`, added)
    }
  }
  if (!canNudge(l, now)) return { live: l, note: null, fixSampleSec }
  if (failNote) return { live: { ...l, lastNudgeAt: now }, note: failNote, fixSampleSec }
  if (l.plan && isNudgeDue(l.plan, now)) {
    return { live: { ...l, lastNudgeAt: now, plan: { ...l.plan, nudgedFor: l.plan.seq } }, note: nudgeText(l.plan, now), fixSampleSec }
  }
  if (isEtaActive(l, now)) {
    const last = l.lastEtaAt ?? l.plan?.declaredAt ?? l.work?.startedAt ?? now
    if (now - last >= STALE_ETA_MS) return { live: { ...l, lastNudgeAt: now }, note: staleNudge(now - last), fixSampleSec }
  }
  return { live: l, note: null, fixSampleSec }
}

/** The user's own message while an ETA runs: ask for a fresh estimate (rate limited). */
export function afterPrompt(live: EtaLive, now: number, name: string = DEFAULT_NAME): { live: EtaLive; note: string | null } {
  if (!isEtaActive(live, now) || !canNudge(live, now)) return { live, note: null }
  return { live: { ...live, lastNudgeAt: now }, note: promptNudge(name) }
}

// ---------- snapshots ----------

export function snapshotOf(live: EtaLive, now: number): EtaSnapshot | null {
  if (!live.self) return null
  const v = etaView(live, now)
  const segs = bandSegments(v, now, live.tzOffsetMin ?? 0)
  return {
    v: 1,
    sessionId: live.self.sessionId,
    project: live.self.project,
    cwd: live.self.cwd,
    label: live.plan?.note ?? live.label,
    state: v.isVisible ? 'working' : 'idle',
    summary: bandText(segs).replace(/^eta /, ''),
    etaAt: v.finishAt,
    // The shown finish has passed: Helm shows "over by", never a stale "~0 min".
    isOverdue: v.isPastFinish,
    agentsRunning: v.agents?.count ?? 0,
    workStartedAt: live.work?.startedAt ?? null,
    updatedAt: now,
    reason: v.reason,
    extendedBy: Math.round(v.extendedMs / MIN),
  }
}

/** Whether the snapshot changed enough to write, or is due a heartbeat. */
export function isWriteDue(next: EtaSnapshot, last: { sig: string; at: number } | null): boolean {
  if (!last) return true
  if (sigOf(next) !== last.sig) return true
  const beat = next.state === 'working' ? MIN : 5 * MIN
  return next.updatedAt - last.at >= beat
}

/** The snapshot less its clock: summary text changes each minute, so it is left out too. */
export function sigOf(s: EtaSnapshot): string {
  return JSON.stringify([s.state, s.label, s.etaAt === null ? null : Math.round(s.etaAt / MIN), s.isOverdue, s.agentsRunning, s.workStartedAt, s.reason ?? null])
}

export function parseSnapshot(text: string): EtaSnapshot | string {
  let o: unknown
  try {
    o = JSON.parse(text)
  } catch (err) {
    return `not JSON (${err instanceof Error ? err.message : String(err)})`
  }
  const s = o as Partial<EtaSnapshot> | null
  if (!s || typeof s !== 'object') return 'not an object'
  if (s.v !== 1) return `unknown version ${JSON.stringify(s.v)}`
  if (typeof s.sessionId !== 'string' || typeof s.updatedAt !== 'number' || (s.state !== 'working' && s.state !== 'idle' && s.state !== 'ended')) {
    return 'missing sessionId, updatedAt or state'
  }
  return s as EtaSnapshot
}

export type SnapshotFile = { name: string; mtimeMs: number; snap: EtaSnapshot | null; error: string | null }

/** Which sessions to list, which to drop, and why. */
export function classifySessions(files: readonly SnapshotFile[], selfId: string | null, now: number, own: EtaSnapshot | null): EtaSessions {
  const out: EtaSessions = { at: now, rows: [], hidden: { idle: 0, ended: 0, dead: 0 }, errors: [] }
  const seen = new Set<string>()
  const add = (s: EtaSnapshot, isSelf: boolean) => {
    seen.add(s.sessionId)
    out.rows.push({
      sessionId: s.sessionId,
      isSelf,
      project: s.project,
      label: s.label,
      state: s.state,
      summary: s.summary,
      etaAt: s.etaAt,
      isOverdue: s.isOverdue,
      updatedAt: s.updatedAt,
      isSilent: !isSelf && s.state === 'working' && now - s.updatedAt > SILENT_WORKING_MS,
    })
  }
  if (own) add(own, true)
  for (const f of files) {
    if (f.error !== null || !f.snap) {
      out.errors.push(`${f.name}: ${f.error ?? 'unreadable'}`)
      continue
    }
    const s = f.snap
    if (s.sessionId === selfId || seen.has(s.sessionId)) continue
    const age = now - s.updatedAt
    if (s.state === 'ended') out.hidden.ended += 1
    else if (s.state === 'idle' && age > STALE_IDLE_MS) out.hidden.idle += 1
    else if (s.state === 'working' && age > DEAD_WORKING_MS) out.hidden.dead += 1
    else add(s, false)
  }
  out.rows.sort((a, b) => Number(b.isSelf) - Number(a.isSelf) || Number(b.state === 'working') - Number(a.state === 'working') || b.updatedAt - a.updatedAt)
  return out
}

/** One session row's ETA part, recomputed from its ETA time so an older snapshot still counts down. */
export function rowEta(r: EtaSessionRow, now: number, tzOffsetMin: number): string {
  if (r.state !== 'working') return 'idle'
  if (r.etaAt === null) return r.summary || 'working · no estimate'
  if (r.etaAt < now) return `past its ETA by ${fmtDur(now - r.etaAt)}`
  return `~${fmtDur(r.etaAt - now)} left · done ~${fmtClock(r.etaAt, tzOffsetMin)}`
}

// ---------- the pane and /eta ----------

export type Line = { text: string; tone: Tone }

function calLines(live: EtaLive, dir: string | null): Line[] {
  const cal = calibration(live.learned.calibration)
  const out: Line[] = []
  if (cal.n === 0) {
    out.push({ text: `No finished estimates yet. After ${CAL_MIN_SAMPLES}, eta scales new estimates by how long work really took against what was said.`, tone: 'dim' })
    out.push(fixLine(live))
    return out
  }
  const recent = live.learned.calibration.slice(-5).map(s => `said ${fmtDur(s.said * MIN)} → took ${fmtDur(s.took * MIN)}`)
  out.push({ text: `${cal.n} finished estimate${cal.n === 1 ? '' : 's'}: ${recent.join('; ')}`, tone: 'normal' })
  const med = cal.median as number
  if (cal.ratio === null) {
    out.push({ text: `Median took/said ${med.toFixed(2)}×. Not applied: needs ${CAL_MIN_SAMPLES} samples, has ${cal.n}.`, tone: 'dim' })
  } else {
    const clamped = cal.ratio !== med ? ` (clamped from ${med.toFixed(2)}× to ${CAL_MIN_RATIO}–${CAL_MAX_RATIO}×)` : ''
    const applied = Math.abs(cal.ratio - 1) < 0.05 ? 'Within 5% of 1×.' : `Over all sizes a said ${fmtDur(10 * MIN)} would be ~${fmtDur(10 * MIN * cal.ratio)}.`
    out.push({ text: `Median took/said ${cal.ratio.toFixed(2)}×${clamped}: ${ratioText(cal.ratio)} overall. ${applied}`, tone: 'normal' })
  }
  out.push({ text: `Each first estimate is scaled only by finished ones of a similar size (${1 / CAL_MATCH}×–${CAL_MATCH}×), from ${CAL_MIN_SAMPLES} of them; with fewer it is shown as said. Re-estimates are shown as said (scaling them made them run late twice as often).`, tone: 'dim' })
  const q = ADJUST.rangeQ
  if (q) out.push({ text: `With ${ADJUST.rangeMinN}+ similar ones whose middle ${Math.round((q[1] - q[0]) * 100)}% spans over ${ADJUST.rangeMinWidth}×, the band shows that span as a range instead of one number; it narrows as estimates get more accurate. History: ${dir === null ? NO_DIR : historyFileOf(dir)}.`, tone: 'dim' })
  const size = live.plan?.originalMinutes ?? live.plan?.minutes ?? null
  if (size !== null && size >= 1) {
    const mine = calibration(live.learned.calibration, size)
    out.push({
      text: mine.ratio !== null ? `This plan (${fmtDur(size * MIN)}): ${mine.matched} similar, ${ratioText(mine.ratio)}.` : `This plan (${fmtDur(size * MIN)}): ${mine.matched ?? 0} similar, not enough; shown as said.`,
      tone: 'normal',
    })
  }
  out.push(fixLine(live))
  return out
}

function fixLine(live: EtaLive): Line {
  const fix = fixCycleMs(live.learned.fixCycles)
  const src = fix.source === 'learned' ? `learned from ${fix.n} fix cycles` : `default; ${fix.n}/${FIX_MIN_SAMPLES} fix cycles learned`
  return { text: `A failed test/build run pushes the ETA out ${fmtDur(fix.ms)} (${src}).`, tone: 'dim' }
}

function usualLines(live: EtaLive): Line[] {
  const keys = new Set([...Object.keys(PRIORS), ...Object.keys(live.learned.durations)])
  const parts = [...keys].sort().map(k => {
    const e = expectedFor(k, live.learned.durations)
    const src = e.learnedN > 0 ? `${e.learnedN} learned${e.n > e.learnedN ? ` + ${e.n - e.learnedN} prior` : ''}` : `${e.n} prior`
    return `${k} ~${fmtDur(e.ms)} (${src})`
  })
  return [{ text: `${parts.join(' · ')} · any other type: ${fmtDur(DEFAULT_AGENT_MS)} guess`, tone: 'normal' }]
}

/** The pane's lines: this session in full, calibration, usual durations, every session. */
export function paneLines(live: EtaLive, sessions: EtaSessions | null, now: number, dir: string | null): Line[] {
  const tz = live.tzOffsetMin ?? 0
  const v = etaView(live, now)
  const L: Line[] = []
  const head = (t: string) => L.push({ text: t, tone: 'accent' })
  head('This session')
  const band = bandText(bandSegments(v, now, tz)).replace(/^eta /, '')
  L.push({ text: band || 'idle: no turn, no agents, nothing declared', tone: v.isOverdue ? 'warn' : v.isVisible ? 'normal' : 'dim' })
  const plan = live.plan
  if (plan) {
    const est = plan.minutes !== null ? `said ${fmtDur(plan.minutes * MIN)} at ${fmtClock(plan.declaredAt, tz)}` : 'no minutes given'
    const first = plan.originalMinutes !== null ? ` · first estimate ${fmtDur(plan.originalMinutes * MIN)} for the whole task` : ''
    L.push({ text: `Declared: ${est}${first}${plan.note ? ` · ${plan.note}` : ''}`, tone: 'normal' })
    if (plan.steps.length) L.push({ text: `Steps: ${plan.steps.map((s, i) => `${i + 1}. ${s}`).join('  ')}`, tone: 'dim' })
  } else {
    L.push({ text: 'Declared: nothing (the model has not called Eta for this work)', tone: 'dim' })
  }
  const etas = agentEtas(live, now)
  if (etas.length) {
    L.push({ text: `Agents: ${etas.length} running; the slowest sets the finish, then ${fmtDur(VERIFY_MS)} for the main session to verify`, tone: 'normal' })
    for (const a of etas) {
      const src = a.expect.source === 'guess' ? 'a guess: no history for this type' : `${a.expect.source}, ${a.expect.n} run${a.expect.n === 1 ? '' : 's'}`
      const start = a.agent.isExactStart ? '' : a.agent.kind === 'resume' ? ' · resumed (start ±20s)' : ' · already running when eta saw it, so elapsed is short'
      L.push({
        text: `  ${a.agent.kind === 'resume' ? 'resume' : a.agent.type}  ${clip(a.agent.label, 40)}  ${fmtDur(a.elapsedMs)} elapsed · usual ~${fmtDur(a.expect.ms)} (${src}) · ~${fmtDur(a.remainingMs)} left${a.isOver ? ', past usual' : ''}${start}`,
        tone: a.isOver ? 'warn' : 'dim',
      })
    }
  }
  if (v.winner === 'agents' && v.declared) L.push({ text: 'Showing the agents: they imply a later finish than the declared estimate.', tone: 'normal' })
  else if (v.winner === 'declared' && v.agents) L.push({ text: 'Showing the declared estimate: the agents fit inside it.', tone: 'dim' })
  if (live.bump) L.push({ text: `Pushed out by ${live.bump.count} failed run${live.bump.count === 1 ? '' : 's'} (${live.bump.reason}, +${fmtDur(live.bump.extendedMs)} in all); holds until the next estimate.`, tone: 'warn' })
  head('Calibration')
  L.push(...calLines(live, dir))
  head('Usual agent durations')
  L.push(...usualLines(live))
  head(`All sessions (${dir ?? NO_DIR})`)
  if (!sessions) {
    L.push({ text: 'Not read yet.', tone: 'dim' })
  } else {
    for (const r of sessions.rows) {
      const age = r.isSelf ? 'this session' : `updated ${fmtDur(now - r.updatedAt)} ago${r.isSilent ? ': silent while working, closed or hung?' : ''}`
      L.push({
        text: `${r.isSelf ? '>' : ' '} ${clip(r.project, 18)}  ${rowEta(r, now, tz)}  "${clip(r.label || '(no prompt yet)', 50)}"  ${age}`,
        tone: r.isOverdue || r.isSilent ? 'warn' : r.isSelf ? 'normal' : 'dim',
      })
    }
    const h = sessions.hidden
    const hid = [
      h.idle ? `${h.idle} idle with no update for >${fmtDur(STALE_IDLE_MS)}` : '',
      h.ended ? `${h.ended} ended` : '',
      h.dead ? `${h.dead} silent while working for >${fmtDur(DEAD_WORKING_MS)} (presumed closed)` : '',
    ].filter(Boolean)
    if (hid.length) L.push({ text: `Not listed: ${hid.join('; ')}.`, tone: 'dim' })
    for (const e of sessions.errors) L.push({ text: `Unreadable snapshot ${e}`, tone: 'warn' })
  }
  if (v.problems.length || live.tzSource !== 'node') {
    head('Problems')
    for (const p of v.problems) L.push({ text: p, tone: 'warn' })
    if (live.tzSource !== 'node') L.push({ text: `Clock times: ${live.tzSource}`, tone: 'dim' })
  }
  return L
}

export function commandText(live: EtaLive, now: number, dir: string | null): string {
  const v = etaView(live, now)
  const band = bandText(bandSegments(v, now, live.tzOffsetMin ?? 0)).replace(/^eta /, '')
  const cal = calLines(live, dir).map(l => l.text)
  return [`eta: ${band || 'idle'}`, 'Calibration:', ...cal.map(t => `  ${t}`), 'The eta pane lists every session on this machine.'].join('\n')
}

// ---------- the finished-task history ----------

export type { EtaEstimate, EtaHistoryRecord } from '../types'

/** eta's append-only history of finished plans, one JSON line each, beside the snapshots. */
export const historyFileOf = (dir: string) => `${dir}/history.jsonl`

export const shortSession = (sessionId: string) => sessionId.slice(0, 8)
export const historyId = (sessionId: string, firstAt: number) => `${shortSession(sessionId)}-${firstAt}`

/**
 * The history line for a plan ending at `at`, or null when it had no first
 * estimate (what endPlan also skips). Numbers and times only.
 */
export function historyRecord(plan: EtaPlan, at: number, end: 'done' | 'idle', self: EtaSelf | null): EtaHistoryRecord | null {
  const sample = endPlan(plan, at)
  if (!sample || plan.estimatedAt === null) return null
  const estimates: EtaEstimate[] = (plan.estimates ?? []).map(e => ({ ...e }))
  // A plan begun before estimates were kept lacks its first one: put it back.
  if (estimates[0]?.at !== plan.estimatedAt) estimates.unshift({ at: plan.estimatedAt, min: sample.said, f: null })
  const head = estimates[0] as EtaEstimate
  return {
    v: 1,
    id: historyId(self?.sessionId ?? 'unknown', plan.estimatedAt),
    session: self ? shortSession(self.sessionId) : null,
    project: self?.project ?? null,
    startedAt: plan.startedAt,
    firstAt: plan.estimatedAt,
    finishedAt: at,
    first: sample.said,
    estimates,
    took: sample.took,
    factor: head.f,
    range: plan.firstRange ?? null,
    factorSrc: 'shown',
    end,
    src: 'live',
  }
}

/** Parses history.jsonl: the records that read as records, and how many lines did not. */
export function parseHistory(text: string): { records: EtaHistoryRecord[]; bad: number } {
  const records: EtaHistoryRecord[] = []
  let bad = 0
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (!t) continue
    try {
      const r = JSON.parse(t) as Partial<EtaHistoryRecord>
      if (r && r.v === 1 && typeof r.first === 'number' && typeof r.took === 'number' && typeof r.finishedAt === 'number' && typeof r.firstAt === 'number') {
        records.push({ ...r, estimates: Array.isArray(r.estimates) ? r.estimates : [] } as EtaHistoryRecord)
      } else bad++
    } catch {
      bad++
    }
  }
  return { records, bad }
}

// ---------- accuracy: scoring and the adjustment ----------

/** "Within ±25%": the estimate is within 25% of what the work really took (|est − actual| ≤ 0.25 × actual). */
export const WITHIN_TIGHT = 0.25
export const WITHIN_LOOSE = 0.5
/** Running late costs this many times running early, in the scoring loss (a short number that jumps up is worse). */
export const LATE_WEIGHT = 2

export type AccuracyPair = { pred: number; actual: number; at: number }
export type AccuracyScore = {
  n: number
  /** Median of actual/estimate: 0.8 = work takes 0.8× the estimate. */
  medianRatio: number | null
  /** Mean |ln(actual/estimate)|. */
  male: number | null
  within25: number | null
  within50: number | null
  /** Share that ran more than 25% longer than estimated. */
  lateShare: number | null
  /** Mean asymmetric log loss: late errors × LATE_WEIGHT. */
  loss: number | null
}

export function scorePairs(pairs: readonly AccuracyPair[]): AccuracyScore {
  const ok = pairs.filter(p => p.pred > 0 && p.actual > 0)
  const n = ok.length
  if (n === 0) return { n: 0, medianRatio: null, male: null, within25: null, within50: null, lateShare: null, loss: null }
  const logs = ok.map(p => Math.log(p.actual / p.pred))
  const within = (k: number) => ok.filter(p => Math.abs(p.pred - p.actual) <= k * p.actual).length / n
  return {
    n,
    medianRatio: median(ok.map(p => p.actual / p.pred)),
    male: logs.reduce((a, e) => a + Math.abs(e), 0) / n,
    within25: within(WITHIN_TIGHT),
    within50: within(WITHIN_LOOSE),
    lateShare: ok.filter(p => p.actual > p.pred * (1 + WITHIN_TIGHT)).length / n,
    loss: logs.reduce((a, e) => a + (e > 0 ? LATE_WEIGHT * e : -e), 0) / n,
  }
}

/** Weighted quantile, linear between the items' weighted midpoints; `q` in [0, 1]. */
export function weightedQuantile(xs: readonly number[], ws: readonly number[], q: number): number {
  const items = xs.map((x, i) => ({ x, w: ws[i] ?? 1 })).filter(it => it.w > 0).sort((a, b) => a.x - b.x)
  if (items.length === 0) return NaN
  if (items.length === 1) return (items[0] as { x: number }).x
  const total = items.reduce((a, it) => a + it.w, 0)
  let acc = 0
  const mids = items.map(it => {
    const m = (acc + it.w / 2) / total
    acc += it.w
    return m
  })
  const target = Math.min(Math.max(q, mids[0] as number), mids[mids.length - 1] as number)
  for (let i = 1; i < items.length; i++) {
    const m0 = mids[i - 1] as number
    const m1 = mids[i] as number
    if (target <= m1) {
      const a = (items[i - 1] as { x: number }).x
      const b = (items[i] as { x: number }).x
      return m1 === m0 ? b : a + ((b - a) * (target - m0)) / (m1 - m0)
    }
  }
  return (items[items.length - 1] as { x: number }).x
}

/**
 * How an estimate is adjusted from finished ones. `match`: `near` = only
 * finished estimates within CAL_MATCH× of this one's size, `bucket` = the same
 * size bucket (under 10 min, 10-60, over 60), `all` = every one. `quantile`
 * of took/said (0.5 = the median); `halfLifeDays` weights recent ones more
 * (null = all equal). `rangeQ`: the quantiles of took/said the shown range
 * spans (null = always one number), shown from `rangeMinN` matched samples
 * and only when it is at least `rangeMinWidth` wide (hi/lo); narrower, one
 * number. `re`: how a re-estimate is shown: `plan` scales it by the first
 * estimate's factor, `raw` shows it as said (its range from past re-estimates).
 */
export type AdjustOptions = {
  window: number
  match: 'near' | 'bucket' | 'all'
  minSamples: number
  minRatio: number
  maxRatio: number
  quantile: number
  halfLifeDays: number | null
  rangeQ: [number, number] | null
  rangeMinN: number
  rangeMinWidth: number
  re: 'plan' | 'raw'
}

/** The calibration eta used through 2026-10-17: the median of the last CAL_KEEP similar-size samples, clamped, on every estimate of the plan. */
export const LEGACY_ADJUST: AdjustOptions = {
  window: CAL_KEEP, match: 'near', minSamples: CAL_MIN_SAMPLES, minRatio: CAL_MIN_RATIO, maxRatio: CAL_MAX_RATIO,
  quantile: 0.5, halfLifeDays: null, rangeQ: null, rangeMinN: Infinity, rangeMinWidth: Infinity, re: 'plan',
}

/**
 * What the band uses now, chosen by tools/backtest.ts on held-out tasks
 * (2026-10-17, 95 finished tasks): the legacy factor for a first estimate
 * (no candidate beat it held out), re-estimates as said (the plan's factor
 * doubled how often they ran late, 16% to 32%), and the middle half of how
 * similar estimates really went as a range while that spread is wide.
 */
export const ADJUST: AdjustOptions = { ...LEGACY_ADJUST, rangeQ: [0.25, 0.75], rangeMinN: 5, rangeMinWidth: 1.5, re: 'raw' }

/** How many past re-estimates the re-estimate range draws on. */
export const RE_KEEP = 60

export type Adjustment = {
  /** The factor for the estimate, null = not enough similar finished estimates (shown as said). */
  factor: number | null
  /** The shown range as factors of the estimate (lo ≤ center ≤ hi), null = one number. */
  range: [number, number] | null
  /** Matched finished estimates it came from. */
  n: number
  /** Their spread: the 25-75% quantiles of took/said, unclamped (null below minSamples). */
  spread: [number, number] | null
}

export const sizeBucket = (m: number) => (m < 10 ? 0 : m <= 60 ? 1 : 2)

/** The finished estimates that count for one of `forMinutes`, newest last, with their recency weights. */
function matched(samples: readonly EtaCalSample[], forMinutes: number | null, now: number, opts: AdjustOptions): { near: EtaCalSample[]; ws: number[] } {
  const ok = samples.filter(s => s.said >= 1 && s.took > 0)
  const recent = Number.isFinite(opts.window) ? ok.slice(-opts.window) : ok
  const size = forMinutes !== null && forMinutes >= 1 ? forMinutes : null
  const near =
    size === null || opts.match === 'all' ? recent
    : opts.match === 'near' ? recent.filter(s => s.said >= size / CAL_MATCH && s.said <= size * CAL_MATCH)
    : recent.filter(s => sizeBucket(s.said) === sizeBucket(size))
  const day = 24 * 60 * MIN
  const ws = near.map(s => (opts.halfLifeDays === null ? 1 : Math.pow(0.5, Math.max(0, now - s.at) / (opts.halfLifeDays * day))))
  return { near, ws }
}

function rangeAround(ratios: readonly number[], ws: readonly number[], center: number, opts: AdjustOptions): [number, number] | null {
  if (!opts.rangeQ || ratios.length < opts.rangeMinN) return null
  const lo = Math.min(center, Math.max(0.05, weightedQuantile(ratios, ws, opts.rangeQ[0])))
  const hi = Math.max(center, Math.min(opts.maxRatio * 2, weightedQuantile(ratios, ws, opts.rangeQ[1])))
  return hi / lo >= opts.rangeMinWidth ? [lo, hi] : null
}

/** The adjustment for a first estimate of `forMinutes`, from finished first estimates. */
export function adjust(samples: readonly EtaCalSample[], forMinutes: number | null, now: number, opts: AdjustOptions): Adjustment {
  const { near, ws } = matched(samples, forMinutes, now, opts)
  if (near.length === 0 || near.length < opts.minSamples) return { factor: null, range: null, n: near.length, spread: null }
  const ratios = near.map(s => s.took / s.said)
  const point = opts.quantile === 0.5 && opts.halfLifeDays === null ? median(ratios) : weightedQuantile(ratios, ws, opts.quantile)
  const factor = Math.min(opts.maxRatio, Math.max(opts.minRatio, point))
  const spread: [number, number] = [weightedQuantile(ratios, ws, 0.25), weightedQuantile(ratios, ws, 0.75)]
  return { factor, range: rangeAround(ratios, ws, shownFactor(factor) ?? 1, opts), n: near.length, spread }
}

/**
 * The adjustment for a re-estimate of `forMinutes`: under `raw`, shown as said
 * with a range from past re-estimates (`reSamples`); under `plan`, the plan's
 * own first-estimate factor and no range.
 */
export function adjustRe(reSamplesKnown: readonly EtaCalSample[], forMinutes: number, now: number, planFactor: number | null, opts: AdjustOptions): Adjustment {
  if (opts.re === 'plan') return { factor: planFactor, range: null, n: 0, spread: null }
  const { near, ws } = matched(reSamplesKnown.slice(-RE_KEEP), forMinutes, now, { ...opts, window: Infinity })
  if (near.length === 0 || near.length < opts.minSamples) return { factor: null, range: null, n: near.length, spread: null }
  const ratios = near.map(s => s.took / s.said)
  const spread: [number, number] = [weightedQuantile(ratios, ws, 0.25), weightedQuantile(ratios, ws, 0.75)]
  return { factor: null, range: rangeAround(ratios, ws, 1, opts), n: near.length, spread }
}

/** The factor the band applies: within 5% of 1× is shown as said. */
export const shownFactor = (f: number | null) => (f !== null && Math.abs(f - 1) >= 0.05 ? f : null)

/** A past plan's re-estimates as samples: what remained, said, against what it really took. */
export function reSamples(r: EtaHistoryRecord): EtaCalSample[] {
  return r.estimates
    .slice(1)
    .map(e => ({ said: e.min, took: Math.round(((r.finishedAt - e.at) / MIN) * 10) / 10, at: r.finishedAt }))
    .filter(s => s.said >= 1 && s.took > 0)
}

export type RangeScore = { n: number; coverage: number | null; medianWidth: number | null }
export type BacktestResult = {
  first: { raw: AccuracyScore; adjusted: AccuracyScore; range: RangeScore }
  re: { raw: AccuracyScore; adjusted: AccuracyScore; range: RangeScore }
  /** Tasks scored. */
  n: number
}

function rangeScore(hits: readonly { lo: number; hi: number; actual: number }[]): RangeScore {
  if (hits.length === 0) return { n: 0, coverage: null, medianWidth: null }
  return { n: hits.length, coverage: hits.filter(h => h.actual >= h.lo && h.actual <= h.hi).length / hits.length, medianWidth: median(hits.map(h => h.hi / h.lo)) }
}

/**
 * Online backtest: each task at index [from, to) of `records` sorted by finish
 * is predicted from only the tasks finished before its first estimate, its
 * re-estimates from only re-estimates of those tasks. Scores the first
 * estimates and the re-estimates as said and as adjusted, and how often the
 * shown ranges held what really happened.
 */
export function backtest(records: readonly EtaHistoryRecord[], opts: AdjustOptions, from = 0, to = records.length): BacktestResult {
  const sorted = [...records].sort((a, b) => a.finishedAt - b.finishedAt)
  const fRaw: AccuracyPair[] = []
  const fAdj: AccuracyPair[] = []
  const rRaw: AccuracyPair[] = []
  const rAdj: AccuracyPair[] = []
  const fHits: { lo: number; hi: number; actual: number }[] = []
  const rHits: { lo: number; hi: number; actual: number }[] = []
  for (let i = from; i < Math.min(to, sorted.length); i++) {
    const r = sorted[i] as EtaHistoryRecord
    if (!(r.first >= 1) || !(r.took > 0)) continue
    const known = sorted.filter(x => x.finishedAt < r.firstAt)
    const a = adjust(known.map(x => ({ said: x.first, took: x.took, at: x.finishedAt })), r.first, r.firstAt, opts)
    const f = shownFactor(a.factor)
    fRaw.push({ pred: r.first, actual: r.took, at: r.finishedAt })
    fAdj.push({ pred: r.first * (f ?? 1), actual: r.took, at: r.finishedAt })
    if (a.range) fHits.push({ lo: r.first * a.range[0], hi: r.first * a.range[1], actual: r.took })
    const reKnown = opts.re === 'raw' ? known.flatMap(reSamples) : []
    for (const e of r.estimates.slice(1)) {
      const actual = (r.finishedAt - e.at) / MIN
      if (!(e.min >= 1) || !(actual > 0)) continue
      const b = adjustRe(reKnown, e.min, e.at, f, opts)
      rRaw.push({ pred: e.min, actual, at: e.at })
      rAdj.push({ pred: e.min * (shownFactor(b.factor) ?? 1), actual, at: e.at })
      if (b.range) rHits.push({ lo: e.min * b.range[0], hi: e.min * b.range[1], actual })
    }
  }
  return {
    first: { raw: scorePairs(fRaw), adjusted: scorePairs(fAdj), range: rangeScore(fHits) },
    re: { raw: scorePairs(rRaw), adjusted: scorePairs(rAdj), range: rangeScore(rHits) },
    n: fRaw.length,
  }
}
