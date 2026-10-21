// rails' tracked tests, independent of whose rules are loaded:
//  1. the generic helpers and mechanisms in hooks/rules.ts, called directly;
//  2. the example rule set in hooks/rules.example.ts, called directly;
//  3. the plugin's plumbing (/rails list, allow, off, on; denies; prompt
//     unlocks) through the engine, over whatever rules hooks/rules.local.ts holds.

import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type { On, PromptOrigin } from 'claude-code'

import {
  TASK_CMDLETS,
  approvesHookBypass,
  approvesPush,
  approvesTrade,
  changesTask,
  gitCall,
  junctionFixes,
  killsByName,
  liveBacktick,
  onDisk,
  pushTarget,
  pushesTo,
  recursiveDelete,
  says,
  sessionSeparation,
  shellCommands,
  skipsHooks,
  toolMatches,
  worktreeJunction,
} from '../hooks/rules'
import type { Ctx, Project, Rule, ToolInput } from '../hooks/rules'
import { PIN_TEXT as EXAMPLE_PIN_TEXT, LOCAL_MISSING as EXAMPLE_LOCAL_MISSING, RULES as EXAMPLE, approvesBoth, projectOf } from '../hooks/rules.example'
// The active rule set, as register.ts loads it: hooks/rules.local.ts, or the tracked fallback when that is missing.
import { LOCAL_MISSING, PIN_TEXT, RULES } from '../hooks/rules.local'
import * as FALLBACK from '../hooks/rules.local/index'
import { DEFAULT_NAME, USER_FILE, capital, parseUser, possessive, userFile, userWarning } from '../hooks/user'

/** The name the test world's user.local.json gives (the name setting, hooks/user.ts). */
const NAME = 'Alex'
const HOME = 'C:\\Users\\you'
const WORK = 'C:\\Users\\you\\work'
const APP = 'C:\\Users\\you\\code\\your-app'
const SITE = 'C:\\Users\\you\\code\\your-site'
const MIN = 60_000

type Disk = Record<string, 'dir' | 'file' | 'link'>

type FakeCtx = Ctx & { pins: [Project, string][] }

/** A deterministic Ctx: `git` answers by its args joined with spaces, `disk` says what exists. */
function fakeCtx(o: { cwd?: string; git?: Record<string, string>; disk?: Disk; isModelCall?: boolean } = {}): FakeCtx {
  const key = (p: string) => p.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
  const disk = new Map(Object.entries(o.disk ?? {}).map(([k, v]) => [key(k), { name: k, kind: v }] as const))
  let pinned: { project: Project; by: string } | undefined
  const pins: [Project, string][] = []
  return {
    pins,
    isModelCall: o.isModelCall ?? true,
    cwd: async () => o.cwd ?? HOME,
    git: async (_dir, args) => o.git?.[args.join(' ')],
    home: async () => HOME,
    kind: async p => disk.get(key(p))?.kind,
    entries: async dir => {
      const d = key(dir)
      if (disk.get(d)?.kind !== 'dir') return undefined
      return [...disk]
        .filter(([k]) => k.startsWith(`${d}\\`) && !k.slice(d.length + 1).includes('\\'))
        .map(([, v]) => ({ name: v.name.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? v.name, isLink: v.kind === 'link' }))
    },
    isLink: async p => disk.get(key(p))?.kind === 'link',
    pin: async (project, by) => {
      pins.push([project, by])
      pinned ??= { project, by }
      return pinned
    },
  }
}

const bashIn = (command: string): ToolInput => ({ tool: 'Bash', command })
const psIn = (command: string): ToolInput => ({ tool: 'PowerShell', command })
const editIn = (file_path: string): ToolInput => ({ tool: 'Edit', file_path, old_string: 'a', new_string: 'b' })

/* ------------------------------------------------------- 1. generic helpers */

describe('prompt helpers', () => {
  test('approvesPush: release words, not negations, conditions or questions', () => {
    for (const t of ['go', 'ok go', 'yes, go ahead', 'ok push', 'ship it', 'push everything', 'deploy it now']) expect(approvesPush(t)).toBe(true)
    for (const t of ["don't push yet", 'push only on go', 'did you push?', 'go check the logs', '/ship', 'wait to push until the tests pass']) {
      expect(approvesPush(t)).toBe(false)
    }
  })

  test('approvesTrade: a confirmation, not a cancel, a negation or a question', () => {
    for (const t of ['buy it', 'yes', 'confirm', 'do it', 'sell 5 shares']) expect(approvesTrade(t)).toBe(true)
    for (const t of ['cancel that', "don't buy it", 'should I buy?', 'hold off', '/buy']) expect(approvesTrade(t)).toBe(false)
  })

  test('says: topic and verb in a short prompt, neither negated nor asked', () => {
    expect(says('restart explorer please', /\bexplorer\b/i, 'restart')).toBe(true)
    expect(says("don't restart explorer", /\bexplorer\b/i, 'restart')).toBe(false)
    expect(says('did you restart explorer?', /\bexplorer\b/i, 'restart')).toBe(false)
    expect(says('can you restart explorer?', /\bexplorer\b/i, 'restart')).toBe(true)
    expect(says('restart it', /\bexplorer\b/i, 'restart')).toBe(false)
    expect(says(`restart explorer ${'and more '.repeat(30)}`, /\bexplorer\b/i, 'restart')).toBe(false)
  })
})

