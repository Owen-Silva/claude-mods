// Pace math and wording: pure functions, no `$`, so tests drive them directly.
import type { PaceReading, PaceSnapshot, PaceWindow } from '../types'
import { DEFAULT_NAME } from './user'

const MIN = 60_000
const HOUR = 60 * MIN

/** Length of the rolling rate-limit window this mod paces. */
export const WINDOW_MS = 5 * HOUR
/** Measured: one round of 3 file-scoped Opus agents uses about 6% of a 5H window. */
export const PCT_PER_ROUND_OF_3 = 6
export const AGENTS_PER_ROUND = 3
export const PCT_PER_AGENT = PCT_PER_ROUND_OF_3 / AGENTS_PER_ROUND
/** The CPU cap: no more than ~5 agents at once. */
export const MAX_CONCURRENT_AGENTS = 5
/** Points kept back for the main session's own turns. */
export const MARGIN_PCT = 5
/** "Hot": at the current burn, 100% lands more than this long before the reset. */
export const HOT_LEAD_MS = 30 * MIN
/** Before this much of the window has passed, the average burn is too noisy to project. */
export const MIN_ELAPSED_FOR_BURN_MS = 20 * MIN
/** A reading older than this is labelled with its age. */
export const STALE_MS = 10 * MIN
/** 5H thresholds that toast once per window. */
export const TOAST_THRESHOLDS = [80, 95] as const
/** Measured: one Opus agent uses about this much of the WEEKLY limit. */
export const WEEK_PCT_PER_AGENT = 0.42

// A one-time "Reset for free" promo (refills weekly + 5H; pressed in claude.ai
// or Desktop). Its dates and wording are machine-local config: register.tsx
// reads free-reset.local.json beside the hooks folder (gitignored) through
// parseFreeReset. No file, or an invalid one, means no promo: no /pace row,
// no toast, no tracking.
export type FreeResetConfig = {
  /** Press toasts only fire from this instant (epoch ms)... */
  toastFrom: number
  /** ...until the offer expires (epoch ms); the /pace row shows until then. */
  expiresAt: number
  /** Weekly % levels that toast once per weekly cycle, ascending; the highest is "press now". */
  levels: readonly number[]
  /** No press toast when the natural weekly reset is this close: the unspent % would be lost for little. */
  minLeadMs: number
  /** A weekly drop this large with the same resets_at means the free reset was pressed. */
  dropPts: number
  /** When to press, as shown in the /pace row. */
  target: string
  /** The expiry, as shown in the /pace row. */
  expiresLabel: string
  /** Where the button is, as the "press now" toast names it. */
  where: string
}

/**
 * The promo config from free-reset.local.json's text, or null when it is not
 * a JSON object or a field is missing or malformed. `toastFrom` and `expiresAt`
 * are ISO instants with their offset, `minLeadHours` is hours, `dropPoints` is
 * weekly percentage points, `levels` ascending weekly percentages.
 */
export function parseFreeReset(text: string): FreeResetConfig | null {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>
  const instant = (x: unknown) => (typeof x === 'string' ? Date.parse(x) : NaN)
  const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : NaN)
  const str = (x: unknown) => (typeof x === 'string' && x.trim() !== '' ? x : null)
  const toastFrom = instant(o.toastFrom)
  const expiresAt = instant(o.expiresAt)
  const minLeadHours = num(o.minLeadHours)
  const dropPts = num(o.dropPoints)
  const target = str(o.target)
  const expiresLabel = str(o.expiresLabel)
  const where = str(o.where)
  const levels = Array.isArray(o.levels) ? o.levels.map(num) : []
  const isAscending = levels.length > 0 && levels.every((l, i) => Number.isFinite(l) && (i === 0 || l > (levels[i - 1] as number)))
  if (!Number.isFinite(toastFrom) || !Number.isFinite(expiresAt) || !(minLeadHours >= 0) || !(dropPts > 0)) return null
  if (!isAscending || target === null || expiresLabel === null || where === null) return null
  return { toastFrom, expiresAt, levels, minLeadMs: minLeadHours * HOUR, dropPts, target, expiresLabel, where }
}

