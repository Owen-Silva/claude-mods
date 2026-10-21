// The types and generic mechanisms behind the rule table. Each rule turns
// one of the user's "never do X" rules into a tool.call check: an id, the
// tools it reads, a check that returns what matched, an optional prompt
// unlock, and the deny text.
//
// The rules themselves are config, not code: register.ts imports RULES and
// PIN_TEXT from ./rules.local (machine-local, gitignored). A fresh clone
// starts it from the example: cp hooks/rules.example.ts hooks/rules.local.ts

import { commands, isAbsolutePath, joinPath, lex, normPath } from './shell'
import type { Cmd } from './shell'

export type ToolInput = { tool: string; [field: string]: unknown }

export type Ctx = {
  /** The session's directory, absolute. */
  cwd: () => Promise<string>
  /** `git -C <dir> <args>`'s stdout, trimmed; undefined when it fails. */
  git: (dir: string, args: readonly string[]) => Promise<string | undefined>
  /** The model made the call (not another plugin's `$.tool.call`). */
  isModelCall: boolean
  /** The user's home folder (USERPROFILE / HOME); undefined when unset. */
  home: () => Promise<string | undefined>
  /** What a path is on disk, links not followed; undefined when missing or unreadable. */
  kind: (path: string) => Promise<'file' | 'dir' | 'link' | 'other' | undefined>
  /** A directory's entries as they stand (links not followed); undefined when it cannot be listed. */
  entries: (dir: string) => Promise<{ name: string; isLink: boolean }[] | undefined>
  /** Whether the path is itself a symbolic link or NTFS junction: false when missing, undefined when rails cannot tell. */
  isLink: (path: string) => Promise<boolean | undefined>
  /** Pins the session to `project` unless it is pinned already; resolves with the pin that stands. */
  pin: (project: Project, by: string) => Promise<{ project: Project; by: string }>
}

/** A project session-separation keeps apart, by the name its rules give it. */
export type Project = string

/** How /rails shows the session's project pin (`Project: ...`). */
export type PinText = {
  /** The text after "Project: " before the first pin. */
  none: string
  /** A pinned project's display name. */
  name: (project: Project) => string
}

export type Unlock = {
  /** Whether a prompt of the user's authorizes the rule's action. */
  test: (prompt: string) => boolean
  /** How long after that prompt the authorization lasts. */
  ms: number
  /** What the user says to authorize it. */
  hint: string
}

export type Rule = {
  id: string
  /** One line for /rails: what trips it. */
  summary: string
  /** The memory it encodes. */
  source: string
  /** Tool names it reads; a RegExp tests the name. */
  tools: readonly string[] | RegExp
  /** What matched (a short quote of the call), or undefined when the call is fine. */
  check: (e: ToolInput, ctx: Ctx) => string | undefined | Promise<string | undefined>
  unlock?: Unlock
  /** Why it is blocked and what to do instead. */
  reason: (hit: string, e: ToolInput) => string
}

export const SHELLS = ['Bash', 'PowerShell'] as const
export const MIN = 60_000

/* --------------------------------------------------------------- helpers */

const cache = new WeakMap<object, Cmd[]>()

/** The commands a Bash or PowerShell call runs (none for other tools). */
export function shellCommands(e: ToolInput): Cmd[] {
  const hit = cache.get(e)
  if (hit !== undefined) return hit
  const src = typeof e.command === 'string' ? e.command : ''
  const cmds = e.tool === 'Bash' ? commands(src, 'bash') : e.tool === 'PowerShell' ? commands(src, 'ps') : []
  cache.set(e, cmds)
  return cmds
}

export function clip(text: string, n = 140): string {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length > n ? `${one.slice(0, n - 1)}…` : one
}

/** The commands of each pipeline (statement), in order. */
export function pipelines(cmds: readonly Cmd[]): Cmd[][] {
  const groups = new Map<number, Cmd[]>()
  for (const cmd of cmds) groups.set(cmd.pipeline, [...(groups.get(cmd.pipeline) ?? []), cmd])
  return [...groups.values()]
}

export function pipelineText(cmds: readonly Cmd[]): string {
  return cmds.map(c => c.raw).join(' | ')
}

export const flag = (word: string): string => word.replace(/^[-/]+/, '').toLowerCase()

/** The values after a parameter matching `re` (PowerShell `-Name a,b` or `-Name:a`). */
export function paramValues(args: readonly string[], re: RegExp): string[] {
  const out: string[] = []
  args.forEach((a, i) => {
    const m = /^(-[A-Za-z]+):(.+)$/.exec(a)
    if (m !== null && re.test(m[1] as string)) out.push(...(m[2] as string).split(','))
    else if (re.test(a)) out.push(...(args[i + 1] ?? '').split(','))
  })
  return out.map(v => v.trim()).filter(v => v !== '')
}

