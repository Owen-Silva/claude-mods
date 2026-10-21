// The transcript reader: agent-context.js's method, run as one short node
// process over the agents fleet has no reading for (agents that started
// before the mod loaded, and every agent's brief/start time once).
// The module itself has no Node, so the script runs through $.process.run,
// fed on stdin with its arguments in FLEET_ARGS. It only reads: the tail
// (TAIL bytes) for usage, the head (64 KB) for the brief.

export type ProbeHit = {
  isFound: boolean
  /** Last request's context, when a usage line was in the tail. */
  ctx?: number
  maxCtx?: number
  isOneM?: boolean
  model?: string
  /** The first user message (the brief), cut to 400 chars. */
  brief?: string
  /** Epoch ms of the first line, and of the last reading. */
  startedAt?: number
  at?: number
  /** The transcript's last write, epoch ms: a finished agent's end time. */
  mtime?: number
  error?: string
}

/** What the script reads from FLEET_ARGS. */
export type ProbeArgs = { sid: string; ids: string[]; running: string[]; recentMs: number }

export type ProbeOutput = { root: string; isRootReadable: boolean; hits: Record<string, ProbeHit> }

export const PROBE_SCRIPT = String.raw`
const fs = require('fs'), os = require('os'), path = require('path');
const TAIL = 2 * 1024 * 1024;
const args = JSON.parse(process.env.FLEET_ARGS || '{}');
const root = path.join(os.homedir(), '.claude', 'projects');
const out = { root: root, isRootReadable: true, hits: {} };
let projects = [];
try { projects = fs.readdirSync(root); } catch (e) { out.isRootReadable = false; }
function readAt(fd, pos, len) { const b = Buffer.alloc(len); const n = fs.readSync(fd, b, 0, len, pos); return b.slice(0, n).toString('utf8'); }
for (const id of args.ids || []) {
  const hit = { isFound: false };
  out.hits[id] = hit;
  let file = '';
  for (const p of projects) {
    const f = path.join(root, p, args.sid, 'subagents', 'agent-' + id + '.jsonl');
    if (fs.existsSync(f)) { file = f; break; }
  }
  if (!file) continue;
  hit.isFound = true;
  let st;
  try { st = fs.statSync(file); hit.mtime = st.mtimeMs; } catch (e) { hit.error = String(e && e.message || e); continue; }
  // An old, finished agent needs its end time alone: no head or tail read.
  if ((args.running || []).indexOf(id) < 0 && Date.now() - st.mtimeMs > (args.recentMs || 0)) continue;
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const head = readAt(fd, 0, Math.min(size, 64 * 1024));
    for (const line of head.split('\n')) {
      if (!line) continue;
      let j; try { j = JSON.parse(line); } catch (e) { continue; }
      if (hit.startedAt === undefined && j.timestamp) hit.startedAt = Date.parse(j.timestamp);
      if (j.type !== 'user') continue;
      const c = j.message && j.message.content;
      const t = typeof c === 'string' ? c : Array.isArray(c) ? ((c.find(function (x) { return x.type === 'text'; }) || {}).text || '') : '';
      if (t) { hit.brief = t.slice(0, 400); break; }
    }
    const len = Math.min(size, TAIL);
    const tail = readAt(fd, size - len, len);
    let maxCtx = 0, last = null, oneM = false, model = '', at = 0;
    for (const line of tail.split('\n')) {
      if (line.indexOf('[1m]"') >= 0 || line.indexOf('"model":"claude-opus-5') >= 0) oneM = true;
      if (line.indexOf('"usage"') < 0) continue;
      let j; try { j = JSON.parse(line); } catch (e) { continue; }
      const u = j.message && j.message.usage;
      if (!u) continue;
      const ctx = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.output_tokens || 0);
      if (ctx > maxCtx) maxCtx = ctx;
      last = ctx;
      if (j.message.model) model = j.message.model;
      if (j.timestamp) at = Date.parse(j.timestamp);
    }
    if (last !== null) { hit.ctx = last; hit.maxCtx = maxCtx; hit.isOneM = oneM; hit.model = model || undefined; hit.at = at || undefined; }
  } catch (e) {
    hit.error = String(e && e.message || e);
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch (e) {}
  }
}
process.stdout.write(JSON.stringify(out));
`

/** Parses the script's stdout; throws with a short reason when it is not ours. */
export function parseProbe(stdout: string): ProbeOutput {
  let v: unknown
  try {
    v = JSON.parse(stdout)
  } catch {
    throw new Error(`reader printed no JSON (${stdout.trim().slice(0, 60) || 'nothing'})`)
  }
  if (!v || typeof v !== 'object' || !('hits' in v)) throw new Error('reader output had no hits')
  return v as ProbeOutput
}
