// eta math and wording, driven directly (no engine).
import { describe, expect, test } from 'claude-code/testing'

import type { EtaAgent, EtaCalSample, EtaLive, EtaSnapshot } from '../types'
import {
  afterPrompt,
  afterToolResult,
  agentEtas,
  applyEta,
  fixCycleMs,
  historyFor,
  judgeRun,
  overRemainingMs,
  bandSegments,
  bandText,
  calibration,
  classifySessions,
  doneToast,
  emptyLive,
  endWork,
  etaView,
  expectedFor,
  fmtClock,
  fmtDur,
  isNudgeDue,
  isWorkOver,
  isWriteDue,
  MIN,
  parseSnapshot,
  sigOf,
  snapshotOf,
  startTurn,
  withDuration,
} from '../hooks/core'

const NOW = Date.parse('2026-10-02T16:00:00Z')
/** Band text at `now`, clock times in UTC. */
const band = (live: EtaLive, now: number) => bandText(bandSegments(etaView(live, now), now, 0))
const tones = (live: EtaLive, now: number) => bandSegments(etaView(live, now), now, 0).map(s => s.tone)

const working = (at = NOW): EtaLive => startTurn(emptyLive(), at, 'build the eta mod')
const declare = (live: EtaLive, input: Record<string, unknown>, at: number) => applyEta(live, input, at).live
const agent = (id: string, type: string, startedAt: number, extra: Partial<EtaAgent> = {}): EtaAgent => ({
  id,
  type,
  label: id,
  startedAt,
  isExactStart: true,
  kind: 'run',
  status: 'running',
  endedAt: null,
  ...extra,
})
const withAgents = (live: EtaLive, ...as: EtaAgent[]): EtaLive => ({ ...live, agents: Object.fromEntries(as.map(a => [a.id, a])) })
const withCal = (live: EtaLive, ratios: number[]): EtaLive => ({
  ...live,
  learned: { ...live.learned, calibration: ratios.map((r, i): EtaCalSample => ({ said: 10, took: 10 * r, at: NOW - i })) },
})

describe('formatting', () => {
  test('durations and clock times', () => {
    expect(fmtDur(20_000)).toBe('<1m')
    expect(fmtDur(14 * MIN)).toBe('14m')
    expect(fmtDur(65 * MIN)).toBe('1h05m')
    expect(fmtClock(NOW + 32 * MIN, 0)).toBe('4:32 PM')
    expect(fmtClock(NOW, -240)).toBe('12:00 PM')
    expect(fmtClock(Date.parse('2026-10-02T00:05:00Z'), 0)).toBe('12:05 AM')
  })
})

describe('countdown', () => {
  test('idle is hidden', () => {
    expect(bandSegments(etaView(emptyLive(), NOW), NOW, 0)).toEqual([])
    expect(etaView(emptyLive(), NOW).isVisible).toBe(false)
  })

  test('a running turn with no estimate shows elapsed time alone', () => {
    expect(band(working(), NOW + 3 * MIN)).toBe('eta working · 3m elapsed · no estimate yet')
  })

  test('a declared estimate counts down, with the finish time and the step', () => {
    const live = declare(working(), { minutes: 12, steps: ['read', 'write', 'verify rails', 'report'], step: 3 }, NOW)
    expect(band(live, NOW + 2 * MIN)).toBe('eta ~10m left · done ~4:12 PM · step 3/4: verify rails')
    expect(etaView(live, NOW + 2 * MIN).remainingMs).toBe(10 * MIN)
  })

  test('a passed estimate turns amber and says by how much', () => {
    const live = declare(working(), { minutes: 12 }, NOW)
    const t = NOW + 18 * MIN
    expect(band(live, t)).toBe('eta over by 6m (12m estimate)')
    expect(tones(live, t)).toContain('warn')
    expect(tones(live, NOW + 5 * MIN)).not.toContain('warn')
  })

  test('done:true shows wrapping up until the turn ends', () => {
    const live = declare(declare(working(), { minutes: 5 }, NOW), { done: true }, NOW + 4 * MIN)
    expect(band(live, NOW + 4 * MIN)).toBe('eta wrapping up · 4m elapsed')
  })
})

