// The rule mechanism: what a rule reads (a call), what it may reach (a ctx),
// and the generic helpers rules share. The rules themselves live in
// rules.local.ts (personal, untracked; start from rules.example.ts).
//
// A rule opens an item from a SUCCESSFUL call (an edit's path, a command the
// shell parser read) and closes it from a later call. Where the obligation is
// a fact on disk (an index is stale, a repo is ahead of origin) the rule
// checks that fact instead of guessing from command text: it opens only when
// the fact is false and closes only when it is true. An item opened on an
// unrelated edit is the worst outcome, so every trigger is an exact path or a
// parsed command.

import type { Followup } from '../types'
import type { Hit, Progress } from './items'
import { commands, isAbsolutePath, joinPath, normPath } from './shell'
import type { Cmd } from './shell'

/* ----------------------------------------------------------------- calls */

export type EditCall = {
  kind: 'edit'
  tool: string
  /** Normalised: forward slashes, lower case, `c:/...`. */
  path: string
  /** The file name as written, for labels. */
  name: string
  /** Edit's old_string ('' for Write). */
  oldText: string
  /** Edit's new_string, Write's content, NotebookEdit's new_source. */
  newText: string
}

export type ShellCall = {
  kind: 'shell'
  tool: string
  src: string
  cmds: Cmd[]
  /** What the model read back (stdout and stderr). */
  output: string
}

export type Call = EditCall | ShellCall

export type RunResult = { exitCode: number; stdout: string; stderr: string }

export type Ctx = {
  /** The session's directory, normalised. */
  cwd: string
  git: (dir: string, args: readonly string[]) => Promise<string | undefined>
  /** Runs a program; rejects when it cannot start. */
  run: (argv: readonly string[]) => Promise<RunResult>
  /** Reads a text file; rejects when missing. */
  read: (path: string) => Promise<string>
  /** File and directory names in a directory; rejects when missing. */
  list: (path: string) => Promise<{ name: string; isDir: boolean }[]>
  now: () => Promise<number>
  /** A toast: a check that could not run says so. */
  warn: (text: string) => void
  /** Whether an item with this key is open (a merge needs no fresh check). */
  hasOpen: (key: string) => boolean
}

export type Rule = {
  id: string
  summary: string
  /** The memory file(s) the rule comes from. */
  source: string
  open?: (call: Call, ctx: Ctx) => Promise<Hit[]>
  /** What this call showed toward closing `item` (one of this rule's), if anything. */
  progress?: (call: Call, item: Followup, ctx: Ctx) => Promise<Progress | undefined>
}

/** The user's home, normalised; undefined until the hooks read it from the environment. */
let home: string | undefined

/**
 * Sets what `~` and the home variables expand to. The hooks pass
 * `$.env.get('USERPROFILE') ?? $.env.get('HOME')` before they read a call, so
 * no call is read without it; while it is unknown those forms stay as written.
 */
export function setHome(raw: string | undefined): void {
  home = raw === undefined || raw.trim() === '' ? undefined : normPath(raw)
}

/** The home `~` expands to (normalised), or undefined before it is known. */
export function homeDir(): string | undefined {
  return home
}

/** Normalised path with `~` and the home variables expanded. */
export function resolvePath(p: string, base: string): string {
  const h = home
  const expanded = h === undefined ? p : p.replace(/^(~|\$home|\$\{home\}|\$env:userprofile|%userprofile%)(?=[\\/]|$)/i, () => h)
  return normPath(isAbsolutePath(expanded) ? expanded : joinPath(base, expanded))
}

/** The directory a command runs in: a `cd` before it on the line, else the session's. */
export function dirOf(cmd: Cmd, cwd: string): string {
  return cmd.dir === undefined ? cwd : resolvePath(cmd.dir, cwd)
}

/** `path` is `root` or inside it (both normalised). */
export const under = (path: string, root: string): boolean => path === root || path.startsWith(`${root}/`)

const EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit'])
const SHELLS: Record<string, 'bash' | 'ps'> = { Bash: 'bash', PowerShell: 'ps' }

