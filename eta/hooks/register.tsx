// eta: how much longer this session's work will take, live above the prompt,
// so the user never has to ask. Three sources: the estimate the model declares
// through the Eta tool, the running subagents' usual durations (learned in
// $.store), and calibration of declared against actual. /eta opens a pane
// with the detail and every session on this machine (snapshot files).
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { EtaAgent, EtaCalSample, EtaHistoryRecord, EtaLive, EtaSessions } from '../types'
import {
  afterPrompt,
  afterToolResult,
  applyEta,
  etaDir,
  historyFileOf,
  HISTORY_KEEP,
  parseHistory,
  RE_KEEP,
  reSamples,
  judgeRun,
  bandSegments,
  CAL_KEEP,
  classifySessions,
  commandText,
  emptyLive,
  endWork,
  etaView,
  historyKey,
  isRunningStatus,
  isWorkOver,
  isWriteDue,
  LATE_TOAST_MS,
  laneOf,
  MIN,
  NO_DIR,
  paneLines,
  parseSnapshot,
  promptLine,
  sigOf,
  snapshotOf,
  startTurn,
  toolDescription,
  TOOL_FULL_NAME,
  TOOL_NAME,
  TOOL_SCHEMA,
  withDuration,
} from './core'
import type { EtaInput, RunVerdict, SnapshotFile, Tone } from './core'
import { readUser } from './user'

const TICK_MS = 20_000
const PANE = 'eta'
const TOAST_MS = 10_000
/** The pane's session list is re-read on ticks for this long after /eta. */
const PANE_LIVE_MS = 30 * MIN
/** Only snapshot files touched this recently are read; older ones are stale by the rules anyway. */
const READ_WITHIN_MS = 60 * MIN
const KEEP_FINISHED = 20

const liveAtom = atom({ plugin: 'eta', key: 'live' } as const, null)
const sessionsAtom = atom({ plugin: 'eta', key: 'sessions' } as const, null)

const TONE: Record<Tone, { color?: string; dimColor?: boolean; bold?: boolean }> = {
  accent: { color: '#8a9bb0' },
  dim: { dimColor: true },
  normal: {},
  warn: { color: '#c9a25a' },
}

/** Prunes snapshot files older than a week and reports the machine's UTC offset. */
const PROBE_SCRIPT = `
const fs = require('fs'), path = require('path')
const dir = process.env.ETA_DIR, cutoff = Date.now() - 7 * 864e5
let pruned = 0; const errs = []
try {
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json')) continue
    const p = path.join(dir, f)
    try { if (fs.statSync(p).mtimeMs < cutoff) { fs.unlinkSync(p); pruned++ } } catch (e) { errs.push(f + ': ' + e.message) }
  }
} catch (e) { if (e.code !== 'ENOENT') errs.push(e.message) }
process.stdout.write(JSON.stringify({ tz: -new Date().getTimezoneOffset(), pruned, errs }))
`

// Module state: a reload runs the module afresh, which is what these want.
let started: Promise<void> | null = null
let refreshing: Promise<void> | null = null
let paneOpenedAt = -Infinity
let lastWrite: { sig: string; at: number } | null = null
/** eta's data folder, resolved once per load from the environment (null: no home folder). */
let dataDir: Promise<string | null> | null = null

const noop = () => {}

/** Snapshots and the history live here: see core.ts etaDir. */
function dirOf($: EngineInterface): Promise<string | null> {
  dataDir ??= (async () =>
    etaDir({
      configDir: await $.env.get('CLAUDE_CONFIG_DIR'),
      home: (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')),
    }))().catch(() => {
    dataDir = null // not remembered: the next call asks again
    return null
  })
  return dataDir
}

function why(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).split('\n')[0]?.slice(0, 160) ?? 'unknown error'
}

async function getLive($: EngineInterface): Promise<EtaLive> {
  return (await read($, liveAtom)) ?? emptyLive()
}

async function commit($: EngineInterface, fn: (cur: EtaLive) => EtaLive): Promise<EtaLive> {
  let out: EtaLive = emptyLive()
  await update($, liveAtom, cur => {
    out = fn(cur ?? emptyLive())
    return out
  })
  return out
}

const problem = (live: EtaLive, key: string, text: string | null): EtaLive => {
  if (text === null) {
    if (!(key in live.problems)) return live
    const { [key]: _gone, ...rest } = live.problems
    return { ...live, problems: rest }
  }
  return live.problems[key] === text ? live : { ...live, problems: { ...live.problems, [key]: text } }
}

