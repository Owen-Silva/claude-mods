// eta's hooks against the engine: the band on terminal and desktop, the Eta
// tool, the static prompt line, the nudge on the next tool result, the done
// toast, agent learning, snapshot files and the /eta pane.
import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { AgentInfo, On } from 'claude-code'

const MIN = 60_000
const NOW = Date.parse('2026-10-02T16:00:00Z')
const DIR = 'C:/Users/you/.claude/mods-data/eta'
const SCROLL = { offset: 0, bodyRows: 40 }
const BAND = { plugin: 'eta', component: 'AbovePrompt', props: { hasSurvey: false, isWorking: true, maxRows: 4, bodyColumns: 160, scroll: SCROLL, view: {} } } as const
const PANE = { plugin: 'eta', component: 'Pane', requestId: 'eta', props: { title: 'ETA', isFocused: false, bodyColumns: 160, placement: 'dock', scroll: SCROLL, view: {} } } as const

/** The engine hands paths over in the platform's spelling (backslashes on Windows). */
const norm = (p: string) => p.split('\\').join('/')

type World = {
  files: Map<string, { text: string; mtimeMs: number }>
  toasts: string[]
  listed: AgentInfo[]
  writeError?: string
  /** The history append's node run fails with this stderr. */
  appendError?: string
  /** What the tools beneath answer (default: ok). */
  toolAnswer?: { result: unknown; text: string; isError?: true }
  /** The environment the mod reads (default: USERPROFILE C:\Users\you). */
  env?: Record<string, string>
  /** The data folder the mod should list (default DIR). */
  dir?: string
  /** user.local.json's text, the name setting (default: no such file). */
  user?: string
}

/** The world beneath eta, answered from memory. */
function world(on: On, w: Partial<World> = {}) {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on)
  mock.env(on, w.env ?? { USERPROFILE: 'C:\\Users\\you' })
  const st: World = { files: w.files ?? new Map(), toasts: [], listed: w.listed ?? [], writeError: w.writeError, appendError: w.appendError }
  on('session.id', () => ({ value: 'sess-me' }))
  on('session.cwd', () => ({ value: 'C:\\Users\\you\\.claude\\mods' }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('tool.register', ($, e) => ({ value: { tool: `mcp__eta__${e.name}` } }))
  on('ui.toast', ($, e) => {
    st.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.log', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isOpen: true } }) as never)
  on('process.run', ($, e) => {
    const ok = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    // The history append (`node -e`): appended to the file in memory, as O_APPEND would.
    if (e.argv[1] === '-e' && e.init?.env?.ETA_HISTORY) {
      if (st.appendError) return { value: { exitCode: 1, stdout: '', stderr: st.appendError, isStdoutTruncated: false, isStderrTruncated: false } }
      const p = norm(e.init.env.ETA_HISTORY)
      st.files.set(p, { text: (st.files.get(p)?.text ?? '') + (e.init.stdin ?? ''), mtimeMs: clock.now() })
      return ok('ok')
    }
    return ok(JSON.stringify({ tz: 0, pruned: 0, errs: [] }))
  })
  on('fs.exists', ($, e) => ({ value: st.files.has(norm(e.path)) }))
  on('fs.write', ($, e) => {
    if (st.writeError) return { deny: st.writeError }
    st.files.set(norm(e.path), { text: e.text, mtimeMs: clock.now() })
    return { value: undefined }
  })
  on('fs.list', ($, e) => {
    const dir = w.dir ?? DIR
    expect(norm(e.path ?? '')).toBe(dir)
    return {
      value: [...st.files.entries()]
        .filter(([p]) => p.startsWith(`${dir}/`))
        .map(([p, f]) => ({ name: p.slice(dir.length + 1), kind: 'file' as const, size: f.text.length, mtimeMs: f.mtimeMs, isLink: false })),
    }
  })
  on('fs.read', ($, e) => {
    if (w.user !== undefined && /\/user\.local\.json$/.test(norm(e.path))) return { value: w.user }
    const f = st.files.get(norm(e.path))
    return f ? { value: f.text } : { deny: `ENOENT ${e.path}` }
  })
  on('agent.list', () => ({ value: st.listed }))
  on('agent.spawn', ($, e) => ({ model: 'claude-opus-5-5', agentId: /\[lane:([^\]]+)\]/.exec(e.prompt)?.[1] ?? 'a1' }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('tool.call', () => (st.toolAnswer ?? { result: 'ok', text: 'ok' }) as never)
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'You are Claude Code.', scope: 'shared' as const }] }))
  return { clock, st }
}

