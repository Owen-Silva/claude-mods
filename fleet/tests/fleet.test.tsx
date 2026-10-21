import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { AgentInfo, On } from 'claude-code'

const NOW = 1_800_000_000_000
const SCROLL = { offset: 0, bodyRows: 20 }
const BAND = { component: 'AbovePrompt', props: { hasSurvey: false, isWorking: true, maxRows: 4, bodyColumns: 100, scroll: SCROLL, view: {} } } as const
const PANE = { component: 'Pane', requestId: 'fleet', props: { title: 'Fleet', isFocused: false, bodyColumns: 110, placement: 'dock', scroll: SCROLL, view: {} } } as const

type World = { toasts: string[]; listed: AgentInfo[]; probe: 'ok' | 'fail' }

/** The engine beneath fleet: a clock, the agent list, the transcript reader, toasts. */
function world(on: On, w: World) {
  const clock = mock.clock(on, { now: NOW })
  on('agent.spawn', ($, e) => ({ model: 'claude-opus-5-5', agentId: e.prompt.includes('lane:mod-pace') ? 'a2' : 'a1' }))
  on('agent.list', () => ({ value: w.listed }))
  on('session.id', () => ({ value: 'sid-1' }))
  on('process.run', () => {
    if (w.probe === 'fail') return { value: { exitCode: 1, stdout: '', stderr: 'Error: EACCES reading projects', isStdoutTruncated: false, isStderrTruncated: false } }
    const hits: Record<string, unknown> = {}
    for (const a of w.listed) hits[a.id] = { isFound: true, startedAt: NOW - 1000 }
    return { value: { exitCode: 0, stdout: JSON.stringify({ root: '/r', isRootReadable: true, hits }), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.render', () => ({ type: 'engine', ref: 0 }))
  on('turn.complete', () => ({ text: '' }))
  on('ui.toast', ($, e) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  return clock
}

/** The Agent tool starting a subagent, as the engine raises it. */
let spawned = 0
function spawn($: Engine, a: { prompt: string; description: string; subagentType: string }) {
  spawned += 1
  return $.agent.spawn({
    ...a,
    tool_use_id: `toolu_${spawned}`,
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'claude-opus-5-5',
    background: true,
    fork: false,
  })
}

/** One subagent request whose context was `ctx` tokens. */
async function step($: Engine, agentId: string, ctx: number) {
  const s = $.turn.step({ turnId: `t-${agentId}`, index: 0, model: 'claude-opus-5-5', messageCount: 3, agentId })
  for await (const _ of s) {
    // drain
  }
  return ctx
}

function answerSteps(on: On, sizes: Record<string, number>) {
  on('turn.step', async function* ($, e) {
    const ctx = sizes[e.agentId ?? ''] ?? 0
    return {
      turnId: e.turnId,
      index: e.index,
      answer: '',
      toolUses: [],
      stopReason: 'tool_use' as const,
      usage: { input_tokens: 10, output_tokens: 0, cache_read_input_tokens: ctx - 10, cache_creation_input_tokens: 0, model: 'claude-opus-5-5' },
    }
  })
}

test('band shows running agents with the peak lane; toasts at 32% once; nothing when idle', async ($, on) => {
  const w: World = { toasts: [], listed: [], probe: 'ok' }
  const clock = world(on, w)
  const sizes: Record<string, number> = { a1: 180_000, a2: 50_000 }
  answerSteps(on, sizes)

  for (const surface of ['terminal', 'desktop'] as const) {
    const idle = await $.ui.mount({ plugin: 'fleet', surface, ...BAND })
    expect(await idle.find({ key: 'fleet-band' })).toBeUndefined()
    await idle.unmount()
  }

  await spawn($, {prompt: '[lane:mod-rails]\n\nbuild rails', description: 'Build rails', subagentType: 'opus-high' })
  await spawn($, {prompt: '[lane:mod-pace]\n\nbuild pace', description: 'Build pace', subagentType: 'opus-high' })
  w.listed = [
    { id: 'a1', description: 'Build rails', type: 'opus-high', status: 'running' },
    { id: 'a2', description: 'Build pace', type: 'opus-high', status: 'running' },
  ]
  await step($, 'a1', sizes.a1 as number)
  await step($, 'a2', sizes.a2 as number)
  await clock.settle()

  for (const surface of ['terminal', 'desktop'] as const) {
    const band = await $.ui.mount({ plugin: 'fleet', surface, ...BAND })
    const found = await band.find({ key: 'fleet-band' })
    expect(found?.text).toMatch(/2 agents · peak ctx 18% \(mod-rails\) · 0 over 32%/)
    await band.unmount()
  }
  expect(w.toasts).toHaveLength(0)

  sizes.a1 = 330_000
  await step($, 'a1', sizes.a1)
  await step($, 'a1', sizes.a1)
  await clock.settle()
  expect(w.toasts.filter(t => /mod-rails at 33%: hand off/.test(t))).toHaveLength(1)

  sizes.a1 = 410_000
  await step($, 'a1', sizes.a1)
  await clock.settle()
  expect(w.toasts.filter(t => /over the 40% ceiling/.test(t))).toHaveLength(1)

  // both finish: the band goes away after the next refresh
  w.listed = w.listed.map(a => ({ ...a, status: 'completed' }))
  await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 't-a1', agentId: 'a1', reason: 'answer' })
  await clock.advance(1500)
  await clock.settle()
  const after = await $.ui.mount({ plugin: 'fleet', surface: 'terminal', ...BAND })
  expect(await after.find({ key: 'fleet-band' })).toBeUndefined()
})

test('cap: one toast when a sixth agent runs', async ($, on) => {
  const w: World = { toasts: [], listed: [], probe: 'ok' }
  const clock = world(on, w)
  answerSteps(on, {})
  for (let i = 1; i <= 6; i++) w.listed.push({ id: `x${i}`, description: `Job ${i}`, type: 'opus-high', status: 'running' })
  await spawn($, {prompt: '[lane:mod-rails] go', description: 'Build rails', subagentType: 'opus-high' })
  await clock.advance(1500)
  await clock.settle()
  await clock.advance(12_000)
  await clock.settle()
  expect(w.toasts.filter(t => /over the cap of 5/.test(t))).toHaveLength(1)
})

test('pane lists each agent with lane, model, state, context; reader failure is said', async ($, on) => {
  const w: World = { toasts: [], listed: [], probe: 'fail' }
  const clock = world(on, w)
  answerSteps(on, { a1: 120_000 })
  await spawn($, {prompt: '[lane:mod-rails]\n\nbuild', description: 'Build rails', subagentType: 'opus-high' })
  w.listed = [
    { id: 'a1', description: 'Build rails', type: 'opus-high', status: 'running' },
    { id: 'old', description: 'Earlier job', type: 'Explore', status: 'running' },
  ]
  await step($, 'a1', 120_000)
  await clock.advance(1500)
  await clock.settle()

  for (const surface of ['terminal', 'desktop'] as const) {
    const pane = await $.ui.mount({ plugin: 'fleet', surface, ...PANE })
    expect((await pane.find({ key: 'head' }))?.text).toMatch(/^2 running \/ cap 5/)
    const row = await pane.find({ key: 'row-a1' })
    expect(row?.text).toMatch(/mod-rails/)
    expect(row?.text).toMatch(/opus-high · opus-5-5/)
    expect(row?.text).toMatch(/running/)
    expect(row?.text).toMatch(/12%/)
    expect((await pane.find({ key: 'probe-error' }))?.text).toMatch(/Transcript readings unavailable: node exited 1: Error: EACCES reading projects/)
    await pane.unmount()
  }

  const band = await $.ui.mount({ plugin: 'fleet', surface: 'terminal', ...BAND })
  expect((await band.find({ key: 'fleet-band' }))?.text).toMatch(/transcripts unreadable: node exited 1: Error: EACCES/)
})