describe('declared against agents', () => {
  test('agents implying a later finish win, and the band says why', () => {
    const live = withAgents(declare(working(), { minutes: 5 }, NOW), agent('a1', 'opus-high', NOW))
    const v = etaView(live, NOW)
    expect(v.winner).toBe('agents')
    // opus-high usual ~11.8m (prior median 709.5s), +3m to verify, against 5m declared
    expect(band(live, NOW)).toBe('eta ~15m left (agents need longer · +10m) · done ~4:15 PM · 1 agent (longest ~12m)')
  })

  test('an agent launched after the estimate: the finish is at least its usual end, and says so', () => {
    const live0 = declare(working(), { minutes: 5 }, NOW)
    const t = NOW + 2 * MIN
    const live = withAgents(live0, agent('a1', 'opus-high', t))
    const v = etaView(live, t)
    // opus-high usual 709.5s from t, then 3m to verify
    expect(v.finishAt).toBeGreaterThanOrEqual(t + 709_500)
    expect(v.reason).toBe('agent launched · +12m')
    const snap = snapshotOf({ ...live, self: { sessionId: 's', project: 'p', cwd: 'c' } }, t)
    expect(snap?.reason).toBe('agent launched · +12m')
    expect(snap?.extendedBy).toBe(12)
  })

  test('a declared estimate later than the agents stands', () => {
    const live = withAgents(declare(working(), { minutes: 40 }, NOW), agent('a1', 'opus-high', NOW))
    expect(etaView(live, NOW).winner).toBe('declared')
    expect(band(live, NOW)).toContain('~40m left · done ~4:40 PM')
  })

  test('with no declaration the agents alone give the number: slowest plus verify', () => {
    const live = withAgents(working(), agent('a1', 'opus-high', NOW - 5 * MIN), agent('a2', 'opus-xhigh', NOW), agent('a3', 'Explore', NOW))
    const v = etaView(live, NOW)
    expect(v.winner).toBe('agents')
    // opus-xhigh usual 1467s (24.45m) is the slowest; +3m verify
    expect(v.remainingMs).toBe(1_467_000 + 3 * MIN)
    expect(band(live, NOW)).toContain('3 agents (longest ~24m; 1 guessed)')
  })

  test('an agent past its usual time is pushed out, growing with its run, and flagged', () => {
    // opus-high priors all under 13m: past them, half the elapsed time more (30m in: 15m).
    const live = withAgents(working(), agent('a1', 'opus-high', NOW - 30 * MIN))
    const [a] = agentEtas(live, NOW)
    expect(a?.remainingMs).toBe(15 * MIN)
    expect(a?.isOver).toBe(true)
    expect(band(live, NOW)).toContain('1 past usual')
    // Later, more left, never a falling minute.
    const [b] = agentEtas(live, NOW + 10 * MIN)
    expect(b?.remainingMs).toBe(20 * MIN)
    // Just past usual: at least 2 minutes.
    const [c] = agentEtas(withAgents(working(), agent('a2', 'opus-high', NOW - 12 * MIN)), NOW)
    expect(c?.remainingMs).toBe(2 * MIN)
  })

  test('past usual, the longer past runs of the type set the extra time', () => {
    // Learned runs: 10m, 11m, 40m, 50m, 60m. 20m in, the longer ones' median is 50m: 30m left, capped at half of 20m.
    const durations = { 'opus-high': [600, 660, 2400, 3000, 3600] }
    expect(overRemainingMs(historyFor('opus-high', durations), 20 * MIN)).toBe(10 * MIN)
    // 45m in: longer are 50m and 60m, median 55m: 10m left (under the cap of 22.5m).
    expect(overRemainingMs(historyFor('opus-high', durations), 45 * MIN)).toBe(10 * MIN)
    // Floor of 2m.
    expect(overRemainingMs([], 1 * MIN)).toBe(2 * MIN)
  })
})