const start = async ($: Engine) => {
  await $.session.start({ cwd: 'C:/Users/you/.claude/mods', surface: 'terminal', isInteractive: true })
}
let turns = 0
const turnStart = ($: Engine, text = 'build the eta mod') => $.turn.start({ text, turnId: `t${++turns}` })
const turnEnd = ($: Engine, agentId?: string) =>
  $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: `t${turns}`, reason: 'answer', ...(agentId ? { agentId } : {}) })
const eta = ($: Engine, input: Record<string, unknown>) => $.tool.call({ tool: 'mcp__eta__Eta', ...input } as never)
const bash = ($: Engine) => $.tool.call({ tool: 'Bash', command: 'ls' } as never)
const spawn = ($: Engine, lane: string, subagentType: string) =>
  $.agent.spawn({
    prompt: `[lane:${lane}] do it`,
    description: lane,
    subagentType,
    tool_use_id: `toolu_${lane}`,
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'claude-opus-5-5',
    background: true,
    fork: false,
  } as never)

async function texts($: Engine, what: typeof BAND | typeof PANE, surface: 'terminal' | 'desktop' = 'terminal'): Promise<string[]> {
  const ui = await $.ui.mount({ ...what, surface } as never)
  const found = (await ui.findAll({ type: 'Text' })) as { text?: string }[]
  await ui.unmount?.()
  return found.map(t => t.text ?? '')
}
const bandText = async ($: Engine, surface: 'terminal' | 'desktop' = 'terminal') => (await texts($, BAND, surface)).join('')

describe('band', () => {
  test('idle: nothing drawn', async ($, on) => {
    world(on)
    await start($)
    expect(await bandText($, 'terminal')).toBe('')
    expect(await bandText($, 'desktop')).toBe('')
  })

  test('a declared estimate counts down on terminal and desktop', async ($, on) => {
    const { clock } = world(on)
    await start($)
    await turnStart($)
    const r = await eta($, { minutes: 12, steps: ['read', 'write', 'verify rails', 'report'], step: 3 })
    expect(String((r as { result?: unknown }).result)).toContain("The user's band now reads: ~12m left")
    await clock.advance(2 * MIN)
    for (const surface of ['terminal', 'desktop'] as const) {
      expect(await bandText($, surface)).toBe('eta ~10m left · done ~4:12 PM · step 3/4: verify rails')
    }
  })

  test('working with no estimate, then overdue in amber', async ($, on) => {
    const { clock } = world(on)
    await start($)
    await turnStart($)
    await clock.advance(3 * MIN)
    expect(await bandText($)).toBe('eta working · 3m elapsed · no estimate yet')
    await eta($, { minutes: 5 })
    await clock.advance(11 * MIN)
    for (const surface of ['terminal', 'desktop'] as const) expect(await bandText($, surface)).toBe('eta over by 6m (5m estimate)')
  })

  test('agents imply a later finish: shown with the reason', async ($, on) => {
    world(on)
    await start($)
    await turnStart($)
    await eta($, { minutes: 5 })
    await spawn($, 'mod-x', 'opus-high')
    for (const surface of ['terminal', 'desktop'] as const) {
      expect(await bandText($, surface)).toBe('eta ~15m left (agents need longer · +10m) · done ~4:15 PM · 1 agent (longest ~12m)')
    }
  })

  test('a failing data source shows its reason', async ($, on) => {
    world(on, { writeError: 'EACCES: permission denied' })
    await start($)
    await turnStart($)
    const t = await bandText($)
    expect(t).toContain('issue: snapshot: not written (')
    expect(t).toContain('EACCES')
  })
})

