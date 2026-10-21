// fleet's pure logic: no $ here, so the tests exercise it directly.
import type { FleetAgent } from '../types/index'

export const WARN = 0.32 // hand off here
export const CEILING = 0.4 // never past here
export const CAP = 5 // running agents before the machine lags
export const RECENT_MS = 30 * 60 * 1000 // finished agents stay listed this long
export const MAX_FINISHED = 12

export type Level = 'ok' | 'warn' | 'over' | 'unknown'

/** Muted status colors: no neon. Text without a level stays default. */
export const COLORS: Record<Level, string | undefined> = {
  ok: '#7f9f7a',
  warn: '#c4a256',
  over: '#c0675a',
  unknown: undefined,
}

/** The `[lane:<name>]` tag of a brief, or null. */
export function laneOf(prompt: string | undefined): string | null {
  const m = /\[lane:([^\]\s]+)\]/i.exec(prompt ?? '')
  return m && m[1] ? m[1] : null
}

/**
 * Context window in tokens, by agent-context.js's rule: 1M when the model id
 * says [1m] or is an Opus 5.x (1M with no tag), or any request already passed
 * 200k (impossible on a 200k window); else 200k.
 */
export function windowFor(model: string | undefined, maxCtx = 0, isOneM = false): number {
  const id = model ?? ''
  if (isOneM || id.includes('[1m]') || /^claude-opus-5/.test(id) || maxCtx > 200_000) return 1_000_000
  return 200_000
}

export type Usage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

/** The context a request ran over, as agent-context.js counts it. */
export function ctxOf(u: Usage): number {
  return (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.output_tokens || 0)
}

export function pctOf(a: FleetAgent): number | undefined {
  if (a.ctx === undefined) return undefined
  const w = a.window ?? windowFor(a.model, a.maxCtx)
  return w > 0 ? a.ctx / w : undefined
}

export function levelOf(pct: number | undefined): Level {
  if (pct === undefined) return 'unknown'
  if (pct >= CEILING) return 'over'
  if (pct >= WARN) return 'warn'
  return 'ok'
}

export function isRunning(a: FleetAgent): boolean {
  return a.status === 'running' || a.status === 'pending'
}

/** Applies one request's usage to an agent: the reading, the window, the peak. */
export function withReading(a: FleetAgent, ctx: number, model: string | undefined, at: number, source: 'live' | 'transcript', isOneM = false): FleetAgent {
  const maxCtx = Math.max(a.maxCtx ?? 0, ctx)
  const m = model || a.model
  return { ...a, ctx, maxCtx, model: m, window: windowFor(m, maxCtx, isOneM), ctxAt: at, ctxSource: source }
}

export type Alert = { id: string; text: string }

/**
 * Marks each running agent that crossed 32% or 40% since its last toast and
 * returns the toasts to show (once per agent per threshold).
 */
export function crossings(agents: Record<string, FleetAgent>): { agents: Record<string, FleetAgent>; alerts: Alert[] } {
  const out: Record<string, FleetAgent> = {}
  const alerts: Alert[] = []
  for (const [id, a] of Object.entries(agents)) {
    const pct = pctOf(a)
    let next = a
    if (isRunning(a) && pct !== undefined) {
      const p = Math.round(pct * 100)
      if (pct >= CEILING && a.warned < 40) {
        alerts.push({ id, text: `fleet: ${a.lane} at ${p}%: over the 40% ceiling. Stop it and continue with a fresh agent.` })
        next = { ...a, warned: 40 }
      } else if (pct >= WARN && pct < CEILING && a.warned < 32) {
        alerts.push({ id, text: `fleet: ${a.lane} at ${p}%: hand off now (done / left / files / test state).` })
        next = { ...a, warned: 32 }
      }
    }
    out[id] = next
  }
  return { agents: out, alerts }
}

/** Running agents first (fullest first), then the recently finished, newest first. */
export function ordered(agents: Record<string, FleetAgent>, now: number): FleetAgent[] {
  const all = Object.values(agents)
  const running = all.filter(isRunning).sort((x, y) => (pctOf(y) ?? -1) - (pctOf(x) ?? -1))
  const done = all
    .filter(a => !isRunning(a) && a.endedAt !== undefined && now - a.endedAt <= RECENT_MS)
    .sort((x, y) => (y.endedAt ?? 0) - (x.endedAt ?? 0))
    .slice(0, MAX_FINISHED)
  return [...running, ...done]
}

export function pctText(pct: number | undefined): string {
  return pct === undefined ? '--' : `${Math.round(pct * 100)}%`
}