describe('learned durations and priors', () => {
  test('priors seed each known type; unknown types are a marked guess', () => {
    expect(expectedFor('opus-high', {})).toEqual({ ms: 709_500, source: 'prior', n: 4, learnedN: 0 })
    expect(expectedFor('opus-xhigh', {}).ms).toBe(1_467_000)
    expect(expectedFor('resume', {}).ms).toBe(150_000)
    expect(expectedFor('general-purpose', {})).toEqual({ ms: 10 * MIN, source: 'guess', n: 0, learnedN: 0 })
  })

  test('finished runs move the median and the newest 20 count', () => {
    let d: Record<string, number[]> = {}
    for (let i = 0; i < 3; i += 1) d = withDuration(d, 'opus-high', 1200)
    expect(expectedFor('opus-high', d)).toEqual({ ms: 762_000, source: 'learned', n: 7, learnedN: 3 })
    for (let i = 0; i < 30; i += 1) d = withDuration(d, 'opus-high', 300)
    const e = expectedFor('opus-high', d)
    expect(e.n).toBe(20)
    expect(e.ms).toBe(300_000)
    d = withDuration(d, 'Explore', 200)
    expect(expectedFor('Explore', d)).toEqual({ ms: 200_000, source: 'learned', n: 1, learnedN: 1 })
  })

  test('a resumed agent is timed by resume history, not its type', () => {
    const live = withAgents(working(), agent('a1', 'opus-high', NOW, { kind: 'resume', isExactStart: false }))
    expect(agentEtas(live, NOW)[0]?.expect.ms).toBe(150_000)
  })
})

describe('calibration', () => {
  test('no ratio before three samples', () => {
    expect(calibration([]).ratio).toBe(null)
    const two = withCal(declare(working(), { minutes: 12 }, NOW), [1.5, 1.5])
    expect(calibration(two.learned.calibration)).toEqual({ n: 2, median: 1.5, ratio: null, matched: null })
    expect(band(two, NOW)).toBe('eta ~12m left · done ~4:12 PM')
  })

  test('from three samples the median ratio is applied and shown honestly', () => {
    const live = withCal(declare(working(), { minutes: 12 }, NOW), [1.5, 1.4, 1.6])
    expect(calibration(live.learned.calibration).ratio).toBe(1.5)
    expect(band(live, NOW)).toBe('eta ~18m left (said 12m; estimates run ~1.5× long) · done ~4:18 PM')
  })

  test('only finished estimates of a similar size calibrate one; too few and it is shown as said', () => {
    // Big plans finished early, small ones on time: the shape of a real history.
    const samples: EtaCalSample[] = [
      { said: 120, took: 60, at: 1 },
      { said: 150, took: 80, at: 2 },
      { said: 100, took: 55, at: 3 },
      { said: 90, took: 50, at: 4 },
      { said: 15, took: 16, at: 5 },
      { said: 20, took: 21, at: 6 },
      { said: 12, took: 12, at: 7 },
    ]
    const r2 = (x: number | null) => (x === null ? null : Math.round(x * 100) / 100)
    expect(r2(calibration(samples).ratio)).toBe(0.75)
    expect(r2(calibration(samples, 15).ratio)).toBe(1.05)
    expect(r2(calibration(samples, 120).ratio)).toBe(0.75)
    expect(calibration(samples, 4)).toMatchObject({ ratio: null, matched: 0 })
    const live = { ...declare(working(), { minutes: 15 }, NOW), learned: { durations: {}, calibration: samples } }
    expect(band(live, NOW)).toBe('eta ~16m left (said 15m; estimates run ~1.1× long) · done ~4:16 PM')
  })

  test('the ratio is clamped to a sane range', () => {
    expect(calibration(withCal(emptyLive(), [5, 6, 7]).learned.calibration).ratio).toBe(3)
    expect(calibration(withCal(emptyLive(), [0.1, 0.2, 0.2]).learned.calibration).ratio).toBe(0.75)
  })

  test('ending a declared plan records said against took', () => {
    let live = declare(working(), { minutes: 10 }, NOW + MIN)
    live = declare(live, { minutes: 3, step: 2 }, NOW + 9 * MIN)
    const out = endWork({ ...live, work: live.work && { ...live.work, isTurnRunning: false } }, NOW + 16 * MIN)
    expect(out.sample).toEqual({ said: 10, took: 15, at: NOW + 16 * MIN })
    expect(out.live.plan).toBe(null)
    expect(out.live.work).toBe(null)
  })
})

describe('overdue nudge', () => {
  test('fires once per estimate, past half again over', () => {
    let live = declare(working(), { minutes: 10 }, NOW)
    expect(isNudgeDue(live.plan, NOW + 14 * MIN)).toBe(false)
    expect(isNudgeDue(live.plan, NOW + 16 * MIN)).toBe(true)
    live = { ...live, plan: live.plan && { ...live.plan, nudgedFor: live.plan.seq } }
    expect(isNudgeDue(live.plan, NOW + 30 * MIN)).toBe(false)
    // A step alone is not a new estimate.
    live = declare(live, { step: 2 }, NOW + 31 * MIN)
    expect(isNudgeDue(live.plan, NOW + 40 * MIN)).toBe(false)
    // New minutes are: due again once those are passed by half.
    live = declare(live, { minutes: 4 }, NOW + 41 * MIN)
    expect(isNudgeDue(live.plan, NOW + 46 * MIN)).toBe(false)
    expect(isNudgeDue(live.plan, NOW + 48 * MIN)).toBe(true)
  })
})

