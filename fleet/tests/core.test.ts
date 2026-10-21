import { describe, expect, test } from 'claude-code/testing'

import type { FleetAgent } from '../types'
import {
  applyProbe,
  bandText,
  columnsFor,
  crossings,
  elapsedText,
  fit,
  freshAgent,
  laneOf,
  levelOf,
  mergeList,
  needsProbe,
  ordered,
  summarize,
  windowFor,
  withReading,
} from '../hooks/core'

const NOW = 1_800_000_000_000
const agent = (id: string, more: Partial<FleetAgent> = {}): FleetAgent => freshAgent(id, { lane: id, ...more })

describe('core', () => {
  test('lane tag comes from the brief', () => {
    expect(laneOf('[lane:mod-rails]\n\nBuild it')).toBe('mod-rails')
    expect(laneOf('no tag here')).toBe(null)
    expect(laneOf(undefined)).toBe(null)
  })

  test('window follows agent-context.js: Opus 5.x and [1m] are 1M, past 200k is 1M, else 200k', () => {
    expect(windowFor('claude-opus-5-5')).toBe(1_000_000)
    expect(windowFor('claude-sonnet-4-5[1m]')).toBe(1_000_000)
    expect(windowFor('claude-haiku-4-5')).toBe(200_000)
    expect(windowFor('claude-haiku-4-5', 250_000)).toBe(1_000_000)
  })

  test('levels: green under 32, amber 32 to 40, red at 40', () => {
    expect(levelOf(0.31)).toBe('ok')
    expect(levelOf(0.32)).toBe('warn')
    expect(levelOf(0.399)).toBe('warn')
    expect(levelOf(0.4)).toBe('over')
    expect(levelOf(undefined)).toBe('unknown')
  })

  test('each threshold toasts once per agent', () => {
    let agents: Record<string, FleetAgent> = { a: withReading(agent('a'), 330_000, 'claude-opus-5-5', NOW, 'live') }
    let r = crossings(agents)
    expect(r.alerts).toHaveLength(1)
    expect(r.alerts[0]?.text).toMatch(/hand off/)
    agents = r.agents
    r = crossings(agents)
    expect(r.alerts).toHaveLength(0)
    agents = { a: withReading(r.agents.a as FleetAgent, 410_000, undefined, NOW, 'live') }
    r = crossings(agents)
    expect(r.alerts).toHaveLength(1)
    expect(r.alerts[0]?.text).toMatch(/over the 40% ceiling/)
    expect(crossings(r.agents).alerts).toHaveLength(0)
  })

  test('an agent jumping straight past 40% gets the ceiling toast alone', () => {
    const r = crossings({ a: withReading(agent('a'), 450_000, 'claude-opus-5-5', NOW, 'live') })
    expect(r.alerts.map(a => a.text)).toEqual([expect.stringContaining('40% ceiling')])
  })

  test('finished agents never toast', () => {
    const r = crossings({ a: { ...withReading(agent('a'), 450_000, 'claude-opus-5-5', NOW, 'live'), status: 'completed' } })
    expect(r.alerts).toHaveLength(0)
  })

  test('band: one line while running, nothing when idle', () => {
    expect(bandText(summarize({}))).toBe(null)
    expect(bandText(summarize({ a: { ...agent('a'), status: 'completed' } }))).toBe(null)
    const agents = {
      a: withReading(agent('mod-rails'), 180_000, 'claude-opus-5-5', NOW, 'live'),
      b: withReading(agent('mod-pace'), 50_000, 'claude-opus-5-5', NOW, 'live'),
      c: agent('mod-fleet'),
    }
    expect(bandText(summarize(agents))).toBe('3 agents · peak ctx 18% (mod-rails) · 0 over 32% · 1 not read yet')
    expect(bandText(summarize(agents), 'node exited 1')).toMatch(/transcripts unreadable: node exited 1$/)
  })

  test('band names the cap once past 5', () => {
    const many: Record<string, FleetAgent> = {}
    for (const id of ['a', 'b', 'c', 'd', 'e', 'f']) many[id] = agent(id)
    expect(bandText(summarize(many))).toMatch(/^6 agents \(over cap 5\)/)
  })

  test('list merge: new rows, statuses, end time when seen stopping', () => {
    let rows = mergeList({}, [{ id: 'a', description: 'Build x', type: 'opus-high', status: 'running' }], NOW)
    expect(rows.a?.lane).toBe('Build x')
    rows = { a: { ...(rows.a as FleetAgent), lane: 'mod-x', hasLaneTag: true } }
    rows = mergeList(rows, [{ id: 'a', description: 'Build x', type: 'opus-high', status: 'completed' }], NOW + 5000)
    expect(rows.a?.status).toBe('completed')
    expect(rows.a?.endedAt).toBe(NOW + 5000)
    expect(rows.a?.lane).toBe('mod-x')
    // first seen already finished: no end time until the transcript says
    const old = mergeList({}, [{ id: 'b', description: 'Old', type: 'Explore', status: 'completed' }], NOW)
    expect(old.b?.endedAt).toBe(undefined)
  })

  test('probe: lane, start, seed reading; a live reading wins', () => {
    const cur = { a: agent('a', { description: 'Build x', lane: 'Build x' }), b: { ...withReading(agent('b'), 100, 'claude-opus-5-5', NOW, 'live') } }
    const out = applyProbe(
      cur,
      {
        a: { isFound: true, brief: '[lane:mod-x] go', startedAt: NOW - 60_000, ctx: 320_000, maxCtx: 320_000, isOneM: true, model: 'claude-opus-5-5', at: NOW },
        b: { isFound: true, ctx: 999_999, model: 'claude-opus-5-5' },
      },
      NOW,
    )
    expect(out.a?.lane).toBe('mod-x')
    expect(out.a?.ctxSource).toBe('transcript')
    expect(out.a?.ctx).toBe(320_000)
    expect(out.a?.startedAt).toBe(NOW - 60_000)
    expect(out.b?.ctx).toBe(100)
    expect(out.b?.ctxSource).toBe('live')
  })

  test('probe: a missing transcript is said, not hidden', () => {
    const out = applyProbe({ a: agent('a') }, { a: { isFound: false } }, NOW)
    expect(out.a?.note).toMatch(/no transcript file/)
    expect(out.a?.isProbed).toBe(true)
  })

  test('who gets probed: everyone once, then running agents without live readings every 30 s', () => {
    const rows = {
      fresh: agent('fresh'),
      live: { ...withReading(agent('live'), 1, 'm', NOW, 'live'), isProbed: true, probedAt: NOW - 60_000 },
      seeded: { ...withReading(agent('seeded'), 1, 'm', NOW, 'transcript'), isProbed: true, probedAt: NOW - 10_000 },
      stale: { ...withReading(agent('stale'), 1, 'm', NOW, 'transcript'), isProbed: true, probedAt: NOW - 31_000 },
      done: { ...agent('done'), status: 'completed', isProbed: true, probedAt: 0 },
    }
    expect(needsProbe(rows, NOW).sort()).toEqual(['fresh', 'stale'])
  })

  test('order: running fullest first, then recent finished; old finished hidden', () => {
    const rows = {
      r1: withReading(agent('r1'), 100_000, 'claude-opus-5-5', NOW, 'live'),
      r2: withReading(agent('r2'), 300_000, 'claude-opus-5-5', NOW, 'live'),
      d1: { ...agent('d1'), status: 'completed', endedAt: NOW - 60_000 },
      d2: { ...agent('d2'), status: 'completed', endedAt: NOW - 2 * 3600_000 },
      d3: { ...agent('d3'), status: 'completed' },
    }
    expect(ordered(rows, NOW).map(a => a.id)).toEqual(['r2', 'r1', 'd1'])
  })

  test('elapsed and fit', () => {
    expect(elapsedText({ ...agent('a'), startedAt: NOW - 125_000 }, NOW)).toBe('2m05s')
    expect(elapsedText({ ...agent('a'), startedAt: NOW - 3_700_000 }, NOW)).toBe('1h01m')
    expect(elapsedText(agent('a'), NOW)).toBe('--')
    expect(fit('abcdef', 4)).toBe('abc…')
    expect(fit('ab', 4)).toBe('ab  ')
  })

  test('columns drop model and tool when narrow, never exceed the width', () => {
    for (const cols of [40, 56, 76, 120]) {
      const c = columnsFor(cols)
      expect(c.lane + c.model + c.state + c.elapsed + c.ctx + c.tool).toBeLessThanOrEqual(Math.max(cols, 41))
    }
    expect(columnsFor(40).model).toBe(0)
    expect(columnsFor(60).tool).toBe(0)
    expect(columnsFor(100).tool).toBeGreaterThan(0)
  })
})