export type Verdict = 'under' | 'on' | 'hot' | 'pinned' | 'early' | 'reset' | 'missing'

export type PaceView = {
  verdict: Verdict
  /** When the snapshot was taken (epoch ms). */
  now: number
  /** Why there are no figures (missing) or none for this window (reset). */
  reason?: string
  used?: number
  remainingMs?: number
  elapsedMs?: number
  /** Average burn since the window opened, in points per hour; null too early. */
  burnPerHour?: number | null
  /** 5H % at the reset if the average burn holds; null too early. */
  projectedFinal?: number | null
  /** From now until 100% at the current burn; null when it never gets there. */
  hitInMs?: number | null
  /** How long before the reset 100% lands (negative: after the reset). */
  hitBeforeResetMs?: number | null
  /** Points left over at the reset after the margin, at the current burn. */
  spare?: number
  extraRounds?: number
  recommendedAgents?: number
  ageMs?: number
  isStale?: boolean
  week: PaceWindow | null
  costUsd: number | null
  source?: string
  /** When the one-time free reset was detected as pressed; null while unused. */
  freeResetUsedAt: number | null
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))

/** Turns a snapshot into the verdict and every figure the surfaces show. */
export function paceView(snap: PaceSnapshot): PaceView {
  const { now, reading, costUsd } = snap
  const freeResetUsedAt = snap.freeResetUsedAt ?? null
  if (!reading) {
    return { now, verdict: 'missing', reason: snap.reason ?? 'no rate-limit reading', week: null, costUsd, freeResetUsedAt }
  }
  const week = reading.sevenDay && reading.sevenDay.resetsAt > now ? reading.sevenDay : null
  const ageMs = Math.max(0, now - reading.observedAt)
  const base = { now, week, costUsd, ageMs, isStale: ageMs > STALE_MS, source: reading.sourceDetail, freeResetUsedAt }
  const fh = reading.fiveHour
  if (!fh) {
    return { ...base, verdict: 'missing', reason: `the reading has no five_hour window (${reading.sourceDetail})` }
  }
  const rawRemaining = fh.resetsAt - now
  if (rawRemaining <= 0) {
    return {
      ...base,
      verdict: 'reset',
      reason: `the 5H window reset ${fmtDuration(-rawRemaining)} ago; waiting for a fresh reading (next API response)`,
    }
  }
  const remainingMs = Math.min(rawRemaining, WINDOW_MS)
  const elapsedMs = WINDOW_MS - remainingMs
  const used = fh.percentUsed
  const common = { ...base, used, remainingMs, elapsedMs }

  if (used >= 100) {
    return { ...common, verdict: 'pinned', burnPerHour: null, projectedFinal: 100, hitInMs: 0, hitBeforeResetMs: remainingMs, spare: 0, extraRounds: 0, recommendedAgents: 0 }
  }

  if (elapsedMs < MIN_ELAPSED_FOR_BURN_MS) {
    const spare = 100 - MARGIN_PCT - used
    return {
      ...common,
      verdict: 'early',
      burnPerHour: null,
      projectedFinal: null,
      hitInMs: null,
      hitBeforeResetMs: null,
      spare,
      extraRounds: Math.max(0, Math.floor(spare / PCT_PER_ROUND_OF_3)),
      recommendedAgents: clamp(Math.floor(spare / PCT_PER_AGENT), 0, MAX_CONCURRENT_AGENTS),
    }
  }

  const burnPerHour = used / (elapsedMs / HOUR)
  const projectedFinal = used + burnPerHour * (remainingMs / HOUR)
  const hitInMs = burnPerHour > 0 ? ((100 - used) / burnPerHour) * HOUR : null
  const hitBeforeResetMs = hitInMs === null ? null : remainingMs - hitInMs
  const spare = 100 - MARGIN_PCT - projectedFinal
  const verdict: Verdict =
    hitBeforeResetMs !== null && hitBeforeResetMs > HOT_LEAD_MS ? 'hot' : spare >= PCT_PER_ROUND_OF_3 ? 'under' : 'on'
  return {
    ...common,
    verdict,
    burnPerHour,
    projectedFinal,
    hitInMs,
    hitBeforeResetMs,
    spare,
    extraRounds: verdict === 'hot' ? 0 : Math.max(0, Math.floor(spare / PCT_PER_ROUND_OF_3)),
    recommendedAgents: verdict === 'hot' ? 0 : clamp(Math.floor(spare / PCT_PER_AGENT), 0, MAX_CONCURRENT_AGENTS),
  }
}