describe('done toast', () => {
  test('only for work of three minutes or more, with the estimate as a total', () => {
    const w = working()
    expect(doneToast(w.work, null, NOW + 2 * MIN)).toBe(null)
    expect(doneToast(w.work, null, NOW + 3 * MIN)).toBe('eta: done after 3m')
    const live = declare(w, { minutes: 16 }, NOW + 2 * MIN)
    expect(doneToast(live.work, live.plan, NOW + 23 * MIN)).toBe('eta: done after 23m (estimated 18m)')
    expect(doneToast(live.work && { ...live.work, isToasted: true }, live.plan, NOW + 23 * MIN)).toBe(null)
  })

  test('done:true toasts once; the turn end does not repeat it', () => {
    const live = declare(working(), { minutes: 5 }, NOW)
    const done = applyEta(live, { done: true }, NOW + 6 * MIN)
    expect(done.toast).toBe('eta: done after 6m (estimated 5m)')
    const after = endWork({ ...done.live, work: done.live.work && { ...done.live.work, isTurnRunning: false } }, NOW + 7 * MIN)
    expect(after.toast).toBe(null)
  })

  test('work ends at the turn end unless agents or background tasks still run', () => {
    const live = working()
    const idle = { ...live, work: live.work && { ...live.work, isTurnRunning: false, lastActiveAt: NOW + MIN } }
    expect(isWorkOver(idle, NOW + MIN, true)).toBe(true)
    expect(isWorkOver(withAgents(idle, agent('a1', 'opus-high', NOW)), NOW + MIN, true)).toBe(false)
    const bg = { ...idle, work: idle.work && { ...idle.work, backgroundTasks: 1 } }
    expect(isWorkOver(bg, NOW + 5 * MIN, true)).toBe(false)
    expect(isWorkOver(bg, NOW + 32 * MIN, false)).toBe(true)
    expect(isWorkOver(idle, NOW + 2 * MIN, false)).toBe(false)
    expect(isWorkOver(idle, NOW + 3 * MIN, false)).toBe(true)
  })
})

