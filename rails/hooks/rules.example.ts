// Example rails rules. rails loads its rules from rules.local.ts (machine-local,
// gitignored), so start yours from this file and make it your own:
//
//   cp hooks/rules.example.ts hooks/rules.local.ts
//
// Each rule turns one "never do X" into a tool.call check: an id, the tools it
// reads, a check that returns what matched (undefined when the call is fine),
// an optional unlock (the user's own latest prompt authorizes the action for a
// while), and the deny text the model reads. Rules run in order; keep
// session-separation last, since its check pins the session to a project.
// The placeholders (your-name/your-app, ~/code/your-app, ~/code/your-site) are
// meant to be replaced.

import {
  HOMES,
  MIN,
  SHELLS,
  approvesHookBypass,
  approvesPush,
  clip,
  hasOssGuard,
  hookBypass,
  junctionFixes,
  killsByName,
  liveBacktick,
  paramValues,
  pipelineText,
  pipelines,
  pushesTo,
  says,
  sessionSeparation,
  shellCommands,
  worktreeJunction,
} from './rules'
import type { PinText, Project, Rule } from './rules'
import { normPath, programName } from './shell'

/** The repo whose `main` branch is production (a push or a merged PR deploys it). */
const PRODUCTION = {
  url: /github\.com[/:]your-name\/your-app(?:\.git)?\/?$/i,
  slug: /(^|\/)your-name\/your-app$/i,
  isPath: (p: string): boolean => normPath(p).split('/').includes('your-app'),
  branch: 'main',
  note: ', which deploys to production',
}

/** The projects session-separation keeps apart, by folder under ~/code, with their display names. */
const PROJECTS = new Map<Project, string>([
  ['your-app', 'your-app'],
  ['your-site', 'your-site'],
])

/** Which project a path is in: ~/code/your-app or ~/code/your-site (and anything inside them). */
export function projectOf(p: string): Project | undefined {
  const m = /^(?:[a-z]:)?\/users\/[^/]+\/code\/([^/]+)(?:\/|$)/.exec(normPath(p).replace(HOMES, 'c:/users/~'))
  const name = m?.[1]
  return name !== undefined && PROJECTS.has(name) ? name : undefined
}

/** "work on both projects here": the user explicitly mixing them in one session. */
export function approvesBoth(text: string): boolean {
  if (/\b(?:separate|apart|split|relay|hand\s+(?:it\s+)?(?:off|over|back))\b/i.test(text)) return false
  return says(text, /\bboth\s+(?:projects|repos|of\s+them)\b/i, 'work|working|edit|fix|do|change|handle|touch|build|update|mix|commit|both')
}

/** False in every real rules.local.ts (a copy of this file included); true only in the tracked fallback, rules.local/index.ts. */
export const LOCAL_MISSING = false

/** How /rails shows the session's project pin; null hides the line (a rule set without session-separation). */
export const PIN_TEXT: PinText | null = {
  none: 'none yet (the first write to a project pins the session)',
  name: project => PROJECTS.get(project) ?? project,
}