describe('prompt line', () => {
  test('byte-identical whatever the state', async ($, on) => {
    const { clock } = world(on)
    await start($)
    const compose = async () => {
      const r = await $.prompt.compose({ model: 'claude-opus-5-5', promptModel: 'claude-opus-5-5', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] } as never)
      return JSON.stringify(r.sections.filter(s => s.id.startsWith('eta')))
    }
    const idle = await compose()
    expect(idle).toContain('The user hates asking how much longer.')
    expect(idle).toContain("A band above the user's prompt shows the countdown.")
    await turnStart($)
    expect(await compose()).toBe(idle)
    await eta($, { minutes: 2, steps: ['a', 'b'] })
    expect(await compose()).toBe(idle)
    await spawn($, 'mod-y', 'opus-xhigh')
    await clock.advance(10 * MIN)
    expect(await bandText($)).toContain('agents')
    expect(await compose()).toBe(idle)
  })
})

describe('overdue nudge', () => {
  test('rides the next main-loop tool result once per estimate', async ($, on) => {
    const { clock } = world(on)
    await start($)
    await turnStart($)
    await eta($, { minutes: 2 })
    const ctx = async () => ((await bash($)) as { context?: readonly string[] }).context ?? []
    await clock.advance(2 * MIN)
    expect(await ctx()).toEqual([])
    await clock.advance(2 * MIN)
    const first = await ctx()
    expect(first.length).toBe(1)
    expect(first[0]).toContain('[eta] Your Eta estimate (2m, set 4m ago)')
    expect(await ctx()).toEqual([])
    await eta($, { step: 'b' })
    await clock.advance(5 * MIN)
    expect(await ctx()).toEqual([])
    await eta($, { minutes: 1 })
    await clock.advance(2 * MIN)
    // Due again, but every re-estimate nudge shares one 10-minute rate limit (the last went at 4m).
    expect(await ctx()).toEqual([])
    await clock.advance(4 * MIN)
    expect((await ctx()).length).toBe(1)
  })
})

describe('the number goes up', () => {
  const run = ($: Engine, command: string) => $.tool.call({ tool: 'Bash', command } as never)
  test('a failed test run pushes the ETA out, nudges with one line, and writes the reason to the snapshot', async ($, on) => {
    const { clock, st } = world(on)
    await start($)
    await turnStart($)
    await eta($, { minutes: 10 })
    await clock.advance(4 * MIN)
    const failed = 'Exit code 1\nℹ tests 5\nℹ pass 3\nℹ fail 2'
    st.toolAnswer = { isError: true, result: failed, text: failed }
    const r = (await run($, 'node --test tests/')) as { context?: readonly string[] }
    expect(r.context?.length).toBe(1)
    expect(r.context?.[0]).toContain('[eta] test failed (2 failed): the ETA was pushed out 10m')
    expect(await bandText($)).toBe('eta ~16m left (test failed · +10m) · done ~4:20 PM')
    const snap = JSON.parse(st.files.get(`${DIR}/sess-me.json`)?.text ?? '{}')
    expect(snap.reason).toBe('test failed · +10m')
    expect(snap.extendedBy).toBe(10)
    expect(snap.etaAt).toBe(NOW + 20 * MIN)
    // A zero-failure run is no failure, and the fix cycle (failure to pass, 6m) is learned.
    await clock.advance(6 * MIN)
    const passed = 'ℹ tests 5\nℹ pass 5\nℹ fail 0'
    st.toolAnswer = { result: { stdout: passed, stderr: '', interrupted: false }, text: passed }
    const ok = (await run($, 'node --test tests/')) as { context?: readonly string[] }
    expect(ok.context ?? []).toEqual([])
    expect((await texts($, PANE)).join('\n')).toContain('pushes the ETA out 10m (default; 1/3 fix cycles learned)')
  })

  test('the name setting: the prompt line, the tool reply and the nudge name the user', async ($, on) => {
    world(on, { user: '{ "name": "Alex" }' })
    let seen: readonly string[] | undefined
    on('prompt.submit', ($, e) => {
      seen = e.context
      return { text: e.text, context: e.context }
    })
    await start($)
    const r = await $.prompt.compose({ model: 'claude-opus-5-5', promptModel: 'claude-opus-5-5', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] } as never)
    const line = JSON.stringify(r.sections.filter(s => s.id.startsWith('eta')))
    expect(line).toContain('Alex hates asking how much longer.')
    expect(line).toContain("A band above Alex's prompt shows the countdown.")
    await turnStart($)
    expect(String((await eta($, { minutes: 12 })).result)).toContain("Alex's band now reads: ~12m left")
    await $.prompt.submit({ text: 'also fix the header', origin: { kind: 'composer' }, wait: false } as never)
    expect(seen?.[0]).toContain('Alex added a message')
  })

  test('a corrupt name setting falls back to the default name', async ($, on) => {
    world(on, { user: '{"name": 7}' })
    await start($)
    await turnStart($)
    expect(String((await eta($, { minutes: 12 })).result)).toContain("The user's band now reads: ~12m left")
  })

  test("the user's message while an ETA runs carries a one-line re-estimate nudge; a notification does not", async ($, on) => {
    const { clock } = world(on)
    let seen: readonly string[] | undefined
    on('prompt.submit', ($, e) => {
      seen = e.context
      return { text: e.text, context: e.context }
    })
    await start($)
    await turnStart($)
    await eta($, { minutes: 20 })
    await clock.advance(MIN)
    await $.prompt.submit({ text: '<task-notification>done</task-notification>', origin: { kind: 'task-notification' }, wait: false } as never)
    expect(seen ?? []).toEqual([])
    await $.prompt.submit({ text: 'also fix the header', origin: { kind: 'composer' }, wait: false } as never)
    expect(seen?.length).toBe(1)
    expect(seen?.[0]).toContain('The user added a message')
  })

  test('an agent launched after done:true reopens the countdown', async ($, on) => {
    const { clock } = world(on)
    await start($)
    await turnStart($)
    await eta($, { minutes: 5 })
    await eta($, { done: true })
    expect(await bandText($)).toContain('wrapping up')
    await clock.advance(30_000)
    await spawn($, 'late', 'opus-high')
    expect(await bandText($)).toContain('left')
  })
})