export function positional(args: readonly string[]): string[] {
  return args.filter(a => !a.startsWith('-'))
}

/** Whether any path argument, resolved against the command's `cd`, matches. */
export function touchesPath(cmd: Cmd, re: RegExp): boolean {
  return positional(cmd.args).some(a => re.test(normPath(joinPath(cmd.dir, a))))
}

export const DELETERS = new Set(['rm', 'rmdir', 'rd', 'del', 'erase', 'remove-item', 'ri', 'unlink'])
export const MOVERS = new Set(['mv', 'move', 'move-item', 'mi', 'ren', 'rename', 'rename-item', 'rni'])
export const WRITERS = new Set(['set-content', 'sc', 'add-content', 'ac', 'out-file', 'clear-content', 'clc', 'new-item', 'ni', 'copy-item', 'cp', 'copy', 'tee', 'tee-object'])

/* ---------------------------------------------------------------- prompts */

export function words(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length
}

export const isSlash = (text: string): boolean => text.trimStart().startsWith('/')

/** A question that is not a request ("did you push?", not "can you push?"). */
export function isQuestion(text: string): boolean {
  return /\?\s*$/.test(text) && !/^(?:\w+[\s,]+)?(?:can|could|would|will)\s+you\b/i.test(text.trim())
}

/** A negation or a condition shortly before one of `verbs`, or a condition right after. */
export function isNegated(text: string, verbs: string): boolean {
  const before = new RegExp(
    `\\b(?:don'?t|dont|do\\s+not|never|not|no|stop|hold(?:\\s+off)?(?:\\s+on)?|wait(?:\\s+to)?|before|until|unless|without)\\s+(?:\\S+\\s+){0,2}?(?:${verbs})`,
    'i',
  )
  const after = new RegExp(`\\b(?:${verbs})\\w*\\W+(?:\\w+\\W+){0,2}?(?:only|once|after|when|if|until|unless)\\b`, 'i')
  return before.test(text) || after.test(text)
}

/** A short prompt that mentions `topic` and one of `verbs`, neither negated nor asked. */
export function says(text: string, topic: RegExp, verbs: string, maxWords = 40): boolean {
  if (isSlash(text) || words(text) > maxWords || isQuestion(text)) return false
  return topic.test(text) && new RegExp(`\\b(?:${verbs})\\b`, 'i').test(text) && !isNegated(text, verbs)
}

export const GO = /^(?:(?:ok(?:ay)?|yes|yep|yeah|sure|alright|cool)[\s,.!]*)*go(?:\s+(?:ahead|for\s+it|now))?[\s.!]*$/i

/** "go", "ok push", "ship it", "push everything": the user's release words. */
export function approvesPush(text: string): boolean {
  if (GO.test(text.trim())) return true
  return says(text, /\b(?:push|ship|deploy)\b/i, 'push|ship|deploy', 30)
}

/** "buy 5 AMD", "yes", "confirm", "do it" right after an order preview. */
export function approvesTrade(text: string): boolean {
  if (isSlash(text) || words(text) > 40 || isQuestion(text)) return false
  if (/\b(?:cancel|hold\s+off|wait)\b/i.test(text)) return false
  const verbs = 'buy|sell|short|cover|exercise|place|execute|submit|trade|order'
  if (isNegated(text, verbs)) return false
  return /\b(?:buy|sell|short|cover|exercise|place|execute|submit|send\s+it|confirm(?:ed)?|approved?|yes|yep|yeah|do\s+it|go(?:\s+ahead)?)\b/i.test(text)
}

/* -------------------------------------------------------------------- git */

export type GitCall = { sub: string; args: string[]; dir: string | undefined }

export function gitCall(args: readonly string[]): GitCall | undefined {
  let dir: string | undefined
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string
    if (a === '-C') {
      const p = args[i + 1]
      if (p !== undefined) dir = joinPath(dir, p)
      i++
      continue
    }
    if (a === '--git-dir' || a === '--work-tree') {
      dir = args[i + 1] ?? dir
      i++
      continue
    }
    const eq = /^--(?:git-dir|work-tree)=(.+)$/.exec(a)
    if (eq !== null) {
      dir = eq[1]
      continue
    }
    if (a === '-c' || a === '--namespace' || a === '--config-env' || a === '--exec-path') {
      i++
      continue
    }
    if (a.startsWith('-')) continue
    return { sub: a.toLowerCase(), args: args.slice(i + 1), dir }
  }
  return undefined
}