/** `2h41m`, `41m`, `<1m`. */
export function fmtDuration(ms: number): string {
  const m = Math.floor(Math.max(0, ms) / MIN)
  if (m < 1) return '<1m'
  const h = Math.floor(m / 60)
  const r = m % 60
  return h > 0 ? `${h}h${String(r).padStart(2, '0')}m` : `${r}m`
}

/** `46%`, `23.5%`. */
export function fmtPct(n: number): string {
  return `${Math.round(n * 10) / 10}%`
}

export function fmtUsd(n: number): string {
  return `$${n.toFixed(2)}`
}

const rounds = (n: number) => `~${n} more round${n === 1 ? '' : 's'} of ${AGENTS_PER_ROUND} agents`
const agents = (n: number) => `${n} agent${n === 1 ? '' : 's'}`

/** The verdict phrase the band shows after the time left. */
export function verdictPhrase(v: PaceView): string {
  switch (v.verdict) {
    case 'under':
      return `under pace — room for ${rounds(v.extraRounds ?? 0)}`
    case 'on':
      return (v.recommendedAgents ?? 0) > 0
        ? `on pace — room for ~${agents(v.recommendedAgents ?? 0)} more`
        : 'on pace — keep the current load'
    case 'hot':
      return `hot — 100% in ${fmtDuration(v.hitInMs ?? 0)}, ${fmtDuration(v.hitBeforeResetMs ?? 0)} before reset; hold new agents`
    case 'pinned':
      return 'at the limit — hold until the reset'
    case 'early':
      return `early (${fmtDuration(v.elapsedMs ?? 0)} in, pace readable at ${fmtDuration(MIN_ELAPSED_FOR_BURN_MS)}) — headroom for ${rounds(v.extraRounds ?? 0)}`
    case 'reset':
    case 'missing':
      return v.reason ?? ''
  }
}

export type BandTone = 'normal' | 'accent' | 'warn' | 'alert'

export type BandSegment = { text: string; tone: BandTone | 'dim' }

/** The band's one line as toned segments; the renderer only colors them. */
export function bandSegments(v: PaceView): BandSegment[] {
  const sep: BandSegment = { text: ' · ', tone: 'dim' }
  const tail: BandSegment[] = []
  if (v.week) tail.push(sep, { text: `WK ${fmtPct(v.week.percentUsed)}`, tone: 'dim' })
  if (v.costUsd !== null) tail.push(sep, { text: fmtUsd(v.costUsd), tone: 'dim' })
  if (v.isStale && v.ageMs !== undefined) tail.push(sep, { text: `reading ${fmtDuration(v.ageMs)} old`, tone: 'warn' })

  if (v.verdict === 'missing') {
    return [{ text: '5H pace: no reading — ', tone: 'warn' }, { text: v.reason ?? '', tone: 'dim' }, ...tail]
  }
  if (v.verdict === 'reset') {
    return [{ text: '5H ', tone: 'dim' }, { text: v.reason ?? '', tone: 'warn' }, ...tail]
  }
  const tone: BandTone =
    v.verdict === 'pinned' ? 'alert' : v.verdict === 'hot' ? 'warn' : v.verdict === 'under' ? 'accent' : 'normal'
  return [
    { text: '5H ', tone: 'dim' },
    { text: fmtPct(v.used ?? 0), tone: v.verdict === 'pinned' ? 'alert' : 'normal' },
    sep,
    { text: `${fmtDuration(v.remainingMs ?? 0)} left`, tone: 'normal' },
    sep,
    { text: verdictPhrase(v), tone },
    ...tail,
  ]
}