describe('done', () => {
  test('a turn of three minutes or more ends with a toast; a short one does not', async ($, on) => {
    const { clock, st } = world(on)
    await start($)
    await turnStart($)
    await clock.advance(MIN)
    await turnEnd($)
    await clock.advance(5000)
    expect(st.toasts).toEqual([])
    expect(await bandText($)).toBe('')

    await turnStart($)
    await eta($, { minutes: 3 })
    await clock.advance(4 * MIN)
    await turnEnd($)
    await clock.advance(5000)
    expect(st.toasts).toEqual(['eta: done after 4m (estimated 3m)'])
    expect(await bandText($)).toBe('')
  })

  test('done:true toasts once, then wraps up until the turn ends', async ($, on) => {
    const { clock, st } = world(on)
    await start($)
    await turnStart($)
    await eta($, { minutes: 10 })
    await clock.advance(5 * MIN)
    await eta($, { done: true })
    expect(st.toasts).toEqual(['eta: done after 5m (estimated 10m)'])
    expect(await bandText($)).toBe('eta wrapping up · 5m elapsed')
    await turnEnd($)
    await clock.advance(5000)
    expect(st.toasts.length).toBe(1)
    expect(await bandText($)).toBe('')
  })

  test('background tasks keep the work open, labelled as such; an end long after has no toast', async ($, on) => {
    const { clock, st } = world(on)
    on('classic.Stop', () => ({}) as never)
    await start($)
    await turnStart($)
    await clock.advance(4 * MIN)
    await turnEnd($)
    await $.classic.Stop({
      stop_hook_active: false,
      background_tasks: [
        { id: 'b1', type: 'shell', status: 'running', description: 'npm test' },
        { id: 'b2', type: 'subagent', status: 'running', description: 'a lane' },
      ],
    } as never)
    await clock.advance(5000)
    expect(await bandText($)).toBe('eta waiting on 1 background task · 4m elapsed · no estimate yet')
    await clock.advance(31 * MIN)
    expect(await bandText($)).toBe('')
    expect(st.toasts).toEqual([])
  })

  test('an interrupted turn ends the work with no toast and no calibration sample', async ($, on) => {
    const { clock, st } = world(on)
    await start($)
    await turnStart($)
    await eta($, { minutes: 2 })
    await clock.advance(5 * MIN)
    await $.turn.complete({ answer: '', durationMs: 1, isAborted: true, turnId: `t${turns}`, reason: 'aborted' } as never)
    await clock.advance(5000)
    expect(st.toasts).toEqual([])
    expect(await bandText($)).toBe('')
    const r = await $.command.run({ command: 'eta', args: '' } as never)
    expect(String((r as { text?: string }).text)).toContain('No finished estimates yet')
  })

  test("a subagent calling Eta leaves the main session's plan alone", async ($, on) => {
    world(on)
    await start($)
    await turnStart($)
    await eta($, { minutes: 12 })
    const r = await $.tool.call({ tool: 'mcp__eta__Eta', minutes: 1, agentId: 'a9' } as never)
    expect(String((r as { result?: unknown }).result)).toContain('main session only')
    expect(await bandText($)).toContain('~12m left')
  })

  test('the turn ending while agents run keeps the countdown', async ($, on) => {
    const { clock, st } = world(on)
    await start($)
    await turnStart($)
    await spawn($, 'mod-z', 'opus-high')
    await turnEnd($)
    await clock.advance(5000)
    expect(await bandText($)).toContain('1 agent')
    expect(st.toasts).toEqual([])
  })
})

