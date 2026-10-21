// The example rules (rules.example.ts), driven directly against a fake world:
// an edit-triggered rule and a command-triggered rule, each with near misses.
import { describe, expect, test } from 'claude-code/testing'

import { EMPTY, openItem } from '../hooks/items'
import type { Hit } from '../hooks/items'
import { RULES, TOOL_EXAMPLES } from '../hooks/rules.example'
import { callOf, setHome } from '../hooks/rules'
import type { Call, Ctx, Rule } from '../hooks/rules'

const HOME = 'C:\\Users\\you'
const CWD = 'c:/users/you'
const APP = 'c:/users/you/projects/my-app'

const rule = (id: string): Rule => RULES.find(r => r.id === id) as Rule

type World = { ahead: Record<string, string | undefined>; gitCalls: string[]; warnings: string[] }

function ctxOf(w: World, cwd = CWD): Ctx {
  return {
    cwd,
    git: async (dir, args) => {
      w.gitCalls.push(`${dir} ${args.join(' ')}`)
      return w.ahead[dir]
    },
    run: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    read: async p => {
      throw new Error(`ENOENT ${p}`)
    },
    list: async () => [],
    now: async () => 0,
    warn: t => {
      w.warnings.push(t)
    },
    hasOpen: () => false,
  }
}

const world = (ahead: Record<string, string | undefined> = {}): World => ({ ahead, gitCalls: [], warnings: [] })
const edit = (path: string, newText = 'x'): Call => callOf({ tool: 'Edit', file_path: path, old_string: 'a', new_string: newText }, CWD) as Call
const sh = (src: string, output = ''): Call => callOf({ tool: 'Bash', command: src }, CWD, output) as Call
const itemOf = (hit: Hit) => openItem(EMPTY, hit, 1).next.items[0]!

describe('the example set', () => {
  test('neutral, well-formed rules and description text', () => {
    expect(RULES.map(r => r.id)).toEqual(['npm-install', 'push-after-commit'])
    for (const r of RULES) {
      expect(r.summary.length > 10).toBe(true)
      expect(r.source.length > 0).toBe(true)
      expect(typeof r.open).toBe('function')
      expect(typeof r.progress).toBe('function')
    }
    expect(TOOL_EXAMPLES.startsWith('(')).toBe(true)
    expect(TOOL_EXAMPLES.endsWith('...).')).toBe(true)
  })
})

describe('npm-install (edit-triggered)', () => {
  test('a package.json edit opens one item per folder; an install there closes it', async () => {
    setHome(HOME)
    const w = world()
    const ctx = ctxOf(w)
    const hits = await rule('npm-install').open!(edit('C:\\Users\\you\\Projects\\My-App\\package.json'), ctx)
    expect(hits).toEqual([
      {
        rule: 'npm-install',
        key: `npm-install:${APP}`,
        label: 'npm install',
        how: `run npm install in ${APP} so the lockfile and node_modules match package.json`,
        trigger: 'package.json',
      },
    ])
    const item = itemOf(hits[0]!)
    const progress = rule('npm-install').progress!
    expect(await progress(sh('npm install'), item, ctx)).toBeUndefined()
    expect(await progress(sh('cd ~/projects/other && npm install'), item, ctx)).toBeUndefined()
    expect(await progress(sh('cd ~/projects/my-app && npm test'), item, ctx)).toBeUndefined()
    expect(await progress(edit(`${APP}/package.json`), item, ctx)).toBeUndefined()
    expect(await progress(sh('cd ~/projects/my-app && npm ci'), item, ctx)).toEqual({ steps: ['done'], evidence: 'npm ci' })
    expect(await progress(sh('npm i'), item, ctxOf(w, APP))).toEqual({ steps: ['done'], evidence: 'npm i' })
  })

  test('near misses: another file, a package.json inside node_modules, a shell call', async () => {
    const ctx = ctxOf(world())
    const open = rule('npm-install').open!
    expect(await open(edit(`${APP}/package-lock.json`), ctx)).toEqual([])
    expect(await open(edit(`${APP}/node_modules/left-pad/package.json`), ctx)).toEqual([])
    expect(await open(sh('cat package.json'), ctx)).toEqual([])
  })
})

describe('push-after-commit (command-triggered)', () => {
  test('a commit in a configured repo (by ~) opens; the push that levels the upstream closes', async () => {
    setHome(HOME)
    const w = world({ [APP]: '2' })
    const ctx = ctxOf(w)
    const hits = await rule('push-after-commit').open!(sh('cd ~/projects/my-app && git commit -m "fix"'), ctx)
    expect(hits).toEqual([
      {
        rule: 'push-after-commit',
        key: `push-after-commit:${APP}`,
        label: 'push my-app',
        how: `git -C ${APP} push (check no secret file is tracked first)`,
        trigger: 'git commit',
      },
    ])
    expect(w.gitCalls).toEqual([`${APP} rev-list --count @{upstream}..HEAD`])
    const item = itemOf(hits[0]!)
    const progress = rule('push-after-commit').progress!
    expect(await progress(sh('git -C ~/projects/my-app status'), item, ctx)).toBeUndefined()
    expect(await progress(sh('git -C ~/projects/my-app push', ' ! [rejected]'), item, ctx)).toBeUndefined()
    w.ahead[APP] = '0'
    expect(await progress(sh('git -C ~/projects/my-app push'), item, ctx)).toEqual({ steps: ['done'], evidence: `${APP} is level with its upstream` })
  })

  test('every spelling of the repo counts: git -C, the home variables, a subfolder', async () => {
    setHome(HOME)
    const ctx = ctxOf(world({ [APP]: '1' }))
    const open = rule('push-after-commit').open!
    for (const src of ['git -C C:/Users/you/projects/my-app commit -m x', 'cd $HOME/projects/my-app/src && git commit -am x', 'git -C ~/projects/my-app commit --amend']) {
      expect((await open(sh(src), ctx)).map(h => h.key)).toEqual([`push-after-commit:${APP}`])
    }
  })

  test('near misses: another repo, a commit pushed on the same line, an echo, an edit', async () => {
    setHome(HOME)
    const behind = world({ [APP]: '1' })
    const open = rule('push-after-commit').open!
    expect(await open(sh('cd ~/projects/my-app-live && git commit -m x'), ctxOf(behind))).toEqual([])
    expect(await open(sh('echo "git commit in my-app"'), ctxOf(behind))).toEqual([])
    expect(await open(edit(`${APP}/README.md`), ctxOf(behind))).toEqual([])
    expect(behind.gitCalls).toEqual([])
    expect(await open(sh('cd ~/projects/my-app && git commit -m x && git push'), ctxOf(world({ [APP]: '0' })))).toEqual([])
  })

  test('git that cannot count still opens, and says so', async () => {
    setHome(HOME)
    const w = world({})
    const hits = await rule('push-after-commit').open!(sh('git -C ~/projects/my-app commit -m x'), ctxOf(w))
    expect(hits.length).toBe(1)
    expect(w.warnings).toEqual([`followups: could not count the commits ${APP} is ahead of its upstream; opened the push item anyway`])
  })
})
