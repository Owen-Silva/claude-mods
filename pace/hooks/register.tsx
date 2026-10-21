// pace: is this session on pace to use the 5-hour rate-limit window by its end?
// Band above the prompt, /pace, a model-callable Pace tool, threshold toasts
// and one static system-prompt line. Figures come from Claude Code itself ($.session.usage and
// session.measure); the mission-control status line records are a fallback
// for the stretch before this session's first API response.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { PaceReading, PaceSnapshot } from '../types'
import {
  bandSegments,
  commandText,
  freshest,
  paceView,
  promptSection,
  pruneFired,
  readingFromSession,
  readingFromStatusline,
  toastsDue,
  TOOL_DESCRIPTION,
  TOOL_NAME,
  toolText,
  parseFreeReset,
  trackFreeReset,
} from './pace'
import type { BandSegment, FreeResetConfig, FreeResetState } from './pace'
import { parseRecord, sidecarRecord, statuslineDir } from './sidecar'
import { readUser } from './user'
import type { SidecarFigures } from './sidecar'

const REFRESH_MS = 60_000
/** The Pace tool as the model calls it (`mcp__<plugin>__<name>`). */
const TOOL_FULL_NAME = 'mcp__pace__Pace'
/** `$.store` key of the toasts already shown, kept across sessions: the window is account-wide. */
const FIRED_KEY = 'fired'
/** `$.store` key of the one-time free reset state (FreeResetState), kept only while a promo config exists. */
const FREE_RESET_KEY = 'freeReset'
/** The promo config, beside plugin.json; absent for anyone without the promo. */
const FREE_RESET_FILE = 'free-reset.local.json'

const snapshotAtom = atom({ plugin: 'pace', key: 'snapshot' } as const, null)

const TONE: Record<BandSegment['tone'], { color?: string; dimColor?: boolean }> = {
  dim: { dimColor: true },
  normal: {},
  accent: { color: '#8fa7bf' },
  warn: { color: '#c9a25a' },
  alert: { color: '#c96f5f' },
}

// Module state: a reload runs the module afresh, which is what these want.
let started = false
let refreshing: Promise<void> | null = null
/** When this session's rate-limit figures last changed or were re-measured. */
let native: { sig: string; at: number } | null = null
/** The promo config, read once per load (null: no promo). */
let freeReset: Promise<FreeResetConfig | null> | null = null

function errText(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).split('\n')[0]?.slice(0, 160) ?? 'unknown error'
}

/** The status line record folder (see sidecar.ts statuslineDir); null without a home folder. */
async function statuslineDirOf($: EngineInterface): Promise<string | null> {
  return statuslineDir({
    override: await $.env.get('PACE_STATUSLINE_DIR'),
    home: (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')),
  })
}

/** free-reset.local.json beside plugin.json, parsed; a missing file is no promo, silently. */
function freeResetOf($: EngineInterface): Promise<FreeResetConfig | null> {
  freeReset ??= (async () => {
    let text: string
    try {
      text = String(await $.fs.read(`${$.plugin.root}/${FREE_RESET_FILE}`))
    } catch {
      return null
    }
    const cfg = parseFreeReset(text)
    if (!cfg) $.ui.log(`pace: ${FREE_RESET_FILE} is not a valid promo config; no free-reset row, toast or tracking`)
    return cfg
  })()
  return freeReset
}

async function newestStatusline($: EngineInterface, after: number): Promise<{ reading: PaceReading | null; note: string | null }> {
  const dir = await statuslineDirOf($)
  if (dir === null) return { reading: null, note: 'status line folder unknown (USERPROFILE and HOME are unset; set PACE_STATUSLINE_DIR)' }
  let entries
  try {
    entries = await $.fs.list(dir)
  } catch (err) {
    return { reading: null, note: `status line folder unreadable (${dir}: ${errText(err)})` }
  }
  const files = entries
    .filter(f => f.kind === 'file' && f.name.endsWith('.json'))
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, 3)
  if (files.length === 0) return { reading: null, note: `no status line records in ${dir}` }
  if (files[0] && files[0].mtimeMs <= after) return { reading: null, note: null }
  const problems: string[] = []
  for (const f of files) {
    try {
      const text = await $.fs.read(`${dir}/${f.name}`)
      const r = readingFromStatusline(String(text), f.name)
      if (r) return { reading: r, note: null }
      problems.push(`${f.name.slice(0, 8)}… has no rate_limits`)
    } catch (err) {
      problems.push(`${f.name.slice(0, 8)}…: ${errText(err)}`)
    }
  }
  return { reading: null, note: `newest status line records unusable (${problems.join('; ')})` }
}