export const RULES: readonly Rule[] = [
  {
    id: 'protected-push',
    summary: 'git push / gh pr merge that reaches the production branch (main) of your-name/your-app',
    source: 'example: production pushes are the user\'s call',
    tools: SHELLS,
    check: pushesTo(PRODUCTION),
    unlock: { test: approvesPush, ms: 60 * MIN, hint: 'the user says "go" (or "push" / "ship it")' },
    reason: hit =>
      `${hit}. That branch is PRODUCTION and pushing it is the user's call every time. Show them the diff and the test summary, ask in one line ("Push <what> to production?"), and push only after they answer "go". Pushing another branch is fine: name it explicitly (git push origin my-feature).`,
  },
  {
    id: 'live-backtick',
    summary: 'a live backtick (command substitution) in a Bash command',
    source: 'example: backticks run, even inside double quotes',
    tools: ['Bash'],
    check: liveBacktick,
    reason: hit =>
      `${hit} is command substitution: bash RUNS it, even inside double quotes, so a backticked command inside a commit message or a node -e string runs before the outer command does. For text that contains backticks use single quotes, a quoted heredoc (<<'EOF'), or the Write tool; to substitute a command on purpose write $(...).`,
  },
  {
    id: 'kill-by-name',
    summary: 'killing claude.exe by image name (taskkill /IM, Stop-Process -Name, pkill)',
    source: 'example: other sessions share the image name',
    tools: SHELLS,
    check: e => killsByName(e, 'claude'),
    reason: hit =>
      `${hit} kills every instance by name: the user's other Claude Code sessions (and this one) are all claude.exe. Kill by PID only: find the one you started (Get-CimInstance Win32_Process -Filter "Name='claude.exe'" | Where-Object { $_.CommandLine -like '*<your marker>*' }) and Stop-Process -Id <pid>.`,
  },
  {
    id: 'startup-run-delete',
    summary: 'deleting a Windows startup Run value (Remove-ItemProperty / reg delete on ...\\CurrentVersion\\Run)',
    source: 'example: disable startup apps, never delete them',
    tools: SHELLS,
    check: e => {
      const run = /currentversion\/run(once)?(\/|$)/
      for (const group of pipelines(shellCommands(e))) {
        const mentions = group.some(c => c.args.some(a => run.test(normPath(a))))
        if (!mentions) continue
        for (const c of group) {
          if (['remove-itemproperty', 'rp', 'clear-itemproperty', 'clp', 'remove-item', 'ri', 'del', 'erase'].includes(c.name)) return clip(pipelineText(group))
          if (c.name === 'reg' && /^delete$/i.test(c.args[0] ?? '')) return clip(c.raw)
        }
      }
      return undefined
    },
    unlock: {
      test: t => says(t, /\brun\s+(?:value|key|entr)/i, 'delete|remove'),
      ms: 30 * MIN,
      hint: 'the user explicitly asks to delete that Run value',
    },
    reason: hit =>
      `${hit} DELETES a startup entry, which removes the app from Settings > Startup Apps for good. To stop an app starting, DISABLE it: set its byte under HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run to 03.`,
  },
  {
    id: 'repo-public',
    summary: 'making a GitHub repo public (gh repo create --public, gh repo edit --visibility public)',
    source: 'example: repos stay private unless the user says otherwise',
    tools: SHELLS,
    check: e => {
      for (const c of shellCommands(e)) {
        if (c.name !== 'gh') continue
        const [a0, a1] = c.args
        if (a0 === 'repo' && a1 === 'create' && c.args.includes('--public')) return clip(c.raw)
        if (a0 === 'repo' && a1 === 'edit' && (c.args.includes('--visibility=public') || paramValues(c.args, /^--visibility$/)[0] === 'public')) return clip(c.raw)
        if (a0 === 'api' && c.args.some(a => /^(private=false|visibility=public)$/i.test(a))) return clip(c.raw)
      }
      return undefined
    },
    unlock: {
      test: t => says(t, /\b(?:public|open[- ]?source)\b/i, 'public|open[- ]?source'),
      ms: 30 * MIN,
      hint: 'the user says to make that repo public',
    },
    reason: hit =>
      `${hit} makes a repo public. Going public is the user's decision, repo by repo, and an old history can carry secrets (a fresh-history repo is the safe route). Create it --private.`,
  },
  {
    id: 'prisma-prod-wipe',
    summary: 'prisma migrate reset / db push --force-reset|--accept-data-loss / --shadow-database-url at the prod DB',
    source: 'example: .env may point at production',
    tools: SHELLS,
    check: e => {
      const text = typeof e.command === 'string' ? e.command : ''
      const isLocal = /DATABASE_URL\s*=\s*["']?(?:["']|(?:postgres(?:ql)?|prisma\+postgres):\/\/(?:[^\s"'@]*@)?(?:localhost|127\.0\.0\.1|\[::1\])|file:)/i.test(text)
      for (const c of shellCommands(e)) {
        const all = [c.name, ...c.args]
        const at = all.findIndex(w => programName(w) === 'prisma')
        if (at < 0) continue
        const rest = all.slice(at + 1).map(w => w.toLowerCase())
        const shadow = rest.findIndex(w => w.startsWith('--shadow-database-url'))
        if (shadow >= 0) {
          const value = rest[shadow]?.includes('=') ? rest[shadow]?.split('=').slice(1).join('=') : rest[shadow + 1]
          if (/prod|database_url/i.test(value ?? '')) return clip(c.raw)
        }
        const isReset = rest[0] === 'migrate' && rest[1] === 'reset'
        const isForce = rest[0] === 'db' && rest[1] === 'push' && rest.some(w => w === '--force-reset' || w === '--accept-data-loss')
        if ((isReset || isForce) && !isLocal) return clip(c.raw)
      }
      return undefined
    },
    reason: hit =>
      `${hit} can wipe the database DATABASE_URL points at, and when .env points at production that is real users' data. Point it at a scratch DB inline (DATABASE_URL="postgresql://...@localhost..."), use --from-url to read, never --shadow-database-url at prod.`,
  },
  {
    id: 'worktree-junction',
    summary: 'git worktree remove / rm -rf / Remove-Item -Recurse / rmdir /s on a worktree whose node_modules is a junction',
    source: 'example: a recursive delete follows junctions',
    tools: SHELLS,
    check: worktreeJunction,
    reason: (hit, e) => {
      const links = junctionFixes.get(e) ?? []
      const fix = links.map(l => `cmd /c rmdir "${l}"`).join('; ')
      return `${hit}. A recursive delete follows a junction and deletes the REAL folder it points at (a worktree whose node_modules links to the main checkout takes the main checkout's node_modules with it). Remove the link itself first, which deletes only the link: ${fix} (from Git Bash: cmd //c rmdir ...). Then run the same command again; rails passes it once the link is gone.`
    },
  },
  {
    id: 'hook-bypass',
    summary: 'skipping the commit/push hooks in a repo with a private-info guard (--no-verify, commit -n, -c core.hooksPath=..., changing or unsetting core.hooksPath)',
    source: 'example: every commit to a public repo is checked for private info first',
    tools: SHELLS,
    check: hookBypass(hasOssGuard),
    unlock: { test: approvesHookBypass, ms: 10 * MIN, hint: 'the user explicitly says to skip the hooks this time' },
    reason: hit =>
      `${hit} skips the hooks of a repo whose pre-commit / commit-msg / pre-push guard checks every commit for private info before it can reach a public repo. Commit and push normally. If the guard blocks, fix what it names (file:line and category); if it is a false positive, add a precise entry to the guard's allowlist. Turning the guard off is the user's call.`,
  },
  // Last: its check pins the session to the project of its first write.
  {
    id: 'session-separation',
    summary: 'writing to one project in a session pinned to another (the first project write pins the session)',
    source: 'example: one project per session',
    tools: [...SHELLS, 'Edit', 'Write', 'NotebookEdit'],
    check: sessionSeparation(projectOf, project => PROJECTS.get(project) ?? project),
    unlock: { test: approvesBoth, ms: 60 * MIN, hint: 'the user explicitly says to work on both projects in this session' },
    reason: hit =>
      `${hit}. These projects never share a session: their rules differ, and a session holding both applies the wrong one. Do not edit, stage or commit the other repo "just this once": hand it back to the user for a separate session. Reading it (Read, Grep, git status, git log) is fine.`,
  },
]