export function bandLine(v: PaceView): string {
  return bandSegments(v).map(s => s.text).join('')
}

/** The fuller breakdown `/pace` prints. */
export function commandText(v: PaceView, fr: FreeResetConfig | null = null): string {
  const lines: string[] = []
  const row = (label: string, text: string) => lines.push(`${label.padEnd(13)}${text}`)
  if (v.verdict === 'missing') {
    row('5-hour', `no reading — ${v.reason}`)
  } else if (v.verdict === 'reset') {
    row('5-hour', v.reason ?? '')
  } else {
    row('5-hour', `${fmtPct(v.used ?? 0)} used · ${fmtDuration(v.elapsedMs ?? 0)} elapsed · resets in ${fmtDuration(v.remainingMs ?? 0)}`)
    row('burn', v.burnPerHour == null
      ? `not projected yet (needs ${fmtDuration(MIN_ELAPSED_FOR_BURN_MS)} of the window; ${fmtDuration(v.elapsedMs ?? 0)} so far)`
      : `${(Math.round(v.burnPerHour * 10) / 10).toFixed(1)}%/h average since the window opened (even pace is 20.0%/h)`)
    if (v.verdict === 'pinned') {
      row('projection', 'limit reached')
    } else if (v.burnPerHour != null) {
      const fin = `${fmtPct(Math.round(v.projectedFinal ?? 0))} at the reset`
      row('projection', v.hitInMs == null
        ? `${fin}; never reaches 100% at this burn`
        : (v.hitBeforeResetMs ?? 0) >= 0
          ? `100% in ${fmtDuration(v.hitInMs)}, ${fmtDuration(v.hitBeforeResetMs ?? 0)} before the reset`
          : `${fin}; 100% would land ${fmtDuration(-(v.hitBeforeResetMs ?? 0))} after the reset`)
    }
    row('verdict', verdictPhrase(v))
    row('next round', roundAdvice(v))
  }
  if (v.week) row('7-day', `${fmtPct(v.week.percentUsed)} used · resets in ${fmtDuration(v.week.resetsAt - v.now)}`)
  if (fr && v.now <= fr.expiresAt) {
    row('free reset', v.freeResetUsedAt !== null
      ? `used ${fmtWhen(v.freeResetUsedAt)}`
      : `unused · press at >=${fr.levels[fr.levels.length - 1]}% weekly (target ${fr.target}) · expires ${fr.expiresLabel}`)
  }
  row('cost', v.costUsd === null ? 'no cost ledger in this host' : `${fmtUsd(v.costUsd)} this session (Claude Code's own total)`)
  if (v.source !== undefined) {
    row('reading', `${v.source}, ${v.ageMs !== undefined ? `${fmtDuration(v.ageMs)} old` : 'age unknown'}${v.isStale ? ' (stale: other sessions may have used more since)' : ''}`)
  }
  row('basis', `3 agents ≈ ${PCT_PER_ROUND_OF_3}% of 5H, 1 agent ≈ ${WEEK_PCT_PER_AGENT}% weekly (measured) · max ${MAX_CONCURRENT_AGENTS} at once · ${MARGIN_PCT} pts kept for the main session · hot = 100% lands >${fmtDuration(HOT_LEAD_MS)} before reset`)
  return lines.join('\n')
}

/** The recommended size of the next round, in words. */
export function roundAdvice(v: PaceView): string {
  if (v.verdict === 'hot' || v.verdict === 'pinned') return 'none — hold new agents until the burn drops or the window resets'
  const n = v.recommendedAgents ?? 0
  if (n === 0) return 'none spare — finish what is running'
  return `up to ${agents(n)} now (~${Math.round(n * PCT_PER_AGENT)}% of 5H)`
}

/** The model-callable tool's short name; the model sees `mcp__pace__Pace`. */
export const TOOL_NAME = 'Pace'