describe('snapshots', () => {
  const self = { sessionId: 'me', project: 'mods', cwd: 'C:/Users/you/.claude/mods' }
  const snap = (over: Partial<EtaSnapshot>): EtaSnapshot => ({
    v: 1,
    sessionId: 'x',
    project: 'webapp',
    cwd: 'C:/x',
    label: 'fix deploy',
    state: 'idle',
    summary: '',
    etaAt: null,
    isOverdue: false,
    agentsRunning: 0,
    workStartedAt: null,
    updatedAt: NOW,
    ...over,
  })

  test('written, read back, and its label is the declared note or the latest prompt', () => {
    const live = { ...declare(working(), { minutes: 12, note: 'wiring hooks' }, NOW), self }
    const s = snapshotOf(live, NOW + MIN) as EtaSnapshot
    expect(s).toMatchObject({ sessionId: 'me', project: 'mods', state: 'working', label: 'wiring hooks', etaAt: NOW + 12 * MIN, updatedAt: NOW + MIN })
    expect(parseSnapshot(JSON.stringify(s))).toEqual(s)
    expect(snapshotOf({ ...working(), self }, NOW)?.label).toBe('build the eta mod')
    expect(snapshotOf({ ...emptyLive(), self }, NOW)?.state).toBe('idle')
    expect(parseSnapshot('{oops')).toMatch(/^not JSON/)
    expect(parseSnapshot('{"v":2}')).toBe('unknown version 2')
  })

  test('written on change, else on a heartbeat (1m working, 5m idle)', () => {
    const a = snap({ state: 'working', etaAt: NOW + 10 * MIN })
    const last = { sig: sigOf(a), at: NOW }
    expect(isWriteDue(a, null)).toBe(true)
    expect(isWriteDue({ ...a, updatedAt: NOW + 30_000 }, last)).toBe(false)
    expect(isWriteDue({ ...a, updatedAt: NOW + MIN }, last)).toBe(true)
    expect(isWriteDue({ ...a, etaAt: NOW + 20 * MIN, updatedAt: NOW + 1000 }, last)).toBe(true)
    const i = snap({})
    expect(isWriteDue({ ...i, updatedAt: NOW + 4 * MIN }, { sig: sigOf(i), at: NOW })).toBe(false)
    expect(isWriteDue({ ...i, updatedAt: NOW + 5 * MIN }, { sig: sigOf(i), at: NOW })).toBe(true)
  })

  test('stale, ended and dead sessions are dropped and counted; bad files are reported', () => {
    const t = NOW + 60 * MIN
    const f = (name: string, s: EtaSnapshot) => ({ name, mtimeMs: s.updatedAt, snap: s, error: null })
    const own = snapshotOf({ ...working(t), self }, t)
    const out = classifySessions(
      [
        f('a.json', snap({ sessionId: 'a', state: 'idle', updatedAt: t - 5 * MIN })),
        f('b.json', snap({ sessionId: 'b', state: 'idle', updatedAt: t - 16 * MIN })),
        f('c.json', snap({ sessionId: 'c', state: 'ended', updatedAt: t - MIN })),
        f('d.json', snap({ sessionId: 'd', state: 'working', updatedAt: t - 4 * MIN, etaAt: t + 5 * MIN })),
        f('e.json', snap({ sessionId: 'e', state: 'working', updatedAt: t - 61 * MIN })),
        f('me.json', snap({ sessionId: 'me', state: 'idle', updatedAt: t - 30 * MIN })),
        { name: 'z.json', mtimeMs: t, snap: null, error: 'not JSON (bad)' },
      ],
      'me',
      t,
      own,
    )
    expect(out.rows.map(r => r.sessionId)).toEqual(['me', 'd', 'a'])
    expect(out.rows[0]?.isSelf).toBe(true)
    expect(out.rows[1]?.isSilent).toBe(true)
    expect(out.hidden).toEqual({ idle: 1, ended: 1, dead: 1 })
    expect(out.errors).toEqual(['z.json: not JSON (bad)'])
  })
})