describe('shell and git parsing', () => {
  test('shellCommands reads cd, pipelines and nested shells', () => {
    const cmds = shellCommands(bashIn('cd /c/repo && git push origin main | tee log.txt'))
    expect(cmds.map(c => c.name)).toEqual(['cd', 'git', 'tee'])
    expect(cmds[1]?.dir).toBe('/c/repo')
    expect(cmds[1]?.pipeline).toBe(cmds[2]?.pipeline)
    expect(shellCommands(psIn('powershell -Command "Stop-Process -Name foo"')).map(c => c.name)).toEqual(['stop-process'])
    expect(shellCommands(editIn('C:\\x.ts'))).toEqual([])
  })

  test('gitCall finds the subcommand past -C and -c', () => {
    expect(gitCall(['-C', 'C:/repo', '-c', 'x=y', 'push', 'origin', 'main'])).toEqual({ sub: 'push', args: ['origin', 'main'], dir: 'C:/repo' })
    expect(gitCall(['--git-dir=/r/.git', 'status'])).toEqual({ sub: 'status', args: [], dir: '/r/.git' })
    expect(gitCall(['--version'])).toBeUndefined()
  })
  test('skipsHooks: the ways a git call skips or rewires hooks, and look-alikes that do not', () => {
    const skips = (cmd: string) => shellCommands(bashIn(cmd)).some(c => skipsHooks(c, cmd))
    for (const yes of [
      'git commit -n -m x',
      'git commit -anm x',
      'git commit --no-verif -m x',
      'git -C repo commit -S -n -m x',
      'git push --no-verify',
      'git merge --no-verify topic',
      'git -ccore.hooksPath=x commit -m x',
      'git --config-env core.hooksPath=HP commit -m x',
      'git config --global core.hooksPath ~/hooks',
      'git config --replace-all core.hooksPath x',
      'git config set core.hooksPath x',
      'git config --remove-section core',
      'git config -e',
      'GIT_CONFIG_PARAMETERS="\'core.hooksPath\'=\'x\'" git commit -m x',
    ]) expect([yes, skips(yes)]).toEqual([yes, true])
    for (const no of [
      'git commit -m "-n"',
      'git commit -mn',
      'git commit -F -n',
      'git commit --message --no-verify',
      'git push -n origin main',
      'git log -n 5',
      'git config core.hooksPath',
      'git config --get core.hooksPath',
      'git config --show-origin --get-all core.hooksPath',
      'git config user.name x',
      'git -c core.editor=vim commit -m x',
    ]) expect([no, skips(no)]).toEqual([no, false])
  })

  test('pushTarget: what can reach the branch', () => {
    expect(pushTarget(['origin', 'phase2'])).toEqual({ remote: 'origin' })
    expect(pushTarget(['origin', 'main:master']).why).toBe('main:master updates master')
    expect(pushTarget(['origin', 'x:main'], 'main', ', which deploys').why).toBe('x:main updates main, which deploys')
    expect(pushTarget(['origin', 'refs/heads/main'], 'main').why).toBe('refs/heads/main updates main')
    expect(pushTarget(['--all'], 'main').why).toBe('--all pushes every branch, main included')
    expect(pushTarget(['origin', 'feature/*'], 'main').why).toBeDefined()
    expect(pushTarget(['--dry-run', 'origin', 'main'], 'main')).toEqual({})
    expect(pushTarget(['--tags', 'origin'])).toEqual({})
    expect(pushTarget(['origin'])).toEqual({ remote: 'origin', why: 'names no branch, so it pushes what is checked out', depends: 'upstream' })
    expect(pushTarget(['origin', 'HEAD']).depends).toBe('head')
  })

  test('liveBacktick: live command substitution only', () => {
    expect(liveBacktick(bashIn('echo `date`'))).toContain('date')
    expect(liveBacktick(bashIn("echo '`date`'"))).toBeUndefined()
    expect(liveBacktick(bashIn('echo $(date)'))).toBeUndefined()
  })

  test('recursiveDelete: rm -rf, Remove-Item -Recurse, rmdir /s', () => {
    const one = (src: string, isPs: boolean) => {
      const cmd = shellCommands(isPs ? psIn(src) : bashIn(src))[0]
      return cmd === undefined ? undefined : recursiveDelete(cmd, isPs)
    }
    expect(one('rm -rf dist', false)?.isPsRecurse).toBe(false)
    expect(one('Remove-Item -Recurse -Force dist', true)?.isPsRecurse).toBe(true)
    expect(one('rm dist -r', true)?.isPsRecurse).toBe(true)
    expect(one('rmdir /s /q dist', true)?.isPsRecurse).toBe(false)
    expect(one('rm notes.txt', false)).toBeUndefined()
  })

  test('onDisk folds ~, relative paths and Git Bash drives', async () => {
    const ctx = fakeCtx({ cwd: WORK })
    expect(await onDisk('~/code/x', undefined, ctx)).toBe(`${HOME}\\code\\x`)
    expect(await onDisk('../y/./z', undefined, ctx)).toBe(`${HOME}\\y\\z`)
    expect(await onDisk('/c/Users/you/a', undefined, ctx)).toBe('C:\\Users\\you\\a')
  })

  test('toolMatches: a list of names or a pattern', () => {
    const named = { tools: ['Bash'] } as unknown as Rule
    const pattern = { tools: /^mcp__.*__place_order$/ } as unknown as Rule
    expect(toolMatches(named, 'Bash')).toBe(true)
    expect(toolMatches(named, 'PowerShell')).toBe(false)
    expect(toolMatches(pattern, 'mcp__broker__place_order')).toBe(true)
    expect(toolMatches(pattern, 'mcp__broker__get_quote')).toBe(false)
  })
})