/** What the model reads about the tool. Fixed text. */
export const TOOL_DESCRIPTION =
  "Live 5-hour rate-limit budget for this account: verdict (under / on pace / hot), 5H and weekly use, time left in the window, burn rate, when 100% would land, and the recommended size of the next subagent round. Call it before launching a round of subagents. The owner wants the 5H limit used up near the END of the window: neither idle with hours left nor pinned at 100% early. Takes no input."

/**
 * The system-prompt section. Deliberately STATIC: a `session` section sits
 * before the conversation, so any change to its text re-caches the whole
 * conversation. Live figures come from the Pace tool instead.
 */
export function promptSection(name: string = DEFAULT_NAME): string {
  return `Before sizing a round of subagents, call the Pace tool (mcp__pace__Pace) for the live 5-hour budget (${name} wants the 5H limit used up near the end of the window).`
}

/** What the Pace tool returns: the /pace breakdown under one line naming it. */
export function toolText(v: PaceView, fr: FreeResetConfig | null = null): string {
  return `Rate-limit pace (live; one Opus subagent ≈ ${PCT_PER_AGENT}% of the 5H window):\n${commandText(v, fr)}`
}

/** Toasts due for this view: each fires once per window, keyed in `fired`. */
export function toastsDue(v: PaceView, reading: PaceReading | null, fired: readonly string[], fr: FreeResetConfig | null = null): { key: string; text: string }[] {
  const due: { key: string; text: string }[] = freeResetToast(v, fired, fr)
  const fh = reading?.fiveHour
  if (!fh || v.used === undefined || v.verdict === 'reset' || v.verdict === 'missing') return due
  const w = windowKey(fh.resetsAt)
  for (const t of TOAST_THRESHOLDS) {
    const key = `${w}:${t}`
    if (v.used >= t && !fired.includes(key)) {
      due.push({ key, text: `5H at ${fmtPct(v.used)} with ${fmtDuration(v.remainingMs ?? 0)} left — ${t >= 95 ? 'hold new agents' : 'size the next round down'}` })
    }
  }
  const hotKey = `${w}:hot`
  if (v.verdict === 'hot' && !fired.includes(hotKey)) {
    due.push({ key: hotKey, text: `5H pace hot: 100% projected in ${fmtDuration(v.hitInMs ?? 0)}, ${fmtDuration(v.hitBeforeResetMs ?? 0)} before the reset — hold or shrink the next round` })
  }
  return due
}

/** Names a window by its reset time, to the 10 minutes (sources disagree by seconds). */
export function windowKey(resetsAt: number): string {
  return `w${Math.round(resetsAt / (10 * MIN))}`
}

/** Keeps only the fired keys of the given window, so the list stays short. Weekly (`wk`) keys stay. */
export function pruneFired(fired: readonly string[], resetsAt: number | undefined): string[] {
  if (resetsAt === undefined) return [...fired]
  const w = `${windowKey(resetsAt)}:`
  return fired.filter(k => k.startsWith(w) || k.startsWith('wk'))
}

/** `3d 18h`, `20h`. */
export function fmtDays(ms: number): string {
  const h = Math.floor(Math.max(0, ms) / HOUR)
  return h >= 24 ? `${Math.floor(h / 24)}d ${h % 24}h` : `${h}h`
}