// ---------- learned data ($.store) ----------

async function loadLearned($: EngineInterface): Promise<void> {
  try {
    const durations = ((await $.store.get('durations')) ?? {}) as Record<string, number[]>
    const cal = ((await $.store.get('calibration')) ?? []) as EtaCalSample[]
    const fixCycles = ((await $.store.get('fixCycles')) ?? []) as number[]
    await commit($, l => problem({ ...l, learned: { ...l.learned, durations, calibration: cal, fixCycles } }, 'store', null))
  } catch (err) {
    await commit($, l => problem(l, 'store', `learned history unreadable (${why(err)}); using priors only`))
  }
}

// ---------- the finished-task history (history.jsonl) ----------

/** Appends stdin to $ETA_HISTORY: one O_APPEND write, so sessions finishing together never lose a line. */
const APPEND_SCRIPT = `
const fs = require('fs'), path = require('path')
const p = process.env.ETA_HISTORY
let s = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', d => { s += d })
process.stdin.on('end', () => {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.appendFileSync(p, s.endsWith('\\n') ? s : s + '\\n')
  process.stdout.write('ok')
})
`

/** Past re-estimates from the history: the re-estimate range. A missing file is no history yet. */
async function loadHistory($: EngineInterface): Promise<void> {
  const dir = await dirOf($)
  if (dir === null) return
  const historyFile = historyFileOf(dir)
  try {
    if (!(await $.fs.exists(historyFile))) return
    const { records } = parseHistory(String(await $.fs.read(historyFile)))
    const re = [...records].sort((a, b) => a.finishedAt - b.finishedAt).flatMap(reSamples).slice(-RE_KEEP)
    await commit($, l => problem({ ...l, learned: { ...l.learned, reSamples: re } }, 'history', null))
  } catch (err) {
    await commit($, l => problem(l, 'history', `history unreadable (${why(err)}); re-estimates shown without a range`))
  }
}

async function recordHistory($: EngineInterface, record: EtaHistoryRecord | null): Promise<void> {
  if (!record) return
  const line = JSON.stringify(record) + '\n'
  const dir = await dirOf($)
  if (dir === null) {
    await commit($, l => problem(l, 'history', `a finished task was not written to the history (${NO_DIR})`))
    return
  }
  const historyFile = historyFileOf(dir)
  try {
    const r = await $.process.run(['node', '-e', APPEND_SCRIPT], { stdin: line, env: { ETA_HISTORY: historyFile }, timeoutMs: 15_000 })
    if (r.exitCode !== 0 || r.stdout.trim() !== 'ok') throw new Error(`node exited ${r.exitCode}: ${r.stderr.trim().split('\n').pop() ?? ''}`)
  } catch (err) {
    // No node: read and rewrite (a line another session appends meanwhile can be lost, so say so if this fails too).
    try {
      const cur = (await $.fs.exists(historyFile)) ? String(await $.fs.read(historyFile)) : ''
      await $.fs.write(historyFile, cur + (cur && !cur.endsWith('\n') ? '\n' : '') + line)
    } catch (err2) {
      await commit($, l => problem(l, 'history', `a finished task was not written to the history (${why(err)}; then ${why(err2)})`))
      return
    }
  }
  const more = reSamples(record)
  await commit($, l => problem({ ...l, learned: { ...l.learned, reSamples: [...(l.learned.reSamples ?? []), ...more].slice(-RE_KEEP) } }, 'history', null))
}

async function recordDuration($: EngineInterface, key: string, seconds: number): Promise<void> {
  try {
    const cur = ((await $.store.get('durations')) ?? {}) as Record<string, number[]>
    const next = withDuration(cur, key, seconds)
    await $.store.set('durations', next)
    await commit($, l => problem({ ...l, learned: { ...l.learned, durations: next } }, 'store', null))
  } catch (err) {
    await commit($, l => problem(l, 'store', `could not save an agent duration (${why(err)})`))
  }
}

async function recordSample($: EngineInterface, sample: EtaCalSample | null): Promise<void> {
  if (!sample) return
  try {
    const cur = ((await $.store.get('calibration')) ?? []) as EtaCalSample[]
    const next = [...cur, sample].slice(-CAL_KEEP)
    await $.store.set('calibration', next)
    await commit($, l => problem({ ...l, learned: { ...l.learned, calibration: next } }, 'store', null))
  } catch (err) {
    await commit($, l => problem(l, 'store', `could not save a calibration sample (${why(err)})`))
  }
}