describe('learning and the pane', () => {
  test('a finished agent teaches its type; /eta explains calibration and lists every session', async ($, on) => {
    const files = new Map<string, { text: string; mtimeMs: number }>()
    const other = (id: string, over: Record<string, unknown>) =>
      files.set(`${DIR}/${id}.json`, {
        mtimeMs: NOW,
        text: JSON.stringify({ v: 1, sessionId: id, project: 'webapp', cwd: 'C:/code/webapp', label: 'fix the deploy', state: 'working', summary: '', etaAt: NOW + 20 * MIN, isOverdue: false, agentsRunning: 0, workStartedAt: NOW - MIN, updatedAt: NOW, ...over }),
      })
    other('sess-webapp', {})
    other('sess-old', { state: 'idle', updatedAt: NOW - 20 * MIN, label: 'old' })
    files.set(`${DIR}/broken.json`, { text: '{nope', mtimeMs: NOW })
    const { clock, st } = world(on, { files })
    await start($)
    await turnStart($, 'ship the eta mod please')
    await spawn($, 'mod-w', 'opus-high')
    st.listed = [{ id: 'mod-w', description: 'mod-w', type: 'opus-high', status: 'running' }]
    await clock.advance(10 * MIN)
    st.listed = [{ id: 'mod-w', description: 'mod-w', type: 'opus-high', status: 'completed' }]
    await clock.advance(20_000)

    // Our own snapshot is on disk for other sessions to read.
    const mine = JSON.parse(files.get(`${DIR}/sess-me.json`)?.text ?? '{}') as { state?: string; label?: string; project?: string }
    expect(mine).toMatchObject({ state: 'working', label: 'ship the eta mod please', project: 'mods' })

    const r = await $.command.run({ command: 'eta', args: '' } as never)
    const text = String((r as { text?: string }).text)
    expect(text).toContain('Calibration:')
    expect(text).toContain('No finished estimates yet. After 3')

    const pane = (await texts($, PANE)).join('\n')
    expect(pane).toContain('opus-high ~11m (1 learned + 4 prior)')
    expect(pane).toContain('> mods')
    expect(pane).toContain('webapp  ~10m left · done ~4:20 PM  "fix the deploy"')
    expect(pane).toContain('Not listed: 1 idle with no update for >15m.')
    expect(pane).toContain('Unreadable snapshot broken.json: not JSON')
    expect(pane).not.toContain('"old"')
  })

  test('the session end marks its snapshot ended', async ($, on) => {
    const { st } = world(on)
    await start($)
    await turnStart($)
    await $.session.end({ reason: 'other', sessionId: 'sess-me' } as never)
    const mine = JSON.parse(st.files.get(`${DIR}/sess-me.json`)?.text ?? '{}') as { state?: string }
    expect(mine.state).toBe('ended')
  })
})