describe('kills and scheduled tasks', () => {
  test('killsByName: by image name, not by PID or a narrowed selection', () => {
    for (const src of ['taskkill /IM foo.exe /F', 'Stop-Process -Name foo -Force', 'Get-Process foo | Stop-Process']) {
      expect(killsByName(psIn(src), 'foo')).toBeDefined()
    }
    expect(killsByName(bashIn('pkill foo'), 'foo')).toBeDefined()
    expect(killsByName(bashIn('kill $(pgrep foo)'), 'foo')).toBeDefined()
    for (const src of ['Stop-Process -Id 1234 -Force', 'taskkill /IM bar.exe', 'Get-Process foo | Select-Object Id', "Get-CimInstance Win32_Process -Filter \"Name='foo.exe'\" | Where-Object { $_.CommandLine -like '*mine*' } | Stop-Process"]) {
      expect(killsByName(psIn(src), 'foo')).toBeUndefined()
    }
  })

  test('changesTask: the cmdlets and schtasks verbs that count', () => {
    const verbs = (f: string[]) => f.some(x => ['run', 'end', 'delete', 'change', 'create'].includes(x))
    const of = (src: string) => changesTask(shellCommands(psIn(src)), /mytask/i, TASK_CMDLETS, verbs)
    expect(of('Disable-ScheduledTask -TaskName MyTask')).toBeDefined()
    expect(of('schtasks /Run /TN MyTask')).toBeDefined()
    expect(of('schtasks /Query /TN MyTask')).toBeUndefined()
    expect(of('Get-ScheduledTask -TaskName MyTask')).toBeUndefined()
    expect(of('Disable-ScheduledTask -TaskName Other')).toBeUndefined()
  })
})

describe('worktreeJunction', () => {
  const WT = `${HOME}\\code\\wt`
  const linked: Disk = { [WT]: 'dir', [`${WT}\\.git`]: 'file', [`${WT}\\node_modules`]: 'link' }
  const plain: Disk = { [WT]: 'dir', [`${WT}\\.git`]: 'file', [`${WT}\\node_modules`]: 'dir' }

  test('a recursive delete of a worktree holding a junction is the hit, with the link to remove', async () => {
    const e = bashIn('rm -rf ~/code/wt')
    const hit = await worktreeJunction(e, fakeCtx({ disk: linked }))
    expect(hit).toContain('node_modules')
    expect(junctionFixes.get(e)).toEqual([`${WT}\\node_modules`])
    expect(await worktreeJunction(psIn(`Remove-Item -Recurse -Force ${WT}`), fakeCtx({ disk: linked }))).toBeDefined()
    expect(await worktreeJunction(bashIn('git worktree remove --force C:/Users/you/code/wt'), fakeCtx({ disk: linked }))).toBeDefined()
  })

  test('a worktree with its own node_modules, or a non-recursive delete, passes', async () => {
    expect(await worktreeJunction(bashIn('rm -rf ~/code/wt'), fakeCtx({ disk: plain }))).toBeUndefined()
    expect(await worktreeJunction(bashIn('rm ~/code/wt/notes.txt'), fakeCtx({ disk: linked }))).toBeUndefined()
  })

  test('PowerShell -Recurse on the junction itself is the hit', async () => {
    const e = psIn(`Remove-Item -Recurse ${WT}\\node_modules`)
    expect(await worktreeJunction(e, fakeCtx({ disk: linked }))).toContain('is itself a junction or symlink')
  })
})

describe('sessionSeparation', () => {
  const of = (p: string) => (/\\code\\(one|two)(\\|$)/i.exec(p)?.[1]?.toLowerCase() as Project | undefined)
  const check = sessionSeparation(of, p => p.toUpperCase())

  test('the first project write pins; a write to the other is the hit', async () => {
    const ctx = fakeCtx()
    expect(await check(editIn(`${HOME}\\code\\one\\a.ts`), ctx)).toBeUndefined()
    expect(ctx.pins.map(p => p[0])).toEqual(['one'])
    expect(await check(editIn(`${HOME}\\code\\one\\b.ts`), ctx)).toBeUndefined()
    const hit = await check(bashIn('cp a.png ~/code/two/a.png'), ctx)
    expect(hit).toContain('writes to TWO, but this session is pinned to ONE')
  })

  test('reads and non-project writes do not pin', async () => {
    const ctx = fakeCtx()
    expect(await check(bashIn('cat ~/code/two/README.md && ls ~/code/one'), ctx)).toBeUndefined()
    expect(await check(editIn(`${HOME}\\notes.md`), ctx)).toBeUndefined()
    expect(ctx.pins).toEqual([])
  })
})

/* -------------------------------------------------------- 2. example rules */

type ExampleCase = { e: ToolInput; ctx?: Parameters<typeof fakeCtx>[0]; before?: ToolInput[] }