describe('failed runs', () => {
  test('summary lines that report failures', () => {
    expect(judgeRun('node --test tests/', 'ℹ tests 12\nℹ pass 10\nℹ fail 2\n', false)).toEqual({ kind: 'fail', what: 'test', detail: '2 failed' })
    expect(judgeRun('npx vitest run', ' Test Files  1 failed | 3 passed (4)\n      Tests  3 failed | 40 passed (43)', true)).toMatchObject({ kind: 'fail', detail: '3 failed' })
    expect(judgeRun('claude plugin test .', '(fail) band > x\n 38 pass\n 1 fail\nRan 39 tests across 2 files.', false)).toMatchObject({ kind: 'fail', what: 'test' })
    expect(judgeRun('python -m pytest -q', '==== 2 failed, 10 passed in 1.2s ====', true)).toMatchObject({ kind: 'fail', detail: '2 failed' })
    expect(judgeRun('npm test', 'FAIL src/a.test.js\n  ● a > b', true)).toMatchObject({ kind: 'fail', detail: 'FAIL' })
    expect(judgeRun('go test ./...', '--- FAIL: TestX (0.00s)\nFAIL', true)).toMatchObject({ kind: 'fail' })
    expect(judgeRun('cd web && npm run build', 'npm ERR! code ELIFECYCLE\nnpm ERR! errno 1', true)).toMatchObject({ kind: 'fail', what: 'build' })
    expect(judgeRun('npx tsc -p . --noEmit', "src/a.ts(3,5): error TS2322: Type 'x'", true)).toMatchObject({ kind: 'fail', what: 'build' })
    expect(judgeRun('node run-tests.js | tail -5', '# tests 9\n# pass 7\n# fail 2', false)).toMatchObject({ kind: 'fail', detail: '2 failed' })
  })

  test('no false alarms: zero failures, views of logs, non-run commands', () => {
    expect(judgeRun('node --test', 'ℹ tests 12\nℹ pass 12\nℹ fail 0', false)).toEqual({ kind: 'pass' })
    expect(judgeRun('claude plugin test .', ' 39 pass\n 0 fail\nRan 39 tests across 2 files.', false)).toEqual({ kind: 'pass' })
    expect(judgeRun('pytest', '==== 0 failed, 12 passed ====', false)).toEqual({ kind: 'pass' })
    expect(judgeRun('npm test', 'Tests: 0 failed, 12 passed\nfail 0', false)).toEqual({ kind: 'pass' })
    // The summary wins over a non-zero exit.
    expect(judgeRun('npm test', 'Exit code 1\nTests: 12 passed, 0 failed', true)).toEqual({ kind: 'pass' })
    // Looking at a log full of FAIL is not a failed run.
    expect(judgeRun('grep -n FAIL test.log', 'FAIL src/a.test.js\n3 failed', false)).toBe(null)
    expect(judgeRun('cd x && cat tests/out.txt', 'ℹ fail 3', false)).toBe(null)
    expect(judgeRun('git log --oneline', 'fix: 3 failed tests', false)).toBe(null)
    // Not a test or build command at all.
    expect(judgeRun('ls -la', 'Exit code 2', true)).toBe(null)
  })

  test('with no summary, a non-zero exit of a test-looking command fails it', () => {
    expect(judgeRun('npm test', 'Exit code 1\nsomething broke', true)).toEqual({ kind: 'fail', what: 'test', detail: 'exit 1' })
    expect(judgeRun('npm run build', 'built in 3s', false)).toEqual({ kind: 'pass' })
    expect(judgeRun('npm test', 'Command was interrupted by the user', true)).toBe(null)
  })

  test('a failure pushes the ETA out by a fix cycle, nudges once, and says why', () => {
    const live = declare(working(), { minutes: 10 }, NOW)
    const t = NOW + 4 * MIN
    const out = afterToolResult(live, { kind: 'fail', what: 'test', detail: '2 failed' }, t)
    const v = etaView(out.live, t)
    expect(v.finishAt).toBe(NOW + 20 * MIN)
    expect(v.winner).toBe('extended')
    expect(v.reason).toBe('test failed · +10m')
    expect(band(out.live, t)).toBe('eta ~16m left (test failed · +10m) · done ~4:20 PM')
    expect(out.note).toContain('test failed (2 failed): the ETA was pushed out 10m')
    expect(out.note).toContain('mcp__eta__Eta')
    expect(out.note?.includes('\n')).toBe(false)
    // A second failure soon after: no compounding beyond a cycle from now, and no second nudge inside 10m.
    const again = afterToolResult(out.live, { kind: 'fail', what: 'test', detail: '1 failed' }, t + 3 * MIN)
    expect(etaView(again.live, t + 3 * MIN).finishAt).toBe(NOW + 20 * MIN)
    expect(again.note).toBe(null)
    // A fresh estimate clears the push-out.
    const fresh = declare(again.live, { minutes: 6 }, t + 4 * MIN)
    expect(fresh.bump).toBe(null)
    expect(etaView(fresh, t + 4 * MIN).finishAt).toBe(t + 10 * MIN)
  })

  test('an overdue estimate is pushed out from now, not from the past finish', () => {
    const live = declare(working(), { minutes: 5 }, NOW)
    const t = NOW + 8 * MIN
    expect(etaView(live, t).isOverdue).toBe(true)
    const out = afterToolResult(live, { kind: 'fail', what: 'build', detail: 'type errors' }, t)
    const v = etaView(out.live, t)
    expect(v.finishAt).toBe(t + 10 * MIN)
    expect(v.isOverdue).toBe(false)
    expect(band(out.live, t)).toContain('~10m left (build failed · +13m)')
  })

  test('a failure with no ETA active changes nothing; a pass after a failure teaches the fix cycle', () => {
    const idle = working()
    const out = afterToolResult(idle, { kind: 'fail', what: 'test', detail: 'x' }, NOW)
    expect(out.live.bump ?? null).toBe(null)
    expect(out.note).toBe(null)
    expect(out.live.fixStartedAt).toBe(NOW)
    const pass = afterToolResult(out.live, { kind: 'pass' }, NOW + 7 * MIN)
    expect(pass.fixSampleSec).toBe(420)
    expect(pass.live.fixStartedAt).toBe(null)
  })

  test('the fix cycle is learned from 3 cycles, clamped to 3–30m', () => {
    expect(fixCycleMs(undefined)).toEqual({ ms: 10 * MIN, source: 'default', n: 0 })
    expect(fixCycleMs([300, 420])).toMatchObject({ ms: 10 * MIN, source: 'default' })
    expect(fixCycleMs([300, 420, 360])).toEqual({ ms: 6 * MIN, source: 'learned', n: 3 })
    expect(fixCycleMs([30, 40, 50]).ms).toBe(3 * MIN)
    expect(fixCycleMs([3000, 4000, 5000]).ms).toBe(30 * MIN)
    const live = { ...declare(working(), { minutes: 10 }, NOW), learned: { durations: {}, calibration: [], fixCycles: [300, 420, 360] } }
    expect(etaView(afterToolResult(live, { kind: 'fail', what: 'test', detail: 'x' }, NOW).live, NOW).finishAt).toBe(NOW + 16 * MIN)
  })
})