export type PushTarget = {
  /** Why it reaches `branch`; undefined when it cannot. */
  why?: string
  remote?: string
  /** It depends on what is checked out: `upstream` (no refspec) or `head` (HEAD). */
  depends?: 'upstream' | 'head'
}

/**
 * Whether `git push <args>` can reach `branch` on its remote, and why.
 * `note` follows "updates <branch>" in the why (", which deploys to production").
 */
export function pushTarget(args: readonly string[], branch = 'master', note = ''): PushTarget {
  const pos: string[] = []
  let repo: string | undefined
  let isTags = false
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string
    if (a === '--') {
      pos.push(...args.slice(i + 1))
      break
    }
    if (a === '-n' || a === '--dry-run') return {}
    if (a === '--all' || a === '--mirror' || a === '--branches') return { why: `${a} pushes every branch, ${branch} included` }
    if (a === '-o' || a === '--push-option' || a === '--receive-pack' || a === '--exec') {
      i++
      continue
    }
    if (a === '--repo') {
      repo = args[i + 1]
      i++
      continue
    }
    if (a.startsWith('--repo=')) {
      repo = a.slice(7)
      continue
    }
    if (a === '--tags') isTags = true
    if (a.startsWith('-')) continue
    pos.push(a)
  }
  const remote = repo ?? pos[0]
  const specs = repo !== undefined ? pos : pos.slice(1)
  if (specs.length === 0) {
    return isTags ? {} : { remote, why: 'names no branch, so it pushes what is checked out', depends: 'upstream' }
  }
  for (const spec of specs) {
    const s = spec.replace(/^\+/, '')
    const k = s.lastIndexOf(':')
    const src = k < 0 ? s : s.slice(0, k)
    const dst = (k < 0 ? s : s.slice(k + 1)).replace(/^refs\/heads\//, '')
    if (dst === branch || dst.includes('*')) return { remote, why: `${spec} updates ${branch}${note}` }
    if (dst === 'HEAD' || dst === '@' || (k < 0 && (src === 'HEAD' || src === '@'))) {
      return { remote, why: `${spec} pushes the checked-out branch`, depends: 'head' }
    }
  }
  return { remote }
}

export async function absolute(dir: string | undefined, ctx: Ctx): Promise<string> {
  if (dir !== undefined && isAbsolutePath(dir)) return dir
  const cwd = await ctx.cwd()
  return dir === undefined ? cwd : joinPath(cwd, dir)
}

/** A repo whose `branch` is production: pushes to it, or PRs merged into it, deploy. */
export type ProtectedBranch = {
  /** The repo's push URL, https or ssh (`/github\.com[/:]you\/app(?:\.git)?\/?$/i`). */
  url: RegExp
  /** The repo as `gh pr merge -R owner/name` names it (`/(^|\/)you\/app$/i`). */
  slug: RegExp
  /** Whether a path is a checkout of the repo, without asking git. */
  isPath: (path: string) => boolean
  /** The production branch (`main`). */
  branch: string
  /** Follows "updates <branch>" in the hit (", which deploys to production"). */
  note: string
}

/** A check for a `git push` or `gh pr merge` that reaches the protected branch of `repo`. */
export function pushesTo(repo: ProtectedBranch): (e: ToolInput, ctx: Ctx) => Promise<string | undefined> {
  const onBranch = new RegExp(`(^|/)(${repo.branch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}|HEAD)$`)
  const isRepo = async (dir: string, remote: string, ctx: Ctx): Promise<boolean> => {
    if (repo.isPath(dir)) return true
    if (!/^([a-z]:)?[\\/]/i.test(dir)) return false
    const url = await ctx.git(dir, ['remote', 'get-url', '--push', remote])
    return url !== undefined && repo.url.test(url)
  }
  return async (e, ctx) => {
    for (const cmd of shellCommands(e)) {
      if (cmd.name === 'gh' && cmd.args[0] === 'pr' && cmd.args[1] === 'merge') {
        const named = paramValues(cmd.args, /^(-R|--repo)$/)[0]
        const isIt = named !== undefined ? repo.slug.test(named) : await isRepo(await absolute(cmd.dir, ctx), 'origin', ctx)
        if (isIt) return `${clip(cmd.raw)} (merging a PR into ${repo.branch} deploys it)`
        continue
      }
      if (cmd.name !== 'git') continue
      const git = gitCall(cmd.args)
      if (git?.sub !== 'push') continue
      const target = pushTarget(git.args, repo.branch, repo.note)
      if (target.why === undefined) continue
      const remote = target.remote
      const dir = await absolute(git.dir !== undefined ? joinPath(cmd.dir, git.dir) : cmd.dir, ctx)
      if (remote !== undefined && /^(https?:|git@|ssh:)/i.test(remote)) {
        if (!repo.url.test(remote)) continue
      } else if (!(await isRepo(dir, remote ?? 'origin', ctx))) continue
      let why = target.why
      if (target.depends !== undefined) {
        const ref =
          target.depends === 'upstream'
            ? ((await ctx.git(dir, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{push}'])) ??
              (await ctx.git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])))
            : await ctx.git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])
        if (ref !== undefined && !onBranch.test(ref)) continue
        why += ref === undefined ? ' (rails could not tell which branch that is)' : ` (${ref})`
      }
      return `${clip(cmd.raw)}: ${why}`
    }
    return undefined
  }
}

