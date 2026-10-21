// The generic pieces, driven directly (no engine): paths and the home, calls,
// git, the push helper, markdown sections, and the checklist itself.
import { describe, expect, test } from 'claude-code/testing'

import { addProgress, bandLine, closeItems, EMPTY, listText, markLeftOpen, markNudged, nudgeable, nudgeText, openItem, toolList } from '../hooks/items'
import { callOf, dirOf, gitCall, homeDir, pushedRefs, pushTo, resolvePath, scriptArg, sectionBody, setHome, short, under } from '../hooks/rules'
import type { Call, Ctx } from '../hooks/rules'
import { commands } from '../hooks/shell'

// A neutral home, as the hooks would read it from USERPROFILE.
const HOME = 'C:\\Users\\you'
const CWD = 'c:/users/you/projects/app'

const ctxAt = (cwd: string): Ctx => ({
  cwd,
  git: async () => undefined,
  run: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
  read: async p => {
    throw new Error(`ENOENT ${p}`)
  },
  list: async () => [],
  now: async () => 0,
  warn: () => {},
  hasOpen: () => false,
})

const shell = (src: string, output = '', tool = 'Bash'): Call => callOf({ tool, command: src }, CWD, output) as Call

describe('home and paths', () => {
  test('every home form expands to the home read from the environment, in one spelling', () => {
    setHome(HOME)
    expect(homeDir()).toBe('c:/users/you')
    expect(resolvePath('~', CWD)).toBe('c:/users/you')
    expect(resolvePath('~/projects/app', CWD)).toBe('c:/users/you/projects/app')
    expect(resolvePath('$HOME/projects', CWD)).toBe('c:/users/you/projects')
    expect(resolvePath('${HOME}/projects', CWD)).toBe('c:/users/you/projects')
    expect(resolvePath('$env:USERPROFILE\\projects', CWD)).toBe('c:/users/you/projects')
    expect(resolvePath('%USERPROFILE%\\projects', CWD)).toBe('c:/users/you/projects')
    expect(resolvePath('/c/Users/you/Projects/App', CWD)).toBe('c:/users/you/projects/app')
    expect(resolvePath('C:\\Users\\you\\Projects\\App\\src\\a.ts', CWD)).toBe('c:/users/you/projects/app/src/a.ts')
    expect(resolvePath('src/a.ts', CWD)).toBe('c:/users/you/projects/app/src/a.ts')
    // Only a whole leading word is a home form.
    expect(resolvePath('~other/x', CWD)).toBe('~other/x')
  })

  test('a POSIX home and a trailing slash read the same way', () => {
    setHome('/home/you/')
    expect(homeDir()).toBe('/home/you')
    expect(resolvePath('~/app', '/tmp')).toBe('/home/you/app')
    setHome('/c/Users/you')
    expect(resolvePath('~/app', CWD)).toBe('c:/users/you/app')
  })

  test('before the home is known, home forms stay as written', () => {
    setHome(undefined)
    expect(homeDir()).toBeUndefined()
    expect(resolvePath('~/app', CWD)).toBe('~/app')
    setHome('')
    expect(homeDir()).toBeUndefined()
    setHome(HOME)
  })

  test('under and dirOf', () => {
    setHome(HOME)
    expect(under('c:/users/you/app/src', 'c:/users/you/app')).toBe(true)
    expect(under('c:/users/you/app', 'c:/users/you/app')).toBe(true)
    expect(under('c:/users/you/app-live', 'c:/users/you/app')).toBe(false)
    const [cd, run] = commands('cd ~/projects/other && npm test', 'bash')
    expect(cd?.name).toBe('cd')
    expect(dirOf(run!, CWD)).toBe('c:/users/you/projects/other')
    expect(dirOf(commands('npm test', 'bash')[0]!, CWD)).toBe(CWD)
  })
})

