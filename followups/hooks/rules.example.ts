// Example rules. To use them: cp hooks/rules.example.ts hooks/rules.local.ts
// (rules.local.ts is gitignored; register.tsx imports RULES and TOOL_EXAMPLES
// from it), then replace them with your own "after X, always do Y" rules.
//
// One rule is triggered by an edit, one by a command. Each opens an item only
// from a successful call and closes it from a later one; where the obligation
// is a fact git or the disk can answer, the rule asks instead of guessing from
// command text. The types and helpers they use are in rules.ts.

import type { Hit } from './items'
import { dirOf, gitCall, resolvePath, short, under } from './rules'
import type { Ctx, Rule } from './rules'
import type { Cmd } from './shell'

/** False in a real rules.local.ts; only the tracked fallback (hooks/rules.local/index.ts) says true. */
export const LOCAL_MISSING = false

/** The examples the Followups tool's description gives (model-facing): name your own rules here. */
export const TOOL_EXAMPLES = '(run npm install after a package.json edit, push after a commit in a configured repo, ...).'

/* ------------------------------------------ edit-triggered: package.json */

const PACKAGE_JSON = '/package.json'

/** `npm install`, `npm i` or `npm ci`. */
const isNpmInstall = (cmd: Cmd): boolean => {
  const sub = cmd.args[0]?.toLowerCase()
  return cmd.name === 'npm' && (sub === 'install' || sub === 'i' || sub === 'ci')
}

const npmInstall: Rule = {
  id: 'npm-install',
  summary: 'package.json edited -> run npm install in its folder',
  source: 'example rule (rules.example.ts)',
  async open(call) {
    if (call.kind !== 'edit' || !call.path.endsWith(PACKAGE_JSON) || call.path.includes('/node_modules/')) return []
    const dir = call.path.slice(0, -PACKAGE_JSON.length)
    return [
      {
        rule: 'npm-install',
        // One item per folder: a second edit to the same package.json merges into it.
        key: `npm-install:${dir}`,
        label: 'npm install',
        how: `run npm install in ${dir} so the lockfile and node_modules match package.json`,
        trigger: call.name,
      },
    ]
  },
  async progress(call, item, ctx) {
    if (call.kind !== 'shell') return undefined
    const dir = item.key.slice('npm-install:'.length)
    // Only an install in that folder counts: a `cd` on the line, else the session's directory.
    const cmd = call.cmds.find(c => isNpmInstall(c) && dirOf(c, ctx.cwd) === dir)
    return cmd === undefined ? undefined : { steps: ['done'], evidence: short(cmd.raw, 100) }
  },
}

/* --------------------------------------- command-triggered: commit, push */

/** Repos whose commits should always reach their upstream, written as you would type them (`~` works). */
const PUSH_REPOS: readonly string[] = ['~/projects/my-app']

/** Commits HEAD has that its upstream lacks, or undefined when git cannot say. */
async function ahead(ctx: Ctx, repo: string): Promise<number | undefined> {
  const out = await ctx.git(repo, ['rev-list', '--count', '@{upstream}..HEAD'])
  return out === undefined || !/^\d+$/.test(out) ? undefined : Number(out)
}

const pushAfterCommit: Rule = {
  id: 'push-after-commit',
  summary: 'commit in a configured repo -> push it (checked with git rev-list)',
  source: 'example rule (rules.example.ts)',
  async open(call, ctx) {
    if (call.kind !== 'shell') return []
    // Resolved per call: `~` expands to the home the hooks read from the environment.
    const repos = PUSH_REPOS.map(r => resolvePath(r, ctx.cwd))
    const hits: Hit[] = []
    for (const cmd of call.cmds) {
      const g = gitCall(cmd, ctx.cwd)
      if (g === undefined || g.sub !== 'commit') continue
      const repo = repos.find(r => under(g.repo, r))
      if (repo === undefined || hits.some(h => h.key === `push-after-commit:${repo}`)) continue
      // A commit pushed later on the same line leaves nothing owed.
      const n = await ahead(ctx, repo)
      if (n === 0) continue
      if (n === undefined) ctx.warn(`followups: could not count the commits ${repo} is ahead of its upstream; opened the push item anyway`)
      hits.push({
        rule: 'push-after-commit',
        key: `push-after-commit:${repo}`,
        label: `push ${repo.split('/').pop() ?? repo}`,
        how: `git -C ${repo} push (check no secret file is tracked first)`,
        trigger: 'git commit',
      })
    }
    return hits
  },
  async progress(call, item, ctx) {
    if (call.kind !== 'shell' || !call.cmds.some(c => gitCall(c, ctx.cwd)?.sub === 'push')) return undefined
    const repo = item.key.slice('push-after-commit:'.length)
    return (await ahead(ctx, repo)) === 0 ? { steps: ['done'], evidence: `${repo} is level with its upstream` } : undefined
  },
}

export const RULES: readonly Rule[] = [npmInstall, pushAfterCommit]