/* ------------------------------------------------------------- backticks */

export function liveBacktick(e: ToolInput): string | undefined {
  if (typeof e.command !== 'string' || !e.command.includes('`')) return undefined
  const lexed = lex(e.command, 'bash')
  if (lexed.isUnbalanced) return undefined
  const first = lexed.backticks[0]
  return first === undefined ? undefined : clip(first, 100)
}

/* ------------------------------------------------------------------ kills */

const KILLERS = new Set(['stop-process', 'spps', 'kill', 'taskkill', 'remove-ciminstance', 'remove-wmiobject', 'rwmi'])
const NARROWED = /commandline|executablepath|\.path\b|parentprocessid|creationdate|starttime|mainwindowtitle|-first\b|-last\b|-index\b|\bhead\b/i

/** A kill that picks processes by image name, not by PID or command line. */
export function killsByName(e: ToolInput, image: string): string | undefined {
  const exact = new RegExp(`^${image}(\\.exe)?\\*?$`, 'i')
  const named = new RegExp(`\\b${image}(\\.exe)?\\b`, 'i')
  const cmds = shellCommands(e)
  for (const cmd of cmds) {
    const n = cmd.name
    if (n === 'taskkill') {
      for (let i = 0; i < cmd.args.length; i++) {
        const f = flag(cmd.args[i] as string)
        const v = cmd.args[i + 1] ?? ''
        if (f === 'im' && exact.test(v)) return clip(cmd.raw)
        if (f === 'fi' && new RegExp(`imagename\\s+eq\\s+${image}`, 'i').test(v)) return clip(cmd.raw)
      }
    }
    if (n === 'stop-process' || n === 'spps' || n === 'kill') {
      if (paramValues(cmd.args, /^-(n|na|nam|name|processname)$/i).some(v => exact.test(v))) return clip(cmd.raw)
      if (n === 'kill' && /\b(pgrep|pidof)\b/.test(cmd.raw) && named.test(cmd.raw)) return clip(cmd.raw)
    }
    if ((n === 'pkill' || n === 'killall') && positional(cmd.args).some(a => exact.test(a))) return clip(cmd.raw)
    if (n === 'wmic' && new RegExp(`name\\s*=\\s*['"]?${image}`, 'i').test(cmd.args.join(' ')) && /\b(delete|terminate)\b/i.test(cmd.args.join(' '))) {
      if (!NARROWED.test(cmd.raw)) return clip(cmd.raw)
    }
  }
  for (const group of pipelines(cmds)) {
    if (group.length < 2) continue
    const rest = group.slice(1)
    const kills = rest.some(
      c =>
        KILLERS.has(c.name) ||
        (c.name === 'invoke-cimmethod' && /terminate/i.test(c.raw)) ||
        (c.name === 'xargs' && c.args.some(a => /^(kill|taskkill|stop-process)$/i.test(a))) ||
        /\.(kill|terminate)\b/i.test(c.raw),
    )
    if (!kills) continue
    const text = pipelineText(group)
    const selects = group.some(c => {
      if (['get-process', 'gps', 'ps', 'pgrep', 'pidof'].includes(c.name)) {
        return [...positional(c.args), ...paramValues(c.args, /^-(n|na|nam|name|processname)$/i)].some(a => a.split(',').some(x => exact.test(x.trim())))
      }
      if (['get-ciminstance', 'gcim', 'get-wmiobject', 'gwmi'].includes(c.name)) {
        return new RegExp(`name\\s*(=|like)\\s*['"]?${image}`, 'i').test(c.args.join(' '))
      }
      if (['grep', 'findstr', 'select-string', 'sls'].includes(c.name)) {
        return !c.args.includes('-v') && positional(c.args).some(a => exact.test(a))
      }
      return false
    })
    const filters = new RegExp(`\\b(name|processname)['"]?\\s*(-i?eq|-i?like|-i?match|==?)\\s*['"]?\\*?${image}`, 'i').test(text)
    if ((selects || filters) && !NARROWED.test(text)) return clip(text)
  }
  return undefined
}