async function recordFixCycle($: EngineInterface, seconds: number | null): Promise<void> {
  if (seconds === null) return
  try {
    const cur = ((await $.store.get('fixCycles')) ?? []) as number[]
    const next = [...cur, seconds].slice(-HISTORY_KEEP)
    await $.store.set('fixCycles', next)
    await commit($, l => problem({ ...l, learned: { ...l.learned, fixCycles: next } }, 'store', null))
  } catch (err) {
    await commit($, l => problem(l, 'store', `could not save a fix cycle (${why(err)})`))
  }
}

/** A finished, foreground Bash/PowerShell call judged as a test/build run, else null. */
function verdictOf(e: { tool: unknown; command?: unknown; run_in_background?: unknown }, r: { result?: unknown; text?: string; isError?: true }): RunVerdict {
  const tool = String(e.tool)
  if (tool !== 'Bash' && tool !== 'PowerShell') return null
  if (typeof e.command !== 'string' || e.run_in_background === true) return null
  const rec = r.result as { backgroundTaskId?: unknown; interrupted?: unknown } | null | undefined
  if (rec && typeof rec === 'object' && (rec.backgroundTaskId || rec.interrupted === true)) return null
  const text = typeof r.text === 'string' ? r.text : typeof r.result === 'string' ? r.result : ''
  return judgeRun(e.command, text, r.isError === true)
}

/** The user's own messages (terminal, phone, an SDK host), not notifications or the engine's own. */
const HUMAN_ORIGINS = new Set(['composer', 'bridge', 'sdk', 'unclassified', 'channel', 'slack-ping'])

// ---------- snapshots (shared folder) ----------

/** A session's snapshot file in the data folder. */
const snapPath = (dir: string, sessionId: string) => `${dir}/${sessionId}.json`

async function writeSnapshot($: EngineInterface, force: 'ended' | null = null): Promise<void> {
  const live = await getLive($)
  const now = await $.clock.now()
  const snap = snapshotOf(live, now)
  if (!snap) return
  if (force) snap.state = force
  if (!force && !isWriteDue(snap, lastWrite)) return
  const dir = await dirOf($)
  try {
    if (dir === null) throw new Error(NO_DIR)
    await $.fs.write(snapPath(dir, snap.sessionId), JSON.stringify(snap))
    lastWrite = { sig: sigOf(snap), at: now }
    if (live.problems.snapshot) await commit($, l => problem(l, 'snapshot', null))
  } catch (err) {
    await commit($, l => problem(l, 'snapshot', `not written (${why(err).replace(/^eta: /, '')}); other sessions cannot see this one`))
  }
}

async function readSessions($: EngineInterface): Promise<EtaSessions> {
  const now = await $.clock.now()
  const live = await getLive($)
  const own = snapshotOf(live, now)
  const files: SnapshotFile[] = []
  let listError: string | null = null
  let skipped = 0
  const dir = await dirOf($)
  try {
    if (dir === null) throw new Error(NO_DIR)
    const entries = await $.fs.list(dir)
    for (const f of entries) {
      if (f.kind !== 'file' || !f.name.endsWith('.json')) continue
      if (own && f.name === `${own.sessionId}.json`) continue
      if (now - f.mtimeMs > READ_WITHIN_MS) {
        skipped += 1
        continue
      }
      try {
        const parsed = parseSnapshot(String(await $.fs.read(`${dir}/${f.name}`)))
        files.push(typeof parsed === 'string' ? { name: f.name, mtimeMs: f.mtimeMs, snap: null, error: parsed } : { name: f.name, mtimeMs: f.mtimeMs, snap: parsed, error: null })
      } catch (err) {
        files.push({ name: f.name, mtimeMs: f.mtimeMs, snap: null, error: why(err) })
      }
    }
  } catch (err) {
    listError = `cannot list ${dir ?? 'the snapshot folder'} (${why(err)})`
  }
  const out = classifySessions(files, own?.sessionId ?? null, now, own)
  out.hidden.idle += skipped
  if (listError) out.errors.unshift(listError)
  return out
}

async function refreshSessions($: EngineInterface): Promise<void> {
  const s = await readSessions($)
  await update($, sessionsAtom, () => s)
}

// ---------- agents ----------