async function gather($: EngineInterface): Promise<PaceSnapshot> {
  const now = await $.clock.now()
  const reasons: string[] = []
  let costUsd: number | null = null
  let own: PaceReading | null = null
  try {
    const u = await $.session.usage()
    costUsd = u.cost?.usd ?? null
    const sig = JSON.stringify(u.rateLimits)
    if (!native || native.sig !== sig) native = { sig, at: now }
    own = readingFromSession(u.rateLimits, native.at)
    if (!own) reasons.push('this session has no rate-limit reading yet (none before its first API response, none on API-key billing)')
  } catch (err) {
    reasons.push(`session usage unavailable: ${errText(err)}`)
  }
  const file = await newestStatusline($, own?.observedAt ?? 0)
  if (file.note) reasons.push(file.note)
  const reading = freshest(own, file.reading)
  return { now, reading, reason: reading ? null : reasons.join('; '), costUsd }
}

async function toastDue($: EngineInterface, snap: PaceSnapshot): Promise<void> {
  const fired = ((await $.store.get(FIRED_KEY)) as string[] | undefined) ?? []
  const due = toastsDue(paceView(snap), snap.reading, fired, await freeResetOf($))
  if (due.length === 0) return
  for (const d of due) $.ui.toast(d.text, { timeoutMs: 10_000 })
  await $.store.set(FIRED_KEY, pruneFired([...fired, ...due.map(d => d.key)], snap.reading?.fiveHour?.resetsAt))
}

async function refreshOnce($: EngineInterface): Promise<void> {
  let snap: PaceSnapshot
  try {
    snap = await gather($)
  } catch (err) {
    snap = { now: await $.clock.now(), reading: null, reason: `refresh failed: ${errText(err)}`, costUsd: null }
  }
  // No promo config: no free-reset state is read or kept.
  const fr = await freeResetOf($)
  if (fr) {
    try {
      const prev = ((await $.store.get(FREE_RESET_KEY)) as FreeResetState | undefined) ?? { usedAt: null, last: null }
      const next = trackFreeReset(prev, snap.reading, snap.now, fr)
      if (next !== prev) await $.store.set(FREE_RESET_KEY, next)
      snap = { ...snap, freeResetUsedAt: next.usedAt }
    } catch (err) {
      $.ui.log(`pace: free reset bookkeeping failed: ${errText(err)}`)
    }
  }
  await update($, snapshotAtom, () => snap)
  try {
    await toastDue($, snap)
  } catch (err) {
    $.ui.log(`pace: toast bookkeeping failed: ${errText(err)}`)
  }
}

function refresh($: EngineInterface): Promise<void> {
  if (refreshing) return refreshing
  refreshing = refreshOnce($).finally(() => {
    refreshing = null
  })
  return refreshing
}

/** Starts the command and the minute tick once per load, from whichever event comes first. */
async function ensureStarted($: EngineInterface): Promise<void> {
  if (started) return
  started = true
  try {
    await $.command.register({
      name: 'pace',
      description: 'Rate-limit pace: 5H and weekly use, burn rate, projection, next round size',
      immediate: true,
    })
  } catch (err) {
    $.ui.toast(`pace: /pace could not be registered (${errText(err)})`, { timeoutMs: 10_000 })
  }
  try {
    await $.tool.register({ name: TOOL_NAME, description: TOOL_DESCRIPTION, inputSchema: { type: 'object', properties: {} } })
  } catch (err) {
    $.ui.toast(`pace: the Pace tool could not be registered (${errText(err)})`, { timeoutMs: 10_000 })
  }
  await refresh($)
  $.clock.every(REFRESH_MS, () => {
    void refresh($)
  })
}

/** Set from session.start: an interactive terminal session (bin/statusline.js writes its record). */
let sidecarTerminal: boolean | null = null
let sidecarWriting: Promise<void> | null = null
/** Set once the missing folder has been logged, so the log says it once per load. */
let sidecarMissingLogged = false