/* ---------------------------------------------------------- scheduled tasks */

export const TASK_CMDLETS = new Set([
  'enable-scheduledtask',
  'disable-scheduledtask',
  'start-scheduledtask',
  'stop-scheduledtask',
  'unregister-scheduledtask',
  'set-scheduledtask',
  'register-scheduledtask',
])

/** A command that changes the scheduled task `task` (by cmdlet or schtasks), with which verbs counting. */
export function changesTask(cmds: readonly Cmd[], task: RegExp, cmdlets: ReadonlySet<string>, schtasks: (flags: string[]) => boolean): string | undefined {
  for (const group of pipelines(cmds)) {
    const text = pipelineText(group)
    if (!task.test(text)) continue
    for (const c of group) {
      if (cmdlets.has(c.name)) return clip(text)
      if (c.name === 'schtasks' && schtasks(c.args.filter(a => /^[-/]/.test(a)).map(flag))) return clip(text)
    }
  }
  return undefined
}

/* -------------------------------------------------------------- disk paths */

export const HOMES = /^(?:~|\$home|\$env:userprofile|\$\{home\}|%userprofile%)(?=[\\/]|$)/i

/** `p` folded to an absolute Windows path (`C:\...`, `.`/`..` folded); undefined when `~` has no home. */
export async function onDisk(p: string, dir: string | undefined, ctx: Ctx): Promise<string | undefined> {
  let abs = joinPath(dir, p)
  if (HOMES.test(abs)) {
    const home = await ctx.home()
    if (home === undefined) return undefined
    abs = abs.replace(HOMES, home.replace(/[\\/]+$/, ''))
  } else if (!isAbsolutePath(abs)) abs = joinPath(await ctx.cwd(), abs)
  abs = abs.replace(/^\/([a-zA-Z])(?=\/|$)/, (_m, d: string) => `${d.toUpperCase()}:`)
  const out: string[] = []
  for (const part of abs.split(/[\\/]+/)) {
    if (part === '.' || (part === '' && out.length > 0)) continue
    if (part === '..' && out.length > 1) out.pop()
    else out.push(part)
  }
  return out.length === 1 ? `${out[0]}\\` : out.join('\\')
}

export const lastName = (p: string): string => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? p