async function mergeAgents($: EngineInterface): Promise<void> {
  const now = await $.clock.now()
  let list
  try {
    list = await $.agent.list()
  } catch (err) {
    await commit($, l => problem(l, 'agents', `agent list unavailable (${why(err)}); counting agents from spawns only`))
    return
  }
  const finished: { key: string; seconds: number }[] = []
  await commit($, l => {
    const agents: Record<string, EtaAgent> = { ...l.agents }
    let anyEnded = false
    let changed = false
    for (const info of list) {
      const cur = agents[info.id]
      const isRunning = isRunningStatus(info.status)
      if (!cur) {
        if (isRunning) {
          agents[info.id] = { id: info.id, type: info.type, label: info.description || info.id, startedAt: now, isExactStart: false, kind: 'run', status: info.status, endedAt: null }
          changed = true
        }
        continue
      }
      const wasRunning = isRunningStatus(cur.status)
      if (wasRunning && !isRunning) {
        agents[info.id] = { ...cur, status: info.status, endedAt: now }
        anyEnded = true
        changed = true
        const canLearn = info.status === 'completed' && (cur.isExactStart || cur.kind === 'resume')
        if (canLearn) finished.push({ key: historyKey(cur), seconds: (now - cur.startedAt) / 1000 })
      } else if (!wasRunning && isRunning) {
        // Finished before and running again: a resume (SendMessage); its start is this sighting.
        agents[info.id] = { ...cur, status: info.status, startedAt: now, isExactStart: false, kind: 'resume', endedAt: null }
        changed = true
      } else if (cur.status !== info.status) {
        agents[info.id] = { ...cur, status: info.status }
        changed = true
      }
    }
    // Bound the record: running ones and the most recent finished.
    const done = Object.values(agents)
      .filter(a => !isRunningStatus(a.status))
      .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))
    for (const a of done.slice(KEEP_FINISHED)) {
      delete agents[a.id]
      changed = true
    }
    if (!changed) return problem(l, 'agents', null)
    const work = l.work && anyEnded ? { ...l.work, lastActiveAt: now } : l.work
    return problem({ ...l, agents, work }, 'agents', null)
  })
  for (const f of finished) await recordDuration($, f.key, f.seconds)
}

// ---------- the work's end ----------

async function maybeEndWork($: EngineInterface, isTurnEnd: boolean): Promise<void> {
  const now = await $.clock.now()
  let ending: ReturnType<typeof endWork> | null = null
  let ended: EtaLive | null = null
  await commit($, l => {
    if (!isWorkOver(l, now, isTurnEnd)) return l
    ended = l
    ending = endWork(l, l.work?.lastActiveAt ?? now)
    return ending.live
  })
  const e = ending as ReturnType<typeof endWork> | null
  if (!e) return
  const endedAt = (ended as EtaLive | null)?.work?.lastActiveAt ?? now
  if (e.toast && now - endedAt <= LATE_TOAST_MS) $.ui.toast(e.toast, { timeoutMs: TOAST_MS })
  await recordSample($, e.sample)
  await recordHistory($, e.record)
  await writeSnapshot($)
}

// ---------- the tick ----------

async function refreshOnce($: EngineInterface): Promise<void> {
  await mergeAgents($)
  await maybeEndWork($, false)
  const now = await $.clock.now()
  await commit($, l => {
    const v = etaView(l, now)
    let work = l.work
    if (work && work.firstEstimateMs === null && v.finishAt !== null) work = { ...work, firstEstimateMs: v.finishAt - work.startedAt }
    // Bump the tick while there is something to count down, so the band redraws.
    return v.isVisible || work !== l.work ? { ...l, work, tick: l.tick + 1 } : l
  })
  await writeSnapshot($)
  if (now - paneOpenedAt < PANE_LIVE_MS) await refreshSessions($)
}

function refresh($: EngineInterface): Promise<void> {
  if (refreshing) return refreshing
  refreshing = refreshOnce($)
    .then(() => commit($, l => problem(l, 'refresh', null)))
    .then(noop)
    .catch(async err => {
      $.ui.log(`eta: refresh failed: ${why(err)}`)
      await commit($, l => problem(l, 'refresh', `refresh failed (${why(err)}); figures may be stale`)).catch(noop)
    })
    .finally(() => {
      refreshing = null
    })
  return refreshing
}

