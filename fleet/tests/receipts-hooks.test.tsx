import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { AgentInfo, On } from 'claude-code'

const NOW = 1_800_000_000_000
const SCROLL = { offset: 0, bodyRows: 30 }
const PANE = { component: 'Pane', requestId: 'fleet', props: { title: 'Fleet', isFocused: false, bodyColumns: 120, placement: 'dock', scroll: SCROLL, view: {} } } as const

const norm = (p: string) => p.replace(/\\/g, '/').toLowerCase()

type World = { toasts: string[]; listed: AgentInfo[]; disk: Set<string> }

/** The engine beneath fleet: clock, agent list, transcript reader, disk, the tools a subagent calls. */
function world(on: On, w: World) {
  const clock = mock.clock(on, { now: NOW })
  on('agent.spawn', ($, e) => ({ model: 'claude-opus-5-5', agentId: /lane:(\S+)\]/.exec(e.prompt)?.[1] === 'mod-quiet' ? 'a2' : 'a1' }))
  on('agent.list', () => ({ value: w.listed }))
  on('session.id', () => ({ value: 'sid-1' }))
  on('process.run', () => {
    const hits: Record<string, unknown> = {}
    for (const a of w.listed) hits[a.id] = { isFound: true, startedAt: NOW - 1000 }
    return { value: { exitCode: 0, stdout: JSON.stringify({ root: '/r', isRootReadable: true, hits }), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  // the engine hands fs paths resolved (C:...); compare slash- and case-blind
  on('fs.exists', ($, e) => ({ value: w.disk.has(norm(e.path)) }))
  on('tool.call', ($, e) => {
    const p = String((e as unknown as { file_path?: string }).file_path ?? '')
    if (p.includes('denied')) return { deny: 'Permission denied' }
    if (p.includes('broken')) return { result: 'old_string not found', text: 'old_string not found', isError: true } as never
    return { result: { ok: true }, text: 'ok' } as never
  })
  on('ui.render', () => ({ type: 'engine', ref: 0 }))
  on('turn.complete', () => ({ text: '' }))
  on('ui.toast', ($, e) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  return clock
}

let spawned = 0
function spawn($: Engine, lane: string) {
  spawned += 1
  return $.agent.spawn({
    prompt: `[lane:${lane}]\n\ngo`,
    description: `Build ${lane}`,
    subagentType: 'opus-high',
    tool_use_id: `toolu_r${spawned}`,
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'claude-opus-5-5',
    background: true,
    fork: false,
  })
}

/** One tool call made inside subagent `agentId`. */
function edit($: Engine, agentId: string, tool: 'Edit' | 'Write', file_path: string) {
  const input = tool === 'Edit' ? { old_string: 'a', new_string: 'b' } : { content: 'x' }
  return $.tool.call({ tool, file_path, ...input, agentId } as never).catch(() => undefined)
}

async function finish($: Engine, w: World, clock: { advance: (ms: number) => Promise<void>; settle: () => Promise<void> }, ids: string[]) {
  w.listed = w.listed.map(a => (ids.includes(a.id) ? { ...a, status: 'completed' } : a))
  for (const id of ids) await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: `t-${id}`, agentId: id, reason: 'answer' })
  await clock.advance(1500)
  await clock.settle()
}

test('receipts: success-only recording, finish toast with MISSING, NO-files toast, pane rows, tool output', async ($, on) => {
  const w: World = { toasts: [], listed: [], disk: new Set(['c:/proj/rules.ts', 'c:/proj/register.ts']) }
  const clock = world(on, w)

  await spawn($, 'mod-rails2')
  await spawn($, 'mod-quiet')
  w.listed = [
    { id: 'a1', description: 'Build mod-rails2', type: 'opus-high', status: 'running' },
    { id: 'a2', description: 'Build mod-quiet', type: 'opus-high', status: 'running' },
  ]
  await edit($, 'a1', 'Edit', 'C:/proj/rules.ts')
  await edit($, 'a1', 'Edit', 'C:/proj/rules.ts')
  await edit($, 'a1', 'Write', 'C:/proj/register.ts')
  await edit($, 'a1', 'Write', 'C:/proj/rails.test.ts') // succeeds, but is gone from disk by the end
  await edit($, 'a1', 'Edit', 'C:/proj/broken.ts') // the tool errored: no write
  await edit($, 'a1', 'Write', 'C:/proj/denied.ts') // denied: no write
  await edit($, 'a2', 'Edit', 'C:/proj/broken.ts') // a2 only ever fails
  await clock.settle()
  expect(w.toasts.filter(t => /finished/.test(t))).toHaveLength(0) // nothing until they end

  await finish($, w, clock, ['a1', 'a2'])
  const done = w.toasts.filter(t => /finished/.test(t))
  expect(done).toHaveLength(2)
  expect(done).toContain('fleet: mod-rails2 finished · wrote 3 files (rules.ts x2, rails.test.ts, register.ts) · 1 MISSING on disk: rails.test.ts')
  expect(done).toContain('fleet: mod-quiet finished · wrote NO files (1 edit failed)')

  // once per agent: later refreshes do not toast again
  await clock.advance(12_000)
  await clock.settle()
  expect(w.toasts.filter(t => /finished/.test(t))).toHaveLength(2)

  for (const surface of ['terminal', 'desktop'] as const) {
    const pane = await $.ui.mount({ plugin: 'fleet', surface, ...PANE })
    const r1 = await pane.find({ key: 'receipt-a1' })
    expect(r1?.text).toMatch(/wrote 3: rules\.ts x2, rails\.test\.ts MISSING, register\.ts/)
    expect((await pane.find({ key: 'receipt-a2' }))?.text).toMatch(/wrote NO files · 1 failed edit/)
    await pane.unmount()
  }

  // the tool: one call verifies a report, on disk now
  w.disk.add('c:/proj/rails.test.ts')
  const r = await $.tool.call({ tool: 'mcp__fleet__FleetReceipts', agent: 'mod-rails2' } as never)
  const out = JSON.parse(String((r as { result?: unknown }).result)) as { agents: Array<Record<string, unknown>> }
  expect(out.agents).toHaveLength(1)
  const v = out.agents[0] as { lane: string; receipt: string; verdict: string; files: unknown[]; failedEdits: number; shellWritesMaybeUntracked: boolean }
  expect(v.lane).toBe('mod-rails2')
  expect(v.receipt).toBe('complete')
  expect(v.verdict).toBe('wrote 3 files, all on disk')
  expect(v.failedEdits).toBe(2)
  expect(v.shellWritesMaybeUntracked).toBe(false)
  expect(v.files).toEqual([
    { path: 'C:/proj/rules.ts', edits: 2, via: 'tool', exists: true },
    { path: 'C:/proj/rails.test.ts', edits: 1, via: 'tool', exists: true },
    { path: 'C:/proj/register.ts', edits: 1, via: 'tool', exists: true },
  ])

  const none = await $.tool.call({ tool: 'mcp__fleet__FleetReceipts', agent: 'nope' } as never)
  expect((JSON.parse(String((none as { result?: unknown }).result)) as { note: string }).note).toMatch(/no agent matches "nope"; agents fleet knows: .*mod-rails2/)
})

test('receipts: an agent started before fleet loaded says so instead of an empty list', async ($, on) => {
  const w: World = { toasts: [], listed: [], disk: new Set(['c:/proj/late.ts']) }
  const clock = world(on, w)
  // never spawned under fleet: first met in the agent list, already running
  w.listed = [{ id: 'old', description: 'Earlier job', type: 'Explore', status: 'running' }]
  await spawn($, 'mod-rails2') // kicks a refresh that lists `old`
  await clock.advance(1500)
  await clock.settle()
  await edit($, 'old', 'Write', 'C:/proj/late.ts')
  await finish($, w, clock, ['old'])

  expect(w.toasts).toContainEqual(expect.stringMatching(/^fleet: Earlier job finished · no full receipt: started before fleet loaded; 1 file seen since \(late\.ts\)$/))
  const pane = await $.ui.mount({ plugin: 'fleet', surface: 'terminal', ...PANE })
  expect((await pane.find({ key: 'receipt-old' }))?.text).toMatch(/partial \(started before fleet loaded\) · wrote 1: late\.ts/)

  const r = await $.tool.call({ tool: 'mcp__fleet__FleetReceipts', agent: 'Earlier' } as never)
  const v = (JSON.parse(String((r as { result?: unknown }).result)) as { agents: Array<{ receipt: string; verdict: string }> }).agents[0]
  expect(v?.receipt).toBe('partial')
  expect(v?.verdict).toMatch(/^partial receipt \(started before fleet loaded\): wrote 1 file, all on disk since recording began/)
})
