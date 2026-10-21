// fleet's receipts: what each subagent actually wrote, from its own tool calls
// that succeeded. Pure logic, no $ here, so the tests exercise it directly.
import type { FleetAgent, FleetReceipt, FleetWrite } from '../types/index'
import { isRunning } from './core'

/** The model-callable tool's short name; the model sees `mcp__fleet__FleetReceipts`. */
export const TOOL_NAME = 'FleetReceipts'
export const TOOL_FULL_NAME = `mcp__fleet__${TOOL_NAME}`

export const TOOL_DESCRIPTION = [
  "Ground-truth receipts of the files each of this session's subagents actually wrote, recorded by the fleet mod from the subagent's own Edit / Write / NotebookEdit calls that SUCCEEDED (denied or errored calls are not counted), with edit counts and a fresh on-disk check of every file.",
  'Call it right after a subagent reports it changed files, BEFORE repeating or building on the report: subagents have reported edits that were never on disk. A report that claims edits while its receipt says "wrote NO files", or lists a file as missing, did not happen; redo that work.',
  'Input: optional `agent`, a lane tag (e.g. "mod-rails2"), agent id, or part of its description; omit it for every agent.',
  'Shell writes (Bash / PowerShell) are tracked best-effort only (redirects, tee, Set-Content / Add-Content / Out-File, cp / mv / Copy-Item / Move-Item to absolute paths); `shellCommands` > 0 means some writes may be untracked, so check those with git diff. An agent that started before fleet loaded has a partial receipt (`receipt: "partial"`).',
].join(' ')

export const TOOL_SCHEMA = {
  type: 'object',
  properties: {
    agent: { type: 'string', description: 'Lane tag, agent id, or part of the description. Omit for all agents.' },
  },
} as const

export const SHELL_NOTE =
  'best-effort: redirects, tee, Set-Content/Add-Content/Out-File, cp/mv/Copy-Item/Move-Item to absolute paths; sed -i, scripts, git and relative paths are not tracked'

/** A receipt for an agent fleet saw spawn (complete) or first met mid-run (partial). */
export function newReceipt(since: number, isComplete: boolean): FleetReceipt {
  return { isComplete, since, writes: {}, failedEdits: 0, shellCommands: 0, isReported: false }
}

/**
 * A partial receipt on each running agent that has none: fleet met it mid-run
 * (it started before fleet loaded), so writes before `now` are unknown.
 */
export function withPartialReceipts(agents: Record<string, FleetAgent>, now: number): Record<string, FleetAgent> {
  const out: Record<string, FleetAgent> = { ...agents }
  for (const [id, a] of Object.entries(agents)) {
    if (!isRunning(a)) continue
    if (!a.receipt) out[id] = { ...a, receipt: newReceipt(now, false) }
    // Resumed after a finish toast (SendMessage): toast again when it ends.
    else if (a.receipt.isReported) out[id] = { ...a, receipt: { ...a.receipt, isReported: false } }
  }
  return out
}

/** The key a path is recorded under: slashes forward, a drive path lowercased. */
export function pathKey(p: string): string {
  const s = p.replace(/\\/g, '/')
  return /^[A-Za-z]:\//.test(s) || /^\/[A-Za-z]\//.test(s) ? s.toLowerCase().replace(/^\/([a-z])\//, '$1:/') : s
}

/** The last segment of a path. */
export function baseName(p: string): string {
  const parts = p.replace(/\\/g, '/').replace(/\/+$/, '').split('/')
  return parts[parts.length - 1] || p
}

/** The tool calls that write a file, and where each names it. */
export const WRITE_TOOLS: Record<string, string> = {
  Edit: 'file_path',
  Write: 'file_path',
  MultiEdit: 'file_path',
  NotebookEdit: 'notebook_path',
}
export const SHELL_TOOLS = new Set(['Bash', 'PowerShell'])

/** The agent's receipt with one more write per path. */
export function withWrites(r: FleetReceipt, paths: readonly string[], via: 'tool' | 'shell', at: number): FleetReceipt {
  const writes = { ...r.writes }
  for (const p of paths) {
    const key = pathKey(p)
    const was: FleetWrite | undefined = writes[key]
    writes[key] = was
      ? { ...was, edits: was.edits + 1, via: was.via === via ? via : 'both', lastAt: at, exists: undefined }
      : { path: p, edits: 1, via, lastAt: at }
  }
  return { ...r, writes }
}