async function sidecarWriteOnce($: EngineInterface, f: SidecarFigures): Promise<void> {
  if (sidecarTerminal === true) return
  if (f.rateLimits.length === 0 && !f.cost) return
  const id = await $.session.id()
  if (!id) return
  // Only into a folder that already exists: $.fs.write would create it, and a
  // machine without mission-control should not grow one.
  const dir = await statuslineDirOf($)
  if (dir === null || !(await $.fs.exists(dir))) {
    if (!sidecarMissingLogged) $.ui.log(`pace sidecar: no status line folder (${dir ?? 'USERPROFILE and HOME are unset'}); no mission-control record written`)
    sidecarMissingLogged = true
    return
  }
  const path = `${dir}/${id}.json`
  let prev: Record<string, unknown> | null = null
  try {
    prev = parseRecord(String(await $.fs.read(path)))
  } catch {
    prev = null // no record yet: start one
  }
  let model: string | null = null
  try {
    model = await $.session.model()
  } catch {
    model = null
  }
  await $.fs.write(path, JSON.stringify(sidecarRecord(prev, id, model, f, await $.clock.now())))
}

/** Writes this session's mission-control record; logs, never throws. */
function sidecarWrite($: EngineInterface, f: SidecarFigures): Promise<void> {
  if (sidecarWriting) return sidecarWriting
  sidecarWriting = sidecarWriteOnce($, f)
    .catch(err => {
      $.ui.log(`pace sidecar: could not write the mission-control record: ${errText(err)}`)
    })
    .finally(() => {
      sidecarWriting = null
    })
  return sidecarWriting
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const r = await next(e)
    // Mission-control record for sessions the statusLine hook never runs in (SDK / Helm).
    sidecarTerminal = e.isInteractive === true && e.surface === 'terminal'
    try {
      const u = await $.session.usage()
      await sidecarWrite($, { rateLimits: u.rateLimits, cost: u.cost, context: u.context })
    } catch (err) {
      $.ui.log(`pace sidecar: usage unavailable at start: ${errText(err)}`)
    }
    await ensureStarted($)
    return r
  })

  on('session.measure', async ($, e, next) => {
    const r = await next(e)
    await sidecarWrite($, { rateLimits: e.rateLimits, cost: e.cost, context: e.context })
    native = { sig: JSON.stringify(e.rateLimits), at: await $.clock.now() }
    if (started) await refresh($)
    else await ensureStarted($)
    return r
  })

  on('prompt.submit', async ($, e, next) => {
    await ensureStarted($)
    return next(e)
  })

  on('command.run', { command: 'pace' }, async $ => {
    await ensureStarted($)
    await refresh($)
    const snap = await read($, snapshotAtom)
    if (!snap) return { text: 'pace: no snapshot yet — the first refresh did not finish' }
    return { text: commandText(paceView(snap), await freeResetOf($)) }
  })

  on('tool.call', { tool: TOOL_FULL_NAME }, async $ => {
    await ensureStarted($)
    await refresh($)
    const snap = await read($, snapshotAtom)
    if (!snap) return { result: 'Pace: no snapshot yet; the first refresh did not finish. Size the round conservatively.' }
    return { result: toolText(paceView(snap), await freeResetOf($)) }
  })

  // Static text only: a changing session section would re-cache the whole conversation.
  on('prompt.compose', async ($, e, next) => {
    const r = await next(e)
    await ensureStarted($)
    return { ...r, sections: [...r.sections, { id: 'pace:pace', text: promptSection((await readUser($)).name), scope: 'session' as const }] }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    if (e.props.hasSurvey) return below
    const snap = await read($, snapshotAtom)
    const segs: BandSegment[] = snap
      ? bandSegments(paceView(snap))
      : [{ text: '5H pace: waiting for the first reading — it arrives after the next turn, or run /pace', tone: 'dim' }]
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        {below}
        <Box key="pace" flexDirection="row">
          {segs.map((s, i) => (
            <Text key={`s${i}`} {...TONE[s.tone]} wrap="truncate-end">
              {s.text}
            </Text>
          ))}
        </Box>
      </Box>
    )
  })
}