describe('data folder', () => {
  test('derived from USERPROFILE: snapshots there, the pane names it', async ($, on) => {
    const { st } = world(on)
    await start($)
    await turnStart($)
    await $.command.run({ command: 'eta', args: '' } as never)
    expect(st.files.has(`${DIR}/sess-me.json`)).toBe(true)
    expect((await texts($, PANE)).join('\n')).toContain(`All sessions (${DIR})`)
  })

  test('CLAUDE_CONFIG_DIR moves it', async ($, on) => {
    const dir = 'D:/cfg/mods-data/eta'
    const { st } = world(on, { env: { CLAUDE_CONFIG_DIR: 'D:\\cfg\\', USERPROFILE: 'C:\\Users\\you' }, dir })
    await start($)
    await turnStart($)
    await $.command.run({ command: 'eta', args: '' } as never)
    expect(st.files.has(`${dir}/sess-me.json`)).toBe(true)
    expect((await texts($, PANE)).join('\n')).toContain(`All sessions (${dir})`)
  })

  test('no home folder: nothing written, the pane says why', async ($, on) => {
    const { st } = world(on, { env: {} })
    await start($)
    await turnStart($)
    await $.command.run({ command: 'eta', args: '' } as never)
    expect([...st.files.keys()]).toEqual([])
    const pane = (await texts($, PANE)).join('\n')
    expect(pane).toContain('All sessions (no data folder: USERPROFILE and HOME are unset)')
    expect(pane).toContain('not written (no data folder: USERPROFILE and HOME are unset)')
  })
})

describe('history', () => {
  const HIST = `${DIR}/history.jsonl`
  const lines = (st: World) => (st.files.get(HIST)?.text ?? '').split('\n').filter(Boolean).map(l => JSON.parse(l) as Record<string, unknown>)

  test('a finished plan appends one line: numbers and times only, every estimate with its time', async ($, on) => {
    const { clock, st } = world(on)
    await start($)
    await turnStart($, 'secret prompt text that must not be written')
    await eta($, { minutes: 20, steps: ['read the private file', 'fix it'], note: 'private note' })
    await clock.advance(5 * MIN)
    await eta($, { minutes: 30, step: 2 })
    await clock.advance(10 * MIN)
    await eta($, { done: true })
    const recs = lines(st)
    expect(recs.length).toBe(1)
    const r = recs[0] as Record<string, unknown>
    expect(r.first).toBe(20)
    expect(r.took).toBe(15)
    expect(r.end).toBe('done')
    expect(r.src).toBe('live')
    expect(r.session).toBe('sess-me')
    expect(r.project).toBe('mods')
    expect((r.estimates as { min: number; at: number }[]).map(e => [e.min, e.at - NOW])).toEqual([[20, 0], [30, 5 * MIN]])
    const raw = st.files.get(HIST)?.text ?? ''
    expect(raw.includes('secret')).toBe(false)
    expect(raw.includes('private')).toBe(false)
    expect(Object.keys(r).sort()).toEqual(['end', 'estimates', 'factor', 'factorSrc', 'finishedAt', 'first', 'firstAt', 'id', 'project', 'range', 'session', 'src', 'startedAt', 'took', 'v'])
  })

  test('a plan that ends by the work going idle is written too; one without minutes is not', async ($, on) => {
    const { clock, st } = world(on)
    await start($)
    await turnStart($)
    await eta($, { steps: ['look'] })
    await clock.advance(4 * MIN)
    await turnEnd($)
    await clock.advance(5000)
    expect(lines(st).length).toBe(0)
    await turnStart($)
    await eta($, { minutes: 8 })
    await clock.advance(6 * MIN)
    await turnEnd($)
    await clock.advance(5000)
    const recs = lines(st)
    expect(recs.length).toBe(1)
    expect(recs[0]?.end).toBe('idle')
    expect(recs[0]?.took).toBe(6)
  })

  test('when the node append fails it falls back to a rewrite; when that fails too the band says so', async ($, on) => {
    const { clock, st } = world(on, { appendError: 'node: not found' })
    st.files.set(HIST, { text: '{"v":1}\n', mtimeMs: NOW })
    await start($)
    await turnStart($)
    await eta($, { minutes: 5 })
    await clock.advance(4 * MIN)
    await eta($, { done: true })
    expect((st.files.get(HIST)?.text ?? '').split('\n').filter(Boolean).length).toBe(2)
    st.writeError = 'disk full'
    await turnEnd($)
    await turnStart($)
    await eta($, { minutes: 5 })
    await clock.advance(4 * MIN)
    await eta($, { done: true })
    await turnEnd($)
    await turnStart($)
    expect(await bandText($)).toContain('history: a finished task was not written to the history')
  })
})