/** `Mon, Jan 5, 9:42 PM`, in the machine's local time zone. */
export function fmtWhen(t: number): string {
  return new Date(t).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

/** The press-the-free-reset toast: the highest weekly level crossed, once per weekly cycle. */
export function freeResetToast(v: PaceView, fired: readonly string[], fr: FreeResetConfig | null = null): { key: string; text: string }[] {
  const wk = v.week
  if (!fr || !wk || v.freeResetUsedAt !== null) return []
  if (v.now < fr.toastFrom || v.now > fr.expiresAt) return []
  const lead = wk.resetsAt - v.now
  if (lead <= fr.minLeadMs) return []
  const level = [...fr.levels].reverse().find(l => wk.percentUsed >= l)
  if (level === undefined) return []
  const key = `wk${Math.round(wk.resetsAt / (10 * MIN))}:fr${level}`
  if (fired.includes(key)) return []
  const top = fr.levels[fr.levels.length - 1] as number
  const text = level >= top
    ? `Weekly at ${fmtPct(wk.percentUsed)} with ${fmtDays(lead)} until it resets. Press the free reset now: ${fr.where}.`
    : `Weekly at ${fmtPct(wk.percentUsed)}. Free-reset press is close; plan to press at ${top}%.`
  return [{ key, text }]
}

/** What the mod remembers about the free reset, across sessions. */
export type FreeResetState = { usedAt: number | null; last: (PaceWindow & { observedAt: number }) | null }

/**
 * Detects the press: weekly use drops by the config's dropPts or more while the
 * natural resets_at stays put. Only newer readings count, so a stale status
 * line record never looks like a drop. Returns `prev` itself when nothing changed,
 * and always without a config (no promo, no tracking).
 */
export function trackFreeReset(prev: FreeResetState, reading: PaceReading | null, now: number, fr: FreeResetConfig | null = null): FreeResetState {
  const wk = reading?.sevenDay
  if (!fr || prev.usedAt !== null || !wk || !reading) return prev
  const last = prev.last
  if (last && reading.observedAt <= last.observedAt) return prev
  if (last && last.percentUsed === wk.percentUsed && last.resetsAt === wk.resetsAt) return prev
  const next = { percentUsed: wk.percentUsed, resetsAt: wk.resetsAt, observedAt: reading.observedAt }
  const sameCycle = last !== null && Math.abs(last.resetsAt - wk.resetsAt) < 10 * MIN
  if (sameCycle && last.percentUsed - wk.percentUsed >= fr.dropPts && now <= fr.expiresAt) {
    return { usedAt: now, last: next }
  }
  return { usedAt: null, last: next }
}

type RateLimitLike = { kind: string; percentUsed: number; resetsAt?: string }

/** A reading from `$.session.usage()`'s rate-limit list; null when it has no window. */
export function readingFromSession(list: readonly RateLimitLike[], observedAt: number): PaceReading | null {
  const pick = (kind: string): PaceWindow | null => {
    const r = list.find(x => x.kind === kind)
    if (!r || typeof r.percentUsed !== 'number' || !r.resetsAt) return null
    const resetsAt = Date.parse(r.resetsAt)
    return Number.isFinite(resetsAt) ? { percentUsed: r.percentUsed, resetsAt } : null
  }
  const fiveHour = pick('five_hour')
  const sevenDay = pick('seven_day')
  if (!fiveHour && !sevenDay) return null
  return { fiveHour, sevenDay, observedAt, source: 'session', sourceDetail: "this session's last API response" }
}

/**
 * A reading from one mission-control statusline record (the status line's
 * JSON as the hook saved it, plus `receivedAt`); null with no rate limits.
 * Throws on text that is not JSON, so the caller can say why.
 */
export function readingFromStatusline(text: string, fileName: string): PaceReading | null {
  const rec = JSON.parse(text) as {
    receivedAt?: string
    rate_limits?: Record<string, { used_percentage?: number; resets_at?: number } | undefined>
  }
  const pick = (kind: string): PaceWindow | null => {
    const r = rec.rate_limits?.[kind]
    if (!r || typeof r.used_percentage !== 'number' || typeof r.resets_at !== 'number') return null
    return { percentUsed: r.used_percentage, resetsAt: r.resets_at * 1000 }
  }
  const fiveHour = pick('five_hour')
  const sevenDay = pick('seven_day')
  const observedAt = rec.receivedAt ? Date.parse(rec.receivedAt) : NaN
  if ((!fiveHour && !sevenDay) || !Number.isFinite(observedAt)) return null
  return { fiveHour, sevenDay, observedAt, source: 'statusline-file', sourceDetail: `status line record ${fileName.slice(0, 8)}…` }
}

/** The fresher of two readings; the session's own on a tie. */
export function freshest(a: PaceReading | null, b: PaceReading | null): PaceReading | null {
  if (!a) return b
  if (!b) return a
  return b.observedAt > a.observedAt ? b : a
}
