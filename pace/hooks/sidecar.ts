// sidecar: the record mission-control's `dash` reads, for sessions where
// Claude Code never runs the statusLine command.
//
// Mission Control reads 5H / WEEK / COST from data/statusline/<session-id>.json,
// written by bin/statusline.js from the settings.json statusLine hook. Claude
// Code only runs that hook in the interactive terminal UI, so Agent SDK
// sessions (Helm, `claude -p`) never wrote a record: from 2026-10-09, when work
// moved to Helm, the folder went stale and dash froze. The engine has the same
// figures in every mode ($.session.usage / session.measure); register.tsx writes
// them through sidecarRecord in the status line's own shape, merged over any
// record already there. Interactive terminal sessions are skipped: their
// bin/statusline.js write is atomic (tmp + rename), and a second writer on the
// same file could make that rename fail on Windows.

/**
 * The status line record folder, which this mod both reads (fallback figures)
 * and writes (the sidecar): `override` (PACE_STATUSLINE_DIR) when set, else
 * <home>/mission-control/data/statusline. Forward slashes, no trailing slash;
 * null when there is neither.
 */
export function statuslineDir(env: { override?: string | null; home?: string | null }): string | null {
  const clean = (p: string) => p.split('\\').join('/').replace(/\/+$/, '')
  if (env.override && env.override.trim() !== '') return clean(env.override.trim())
  if (env.home && env.home.trim() !== '') return `${clean(env.home.trim())}/mission-control/data/statusline`
  return null
}

export type SidecarFigures = {
  rateLimits: readonly { kind: string; percentUsed: number; resetsAt?: string }[]
  cost?: { usd: number }
  context?: { tokens?: number; window: number; percent?: number }
}

/** The record bin/statusline.js would have written, merged over `prev`. */
export function sidecarRecord(prev: Record<string, unknown> | null, sessionId: string, model: string | null, f: SidecarFigures, nowMs: number): Record<string, unknown> {
  const rec: Record<string, unknown> = { ...(prev ?? {}) }
  rec.receivedAt = new Date(nowMs).toISOString()
  rec.session_id = sessionId
  rec.source = 'pace-sidecar'
  if (model && !(prev && prev.model)) rec.model = { id: model, display_name: model }
  if (f.cost && Number.isFinite(f.cost.usd)) {
    const prevCost = prev && typeof prev.cost === 'object' && prev.cost ? (prev.cost as Record<string, unknown>) : {}
    rec.cost = { ...prevCost, total_cost_usd: f.cost.usd }
  }
  if (f.context && Number.isFinite(f.context.window)) {
    const pct = typeof f.context.percent === 'number' ? f.context.percent : null
    rec.context_window = {
      total_input_tokens: typeof f.context.tokens === 'number' ? f.context.tokens : 0,
      context_window_size: f.context.window,
      used_percentage: pct,
      remaining_percentage: pct === null ? null : Math.max(0, 100 - pct),
    }
  }
  const rl: Record<string, { used_percentage: number; resets_at?: number }> = {}
  for (const l of f.rateLimits) {
    if (typeof l.percentUsed !== 'number') continue
    const ms = l.resetsAt ? Date.parse(l.resetsAt) : NaN
    rl[l.kind] = Number.isFinite(ms) ? { used_percentage: l.percentUsed, resets_at: Math.round(ms / 1000) } : { used_percentage: l.percentUsed }
  }
  // An empty list (before the first response) keeps whatever reading was there.
  if (Object.keys(rl).length > 0) rec.rate_limits = rl
  return rec
}

/** Parses an existing record; null when missing, unreadable or not an object. */
export function parseRecord(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}