async function probe($: EngineInterface): Promise<void> {
  const fallback = () => -new Date(Date.now()).getTimezoneOffset()
  try {
    const r = await $.process.run(['node', '-'], { stdin: PROBE_SCRIPT, env: { ETA_DIR: (await dirOf($)) ?? '' }, timeoutMs: 15_000 })
    if (r.exitCode !== 0) throw new Error(`node exited ${r.exitCode}: ${r.stderr.trim().split('\n').pop() ?? ''}`)
    const out = JSON.parse(r.stdout) as { tz: number; pruned: number; errs: string[] }
    await commit($, l => problem({ ...l, tzOffsetMin: out.tz, tzSource: 'node' }, 'prune', out.errs.length ? `old snapshots not pruned: ${out.errs.slice(0, 2).join('; ')}` : null))
  } catch (err) {
    await commit($, l => ({ ...l, tzOffsetMin: fallback(), tzSource: `the hook environment's timezone (node probe failed: ${why(err)})` }))
  }
}

async function startOnce($: EngineInterface): Promise<void> {
  try {
    await $.command.register({ name: 'eta', description: 'How much longer: this session in detail, calibration, and every session on this machine', immediate: true })
  } catch (err) {
    $.ui.toast(`eta: /eta could not be registered (${why(err)})`, { timeoutMs: TOAST_MS })
  }
  try {
    await $.tool.register({ name: TOOL_NAME, description: toolDescription((await readUser($)).name), inputSchema: TOOL_SCHEMA })
  } catch (err) {
    $.ui.toast(`eta: the Eta tool could not be registered (${why(err)}); only agent-based estimates will show`, { timeoutMs: TOAST_MS })
  }
  try {
    const cwd = (await $.session.cwd()).split('\\').join('/')
    const sessionId = await $.session.id()
    const project = cwd.replace(/\/+$/, '').split('/').pop() || cwd
    await commit($, l => problem({ ...l, self: { sessionId, project, cwd } }, 'session', null))
  } catch (err) {
    await commit($, l => problem(l, 'session', `session id or folder unavailable (${why(err)}); no snapshot is written`))
  }
  await loadLearned($)
  void loadHistory($).catch(noop)
  void probe($).catch(noop)
  await refresh($)
  $.clock.every(TICK_MS, () => void refresh($))
}

function ensureStarted($: EngineInterface): Promise<void> {
  started ??= startOnce($)
  return started
}