describe('calls', () => {
  test('edits read their path, name and texts', () => {
    setHome(HOME)
    expect(callOf({ tool: 'Edit', file_path: 'C:\\Users\\you\\Projects\\App\\README.md', old_string: 'a', new_string: 'b' }, CWD)).toEqual({
      kind: 'edit',
      tool: 'Edit',
      path: 'c:/users/you/projects/app/readme.md',
      name: 'README.md',
      oldText: 'a',
      newText: 'b',
    })
    expect(callOf({ tool: 'Write', file_path: 'src/x.ts', content: 'x' }, CWD)).toMatchObject({ path: `${CWD}/src/x.ts`, oldText: '', newText: 'x' })
    expect(callOf({ tool: 'NotebookEdit', notebook_path: '~/n.ipynb', new_source: 'y' }, CWD)).toMatchObject({ path: 'c:/users/you/n.ipynb', name: 'n.ipynb', newText: 'y' })
    expect(callOf({ tool: 'Edit' }, CWD)).toBeUndefined()
  })

  test('shells are parsed; other tools are not read', () => {
    const b = callOf({ tool: 'Bash', command: 'cd app && npm i' }, CWD, 'added 3 packages')
    expect(b?.kind).toBe('shell')
    expect(b?.kind === 'shell' ? b.cmds.map(c => c.name) : []).toEqual(['cd', 'npm'])
    expect(b?.kind === 'shell' ? b.output : '').toBe('added 3 packages')
    expect(callOf({ tool: 'PowerShell', command: 'git status' }, CWD)?.kind).toBe('shell')
    expect(callOf({ tool: 'Read', file_path: 'a.ts' }, CWD)).toBeUndefined()
  })

  test('short and scriptArg', () => {
    expect(short('a\n  b   c')).toBe('a b c')
    expect(short('x'.repeat(10), 5)).toBe('xxxx…')
    const [node] = commands('node C:/tools/build.js --check', 'bash')
    expect(scriptArg(node!, /(^|\/)build\.js$/)).toBe('C:/tools/build.js')
    expect(scriptArg(commands('npx build.js', 'bash')[0]!, /build\.js$/)).toBeUndefined()
  })
})

describe('git', () => {
  test('git -C and cd both set the repo; global options are skipped; a quoted mention is data', () => {
    setHome(HOME)
    const [a] = commands('git -C C:/Users/you/projects/app commit -m "x"', 'bash')
    expect(gitCall(a!, CWD)).toEqual({ sub: 'commit', args: ['-m', 'x'], repo: 'c:/users/you/projects/app' })
    const cmds = commands('cd ~/projects/other && git commit -m wip', 'bash')
    expect(gitCall(cmds[1]!, CWD)?.repo).toBe('c:/users/you/projects/other')
    expect(gitCall(commands('git -c core.pager=cat --no-pager log', 'bash')[0]!, CWD)?.sub).toBe('log')
    expect(commands('echo "git commit in app"', 'bash').map(c => gitCall(c, CWD))).toEqual([undefined])
  })

  test("pushedRefs reads git's own report", () => {
    const out = 'To https://example.com/you/app.git\n   abc1234..def5678  main -> main\n'
    expect(pushedRefs(out)).toEqual([{ from: 'abc1234', to: 'def5678', dst: 'main' }])
    expect(pushedRefs(' + abc1234...def5678 main -> main (forced update)')).toEqual([{ from: 'abc1234', to: 'def5678', dst: 'main' }])
    expect(pushedRefs(' * [new branch]      feature -> feature')).toEqual([{ from: '', to: '', dst: 'feature' }])
    expect(pushedRefs('Everything up-to-date')).toEqual([])
    expect(pushedRefs(' ! [rejected]        main -> main (fetch first)')).toEqual([])
  })

  test('pushTo: the repo by its directory or its URL, the branch by name', () => {
    setHome(HOME)
    const ctx = ctxAt(CWD)
    const URL = /example\.com[/:]you\/app\b/i
    const done = 'To https://example.com/you/app.git\n   abc1234..def5678  main -> main\n'
    expect(pushTo(shell('git push origin main', done), ctx, CWD, URL, 'main')).toEqual({ range: { from: 'abc1234', to: 'def5678' }, raw: 'git push origin main' })
    expect(pushTo(shell('git -C ~/elsewhere push', done), ctx, CWD, URL, 'main')?.raw).toBe('git -C ~/elsewhere push')
    expect(pushTo(shell('git -C ~/elsewhere push', done.replace('you/app', 'you/other')), ctx, CWD, URL, 'main')).toBeUndefined()
    expect(pushTo(shell('git push origin main', done), ctx, CWD, URL, 'release')).toBeUndefined()
    expect(pushTo(shell('git push', ' * [new branch]      main -> refs/heads/main'), ctx, CWD, URL, 'main')).toEqual({ range: undefined, raw: 'git push' })
    expect(pushTo(shell('git push', 'Everything up-to-date'), ctx, CWD, URL, 'main')).toBeUndefined()
    expect(pushTo(callOf({ tool: 'Edit', file_path: 'a', new_string: 'git push' }, CWD) as Call, ctx, CWD, URL, 'main')).toBeUndefined()
  })
})