describe('over by', () => {
  test('the countdown at zero shows over by, and the snapshot says overdue', () => {
    const live = { ...declare(working(), { minutes: 5 }, NOW), self: { sessionId: 's', project: 'p', cwd: 'c' } }
    const t = NOW + 9 * MIN
    expect(band(live, t)).toBe('eta over by 4m (5m estimate)')
    expect(band(live, t)).not.toContain('~0')
    const snap = snapshotOf(live, t)
    expect(snap?.isOverdue).toBe(true)
    expect(snap?.etaAt).toBe(NOW + 5 * MIN)
    expect(snapshotOf(live, NOW + 2 * MIN)?.isOverdue).toBe(false)
  })

  test('a push-out that has itself passed is over by, with the reason', () => {
    const live = declare(working(), { minutes: 5 }, NOW)
    const out = afterToolResult(live, { kind: 'fail', what: 'test', detail: 'x' }, NOW + MIN).live
    expect(band(out, NOW + 20 * MIN)).toBe('eta over by 5m (5m estimate; test failed · +10m)')
  })

  test('agents past the estimate: time left, with over by on the estimate; the snapshot is not overdue', () => {
    const live = { ...withAgents(declare(working(), { minutes: 5 }, NOW), agent('a1', 'opus-high', NOW)), self: { sessionId: 's', project: 'p', cwd: 'c' } }
    const t = NOW + 8 * MIN
    expect(band(live, t)).toContain('left (over by 3m on the 5m estimate; agents still running)')
    expect(snapshotOf(live, t)?.isOverdue).toBe(false)
  })
})

describe('re-estimate nudges', () => {
  test("the user's message while an ETA runs asks for a fresh estimate, at most once per 10m", () => {
    const live = declare(working(), { minutes: 30 }, NOW)
    const a = afterPrompt(live, NOW + MIN)
    expect(a.note).toContain('[eta] The user added a message')
    expect(afterPrompt(live, NOW + MIN, 'Alex').note).toContain('[eta] Alex added a message')
    expect(a.note?.includes('\n')).toBe(false)
    expect(afterPrompt(a.live, NOW + 5 * MIN).note).toBe(null)
    expect(afterPrompt(a.live, NOW + 12 * MIN).note).not.toBe(null)
    // No ETA running: nothing.
    expect(afterPrompt(working(), NOW).note).toBe(null)
  })

  test('no Eta update for 10m while tool calls go on: one stale nudge, then quiet for 10m', () => {
    const live = declare(working(), { minutes: 60 }, NOW)
    expect(afterToolResult(live, null, NOW + 9 * MIN).note).toBe(null)
    const s = afterToolResult(live, null, NOW + 11 * MIN)
    expect(s.note).toContain('No Eta update for 11m')
    expect(afterToolResult(s.live, null, NOW + 15 * MIN).note).toBe(null)
    // A step update counts as an update.
    const stepped = declare(s.live, { step: 2 }, NOW + 22 * MIN)
    expect(afterToolResult(stepped, null, NOW + 25 * MIN).note).toBe(null)
  })

  test('the overdue nudge shares the rate limit', () => {
    const live = declare(working(), { minutes: 4 }, NOW)
    const p = afterPrompt(live, NOW + 5 * MIN)
    expect(p.note).not.toBe(null)
    // Overdue nudge due at 6m+, but a nudge went 2m ago.
    expect(afterToolResult(p.live, null, NOW + 7 * MIN).note).toBe(null)
    const later = afterToolResult(p.live, null, NOW + 16 * MIN)
    expect(later.note).toContain('passed by more than half')
    expect(later.live.plan?.nudgedFor).toBe(later.live.plan?.seq)
  })
})