// ---------- hooks ----------

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const r = await next(e)
    await ensureStarted($)
    return r
  })

  on('session.end', async ($, e, next) => {
    await writeSnapshot($, 'ended').catch(noop)
    return next(e)
  })

  // Static text only: a section that varies re-caches the whole conversation.
  on('prompt.compose', async ($, e, next) => {
    const r = await next(e)
    void ensureStarted($)
    return { ...r, sections: [...r.sections, { id: 'eta:eta', text: promptLine((await readUser($)).name), scope: 'session' as const }] }
  })

  on('turn.start', async ($, e, next) => {
    const r = await next(e)
    await ensureStarted($)
    const now = await $.clock.now()
    await commit($, l => startTurn(l, now, e.text))
    void writeSnapshot($).catch(noop)
    return r
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId) {
      // A subagent's run ended: its status flips shortly after.
      $.clock.after(1500, () => void refresh($))
      return r
    }
    const now = await $.clock.now()
    await commit($, l => (l.work ? { ...l, work: { ...l.work, isTurnRunning: false, lastActiveAt: now, wasAborted: e.isAborted } } : l))
    // Stop's background-task count may land just after: decide a moment later.
    $.clock.after(3000, () => void maybeEndWork($, true).catch(noop))
    return r
  })

  // Background tasks still running when the model stopped: the work is not over.
  on('classic.Stop', async ($, e, next) => {
    const r = await next(e)
    // Agents are tracked on their own; this counts shells, monitors, workflows.
    const n = (e.background_tasks ?? []).filter(t => t.type !== 'subagent' && t.type !== 'teammate').length
    await commit($, l => (l.work && l.work.backgroundTasks !== n ? { ...l, work: { ...l.work, backgroundTasks: n } } : l)).catch(noop)
    return r
  })

  on('agent.spawn', async ($, e, next) => {
    const r = await next(e)
    const id = r.agentId
    if (!id) return r
    const now = await $.clock.now()
    await commit($, l => {
      const agent: EtaAgent = {
        id,
        type: e.subagentType,
        label: laneOf(e.prompt) ?? (e.description || id),
        startedAt: now,
        isExactStart: true,
        kind: 'run',
        status: 'running',
        endedAt: null,
      }
      const seq = l.work ? l.seq : l.seq + 1
      const base = l.work ?? { id: seq, startedAt: now, isTurnRunning: false, lastActiveAt: now, backgroundTasks: 0, firstEstimateMs: null, isDone: false, isToasted: false }
      // An agent launched after done:true: the work is not over after all.
      const work = base.isDone ? { ...base, isDone: false } : base
      return { ...l, seq, work, agents: { ...l.agents, [id]: agent } }
    })
    void writeSnapshot($).catch(noop)
    return r
  })

  // The Eta tool, and the overdue nudge on the next main-loop tool result.
  on('tool.call', async ($, e, next) => {
    if (String(e.tool) === TOOL_FULL_NAME) {
      if (e.agentId) return { result: 'Eta tracks the main session only; subagents are timed automatically from their type. No need to call it.' }
      await ensureStarted($)
      const now = await $.clock.now()
      const { name } = await readUser($)
      let out: ReturnType<typeof applyEta> | null = null
      await commit($, l => {
        out = applyEta(l, e as unknown as EtaInput, now, name)
        return out.live
      })
      const o = out as ReturnType<typeof applyEta> | null
      if (!o) return { result: 'Eta: not recorded (state unavailable).' }
      if (o.toast) $.ui.toast(o.toast, { timeoutMs: TOAST_MS })
      await recordSample($, o.sample)
      await recordHistory($, o.record)
      await writeSnapshot($)
      return { result: o.reply }
    }
    const r = await next(e)
    if (e.agentId || r.deny !== undefined) return r
    try {
      const now = await $.clock.now()
      const verdict = verdictOf(e as never, r)
      let out: ReturnType<typeof afterToolResult> | null = null
      const before = await getLive($)
      await commit($, l => {
        out = afterToolResult(l, verdict, now)
        return out.live
      })
      const o = out as ReturnType<typeof afterToolResult> | null
      if (!o) return r
      await recordFixCycle($, o.fixSampleSec)
      if (o.live.bump !== (before.bump ?? null)) await writeSnapshot($)
      if (o.note === null) return r
      return { ...r, context: [...(r.context ?? []), o.note] }
    } catch (err) {
      // Never break a tool call over the countdown.
      await commit($, l => problem(l, 'runs', `tool result not read (${why(err)})`)).catch(noop)
      return r
    }
  })

  // The user adds a message while an ETA runs: ask the model to re-estimate with it in view.
  on('prompt.submit', async ($, e, next) => {
    const kind = (e.origin as { kind?: string } | undefined)?.kind
    if (!kind || !HUMAN_ORIGINS.has(kind)) return next(e)
    let note: string | null = null
    try {
      const now = await $.clock.now()
      const { name } = await readUser($)
      await commit($, l => {
        const o = afterPrompt(l, now, name)
        note = o.note
        return o.live
      })
    } catch {
      return next(e)
    }
    if (note === null) return next(e)
    return next({ ...e, context: [...(e.context ?? []), note] })
  })

  on('command.run', { command: 'eta' }, async $ => {
    await ensureStarted($)
    paneOpenedAt = await $.clock.now()
    await refresh($)
    await refreshSessions($)
    let opened = ''
    try {
      await $.ui.open({ id: PANE, title: 'ETA' })
    } catch (err) {
      opened = `\n(the pane could not open: ${why(err)})`
    }
    return { text: commandText(await getLive($), await $.clock.now(), await dirOf($)) + opened }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    if (e.props.hasSurvey) return below
    const live = await getLive($)
    const now = await $.clock.now()
    const segs = bandSegments(etaView(live, now), now, live.tzOffsetMin ?? 0)
    if (segs.length === 0) return below
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        {below}
        <Box key="eta" flexDirection="row" width={e.props.bodyColumns}>
          {segs.map((s, i) => (
            <Text key={`eta${i}`} {...TONE[s.tone]} wrap="truncate-end">
              {s.text}
            </Text>
          ))}
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const live = await getLive($)
    const sessions = await read($, sessionsAtom)
    const now = await $.clock.now()
    const lines = paneLines(live, sessions, now, await dirOf($))
    return (
      <Box flexDirection="column">
        {lines.map((l, i) => (
          <Text key={`l${i}`} {...TONE[l.tone]} bold={l.tone === 'accent'} wrap="wrap">
            {l.text}
          </Text>
        ))}
      </Box>
    )
  })
}