const WT_EX = `${HOME}\\code\\wt`
/** A repo the guard's installer marked, and one known only by its hooksPath. */
const GUARDED = { 'config --get oss-guard.enabled': 'true' }
const HOOKS_PATH_ONLY = { 'config --get core.hooksPath': 'C:/Users/you/tools/oss-guard/hooks' }
const EXAMPLE_CASES: Record<string, { deny: ExampleCase[]; pass: ExampleCase[] }> = {
  'protected-push': {
    deny: [
      { e: bashIn('git push origin main'), ctx: { cwd: APP } },
      { e: bashIn('git push --force origin HEAD:main'), ctx: { cwd: APP } },
      { e: bashIn('git push --all'), ctx: { cwd: APP } },
      { e: bashIn('git push https://github.com/your-name/your-app.git feature:main') },
      { e: bashIn('git push origin x:main'), ctx: { cwd: `${HOME}\\clone`, git: { 'remote get-url --push origin': 'git@github.com:your-name/your-app.git' } } },
      { e: bashIn('git push'), ctx: { cwd: APP, git: { 'rev-parse --abbrev-ref --symbolic-full-name @{push}': 'origin/main' } } },
      { e: bashIn('gh pr merge 12 -R your-name/your-app --squash') },
      { e: psIn('gh pr merge 12 --merge'), ctx: { cwd: APP } },
    ],
    pass: [
      { e: bashIn('git push origin feature'), ctx: { cwd: APP } },
      { e: bashIn('git push origin main'), ctx: { cwd: `${HOME}\\code\\other` } },
      { e: bashIn('git push --dry-run origin main'), ctx: { cwd: APP } },
      { e: bashIn('git push'), ctx: { cwd: APP, git: { 'rev-parse --abbrev-ref --symbolic-full-name @{push}': 'origin/feature' } } },
      { e: bashIn('gh pr merge 12 -R your-name/other --squash') },
      { e: bashIn('git log --oneline -5 origin/main'), ctx: { cwd: APP } },
    ],
  },
  'live-backtick': {
    deny: [{ e: bashIn('echo `date`') }, { e: bashIn('node -e "x `git push origin main` y"') }],
    pass: [{ e: bashIn("echo '`date`'") }, { e: bashIn('echo $(date)') }, { e: psIn('Write-Host "a`nb"') }],
  },
  'kill-by-name': {
    deny: [{ e: psIn('taskkill /IM claude.exe /F') }, { e: psIn('Stop-Process -Name claude -Force') }, { e: bashIn('pkill claude') }, { e: psIn('Get-Process claude | Stop-Process') }],
    pass: [{ e: psIn('Stop-Process -Id 1234 -Force') }, { e: psIn('taskkill /IM notepad.exe') }, { e: bashIn('ps aux | grep claude') }],
  },
  'startup-run-delete': {
    deny: [
      { e: psIn('Remove-ItemProperty -Path HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run -Name Demo') },
      { e: psIn('reg delete HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run /v Demo /f') },
    ],
    pass: [
      { e: psIn('Get-ItemProperty HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run') },
      { e: psIn('Set-ItemProperty -Path HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run -Name Demo -Value 3') },
    ],
  },
  'repo-public': {
    deny: [
      { e: bashIn('gh repo create your-name/demo --public') },
      { e: bashIn('gh repo edit your-name/demo --visibility public') },
      { e: bashIn('gh api -X PATCH repos/your-name/demo -f private=false') },
    ],
    pass: [{ e: bashIn('gh repo create your-name/demo --private') }, { e: bashIn('gh repo view your-name/demo --json visibility') }],
  },
  'prisma-prod-wipe': {
    deny: [
      { e: bashIn('npx prisma migrate reset --force') },
      { e: bashIn('npx prisma db push --accept-data-loss') },
      { e: bashIn('npx prisma migrate diff --shadow-database-url "$DATABASE_URL"') },
    ],
    pass: [
      { e: bashIn('DATABASE_URL="postgresql://u:p@localhost:5432/scratch" npx prisma migrate reset --force') },
      { e: bashIn('npx prisma migrate status') },
      { e: bashIn('npx prisma db push') },
    ],
  },
  'worktree-junction': {
    deny: [
      { e: bashIn('rm -rf ~/code/wt'), ctx: { disk: { [WT_EX]: 'dir', [`${WT_EX}\\.git`]: 'file', [`${WT_EX}\\node_modules`]: 'link' } } },
      { e: bashIn('git worktree remove --force C:/Users/you/code/wt'), ctx: { disk: { [WT_EX]: 'dir', [`${WT_EX}\\.git`]: 'file', [`${WT_EX}\\node_modules`]: 'link' } } },
    ],
    pass: [{ e: bashIn('rm -rf ~/code/wt'), ctx: { disk: { [WT_EX]: 'dir', [`${WT_EX}\\.git`]: 'file', [`${WT_EX}\\node_modules`]: 'dir' } } }],
  },
  'hook-bypass': {
    deny: [
      { e: bashIn('git commit --no-verify -m "wip"'), ctx: { git: GUARDED } },
      { e: bashIn('git commit -nm "wip"'), ctx: { git: GUARDED } },
      { e: bashIn('git commit -a -m wip -n'), ctx: { git: GUARDED } },
      { e: bashIn('git push --no-verify origin main'), ctx: { git: GUARDED } },
      { e: bashIn('git -c core.hooksPath=/dev/null commit -m wip'), ctx: { git: GUARDED } },
      { e: bashIn('git config core.hooksPath .git/hooks'), ctx: { git: GUARDED } },
      { e: bashIn('git config --local --unset core.hooksPath'), ctx: { git: GUARDED } },
      { e: bashIn('git config unset core.hooksPath'), ctx: { git: GUARDED } },
      { e: bashIn('OSS_GUARD_CONFIG_DIR=/tmp/empty git commit -m wip'), ctx: { git: GUARDED } },
      { e: psIn('git -C C:/Users/you/code/your-app push --no-verify'), ctx: { git: HOOKS_PATH_ONLY } },
    ],
    pass: [
      { e: bashIn('git commit -m "docs: never use -n or --no-verify"'), ctx: { git: GUARDED } },
      { e: bashIn('git commit -mn'), ctx: { git: GUARDED } },
      { e: bashIn('git config --get core.hooksPath && git config core.hooksPath'), ctx: { git: GUARDED } },
      { e: bashIn('git push --dry-run origin main'), ctx: { git: GUARDED } },
      { e: bashIn('git commit --no-verify -m "wip"') },
      { e: bashIn('git config --unset core.hooksPath') },
    ],
  },
  'session-separation': {
    deny: [
      { e: editIn(`${SITE}\\index.html`), before: [editIn(`${APP}\\server.js`)] },
      { e: bashIn('cp ~/code/your-site/logo.png ~/code/your-app/logo.png'), before: [editIn(`${SITE}\\index.html`)] },
    ],
    pass: [
      { e: editIn(`${APP}\\b.js`), before: [editIn(`${APP}\\a.js`)] },
      { e: bashIn('cat ~/code/your-site/README.md > /tmp/copy.txt'), before: [editIn(`${APP}\\a.js`)] },
      { e: editIn(`${HOME}\\notes.md`), before: [editIn(`${SITE}\\index.html`)] },
    ],
  },
}

/** What the example rule `id` says about `c`, run as the engine runs it (its tools only, `before` calls first). */
async function exampleHit(id: string, c: ExampleCase): Promise<{ hit: string | undefined; reason?: string }> {
  const rule = EXAMPLE.find(r => r.id === id)
  if (rule === undefined) throw new Error(`no example rule ${id}`)
  const ctx = fakeCtx(c.ctx)
  for (const b of c.before ?? []) {
    if ((await rule.check(b, ctx)) !== undefined) throw new Error(`a before-call hit ${id}`)
  }
  if (!toolMatches(rule, c.e.tool)) return { hit: undefined }
  const hit = await rule.check(c.e, ctx)
  return hit === undefined ? { hit } : { hit, reason: rule.reason(hit, c.e) }
}