describe('markdown sections', () => {
  test("a section's own words: quotes, checkboxes, rules and placeholders removed", () => {
    const md = ['# Notes', '## Summary', '> guidance', '- [ ] ticked by hand', '<one line', 'over two>', 'Real words here.', '---', '## Next', 'later'].join('\n')
    expect(sectionBody(md, /^##\s+Summary/)).toBe('Real words here.')
    expect(sectionBody(md, /^##\s+Next/)).toBe('later')
    expect(sectionBody(md, /^##\s+Missing/)).toBeUndefined()
  })
})

describe('checklist', () => {
  const hit = { rule: 'r', key: 'k', label: 'do it', how: 'run x', trigger: 'a.json' }
  test('same key merges; nudge once; left open is never nudged', () => {
    let s = openItem(EMPTY, hit, 1).next
    s = openItem(s, { ...hit, trigger: 'b.json' }, 2).next
    expect(s.items.length).toBe(1)
    expect(s.items[0]?.triggers).toEqual(['a.json', 'b.json'])
    expect(nudgeable(s).length).toBe(1)
    expect(nudgeText(nudgeable(s))).toContain('- #1 do it: run x (opened by a.json, b.json)')
    s = markNudged(s, [1])
    expect(nudgeable(s).length).toBe(0)
    s = markLeftOpen(s, 'waiting for the user').next
    expect(s.items[0]?.leftOpen).toContain('waiting for the user')
    expect(bandLine(s)).toBe('1 follow-up: #1 do it (b.json +1) [left open]')
  })

  test('multi-step items close when every step is in; wider hits widen', () => {
    let s = openItem(EMPTY, { ...hit, needs: ['a', 'b'] }, 1).next
    s = openItem(s, { ...hit, label: 'wider', needs: ['a', 'b', 'c'] }, 2).next
    expect(s.items[0]?.needs).toEqual(['a', 'b', 'c'])
    s = addProgress(s, 1, { steps: ['a', 'b'], evidence: 'first' }, 3).next
    expect(bandLine(s)).toContain('wider 2/3')
    const r = addProgress(s, 1, { steps: ['c'], evidence: 'second' }, 4)
    expect(r.closed?.closedBy).toBe('command')
    expect(bandLine(r.next)).toBeUndefined()
  })

  test('closed items reopen as new items; the list and the tool answer show them', () => {
    let s = openItem(EMPTY, hit, 1).next
    expect(toolList(s)).toBe('1 open follow-up:\n#1 do it\n  do: run x\n  opened by: a.json')
    s = markNudged(s, [1])
    s = closeItems(s, () => true, 'user', 'x', 2).next
    expect(toolList(s)).toBe('No open follow-ups.')
    const r = openItem(s, hit, 3)
    expect(r.opened?.id).toBe(2)
    expect(nudgeable(r.next).map(i => i.id)).toEqual([2])
    const list = listText(r.next, [{ id: 'r', summary: 'a rule' }])
    expect(list).toContain('followups: 1 open, 1 closed this session')
    expect(list).toContain(`  ${'r'.padEnd(18)} a rule`)
    expect(list).toContain('      The user: x')
  })

  test('the name setting: the list and the nudge name the user; the old stored key reads as the user', () => {
    let s = openItem(EMPTY, hit, 1).next
    s = openItem(s, { ...hit, key: 'k2', label: 'other' }, 2).next
    s = closeItems(s, i => i.id === 1, 'user', 'by hand', 3).next
    s = closeItems(s, i => i.id === 2, 'owen', 'from before', 4).next
    const list = listText(s, [], 'Alex')
    expect(list).toContain('      Alex: by hand')
    expect(list).toContain('      Alex: from before')
    expect(listText(s, [])).toContain('      The user: from before')
    const open = openItem(EMPTY, hit, 1).next
    const named = nudgeText(nudgeable(open), 'Alex')
    expect(named).toContain(`(Alex's "after X, always do Y" rules):`)
    expect(named).toContain("they stay on Alex's band until closed.")
    const plain = nudgeText(nudgeable(open))
    expect(plain).toContain(`(the user's "after X, always do Y" rules):`)
    expect(plain).toContain("they stay on the user's band until closed.")
  })
})