/** Paths `p` names, a `*`/`?` in its last part matched against the folder's entries. */
export async function expand(p: string, ctx: Ctx): Promise<string[]> {
  const name = lastName(p)
  if (!/[*?]/.test(name)) return [p]
  const parent = p.slice(0, p.length - name.length).replace(/[\\/]+$/, '')
  const re = new RegExp(`^${name.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i')
  const list = await ctx.entries(parent)
  return (list ?? []).filter(x => re.test(x.name)).map(x => `${parent}\\${x.name}`)
}

/* -------------------------------------------------------- worktree junction */

/** The parameters whose value is not a path. */
const VALUE_PARAMS = /^-(value|inputobject|encoding|itemtype|type|erroraction|ea|filter|include|exclude|delimiter|stream|credential)$/i
const CMD_SWITCH = /^\/[a-z?]$/i

/** The path arguments of a command: positional words, `-Path` / `-LiteralPath` values, no `/s`-style switches. */
export function pathArgs(cmd: Cmd): string[] {
  const out: string[] = []
  for (let i = 0; i < cmd.args.length; i++) {
    const a = cmd.args[i] as string
    if (VALUE_PARAMS.test(a)) {
      i++
      continue
    }
    if (a.startsWith('-') || CMD_SWITCH.test(a)) continue
    out.push(...a.split(',').map(x => x.trim()).filter(x => x !== ''))
  }
  return out
}

const RECURSE_PS = /^-r(?:e(?:c(?:u(?:r(?:se?)?)?)?)?)?$/i

export type Delete = { cmd: Cmd; isPsRecurse: boolean }

/**
 * A recursive delete (rm -rf, Remove-Item -Recurse, rmdir /s, del /s), and whether it is
 * PowerShell's -Recurse (`isPs`: the call is a PowerShell one, where `rm`/`rmdir` are Remove-Item).
 */
export function recursiveDelete(cmd: Cmd, isPs: boolean): Delete | undefined {
  const n = cmd.name
  if (!['rm', 'rmdir', 'rd', 'del', 'erase', 'remove-item', 'ri'].includes(n)) return undefined
  if (cmd.args.some(a => /^\/s$/i.test(a))) return { cmd, isPsRecurse: false }
  if ((isPs || n === 'remove-item' || n === 'ri') && cmd.args.some(a => RECURSE_PS.test(a))) return { cmd, isPsRecurse: true }
  if (!isPs && n === 'rm' && cmd.args.some(a => /^-[a-zA-Z]*[rR][a-zA-Z]*$/.test(a) || a === '--recursive')) return { cmd, isPsRecurse: false }
  return undefined
}

/** Why each link inside the worktree matters, per call (read by the deny text). */
export const junctionFixes = new WeakMap<object, string[]>()

/** The links among a worktree's top-level entries (node_modules checked on its own too); undefined when unreadable. */
async function linksIn(wt: string, ctx: Ctx): Promise<string[] | undefined> {
  const list = await ctx.entries(wt)
  const links = (list ?? []).filter(x => x.isLink).map(x => `${wt}\\${x.name}`)
  if (!links.some(l => lastName(l).toLowerCase() === 'node_modules')) {
    const nm = await ctx.isLink(`${wt}\\node_modules`)
    if (nm === true) links.push(`${wt}\\node_modules`)
    else if (nm === undefined && list === undefined) return undefined
  }
  return links
}

/** The worktree `git worktree remove` names: a path, or the unique last part of one (`git worktree list`). */
async function namedWorktree(spec: string, repo: string | undefined, ctx: Ctx): Promise<string | undefined> {
  const path = await onDisk(spec, repo, ctx)
  if (path !== undefined && (await ctx.kind(path)) !== undefined) return path
  const listed = await ctx.git((await onDisk('.', repo, ctx)) ?? (await ctx.cwd()), ['worktree', 'list', '--porcelain'])
  const want = normPath(spec).replace(/^\.\//, '')
  const hits = (listed ?? '')
    .split('\n')
    .filter(l => l.startsWith('worktree '))
    .map(l => l.slice(9).trim())
    .filter(w => normPath(w).endsWith(`/${want}`))
  return hits.length === 1 ? (hits[0] as string).replace(/\//g, '\\') : path
}

export async function worktreeJunction(e: ToolInput, ctx: Ctx): Promise<string | undefined> {
  for (const cmd of shellCommands(e)) {
    let targets: string[] = []
    let isExplicit = false
    if (cmd.name === 'git') {
      const git = gitCall(cmd.args)
      if (git?.sub !== 'worktree' || git.args[0]?.toLowerCase() !== 'remove') continue
      const spec = positional(git.args.slice(1))[0]
      if (spec === undefined) continue
      const repo = git.dir !== undefined ? joinPath(cmd.dir, git.dir) : cmd.dir
      const wt = await namedWorktree(spec, repo, ctx)
      if (wt !== undefined) targets = [wt]
      isExplicit = true
    } else {
      const del = recursiveDelete(cmd, e.tool === 'PowerShell')
      if (del === undefined) continue
      for (const arg of pathArgs(cmd)) {
        const p = await onDisk(arg, cmd.dir, ctx)
        if (p === undefined) continue
        for (const one of await expand(p, ctx)) {
          // PowerShell 5.1's Remove-Item -Recurse on the junction itself empties its target too.
          if (del.isPsRecurse && (await ctx.isLink(one)) === true) {
            junctionFixes.set(e, [one])
            return `${clip(cmd.raw)}: ${one} is itself a junction or symlink`
          }
          if ((await ctx.kind(`${one}\\.git`)) === 'file') targets.push(one)
        }
      }
    }
    for (const wt of targets) {
      const links = await linksIn(wt, ctx)
      if (links === undefined) {
        if (isExplicit) throw new Error(`could not read ${wt} to look for a node_modules junction`)
        continue
      }
      if (links.length === 0) continue
      junctionFixes.set(e, links)
      const names = links.map(lastName).join(', ')
      return `${clip(cmd.raw)}: ${names} in ${wt} ${links.length === 1 ? 'is a junction or symlink' : 'are junctions or symlinks'}`
    }
  }
  return undefined
}

/* ------------------------------------------------------ session separation */

const GIT_WRITES = new Set([
  'add', 'commit', 'push', 'rm', 'mv', 'reset', 'restore', 'checkout', 'switch', 'merge', 'rebase',
  'cherry-pick', 'revert', 'stash', 'apply', 'am', 'pull', 'tag', 'clean',
])
const MAKERS = new Set(['mkdir', 'md', 'touch', 'ln', 'mklink'])
const COPIERS = new Set(['cp', 'copy', 'copy-item', 'cpi', 'xcopy', 'robocopy'])

/** Redirect targets in a command's text (`> file`, `>> file`, not `2>&1`). */
export function redirects(raw: string): string[] {
  const out: string[] = []
  for (const m of raw.matchAll(/(?:^|[^>&\d])\d?>>?\s*(?!&)("[^"]+"|'[^']+'|[^\s;|&)]+)/g)) out.push((m[1] as string).replace(/^["']|["']$/g, ''))
  return out
}

/** The files a shell command clearly writes (by path), or the repo a git write runs in. */
export async function shellWrites(cmd: Cmd, ctx: Ctx): Promise<string[]> {
  const n = cmd.name
  let paths: string[] = []
  if (n === 'git') {
    const git = gitCall(cmd.args)
    if (git !== undefined && GIT_WRITES.has(git.sub)) paths.push(git.dir ?? '.')
  } else if (COPIERS.has(n)) {
    const dest = paramValues(cmd.args, /^-(destination|dest|d)$/i)
    const pos = pathArgs(cmd)
    paths = n === 'robocopy' ? pos.slice(1, 2) : dest.length > 0 ? dest : pos.slice(-1)
  } else if (DELETERS.has(n) || MOVERS.has(n) || WRITERS.has(n) || MAKERS.has(n)) {
    paths = pathArgs(cmd)
  } else if ((n === 'sed' || n === 'perl') && cmd.args.some(a => /^-[a-z]*i/.test(a) || a.startsWith('--in-place'))) {
    paths = pathArgs(cmd)
  }
  paths.push(...redirects(cmd.raw))
  const out: string[] = []
  for (const p of paths) {
    if (/^(\$null|nul|\/dev\/null)$/i.test(p)) continue
    const abs = await onDisk(p, cmd.dir, ctx)
    if (abs !== undefined) out.push(abs)
  }
  return out
}

/**
 * A check that keeps projects in separate sessions: the first write to a project (`projectOf`
 * its path) pins the session; a write to another one is the hit. `name` is a project's display name.
 */
export function sessionSeparation(
  projectOf: (path: string) => Project | undefined,
  name: (project: Project) => string,
): (e: ToolInput, ctx: Ctx) => Promise<string | undefined> {
  return async (e, ctx) => {
    const writes: { project: Project; what: string }[] = []
    const file = typeof e.file_path === 'string' ? e.file_path : typeof e.notebook_path === 'string' ? e.notebook_path : undefined
    if (file !== undefined) {
      const abs = await onDisk(file, undefined, ctx)
      const project = abs === undefined ? undefined : projectOf(abs)
      if (project !== undefined) writes.push({ project, what: `${e.tool} ${clip(abs ?? file, 100)}` })
    }
    for (const cmd of shellCommands(e)) {
      for (const abs of await shellWrites(cmd, ctx)) {
        const project = projectOf(abs)
        if (project !== undefined) writes.push({ project, what: clip(cmd.raw, 100) })
      }
    }
    const first = writes[0]
    if (first === undefined) return undefined
    const pin = await ctx.pin(first.project, first.what)
    const other = writes.find(w => w.project !== pin.project)
    if (other === undefined) return undefined
    return `${other.what} writes to ${name(other.project)}, but this session is pinned to ${name(pin.project)} (its first write: ${clip(pin.by, 80)})`
  }
}

export function laneName(description: string): string {
  const slug = description
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24)
    .replace(/-+$/, '')
  return slug === '' ? 'name' : slug
}

export function toolMatches(rule: Rule, tool: string): boolean {
  return rule.tools instanceof RegExp ? rule.tools.test(tool) : rule.tools.includes(tool)
}

/* ------------------------------------------------------------------ hook bypass */

/** The git subcommands whose hooks `--no-verify` skips (commit also takes `-n`). */
const NO_VERIFY_SUBS = new Set(['commit', 'push', 'merge', 'pull', 'am'])
/** Global or config options that take the next word as their value. */
const CONFIG_VALUE_OPTS = new Set(['-f', '--file', '--blob', '--type', '--default', '--comment', '--value'])
/** Short commit options that take a value, glued (`-mfix`) or as the next word: a bundle stops there. */
const COMMIT_VALUE_SHORTS = new Set(['m', 'F', 'C', 'c', 't'])
/** Short commit options whose value is optional and only ever glued (`-Skey`, `-uno`): a bundle stops there too. */
const COMMIT_OPTIONAL_SHORTS = new Set(['S', 'u'])
const COMMIT_VALUE_LONGS = new Set(['--message', '--file', '--author', '--date', '--reuse-message', '--reedit-message', '--template', '--fixup', '--squash', '--trailer', '--cleanup', '--pathspec-from-file'])
const isHooksPath = (key: string | undefined): boolean => /^core\.hookspath$/i.test(key ?? '')
const isNoVerify = (a: string): boolean => a.length >= 9 && '--no-verify'.startsWith(a)
const ENV_OVERRIDE = /\b(?:OSS_GUARD_(?:CONFIG_DIR|GITLEAKS)|GIT_CONFIG_(?:PARAMETERS|COUNT|KEY_\d+))\b/

/** Whether one git command skips or rewires the repo's hooks: `-c core.hooksPath=`, `commit -n`, `--no-verify`,
 *  or a `git config` write to core.hooksPath (set, unset, add, replace, edit, or the whole core section). */
export function skipsHooks(cmd: Cmd, commandText = ''): boolean {
  if (cmd.name !== 'git') return false
  const a = cmd.args
  let i = 0
  for (; i < a.length; i++) {
    const w = a[i] as string
    if (w === '-c' || w === '--config-env') {
      if (isHooksPath(a[i + 1]?.split('=')[0])) return true
      i++
      continue
    }
    const glued = /^(?:-c|--config-env=)(.+)$/.exec(w)
    if (glued !== null) {
      if (isHooksPath(glued[1]?.split('=')[0])) return true
      continue
    }
    if (w === '-C' || w === '--git-dir' || w === '--work-tree' || w === '--namespace' || w === '--exec-path') {
      i++
      continue
    }
    if (!w.startsWith('-')) break
  }
  const sub = a[i]?.toLowerCase()
  const rest = a.slice(i + 1)
  if (sub === undefined) return false
  if (NO_VERIFY_SUBS.has(sub)) {
    if (ENV_OVERRIDE.test(commandText)) return true
    for (let j = 0; j < rest.length; j++) {
      const w = rest[j] as string
      if (w === '--') break
      if (isNoVerify(w)) return true
      if (sub !== 'commit') continue
      if (COMMIT_VALUE_LONGS.has(w)) {
        j++
        continue
      }
      if (/^-[^-]/.test(w)) {
        for (const ch of w.slice(1)) {
          if (ch === 'n') return true
          if (COMMIT_OPTIONAL_SHORTS.has(ch)) break
          if (COMMIT_VALUE_SHORTS.has(ch)) {
            if (w.endsWith(ch)) j++
            break
          }
        }
      }
    }
    return false
  }
  if (sub !== 'config') return false
  const flags: string[] = []
  const pos: string[] = []
  for (let j = 0; j < rest.length; j++) {
    const w = rest[j] as string
    if (CONFIG_VALUE_OPTS.has(w)) {
      j++
      continue
    }
    if (w.startsWith('-')) flags.push(w.split('=')[0] as string)
    else pos.push(w)
  }
  const has = (...f: string[]): boolean => f.some(x => flags.includes(x))
  const verb = pos[0]?.toLowerCase()
  if (verb === 'edit' || has('-e', '--edit')) return true
  if (verb === 'set' || verb === 'unset') return isHooksPath(pos[1])
  if (verb === 'remove-section' || verb === 'rename-section') return pos[1]?.toLowerCase() === 'core'
  if (has('--remove-section', '--rename-section')) return pos[0]?.toLowerCase() === 'core'
  if (!isHooksPath(pos[0])) return false
  return pos.length >= 2 || has('--unset', '--unset-all', '--replace-all', '--add')
}

/** A rule check: the first command that skips the hooks of a repo `guarded` says is guarded (where it runs, `-C` included). */
export function hookBypass(guarded: (dir: string, ctx: Ctx) => Promise<boolean>): (e: ToolInput, ctx: Ctx) => Promise<string | undefined> {
  return async (e, ctx) => {
    const text = typeof e.command === 'string' ? e.command : ''
    for (const cmd of shellCommands(e)) {
      if (!skipsHooks(cmd, text)) continue
      const call = gitCall(cmd.args)
      const base = await absolute(cmd.dir, ctx)
      const dir = call?.dir === undefined ? base : isAbsolutePath(call.dir) ? call.dir : joinPath(base, call.dir)
      if (await guarded(dir, ctx)) return clip(cmd.raw)
    }
    return undefined
  }
}

/** A repo whose guard installer marked it (`git config --local oss-guard.enabled true`) or whose hooksPath is the guard's. */
export async function hasOssGuard(dir: string, ctx: Ctx): Promise<boolean> {
  if ((await ctx.git(dir, ['config', '--get', 'oss-guard.enabled'])) === 'true') return true
  return /oss-guard/i.test((await ctx.git(dir, ['config', '--get', 'core.hooksPath'])) ?? '')
}

/** "skip the hooks this once", "use --no-verify here", "bypass oss-guard": the user waiving a commit guard. */
export function approvesHookBypass(text: string): boolean {
  return says(text, /\b(?:hooks?|no-verify|oss-guard|guard)\b/i, 'skip|bypass|disable|turn\\s+off|uninstall|use')
}