describe('example rules', () => {
  test('ids are unique, every rule is documented, session-separation runs last', () => {
    const ids = EXAMPLE.map(r => r.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toEqual(Object.keys(EXAMPLE_CASES))
    expect(ids[ids.length - 1]).toBe('session-separation')
    for (const r of EXAMPLE) {
      expect(r.summary.length).toBeGreaterThan(10)
      expect(r.source.length).toBeGreaterThan(5)
      if (r.unlock !== undefined) {
        expect(r.unlock.ms).toBeGreaterThan(0)
        expect(r.unlock.hint.length).toBeGreaterThan(5)
      }
    }
    expect(EXAMPLE_PIN_TEXT?.none).toContain('none yet')
  })

  for (const [id, { deny, pass }] of Object.entries(EXAMPLE_CASES)) {
    for (const c of deny) {
      test(`${id} denies ${c.e.tool}: ${String(c.e.command ?? c.e.file_path).slice(0, 60)}`, async () => {
        const { hit, reason } = await exampleHit(id, c)
        expect(hit).toBeDefined()
        expect(reason).toContain(hit as string)
      })
    }
    for (const c of pass) {
      test(`${id} passes ${c.e.tool}: ${String(c.e.command ?? c.e.file_path).slice(0, 60)}`, async () => {
        expect((await exampleHit(id, c)).hit).toBeUndefined()
      })
    }
  }

  test('worktree-junction deny text names the exact rmdir', async () => {
    const c = EXAMPLE_CASES['worktree-junction']?.deny[0] as ExampleCase
    expect((await exampleHit('worktree-junction', c)).reason).toContain(`cmd /c rmdir "${WT_EX}\\node_modules"`)
  })

  test('session-separation names both projects', async () => {
    const c = EXAMPLE_CASES['session-separation']?.deny[0] as ExampleCase
    expect((await exampleHit('session-separation', c)).hit).toContain('writes to your-site, but this session is pinned to your-app')
    expect(projectOf('~/code/your-app/x')).toBe('your-app')
    expect(projectOf(`${APP}\\src\\x.ts`)).toBe('your-app')
    expect(projectOf(`${HOME}\\code\\elsewhere\\x.ts`)).toBeUndefined()
  })

  test('unlocks: what the user says, not negations or questions', () => {
    const unlock = (id: string) => EXAMPLE.find(r => r.id === id)?.unlock?.test ?? (() => false)
    const cases: [string, string[], string[]][] = [
      ['protected-push', ['go', 'ok push', 'ship it'], ["don't push yet", 'did you push?', 'go check the logs']],
      ['startup-run-delete', ['delete the Demo run value entirely'], ['clean up my startup apps', "don't delete the run key"]],
      ['repo-public', ['make the demo repo public'], ['never make repos public', 'is the repo public?']],
      ['hook-bypass', ['skip the hooks this once', 'use --no-verify for this commit'], ["don't skip the hooks", 'did the hooks run?', 'fix the guard failure']],
      ['session-separation', ['work on both projects in this session', 'ok, do both projects here'], ['keep both projects separate', 'did you fix both projects?']],
    ]
    for (const [id, yes, no] of cases) {
      for (const t of yes) expect(unlock(id)(t)).toBe(true)
      for (const t of no) expect(unlock(id)(t)).toBe(false)
    }
    expect(approvesBoth('relay both projects')).toBe(false)
  })
})

/* ------------------------------------------- 3. plumbing, over the active rules */

type Call = { tool: string; input: Record<string, unknown> }
type World = { toasts: string[]; clock: MockClock; commands: string[] }

/**
 * The engine beneath the plugin: cwd, git (always fails), an empty disk, toasts, a clock, tools
 * that just run. hooks/rules.local.ts is on disk exactly when it loaded, unless `localOnDisk` says
 * otherwise (`throws`: the disk cannot be asked).
 */
function world(on: On, o: { localOnDisk?: boolean | 'throws'; user?: string | null | 'throws' } = {}): World {
  const toasts: string[] = []
  const commands: string[] = []
  const clock = mock.clock(on, { now: 1_800_000_000_000 })
  const enoent = (p: string): never => {
    throw Object.assign(new Error(`ENOENT: no such file or directory, ${p}`), { code: 'ENOENT' })
  }
  // The name setting, user.local.json beside the mod folders: a valid one naming NAME unless
  // `user` says otherwise (null: no such file; 'throws': the disk cannot be asked).
  const user = o.user === undefined ? JSON.stringify({ name: NAME }) : o.user
  const isUserFile = (p: string) => /[\\/]user\.local\.json$/.test(p)
  on('fs.read', (_$, e) => {
    if (!isUserFile(e.path) || user === null) return { deny: `ENOENT: no such file or directory, ${e.path}` }
    if (user === 'throws') return { deny: 'EIO: i/o error, read' }
    return { value: user }
  })
  on('session.cwd', () => ({ value: WORK }))
  on('env.get', (_$, e) => ({ value: e.name === 'USERPROFILE' ? HOME : undefined }))
  on('fs.stat', (_$, e) => enoent(e.path))
  on('fs.list', (_$, e) => enoent(e.path))
  on('fs.exists', (_$, e) => {
    if (isUserFile(e.path)) return { value: user !== null }
    if (!/[\\/]hooks[\\/]rules\.local\.ts$/.test(e.path)) return { value: false }
    if (o.localOnDisk === 'throws') throw new Error('fs unavailable')
    return { value: o.localOnDisk ?? !LOCAL_MISSING }
  })
  on('process.run', () => ({ value: { exitCode: 128, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('tool.call', () => ({ result: {} as never }))
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  on('command.register', (_$, e) => {
    commands.push(e.name)
    return { value: { command: e.name } }
  })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  return { toasts, clock, commands }
}

async function run($: Engine, c: Call): Promise<string | undefined> {
  const r = await $.tool.call({ tool: c.tool, ...c.input } as never)
  if (r.deny !== undefined) return r.deny
  return r.isError === true ? (r.text ?? 'error') : undefined
}

function say($: Engine, text: string, kind: PromptOrigin['kind'] = 'composer') {
  return $.prompt.submit({ text, wait: false, origin: { kind } as PromptOrigin })
}

async function rails($: Engine, args: string, origin: PromptOrigin = { kind: 'composer' }): Promise<string> {
  const r = await $.command.run({ command: 'rails', args, origin, presentation: { isFullscreen: false, columns: 140 } })
  return r.text ?? ''
}

const bash = (command: string): Call => ({ tool: 'Bash', input: { command } })
const ps = (command: string): Call => ({ tool: 'PowerShell', input: { command } })

/** Calls a typical rule set blocks, none of them touching a project path. */
const PROBES: Call[] = [
  bash('echo `date`'),
  ps('taskkill /IM claude.exe /F'),
  bash('gh repo create your-name/demo --public'),
  ps('Remove-ItemProperty -Path HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run -Name Demo'),
  bash('npx prisma migrate reset --force'),
]

/** Prompts that may unlock a probe's rule. */
const UNLOCKS = ['make the demo repo public', 'delete the Demo run value entirely', 'go', 'yes, confirm']

const ruleOf = (deny: string | undefined): Rule | undefined => {
  const id = /^\[rails\/([^\]]+)\]/.exec(deny ?? '')?.[1]
  return RULES.find(r => r.id === id)
}

/** The first probe the active rules deny, with the rule and what it matched. */
async function firstDenied($: Engine): Promise<{ call: Call; rule: Rule; deny: string }> {
  for (const call of PROBES) {
    const deny = await run($, call)
    const rule = ruleOf(deny)
    if (deny !== undefined && rule !== undefined) return { call, rule, deny }
  }
  throw new Error(`none of the probe calls is denied by the active rules (${RULES.map(r => r.id).join(', ')})`)
}

/** A probe denied by a rule with an unlock, and a prompt that unlocks it. */
async function unlockable($: Engine): Promise<{ call: Call; rule: Rule & { unlock: NonNullable<Rule['unlock']> }; prompt: string }> {
  for (const call of PROBES) {
    const rule = ruleOf(await run($, call))
    const unlock = rule?.unlock
    const prompt = unlock === undefined ? undefined : UNLOCKS.find(t => unlock.test(t))
    if (rule !== undefined && unlock !== undefined && prompt !== undefined) return { call, rule: { ...rule, unlock }, prompt }
  }
  throw new Error('no probe call is denied by a rule that one of the probe prompts unlocks')
}

describe('/rails over the active rules', () => {
  test('registers the command and lists every rule in order with its summary', async ($, on) => {
    const w = world(on)
    await $.session.start({ cwd: HOME, surface: 'terminal', isInteractive: true })
    expect(w.commands).toEqual(['rails'])
    const text = await rails($, '')
    expect(text).toContain(`rails: ${RULES.length} rules, 0 denies this session`)
    let at = 0
    for (const r of RULES) {
      const k = text.indexOf(` ${r.id} `, at)
      expect(k).toBeGreaterThan(-1)
      expect(text).toContain(r.summary)
      at = k
    }
    if (PIN_TEXT === null) expect(text).not.toContain('Project:')
    else expect(text).toContain(`Project: ${PIN_TEXT.none}`)
    expect(text).toContain('/rails allow <id>')
  })

  test('a deny names the rule, its reason and the way out, and counts', async ($, on) => {
    const w = world(on)
    const { call, rule, deny } = await firstDenied($)
    const hit = await rule.check({ tool: call.tool, ...call.input }, fakeCtx({ cwd: WORK }))
    expect(hit).toBeDefined()
    const unlock = rule.unlock === undefined ? '' : ` It unlocks when ${rule.unlock.hint}.`
    expect(deny).toBe(`[rails/${rule.id}] ${rule.reason(hit as string, { tool: call.tool, ...call.input })}${unlock} ${NAME} can let one call through with /rails allow ${rule.id}.`)
    expect(w.toasts.some(t => t.startsWith(`rails blocked ${rule.id}: `))).toBe(true)
    expect(await rails($, '')).toContain('1 deny this session')
  })

  test('allow lets exactly one blocked call through', async ($, on) => {
    const w = world(on)
    const { call, rule } = await firstDenied($)
    expect(await rails($, `allow ${rule.id}`)).toContain('once')
    expect(await rails($, '')).toContain('one bypass armed')
    expect(await run($, call)).toBeUndefined()
    expect(w.toasts).toContain(`rails: ${rule.id} let through once (/rails allow)`)
    expect(await run($, call)).toContain(`[rails/${rule.id}]`)
  })

  test('off and on switch one rule, or all of them, for the session', async ($, on) => {
    world(on)
    const { call, rule } = await firstDenied($)
    expect(await rails($, `off ${rule.id}`)).toBe(`rails: ${rule.id} OFF for this session.`)
    expect(await run($, call)).toBeUndefined()
    expect(await rails($, `on ${rule.id}`)).toBe(`rails: ${rule.id} on for this session.`)
    expect(await run($, call)).toContain(`[rails/${rule.id}]`)
    expect(await rails($, 'off all')).toBe(`rails: ${RULES.map(r => r.id).join(', ')} OFF for this session.`)
    for (const p of PROBES) expect(await run($, p)).toBeUndefined()
    expect((await rails($, '')).split('\n').filter(l => l.startsWith('  off ')).length).toBe(RULES.length)
    await rails($, 'on all')
    expect(await run($, call)).toContain(`[rails/${rule.id}]`)
  })

  test('only the user can change it; unknown verbs and rules are named', async ($, on) => {
    world(on)
    const { call, rule } = await firstDenied($)
    expect(await rails($, `off ${rule.id}`, { kind: 'plugin', name: 'other' } as PromptOrigin)).toBe(
      `rails: only ${NAME} can change rails (by typing /rails), not the model or a plugin.`,
    )
    expect(await run($, call)).toContain(`[rails/${rule.id}]`)
    expect(await rails($, 'off nope')).toBe(`rails: no rule "nope". Rules: ${RULES.map(r => r.id).join(', ')}`)
    expect(await rails($, 'frob x')).toContain('unknown "frob"')
  })

  test("the user's own prompt unlocks for a while; notifications and slash commands do not", async ($, on) => {
    const w = world(on)
    const { call, rule, prompt } = await unlockable($)
    await say($, prompt, 'task-notification')
    expect(await run($, call)).toContain(`[rails/${rule.id}]`)
    await say($, prompt)
    expect(await run($, call)).toBeUndefined()
    expect(w.toasts).toContain(`rails: ${rule.id} allowed, your last prompt authorized it`)
    expect(await rails($, '')).toContain('authorized by your last prompt')
    await say($, '/rails')
    await say($, 'never mind', 'task-notification')
    expect(await run($, call)).toBeUndefined()
    await w.clock.advance(rule.unlock.ms + MIN)
    expect(await run($, call)).toContain(`[rails/${rule.id}]`)
  })

  test('everyday commands pass every rule', async ($, on) => {
    const w = world(on)
    const everyday: Call[] = [
      bash('git status && git diff --stat'),
      bash('npm test 2>&1 | tail -20'),
      bash('git log --oneline -5'),
      bash('for f in *.md; do echo "$f"; done'),
      bash("git commit -m 'fix: a thing'"),
      bash('echo $((1 + 2))'),
      ps('Get-ChildItem . -Filter *.md | Measure-Object'),
      ps('Stop-Process -Id 1234 -Force'),
      { tool: 'Edit', input: { file_path: `${HOME}\\notes.md`, old_string: 'a', new_string: 'b' } },
      { tool: 'Write', input: { file_path: `${WORK}\\todo.md`, content: 'echo `date` later' } },
      { tool: 'Read', input: { file_path: `${WORK}\\todo.md` } },
    ]
    for (const c of everyday) expect(await run($, c)).toBeUndefined()
    expect(w.toasts).toEqual([])
  })
})

/* ------------------------------------- 4. a missing hooks/rules.local.ts is never silent */

const MISSING = 'rails: hooks/rules.local.ts is missing, so rails is running the EXAMPLE rules. Copy hooks/rules.example.ts to hooks/rules.local.ts.'
const NOT_LOADED = 'rails: hooks/rules.local.ts is on disk but did not load, so rails is running the EXAMPLE rules. Restart the session to load it.'
const VANISHED =
  'rails: hooks/rules.local.ts is no longer on disk; this session keeps the rules it loaded, but the next one will run the EXAMPLE rules. Copy hooks/rules.example.ts to hooks/rules.local.ts.'

describe('rules.local fallback', () => {
  test('the tracked fallback is the example rule set, flagged missing; real rule files say loaded', () => {
    expect(FALLBACK.LOCAL_MISSING).toBe(true)
    expect(FALLBACK.RULES).toBe(EXAMPLE)
    expect(FALLBACK.PIN_TEXT).toBe(EXAMPLE_PIN_TEXT)
    expect(Object.keys(FALLBACK).sort()).toEqual(['LOCAL_MISSING', 'PIN_TEXT', 'RULES'])
    expect(EXAMPLE_LOCAL_MISSING).toBe(false)
  })

  test('what loaded is what /rails and the session start say', async ($, on) => {
    const w = world(on)
    await $.session.start({ cwd: HOME, surface: 'terminal', isInteractive: true })
    const first = (await rails($, '')).split('\n')[0]
    if (LOCAL_MISSING) {
      // hooks/rules.local.ts is absent: the example rules are active, and it says so loudly.
      expect(RULES).toBe(EXAMPLE)
      expect(PIN_TEXT).toBe(EXAMPLE_PIN_TEXT)
      expect(w.toasts).toEqual([MISSING])
      expect(first).toBe(MISSING)
      expect(await run($, bash('echo `date`'))).toContain('[rails/live-backtick]')
    } else {
      // The user's own rules loaded: nothing new is shown.
      expect(w.toasts).toEqual([])
      expect(first).toBe(`rails: ${RULES.length} rules, 0 denies this session`)
    }
  })

  test('a rules.local.ts on disk that did not load, or that vanished after loading, is called out', async ($, on) => {
    const w = world(on, { localOnDisk: LOCAL_MISSING })
    await $.session.start({ cwd: HOME, surface: 'terminal', isInteractive: true })
    const expected = LOCAL_MISSING ? NOT_LOADED : VANISHED
    expect(w.toasts).toEqual([expected])
    expect((await rails($, '')).split('\n')[0]).toBe(expected)
  })

  test('a disk that cannot be asked still reports a missing file, and nothing else', async ($, on) => {
    const w = world(on, { localOnDisk: 'throws' })
    await $.session.start({ cwd: HOME, surface: 'terminal', isInteractive: true })
    expect(w.toasts).toEqual(LOCAL_MISSING ? [MISSING] : [])
  })
})

/* --------------------- 5. the name setting: user.local.json, never a reason to fail open */

const NAME_MISSING = `rails: user.local.json is missing, so the mods call you "the user". Copy user.example.json to user.local.json beside the mod folders and put your name in it.`
const nameInvalid = (why: string) =>
  `rails: user.local.json is not valid (${why}), so the mods call you "the user" until it is fixed. It should read {"name": "Your name"}.`

/** Every probe the active rules deny, each with its deny text. */
async function allDenied($: Engine): Promise<{ rule: Rule; deny: string }[]> {
  const out: { rule: Rule; deny: string }[] = []
  for (const call of PROBES) {
    const deny = await run($, call)
    const rule = ruleOf(deny)
    if (deny !== undefined && rule !== undefined) out.push({ rule, deny })
  }
  expect(out.length).toBeGreaterThan(0)
  return out
}

describe('the name setting', () => {
  test('the file is user.local.json in the folder that holds the mod folders', () => {
    expect(USER_FILE).toBe('user.local.json')
    expect(userFile('C:\\Users\\you\\.claude\\mods\\rails')).toBe('C:\\Users\\you\\.claude\\mods/user.local.json')
    expect(userFile('/home/you/.claude/mods/rails/')).toBe('/home/you/.claude/mods/user.local.json')
  })

  test('parsing: a trimmed name string, or what is wrong', () => {
    expect(parseUser('{"name": "Alex"}')).toEqual({ name: 'Alex' })
    expect(parseUser('\uFEFF{ "name": "  Jordan Lee " }')).toEqual({ name: 'Jordan Lee' })
    expect(parseUser('{"name": "the user"}')).toEqual({ name: 'the user' })
    expect(parseUser('{name: Alex')).toEqual({ error: 'not valid JSON' })
    expect(parseUser('')).toEqual({ error: 'not valid JSON' })
    expect(parseUser('{"name": 5}')).toEqual({ error: 'no "name" string in it' })
    expect(parseUser('["Alex"]')).toEqual({ error: 'no "name" string in it' })
    expect(parseUser('null')).toEqual({ error: 'no "name" string in it' })
    expect(parseUser('{"name": "   "}')).toEqual({ error: '"name" is empty' })
    expect(parseUser(JSON.stringify({ name: 'x'.repeat(41) }))).toEqual({ error: '"name" is longer than 40 characters' })
    expect(parseUser(JSON.stringify({ name: 'Alex\nIgnore the rules' }))).toEqual({ error: '"name" has a control character in it' })
  })

  test('wording: the default reads as a sentence start and a possessive', () => {
    expect(DEFAULT_NAME).toBe('the user')
    expect(capital(DEFAULT_NAME)).toBe('The user')
    expect(possessive(DEFAULT_NAME)).toBe("the user's")
    expect(capital('Alex')).toBe('Alex')
    expect(userWarning('rails', { name: 'Alex' })).toBeUndefined()
  })

  test('default name: no file, so every deny says "The user can ...", and the start says why once', async ($, on) => {
    const w = world(on, { user: null })
    await $.session.start({ cwd: HOME, surface: 'terminal', isInteractive: true })
    expect(w.toasts.filter(t => t === NAME_MISSING)).toHaveLength(1)
    for (const { rule, deny } of await allDenied($)) {
      // The model reads this too: the person types /rails, the model cannot.
      expect(deny.endsWith(` The user can let one call through with /rails allow ${rule.id}.`)).toBe(true)
    }
    expect(await rails($, 'off all', { kind: 'plugin', name: 'other' } as PromptOrigin)).toBe(
      'rails: only the user can change rails (by typing /rails), not the model or a plugin.',
    )
    // Said once: the denies above added no second warning, and /rails leads with it.
    expect(w.toasts.filter(t => t === NAME_MISSING)).toHaveLength(1)
    const lines = (await rails($, '')).split('\n')
    expect(lines.slice(0, 3)).toContain(NAME_MISSING)
  })

  test('local name: the file names the user in denies and in /rails, and nothing warns', async ($, on) => {
    const w = world(on, { user: '{\n  "name": "Jordan"\n}\n' })
    await $.session.start({ cwd: HOME, surface: 'terminal', isInteractive: true })
    for (const { rule, deny } of await allDenied($)) expect(deny.endsWith(` Jordan can let one call through with /rails allow ${rule.id}.`)).toBe(true)
    expect(await rails($, 'off all', { kind: 'plugin', name: 'other' } as PromptOrigin)).toContain('only Jordan can change rails')
    expect(w.toasts.filter(t => t.includes('user.local.json'))).toEqual([])
    expect((await rails($, '')).split('\n')[0]).not.toContain('user.local.json')
  })

  for (const [what, text, why] of [
    ['not JSON', '{"name": "Jordan"', 'not valid JSON'],
    ['no name string', '{"nom": "Jordan"}', 'no "name" string in it'],
    ['an empty name', '{"name": ""}', '"name" is empty'],
  ] as const) {
    test(`corrupt setting (${what}): still denied, with the default name, and said once`, async ($, on) => {
      const w = world(on, { user: text })
      await $.session.start({ cwd: HOME, surface: 'terminal', isInteractive: true })
      for (const { rule, deny } of await allDenied($)) expect(deny.endsWith(` The user can let one call through with /rails allow ${rule.id}.`)).toBe(true)
      expect(w.toasts.filter(t => t.includes('user.local.json'))).toEqual([nameInvalid(why)])
    })
  }

  test('an unreadable setting fails closed: the call is still denied, never let through unchecked', async ($, on) => {
    const w = world(on, { user: 'throws' })
    await $.session.start({ cwd: HOME, surface: 'terminal', isInteractive: true })
    const denied = await allDenied($)
    for (const { rule, deny } of denied) expect(deny.endsWith(` The user can let one call through with /rails allow ${rule.id}.`)).toBe(true)
    expect(w.toasts.some(t => t.includes('call allowed unchecked'))).toBe(false)
    const named = w.toasts.filter(t => t.includes('user.local.json'))
    expect(named).toHaveLength(1)
    expect(named[0]).toContain('rails: user.local.json could not be read (')
    expect(named[0]).toContain('EIO: i/o error, read')
    expect(named[0]).toContain('so the mods call you "the user" until it is fixed.')
  })
})
