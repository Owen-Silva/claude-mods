// Backfills eta's finished-task history (history.jsonl) from what already exists:
//   1. the main-session Eta tool calls in Claude Code transcripts (numbers and times only:
//      minutes, done, the reply's "set"/"updated"; never prompt text, notes or steps), and
//   2. the calibration samples in eta's $.store file (the last CAL_KEEP finished estimates).
// A plan that ended by the work going idle (no done:true) has its end only in the store; a
// plan with neither a done call nor a store sample is dropped and counted.
// Live records already in the file are kept as they are; backfilled ones that match a live
// one are skipped. The factor of a backfilled record is replayed under today's calibration
// rules (factorSrc 'replayed'), since the factor shown at the time was never written down.
//
//   node tools/backfill-history.ts [--out <history.jsonl>] [--store <eta store json>] [--dry]
import * as fs from 'node:fs'
import * as path from 'node:path'

import { CAL_KEEP, calibration, etaDir, historyFileOf, historyId, parseHistory, shortSession } from '../hooks/core.ts'
import type { EtaHistoryRecord } from '../hooks/core.ts'

const MIN = 60_000
const args = process.argv.slice(2)
const opt = (name: string, dflt: string) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] ? args[i + 1] as string : dflt
}
const HOME = process.env.USERPROFILE || process.env.HOME || ''
const DIR = etaDir({ configDir: process.env.CLAUDE_CONFIG_DIR, home: HOME })
const OUT = opt('--out', DIR === null ? '' : historyFileOf(DIR))
const STORE_DIR = path.join(HOME, '.claude', 'plugins', 'store')
const STORE = opt('--store', fs.readdirSync(STORE_DIR).filter(f => /^eta_.*\.json$/.test(f)).map(f => path.join(STORE_DIR, f))[0] ?? '')
const DRY = args.includes('--dry')

type Call = { session: string; cwd: string; at: number; minutes: number | null; done: boolean; kind: 'set' | 'update' | 'ignored' | 'unknown'; recorded: boolean }

function scanTranscripts(): Call[] {
  const root = path.join(HOME, '.claude', 'projects')
  const files: string[] = []
  const walk = (d: string) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, ent.name)
      if (ent.isDirectory()) { if (ent.name !== 'subagents' && ent.name !== 'memory') walk(p) }
      else if (ent.name.endsWith('.jsonl')) files.push(p)
    }
  }
  walk(root)
  const calls: Call[] = []
  for (const f of files) {
    if (fs.statSync(f).mtimeMs < Date.parse('2026-10-01')) continue
    const text = fs.readFileSync(f, 'utf8')
    if (!text.includes('mcp__eta__Eta')) continue
    const byId = new Map<string, Call>()
    for (const line of text.split('\n')) {
      if (!line.includes('mcp__eta__Eta') && !line.includes('tool_result')) continue
      let j: any
      try { j = JSON.parse(line) } catch { continue }
      if (j.isSidechain) continue
      const content = j.message && Array.isArray(j.message.content) ? j.message.content : []
      for (const c of content) {
        if (c.type === 'tool_use' && c.name === 'mcp__eta__Eta') {
          const inp = c.input || {}
          const call: Call = { session: String(j.sessionId), cwd: String(j.cwd ?? ''), at: Date.parse(j.timestamp), minutes: typeof inp.minutes === 'number' && Number.isFinite(inp.minutes) ? inp.minutes : null, done: inp.done === true, kind: 'unknown', recorded: false }
          calls.push(call)
          byId.set(c.id, call)
        } else if (c.type === 'tool_result' && byId.has(c.tool_use_id)) {
          const call = byId.get(c.tool_use_id) as Call
          const t = (Array.isArray(c.content) ? c.content.map((x: any) => x.text || '').join('') : String(c.content || '')).trim()
          // The hook's own time is when the result came back; the tool_use time is the model's.
          call.at = Date.parse(j.timestamp) || call.at
          call.recorded = /Recorded for calibration/.test(t)
          call.kind = /^Eta set\./.test(t) ? 'set' : /^Eta updated\./.test(t) ? 'update' : /tracks the main session only|not recorded/.test(t) ? 'ignored' : call.kind
        }
      }
    }
  }
  return calls.filter(c => Number.isFinite(c.at)).sort((a, b) => a.at - b.at)
}

type Open = { session: string; project: string; startedAt: number; estimates: { at: number; min: number; f: number | null }[]; lastAt: number }
type Closed = Open & { finishedAt: number | null; end: 'done' | 'idle'; nextStartAt: number }