/** The call as the rules read it, or undefined for a tool no rule watches. */
export function callOf(e: { tool: string; [k: string]: unknown }, cwd: string, output = ''): Call | undefined {
  const str = (k: string): string => (typeof e[k] === 'string' ? (e[k] as string) : '')
  if (EDIT_TOOLS.has(e.tool)) {
    const raw = str('file_path') || str('notebook_path')
    if (raw === '') return undefined
    const name = raw.replace(/\\/g, '/').split('/').pop() ?? raw
    const newText = e.tool === 'Write' ? str('content') : e.tool === 'Edit' ? str('new_string') : str('new_source')
    return { kind: 'edit', tool: e.tool, path: resolvePath(raw, cwd), name, oldText: str('old_string'), newText }
  }
  const shell = SHELLS[e.tool]
  if (shell === undefined) return undefined
  const src = str('command')
  return { kind: 'shell', tool: e.tool, src, cmds: commands(src, shell), output }
}

/** One line, at most `n` characters. */
export function short(text: string, n = 60): string {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length > n ? `${one.slice(0, n - 1)}…` : one
}

/** The argument of a `node <script>` command that names `script`, if any. */
export const scriptArg = (cmd: Cmd, script: RegExp): string | undefined => {
  if (cmd.name !== 'node') return undefined
  return cmd.args.find(a => script.test(a.replace(/\\/g, '/')))
}

/* ------------------------------------------------------------------- git */

export type GitCall = { sub: string; args: string[]; repo: string }

/** `git [-C dir] [global options] <sub> <args>`, with the repo directory it runs in. */
export function gitCall(cmd: Cmd, cwd: string): GitCall | undefined {
  if (cmd.name !== 'git') return undefined
  let repo = dirOf(cmd, cwd)
  const a = cmd.args
  for (let i = 0; i < a.length; i++) {
    const w = a[i] as string
    if (w === '-C') {
      repo = resolvePath(a[i + 1] ?? '.', repo)
      i++
    } else if (w === '-c' || w === '--git-dir' || w === '--work-tree' || w === '--namespace') i++
    else if (w.startsWith('-')) continue
    else return { sub: w.toLowerCase(), args: a.slice(i + 1), repo }
  }
  return undefined
}

/** What a push updated, read from git's own report (`   abc..def  main -> master`). */
export function pushedRefs(output: string): { from: string; to: string; dst: string }[] {
  const out: { from: string; to: string; dst: string }[] = []
  for (const m of output.matchAll(/^\s*[+ ]?\s*([0-9a-f]{7,40})\.\.\.?([0-9a-f]{7,40})\s+\S+\s+->\s+(\S+)/gim)) {
    out.push({ from: m[1] as string, to: m[2] as string, dst: m[3] as string })
  }
  for (const m of output.matchAll(/^\s*\*\s+\[new branch\]\s+\S+\s+->\s+(\S+)/gim)) out.push({ from: '', to: '', dst: m[1] as string })
  return out
}

/** A successful push to `branch` of the repo at `root` (by its directory, or by the `To <url>` line). */
export function pushTo(call: Call, ctx: Ctx, root: string, url: RegExp, branch: string): { range: { from: string; to: string } | undefined; raw: string } | undefined {
  if (call.kind !== 'shell') return undefined
  for (const cmd of call.cmds) {
    const g = gitCall(cmd, ctx.cwd)
    if (g === undefined || g.sub !== 'push') continue
    const isRepo = under(g.repo, root) || url.test(call.output)
    if (!isRepo) continue
    const ref = pushedRefs(call.output).find(r => r.dst === branch || r.dst === `refs/heads/${branch}`)
    if (ref === undefined) continue
    return { range: ref.from === '' ? undefined : { from: ref.from, to: ref.to }, raw: cmd.raw }
  }
  return undefined
}

/* -------------------------------------------------------------- markdown */

/** A section's own words: quote lines, checkboxes, rules and `<placeholders>` removed. */
export function sectionBody(md: string, heading: RegExp): string | undefined {
  const lines = md.split(/\r?\n/)
  const start = lines.findIndex(l => heading.test(l))
  if (start < 0) return undefined
  const body: string[] = []
  for (const l of lines.slice(start + 1)) {
    if (/^##\s/.test(l)) break
    if (/^\s*>/.test(l) || /^\s*-\s*\[[ x]\]/i.test(l) || /^\s*---\s*$/.test(l)) continue
    body.push(l)
  }
  // Template placeholders (`<post text>`, `<One or two sentences ...>`) may span lines.
  return body.join('\n').replace(/<[^<>]{1,300}>/g, '').trim()
}