const isAbsolute = (p: string) => /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('/') || p.startsWith('\\\\')
const NULLS = /^(\/dev\/null|\$null|nul|null|&\d|-)$/i

function unquote(t: string): string {
  const m = /^"(.*)"$|^'(.*)'$/.exec(t)
  return m ? (m[1] ?? m[2] ?? '') : t
}

/** Splits shell words, keeping quoted runs whole. */
function words(s: string): string[] {
  return (s.match(/"[^"]*"|'[^']*'|[^\s]+/g) ?? []).map(unquote)
}

/**
 * The absolute paths a shell command plainly writes, best-effort: `>` / `>>`
 * redirects, `tee`, `Set-Content` / `Add-Content` / `Out-File`, and the target
 * of `cp` / `mv` / `Copy-Item` / `Move-Item`. Relative paths are dropped (the
 * agent's working directory is unknown), as are null devices.
 */
export function shellWrites(cmd: string): string[] {
  const out: string[] = []
  const add = (p: string | undefined) => {
    const t = unquote((p ?? '').trim())
    if (t && !NULLS.test(t) && isAbsolute(t) && !out.includes(t)) out.push(t)
  }
  // Each command of a pipeline / list on its own.
  const segments = cmd.split(/\r?\n|;|&&|\|\||\|/)
  for (const seg of segments) {
    for (const m of seg.matchAll(/(?:^|[\s(])(?:\d)?>{1,2}\s*("[^"]+"|'[^']+'|[^\s;&|)<>]+)/g)) {
      const pre = m[0].trimStart()
      if (/^\d>/.test(pre) && !/^1>/.test(pre)) continue // 2> is a log, not output
      add(m[1])
    }
    const w = words(seg.trim())
    const verb = (w[0] ?? '').toLowerCase()
    const args = w.slice(1)
    const flagged = (names: string[]) => {
      const i = args.findIndex(a => names.includes(a.toLowerCase()))
      return i >= 0 ? args[i + 1] : undefined
    }
    const positional = args.filter((a, i) => !a.startsWith('-') && !(i > 0 && (args[i - 1] ?? '').startsWith('-') && /^-[A-Za-z]{2,}/.test(args[i - 1] ?? '')))
    if (verb === 'tee') positional.forEach(add)
    else if (['set-content', 'add-content', 'out-file', 'sc', 'ac'].includes(verb)) add(flagged(['-path', '-filepath', '-literalpath']) ?? positional[0])
    else if (verb === 'cp' || verb === 'mv') {
      const t = args.filter(a => !a.startsWith('-'))
      if (t.length >= 2) add(t[t.length - 1])
    } else if (['copy-item', 'move-item', 'copy', 'move', 'cpi', 'mi'].includes(verb)) add(flagged(['-destination']) ?? positional[1])
  }
  return out
}

/** Records one subagent tool call that ran: its writes on success, a failure otherwise. */
export function recordCall(r: FleetReceipt, tool: string, input: Record<string, unknown>, isOk: boolean, at: number): FleetReceipt {
  const field = WRITE_TOOLS[tool]
  if (field) {
    const p = input[field]
    if (!isOk) return { ...r, failedEdits: r.failedEdits + 1 }
    return typeof p === 'string' && p ? withWrites(r, [p], 'tool', at) : r
  }
  if (SHELL_TOOLS.has(tool) && isOk) {
    const cmd = typeof input.command === 'string' ? input.command : ''
    const next = { ...r, shellCommands: r.shellCommands + 1 }
    const paths = shellWrites(cmd)
    return paths.length ? withWrites(next, paths, 'shell', at) : next
  }
  return r
}

/** The writes, most edited first. */
export function writesOf(r: FleetReceipt): FleetWrite[] {
  return Object.values(r.writes).sort((x, y) => y.edits - x.edits || x.path.localeCompare(y.path))
}

/** Applies an on-disk check: `found` maps each write key to whether it exists. */
export function withChecks(r: FleetReceipt, found: Record<string, boolean>, at: number): FleetReceipt {
  const writes: Record<string, FleetWrite> = {}
  for (const [k, w] of Object.entries(r.writes)) writes[k] = k in found ? { ...w, exists: found[k] } : w
  return { ...r, writes, checkedAt: at }
}

export function missingOf(r: FleetReceipt): FleetWrite[] {
  return writesOf(r).filter(w => w.exists === false)
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

function namesText(ws: readonly FleetWrite[], max: number): string {
  const names = ws.slice(0, max).map(w => baseName(w.path) + (w.edits > 1 ? ` x${w.edits}` : ''))
  return names.join(', ') + (ws.length > max ? `, +${ws.length - max} more` : '')
}

/** The finish toast for an agent whose run just ended. */
export function finishToast(a: FleetAgent): string {
  const r = a.receipt
  const verb = a.status === 'completed' ? 'finished' : `ended (${a.status})`
  const head = `fleet: ${a.lane} ${verb}`
  if (!r) return `${head} · no receipt`
  const shell = r.shellCommands > 0 ? ` · ${plural(r.shellCommands, 'shell command')} (writes best-effort)` : ''
  const ws = writesOf(r)
  if (!r.isComplete) {
    const seen = ws.length ? `${plural(ws.length, 'file')} seen since (${namesText(ws, 3)})` : 'no writes seen since'
    return `${head} · no full receipt: started before fleet loaded; ${seen}${shell}`
  }
  if (ws.length === 0) return `${head} · wrote NO files${r.failedEdits ? ` (${plural(r.failedEdits, 'edit')} failed)` : ''}${shell}`
  const missing = ws.filter(w => w.exists === false)
  const gone = missing.length ? ` · ${missing.length} MISSING on disk: ${namesText(missing, 3)}` : ''
  return `${head} · wrote ${plural(ws.length, 'file')} (${namesText(ws, 4)})${gone}${shell}`
}

/** Agents whose run ended and whose finish toast has not gone out. */
export function dueReceipts(agents: Record<string, FleetAgent>): FleetAgent[] {
  return Object.values(agents).filter(a => !isRunning(a) && a.receipt && !a.receipt.isReported)
}

/** Whether `q` names the agent: its lane, id, or part of its description. */
export function matches(a: FleetAgent, q: string): boolean {
  const s = q.trim().toLowerCase().replace(/^\[?lane:/, '').replace(/\]$/, '')
  if (!s) return true
  return a.lane.toLowerCase() === s || a.id.toLowerCase() === s || a.lane.toLowerCase().includes(s) || a.description.toLowerCase().includes(s)
}

export type ReceiptFile = { path: string; edits: number; via: FleetWrite['via']; exists: boolean | null }

export type ReceiptView = {
  id: string
  lane: string
  status: string
  /** `complete`: every write since spawn; `partial`: started before fleet loaded; `none`: never seen running. */
  receipt: 'complete' | 'partial' | 'none'
  verdict: string
  files: ReceiptFile[]
  failedEdits: number
  shellCommands: number
  /** True when shell commands ran, so writes they made may be missing from `files`. */
  shellWritesMaybeUntracked: boolean
  recordingSince?: string
}

/** One agent's receipt as the tool returns it. */
export function receiptView(a: FleetAgent): ReceiptView {
  const r = a.receipt
  const base = { id: a.id, lane: a.lane, status: a.status }
  if (!r) {
    return {
      ...base,
      receipt: 'none',
      verdict: 'no receipt: fleet never saw this agent running (it finished before fleet loaded); verify with git diff',
      files: [],
      failedEdits: 0,
      shellCommands: 0,
      shellWritesMaybeUntracked: true,
    }
  }
  const ws = writesOf(r)
  const missing = ws.filter(w => w.exists === false).length
  let verdict = ws.length === 0 ? 'wrote NO files' : `wrote ${plural(ws.length, 'file')}${missing ? `, ${missing} MISSING on disk` : ', all on disk'}`
  if (!r.isComplete) verdict = `partial receipt (started before fleet loaded): ${verdict} since recording began`
  if (r.shellCommands > 0) verdict += `; ${plural(r.shellCommands, 'shell command')} ran (shell writes ${SHELL_NOTE})`
  return {
    ...base,
    receipt: r.isComplete ? 'complete' : 'partial',
    verdict,
    files: ws.map(w => ({ path: w.path, edits: w.edits, via: w.via, exists: w.exists ?? null })),
    failedEdits: r.failedEdits,
    shellCommands: r.shellCommands,
    shellWritesMaybeUntracked: r.shellCommands > 0,
    ...(r.isComplete ? {} : { recordingSince: new Date(r.since).toISOString() }),
  }
}