export function elapsedText(a: FleetAgent, now: number): string {
  if (a.startedAt === undefined) return '--'
  const ms = Math.max(0, (isRunning(a) ? now : a.endedAt ?? now) - a.startedAt)
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`
}

/** Short model name: `claude-opus-5-5` -> `opus-5-5`. */
export function modelText(model: string | undefined): string {
  return (model ?? '').replace(/^claude-/, '').replace(/\[1m\]$/, '')
}

export type Summary = {
  running: number
  over32: number
  over40: number
  peak?: { lane: string; pct: number }
  /** Running agents with no reading yet. */
  unread: number
}

export function summarize(agents: Record<string, FleetAgent>): Summary {
  const s: Summary = { running: 0, over32: 0, over40: 0, unread: 0 }
  for (const a of Object.values(agents)) {
    if (!isRunning(a)) continue
    s.running++
    const pct = pctOf(a)
    if (pct === undefined) { s.unread++; continue }
    if (pct >= WARN) s.over32++
    if (pct >= CEILING) s.over40++
    if (!s.peak || pct > s.peak.pct) s.peak = { lane: a.lane, pct }
  }
  return s
}

/** The band's one line, or null when nothing runs. */
export function bandText(s: Summary, probeError?: string): string | null {
  if (s.running === 0) return null
  const parts = [`${s.running} agent${s.running === 1 ? '' : 's'}${s.running > CAP ? ` (over cap ${CAP})` : ''}`]
  parts.push(s.peak ? `peak ctx ${pctText(s.peak.pct)} (${s.peak.lane})` : 'peak ctx --')
  parts.push(`${s.over32} over 32%`)
  if (s.unread > 0) parts.push(`${s.unread} not read yet`)
  if (probeError) parts.push(`transcripts unreadable: ${probeError}`)
  return parts.join(' · ')
}

/** Pads or cuts to exactly `n` cells (single-width text assumed). */
export function fit(text: string, n: number): string {
  if (n <= 0) return ''
  if (text.length > n) return n === 1 ? text.slice(0, 1) : text.slice(0, n - 1) + '…'
  return text.padEnd(n)
}

export type Columns = { lane: number; model: number; state: number; elapsed: number; ctx: number; tool: number }

/** Column widths for a body `cols` wide; the model and last-tool columns go first when narrow. */
export function columnsFor(cols: number): Columns {
  const state = 9, elapsed = 8, ctx = 6
  const fixed = state + elapsed + ctx
  let rest = Math.max(10, cols - fixed - 1)
  const showModel = cols >= 56
  const showTool = cols >= 76
  const tool = showTool ? Math.min(14, Math.floor(rest * 0.22)) : 0
  rest -= tool
  const model = showModel ? Math.min(24, Math.floor(rest * 0.45)) : 0
  rest -= model
  return { lane: Math.max(8, rest), model, state, elapsed, ctx, tool }
}

/** What fleet reads of `$.agent.list()` rows. */
export type ListedAgent = { id: string; description: string; type: string; status: string; parentId?: string }

/** A row for an agent fleet has not seen before. */
export function freshAgent(id: string, init: Partial<FleetAgent> = {}): FleetAgent {
  const description = init.description ?? ''
  return { id, lane: description || id, hasLaneTag: false, description, type: '', status: 'running', warned: 0, ...init }
}

/** Folds `$.agent.list()` into the rows: new agents, statuses, end times. */
export function mergeList(cur: Record<string, FleetAgent>, list: readonly ListedAgent[], now: number): Record<string, FleetAgent> {
  const out: Record<string, FleetAgent> = { ...cur }
  for (const info of list) {
    const was = out[info.id]
    const a = was ?? freshAgent(info.id, { description: info.description, type: info.type, status: info.status })
    const next: FleetAgent = {
      ...a,
      description: info.description || a.description,
      type: info.type || a.type,
      status: info.status,
      parentId: info.parentId ?? a.parentId,
    }
    if (!next.hasLaneTag && next.description) next.lane = next.description
    // Seen to stop now: it ended about now. First seen already stopped: the
    // transcript's last write says when (applyProbe).
    if (was && isRunning(was) && !isRunning(next) && next.endedAt === undefined) next.endedAt = now
    out[info.id] = next
  }
  return out
}

/**
 * Which agents the transcript reader should visit: every agent once (brief,
 * start, end time), and a running agent with no live reading every 30 s.
 */
export function needsProbe(agents: Record<string, FleetAgent>, now: number): string[] {
  return Object.values(agents)
    .filter(a => !a.isProbed || (isRunning(a) && a.ctxSource !== 'live' && now - (a.probedAt ?? 0) >= 30_000))
    .map(a => a.id)
}

export type Hit = {
  isFound: boolean
  ctx?: number
  maxCtx?: number
  isOneM?: boolean
  model?: string
  brief?: string
  startedAt?: number
  at?: number
  mtime?: number
  error?: string
}

/** Applies the transcript reader's findings; a live reading always wins. */
export function applyProbe(cur: Record<string, FleetAgent>, hits: Record<string, Hit>, now: number): Record<string, FleetAgent> {
  const out: Record<string, FleetAgent> = { ...cur }
  for (const [id, hit] of Object.entries(hits)) {
    const a0 = out[id]
    if (!a0) continue
    let a: FleetAgent = { ...a0, isProbed: true, probedAt: now }
    if (!hit.isFound) {
      a.note = 'no transcript file for it under ~/.claude/projects'
      out[id] = a
      continue
    }
    const lane = laneOf(hit.brief)
    if (lane && !a.hasLaneTag) a = { ...a, lane, hasLaneTag: true }
    if (a.startedAt === undefined && hit.startedAt) a.startedAt = hit.startedAt
    if (!isRunning(a) && a.endedAt === undefined && hit.mtime) a.endedAt = hit.mtime
    if (hit.ctx !== undefined && a.ctxSource !== 'live') {
      a = withReading(a, hit.ctx, hit.model, hit.at ?? now, 'transcript', hit.isOneM)
      a.maxCtx = Math.max(a.maxCtx ?? 0, hit.maxCtx ?? 0)
      a.window = windowFor(a.model, a.maxCtx, hit.isOneM)
      delete a.note
    } else if (hit.error) {
      a.note = `transcript unreadable: ${hit.error}`
    } else if (a.ctx === undefined && isRunning(a)) {
      a.note = 'no model turn with usage yet'
    }
    out[id] = a
  }
  return out
}