function reconstruct(calls: Call[]): Closed[] {
  const out: Closed[] = []
  const bySession = new Map<string, Call[]>()
  for (const c of calls) bySession.set(c.session, [...(bySession.get(c.session) ?? []), c])
  for (const [session, list] of bySession) {
    let open: Open | null = null
    const close = (finishedAt: number | null, end: 'done' | 'idle', nextStartAt: number) => {
      if (open && open.estimates.length > 0) out.push({ ...open, finishedAt, end, nextStartAt })
      open = null
    }
    for (const c of list) {
      if (c.kind === 'ignored') continue
      if (c.done) { close(c.at, 'done', Infinity); continue }
      if (c.kind === 'set' && open) close(null, 'idle', c.at)
      if (!open) open = { session, project: c.cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '', startedAt: c.at, estimates: [], lastAt: c.at }
      const o = open as Open
      if (c.minutes !== null) o.estimates.push({ at: c.at, min: Math.round(Math.min(Math.max(0, c.minutes), 24 * 60) * 10) / 10, f: null })
      o.lastAt = c.at
    }
    close(null, 'idle', Infinity)
  }
  return out
}

type Sample = { said: number; took: number; at: number }

function main() {
  const calls = scanTranscripts()
  const plans = reconstruct(calls)
  const store = STORE ? JSON.parse(fs.readFileSync(STORE, 'utf8')) as { calibration?: Sample[] } : {}
  const samples = (store.calibration ?? []).slice()
  const used = new Set<number>()
  const matchSample = (said: number, lo: number, hi: number, near: number | null) => {
    let best = -1
    let bestD = Infinity
    samples.forEach((s, i) => {
      if (used.has(i) || Math.abs(s.said - said) > 0.05 || s.at < lo || s.at > hi) return
      const d = near === null ? s.at - lo : Math.abs(s.at - near)
      if (d < bestD) { best = i; bestD = d }
    })
    if (best >= 0) used.add(best)
    return best >= 0 ? samples[best] as Sample : null
  }
  const recs: EtaHistoryRecord[] = []
  let dropped = 0
  for (const p of plans) {
    const first = p.estimates[0] as { at: number; min: number }
    let finishedAt = p.finishedAt
    if (p.end === 'done' && finishedAt !== null) matchSample(first.min, finishedAt - 2 * MIN, finishedAt + 2 * MIN, finishedAt)
    else {
      const s = matchSample(first.min, p.lastAt - 5000, Math.min(p.nextStartAt, p.lastAt + 2 * 24 * 60 * MIN), null)
      finishedAt = s ? s.at : null
    }
    if (finishedAt === null || first.min < 1) { dropped++; continue }
    recs.push({
      v: 1, id: historyId(p.session, first.at), session: shortSession(p.session), project: p.project || null,
      startedAt: p.startedAt, firstAt: first.at, finishedAt, first: first.min,
      estimates: p.estimates, took: Math.round(((finishedAt - first.at) / MIN) * 10) / 10,
      factor: null, factorSrc: 'replayed', end: p.end, src: 'transcript',
    })
  }
  // Store samples no transcript accounts for (their sessions' transcripts are gone).
  samples.forEach((s, i) => {
    if (used.has(i) || !(s.said >= 1)) return
    const firstAt = Math.round(s.at - s.took * MIN)
    recs.push({ v: 1, id: `store-${s.at}`, session: null, project: null, startedAt: firstAt, firstAt, finishedAt: s.at, first: s.said, estimates: [{ at: firstAt, min: s.said, f: null }], took: s.took, factor: null, factorSrc: 'replayed', end: 'idle', src: 'store' })
  })
  // Keep live records; drop backfilled ones they cover.
  const existing = fs.existsSync(OUT) ? parseHistory(fs.readFileSync(OUT, 'utf8')) : { records: [], bad: 0 }
  const live = existing.records.filter(r => r.src === 'live')
  const covered = (r: EtaHistoryRecord) => live.some(l => l.id === r.id || (Math.abs(l.first - r.first) < 0.05 && Math.abs(l.finishedAt - r.finishedAt) < 2 * MIN))
  const all = [...live, ...recs.filter(r => !covered(r))].sort((a, b) => a.finishedAt - b.finishedAt)
  // Replay the factor: the calibration in force at the first estimate, from what had finished by then.
  for (const r of all) {
    if (r.src === 'live') continue
    const prior = all.filter(x => x.finishedAt < r.firstAt).map(x => ({ said: x.first, took: x.took, at: x.finishedAt })).slice(-CAL_KEEP)
    const ratio = calibration(prior, r.first).ratio
    r.factor = ratio !== null && Math.abs(ratio - 1) >= 0.05 ? Math.round(ratio * 1000) / 1000 : null
    for (const e of r.estimates) e.f = r.factor
  }
  const counts = { calls: calls.length, plans: plans.length, transcript: recs.filter(r => r.src === 'transcript').length, storeOnly: recs.filter(r => r.src === 'store').length, live: live.length, dropped, badLines: existing.bad, total: all.length, storeSamples: samples.length, storeMatched: used.size }
  console.log(JSON.stringify(counts))
  if (DRY) return
  const tmp = `${OUT}.tmp-${process.pid}`
  fs.mkdirSync(path.dirname(OUT), { recursive: true })
  fs.writeFileSync(tmp, all.map(r => JSON.stringify(r)).join('\n') + '\n')
  fs.renameSync(tmp, OUT)
  console.log(`wrote ${all.length} records to ${OUT}`)
}

main()
