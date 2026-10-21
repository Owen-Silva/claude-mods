// The mod against the engine, whatever rule set rules.local.ts holds: the
// Followups tool, /followups, the band, the end-of-turn nudge, and the home a
// call's paths expand against. Items are seeded through the mod's own state.
// When the active set is the example set (a fresh clone), its rules also run
// end to end.
import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, PromptOrigin } from 'claude-code'

import { RULES as EXAMPLE_RULES } from '../hooks/rules.example'
import { RULES, TOOL_EXAMPLES } from '../hooks/rules.local'
import type { Followup, FollowupsSession } from '../types'

const NOW = Date.parse('2026-10-02T15:00:00Z')
const H = 'C:\\Users\\you'
const APP = 'c:/users/you/projects/my-app'

type World = {
  env: Record<string, string>
  envReads: string[]
  ahead: string
  /** The next tool call fails. */
  fail: boolean
  toasts: string[]
  tools: { name: string; description: string }[]
  commands: string[]
  /** What the mod's checklist holds while it has written nothing yet (items seeded by the test). */
  seed?: FollowupsSession
  /** user.local.json's text (the name setting); undefined: no such file. */
  user?: string
}

function world(on: On, env: Record<string, string> = { USERPROFILE: H }): World {
  const w: World = { env, envReads: [], ahead: '1', fail: false, toasts: [], tools: [], commands: [] }
  mock.clock(on, { now: NOW })
  on('env.get', ($, e) => {
    w.envReads.push(e.name)
    return { value: w.env[e.name] }
  })
  // Seeding: while the store holds nothing, the checklist reads as the seed; the mod's first write replaces it.
  on('state.get', async ($, e, next) => {
    const r = await next(e)
    const read = (r as { value?: { value?: unknown; version: number } }).value
    const isSession = (e as { plugin?: string; key?: string }).plugin === 'followups' && (e as { key?: string }).key === 'session'
    if (!isSession || w.seed === undefined || read === undefined || read.value !== undefined) return r
    return { ...r, value: { ...read, value: w.seed } } as never
  })
  on('classic.Stop', () => ({}))
  on('session.cwd', () => ({ value: H }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => {
    w.commands.push(e.name)
    return { value: { command: e.name } }
  })
  on('tool.register', ($, e) => {
    w.tools.push({ name: e.name, description: e.description })
    return { value: { tool: `mcp__followups__${e.name}` } }
  })
  on('ui.toast', ($, e) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  on('fs.read', ($, e) => (w.user !== undefined && /[\\/]user\.local\.json$/.test(e.path) ? { value: w.user } : { deny: `ENOENT: no such file ${e.path}` }))
  on('fs.list', ($, e) => ({ deny: `ENOENT: no such directory ${e.path}` }))
  on('process.run', ($, e) => {
    const argv = e.argv.map(String)
    const isCount = argv[0] === 'git' && argv.includes('rev-list')
    return { value: { exitCode: isCount ? 0 : 128, stdout: isCount ? w.ahead : '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('tool.call', () => {
    const failed = w.fail
    w.fail = false
    if (failed) return { isError: true as const, result: 'Exit code 1', text: 'Exit code 1' }
    return { result: { stdout: '', stderr: '', interrupted: false } as never, text: 'ok' }
  })
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box key="engine" />
  })
  return w
}

const start = ($: Engine) => $.session.start({ cwd: H, surface: 'terminal', isInteractive: true })

const ITEM: Followup = {
  id: 1,
  rule: 'example',
  key: 'example',
  label: 'tidy the docs',
  how: 'run npm run docs:tidy',
  triggers: ['README.md'],
  needs: ['done'],
  progress: [],
  openedAt: NOW,
  isOpen: true,
  isNudged: false,
}
function seed(w: World, items: Followup[] = [ITEM]): void {
  w.seed = { nextId: items.length + 1, items }
}

async function bash($: Engine, command: string) {
  return $.tool.call({ tool: 'Bash', command } as never)
}
async function followups($: Engine, args = '', origin: PromptOrigin = { kind: 'composer' } as PromptOrigin): Promise<string> {
  const r = await $.command.run({ command: 'followups', args, origin, presentation: { isFullscreen: false, columns: 140 } })
  return r.text ?? ''
}
async function tool($: Engine, input: Record<string, unknown>): Promise<string> {
  const r = await $.tool.call({ tool: 'mcp__followups__Followups', ...input } as never)
  return String(r.result)
}

const BAND = {
  plugin: 'followups',
  component: 'AbovePrompt' as const,
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 160, scroll: { offset: 0, bodyRows: 10 }, view: {} },
}
async function band($: Engine, surface: 'terminal' | 'desktop' = 'terminal'): Promise<string> {
  const ui = await $.ui.mount({ ...BAND, surface })
  const texts = (await ui.findAll({ type: 'Text' })) as { text?: string }[]
  await ui.unmount?.()
  return texts.map(t => t.text ?? '').join('')
}

describe('session start', () => {
  test('registers /followups and the Followups tool, whose description carries the active examples', async ($, on) => {
    const w = world(on)
    await start($)
    expect(w.commands).toEqual(['followups'])
    expect(w.tools.map(t => t.name)).toEqual(['Followups'])
    const d = w.tools[0]?.description ?? ''
    expect(d.startsWith("The user's follow-up checklist: obligations that memory rules attach to edits and commands ")).toBe(true)
    expect(d).toContain(` ${TOOL_EXAMPLES} Items open by themselves`)
    expect(d).toContain('action "leave_open": keep one open on purpose (it waits for the user, or does not apply)')
    expect(d).toContain('The user sees the evidence.')
  })

  test('the name setting names the user in the description', async ($, on) => {
    const w = world(on)
    w.user = '{ "name": "Alex" }'
    await start($)
    const d = w.tools[0]?.description ?? ''
    expect(d.startsWith("Alex's follow-up checklist: obligations that memory rules attach to edits and commands ")).toBe(true)
    expect(d).toContain('(it waits for Alex, or does not apply)')
    expect(d).toContain('Alex sees the evidence.')
    expect(d).not.toContain('the user')
  })

  test('a corrupt name setting falls back to the default name', async ($, on) => {
    const w = world(on)
    w.user = '{ "name": '
    await start($)
    expect((w.tools[0]?.description ?? '').startsWith("The user's follow-up checklist")).toBe(true)
  })
})

describe('/followups', () => {
  test('lists the active rules in order, nothing open', async ($, on) => {
    world(on)
    await start($)
    const list = await followups($)
    // (Running on the fallback, a warning line leads; fallback.test.tsx covers it.)
    expect(list).toContain('followups: 0 open, 0 closed this session')
    let at = list.indexOf('Rules')
    for (const r of RULES) {
      const next = list.indexOf(`  ${r.id.padEnd(18)} ${r.summary}`)
      expect(next > at).toBe(true)
      at = next
    }
    expect(await followups($, 'nope')).toContain('unknown "nope"')
  })

  test('done and clear are for the user alone', async ($, on) => {
    const w = world(on)
    await start($)
    seed(w, [ITEM, { ...ITEM, id: 2, key: 'other', label: 'second' }])
    expect(await followups($, 'done 1', { kind: 'plugin', name: 'x' } as PromptOrigin)).toBe(
      'followups: only the user closes items by command; the model uses the Followups tool with evidence.',
    )
    expect(await followups($, 'done 1')).toBe('followups: closed #1 tidy the docs.')
    expect(await followups($, 'done 9')).toBe('followups: no open item #9. #2')
    expect(await followups($, 'clear')).toBe('followups: closed 1 open item.')
    const after = await followups($)
    expect(after).toContain('0 open, 2 closed')
    expect(after).toContain('The user: closed with /followups done')
  })

  test('with a name set, the refusal and the closes carry it; an item closed under the old key reads the same', async ($, on) => {
    const w = world(on)
    w.user = '{ "name": "Alex" }'
    await start($)
    const old: Followup = { ...ITEM, id: 2, key: 'old', label: 'older one', isOpen: false, closedBy: 'owen', evidence: 'closed with /followups done', closedAt: NOW }
    seed(w, [ITEM, old])
    expect(await followups($, 'clear', { kind: 'plugin', name: 'x' } as PromptOrigin)).toContain('only Alex closes items by command')
    expect(await followups($, 'done 1')).toBe('followups: closed #1 tidy the docs.')
    const list = await followups($)
    expect(list).toContain('0 open, 2 closed')
    expect(list.split('\n').filter(l => l === '      Alex: closed with /followups done')).toHaveLength(2)
  })
})

describe('Followups tool', () => {
  test('list, done needs evidence, the evidence is shown', async ($, on) => {
    const w = world(on)
    await start($)
    expect(await tool($, { action: 'list' })).toBe('No open follow-ups.')
    seed(w)
    expect(await tool($, { action: 'list' })).toBe('1 open follow-up:\n#1 tidy the docs\n  do: run npm run docs:tidy\n  opened by: README.md')
    expect(await tool($, { action: 'done', id: 1 })).toContain('needs evidence')
    expect(await tool($, { action: 'done', id: 1, evidence: 'ran npm run docs:tidy: 0 problems' })).toContain('Closed #1')
    expect(w.toasts.join('\n')).toContain('model closed #1 tidy the docs: "ran npm run docs:tidy: 0 problems"')
    expect(await tool($, { action: 'done', id: 1, evidence: 'again and again' })).toContain('No open follow-up #1')
    expect(await tool($, { action: 'shrug', id: 1 })).toContain('No open follow-up #1')
  })

  test('leave_open needs a reason and is never nudged', async ($, on) => {
    const w = world(on)
    await start($)
    seed(w)
    expect(await tool($, { action: 'leave_open', id: 1 })).toContain('needs a one-line reason')
    expect(await tool($, { action: 'leave_open', id: 1, reason: 'waits for a review' })).toBe("#1 stays open on the user's band; you will not be reminded of it again.")
    expect(w.toasts.join('\n')).toContain('model left #1 tidy the docs open: "waits for a review"')
    expect((await $.classic.Stop({ stop_hook_active: false })).block).toBeUndefined()
    expect(await band($)).toBe('1 follow-up: #1 tidy the docs (README.md) [left open]')
  })
})

describe('end-of-turn nudge', () => {
  test('one block per item, never a second; held while agents run', async ($, on) => {
    const w = world(on)
    await start($)
    expect((await $.classic.Stop({ stop_hook_active: false })).block).toBeUndefined()
    seed(w)
    const busy = await $.classic.Stop({ stop_hook_active: false, background_tasks: [{ id: 'a1', type: 'subagent', status: 'running', description: 'lane' }] })
    expect(busy.block).toBeUndefined()
    const first = await $.classic.Stop({ stop_hook_active: false })
    expect(first.block).toContain('- #1 tidy the docs: run npm run docs:tidy (opened by README.md)')
    const again = await $.classic.Stop({ stop_hook_active: true, last_assistant_message: 'The docs tidy waits for the release.' })
    expect(again.block).toBeUndefined()
    expect(w.toasts.join('\n')).toContain('model stopped with #1 still open')
    expect((await $.classic.Stop({ stop_hook_active: false })).block).toBeUndefined()
    expect(await followups($)).toContain('left open: stopped after the nudge: The docs tidy waits for the release.')
  })
})

describe('band', () => {
  test('absent with nothing open, one line with items, on terminal and desktop', async ($, on) => {
    const w = world(on)
    await start($)
    for (const surface of ['terminal', 'desktop'] as const) expect(await band($, surface)).toBe('')
    seed(w)
    for (const surface of ['terminal', 'desktop'] as const) expect(await band($, surface)).toBe('1 follow-up: #1 tidy the docs (README.md)')
  })
})

describe('calls and the home', () => {
  test('a successful watched call reads the home first: USERPROFILE, else HOME', async ($, on) => {
    const w = world(on)
    await start($)
    await bash($, 'echo hello')
    expect(w.envReads).toEqual(['USERPROFILE'])
    w.env = { HOME: '/home/you' }
    w.envReads = []
    await bash($, 'echo hello')
    expect(w.envReads).toEqual(['USERPROFILE', 'HOME'])
  })

  test('failed calls and unwatched tools are not read', async ($, on) => {
    const w = world(on)
    await start($)
    w.fail = true
    await bash($, 'echo hello')
    await $.tool.call({ tool: 'Read', file_path: `${H}\\notes.md` } as never)
    expect(w.envReads).toEqual([])
    expect(await tool($, { action: 'list' })).toBe('No open follow-ups.')
  })
})

// A fresh clone's rule set (rules.local.ts copied from rules.example.ts), end to end.
const isExampleSet = RULES.map(r => `${r.id}\n${r.summary}`).join('\n') === EXAMPLE_RULES.map(r => `${r.id}\n${r.summary}`).join('\n')
if (isExampleSet) {
  describe('example rules through the engine', () => {
    test('a package.json edit opens npm install; an install in that folder closes it', async ($, on) => {
      const w = world(on)
      await start($)
      const r = await $.tool.call({ tool: 'Edit', file_path: '~\\projects\\my-app\\package.json', old_string: 'a', new_string: 'b' } as never)
      expect(String(r.context?.join('\n'))).toContain(`[followups] Opened #1 "npm install" (from package.json): run npm install in ${APP}`)
      await bash($, 'cd ~/projects/my-app && npm test')
      expect(await band($)).toBe('1 follow-up: #1 npm install (package.json)')
      await bash($, 'cd ~/projects/my-app && npm install')
      expect(await band($)).toBe('')
      expect(w.toasts.join('\n')).toContain('#1 npm install closed (npm install)')
    })

    test('a commit in the configured repo opens a push; the push that levels it closes', async ($, on) => {
      const w = world(on)
      await start($)
      await bash($, 'cd ~/projects/my-app && git commit -m "fix"')
      expect(await band($)).toBe('1 follow-up: #1 push my-app (git commit)')
      await bash($, 'cd ~/projects/my-app-live && git commit -m "fix"')
      expect(await band($)).toBe('1 follow-up: #1 push my-app (git commit)')
      w.ahead = '0'
      await bash($, 'git -C ~/projects/my-app push')
      expect(await band($)).toBe('')
    })
  })
}
