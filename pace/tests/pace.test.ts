// Pace math and wording, driven directly (no engine).
import { describe, expect, test } from 'claude-code/testing'

import type { PaceReading, PaceSnapshot } from '../types'
import {
  bandLine,
  commandText,
  freshest,
  fmtWhen,
  freeResetToast,
  parseFreeReset,
  trackFreeReset,
  paceView,
  promptSection,
  toolText,
  pruneFired,
  readingFromSession,
  readingFromStatusline,
  toastsDue,
  WINDOW_MS,
} from '../hooks/pace'

const MIN = 60_000
const NOW = Date.parse('2026-10-02T12:00:00Z')

/** A snapshot with 5H `used`% and `remainingMin` left in the window. */
function snap(used: number, remainingMin: number, opts: { ageMin?: number; week?: number; cost?: number | null } = {}): PaceSnapshot {
  const reading: PaceReading = {
    fiveHour: { percentUsed: used, resetsAt: NOW + remainingMin * MIN },
    sevenDay: { percentUsed: opts.week ?? 52, resetsAt: NOW + 3 * 24 * 60 * MIN },
    observedAt: NOW - (opts.ageMin ?? 1) * MIN,
    source: 'session',
    sourceDetail: "this session's last API response",
  }
  return { now: NOW, reading, reason: null, costUsd: opts.cost === undefined ? 12.4 : opts.cost }
}

describe('verdicts', () => {
  test('under pace: low burn leaves whole rounds spare', () => {
    const v = paceView(snap(20, 150)) // 150m elapsed: 8%/h, 40% at reset
    expect(v.verdict).toBe('under')
    expect(v.burnPerHour).toBe(8)
    expect(v.projectedFinal).toBe(40)
    expect(v.extraRounds).toBe(9) // (100 - 5 - 40) / 6
    expect(v.recommendedAgents).toBe(5) // capped at 5 at once
    expect(bandLine(v)).toBe('5H 20% · 2h30m left · under pace — room for ~9 more rounds of 3 agents · WK 52% · $12.40')
  })

  test('on pace: lands near 100% at the reset', () => {
    const v = paceView(snap(48, 150)) // 19.2%/h, 96% at reset
    expect(v.verdict).toBe('on')
    expect(v.recommendedAgents).toBe(0)
    expect(bandLine(v)).toContain('on pace — keep the current load')
  })

  test('on pace with a little room says how many agents', () => {
    const v = paceView(snap(40, 150)) // 16%/h, 80% at reset, spare 15
    expect(v.verdict).toBe('under')
    const w = paceView(snap(44, 150)) // 17.6%/h, 88% at reset, spare 7 -> one round
    expect(w.verdict).toBe('under')
    const x = paceView(snap(45.5, 150)) // 18.2%/h, 91% at reset, spare 4 -> on, 2 agents
    expect(x.verdict).toBe('on')
    expect(x.recommendedAgents).toBe(2)
    expect(bandLine(x)).toContain('on pace — room for ~2 agents more')
  })

  test('hot: 100% lands more than 30 minutes before the reset', () => {
    const v = paceView(snap(60, 180)) // 120m elapsed: 30%/h, 100% in 80m, 100m early
    expect(v.verdict).toBe('hot')
    expect(v.hitInMs).toBe(80 * MIN)
    expect(v.hitBeforeResetMs).toBe(100 * MIN)
    expect(v.recommendedAgents).toBe(0)
    expect(bandLine(v)).toContain('hot — 100% in 1h20m, 1h40m before reset; hold new agents')
  })

  test('the 30-minute line: 27m early is on pace, 50m early is hot', () => {
    expect(paceView(snap(55, 150)).verdict).toBe('on') // 100% ~27m before reset
    expect(paceView(snap(60, 150)).verdict).toBe('hot') // 100% 50m before reset
  })

  test('pinned at 100%', () => {
    const v = paceView(snap(100, 90))
    expect(v.verdict).toBe('pinned')
    expect(v.recommendedAgents).toBe(0)
    expect(bandLine(v)).toContain('at the limit')
  })

  test('early in the window: no projection, headroom shown', () => {
    const v = paceView(snap(3, WINDOW_MS / MIN - 10)) // 10m in
    expect(v.verdict).toBe('early')
    expect(v.burnPerHour).toBeNull()
    expect(v.extraRounds).toBe(15) // (100 - 5 - 3) / 6
    expect(bandLine(v)).toContain('early (10m in, pace readable at 20m)')
  })

  test('window reset since the reading: no stale numbers', () => {
    const v = paceView(snap(88, -5))
    expect(v.verdict).toBe('reset')
    expect(v.used).toBeUndefined()
    expect(bandLine(v)).toContain('reset 5m ago; waiting for a fresh reading')
    expect(bandLine(v)).not.toContain('88')
  })

  test('stale reading is labelled with its age', () => {
    const v = paceView(snap(30, 150, { ageMin: 25 }))
    expect(v.isStale).toBe(true)
    expect(bandLine(v)).toContain('reading 25m old')
    expect(bandLine(paceView(snap(30, 150, { ageMin: 4 })))).not.toContain('old')
  })

  test('missing reading shows the reason, never a number', () => {
    const v = paceView({ now: NOW, reading: null, reason: 'no statusline file', costUsd: 3 })
    expect(v.verdict).toBe('missing')
    expect(bandLine(v)).toBe('5H pace: no reading — no statusline file · $3.00')
    expect(commandText(v)).toContain('no reading — no statusline file')
  })
})

describe('prompt section and Pace tool', () => {
  test('the prompt section is one fixed line with no figures in it', () => {
    expect(promptSection().split('\n').length).toBe(1)
    expect(promptSection()).not.toMatch(/\d+%|\d+h|\d+m\b/)
    expect(promptSection()).toContain('call the Pace tool')
    expect(promptSection()).toContain('(the user wants the 5H limit')
    expect(promptSection('Alex')).toContain('(Alex wants the 5H limit')
  })

  test('the tool text carries the live figures', () => {
    const t = toolText(paceView(snap(60, 180)))
    expect(t.split('\n')[0]).toContain('Rate-limit pace (live')
    expect(t).toContain('5-hour       60% used · 2h00m elapsed · resets in 3h00m')
    expect(t).toContain('30.0%/h average')
    expect(t).toContain('100% in 1h20m, 1h40m before the reset')
    expect(t).toContain('verdict      hot')
    expect(t).toContain('next round   none — hold new agents')
    expect(t).toContain('7-day        52% used')
  })

  test('the tool recommends a round when under pace, and says why when data is missing', () => {
    expect(toolText(paceView(snap(20, 150)))).toContain('next round   up to 5 agents now (~10% of 5H)')
    expect(toolText(paceView({ now: NOW, reading: null, reason: 'no statusline file', costUsd: null }))).toContain('no reading — no statusline file')
  })
})

describe('/pace text', () => {
  test('burn, projection, verdict and round size', () => {
    const t = commandText(paceView(snap(60, 180)))
    expect(t).toContain('30.0%/h average')
    expect(t).toContain('100% in 1h20m, 1h40m before the reset')
    expect(t).toContain('next round   none — hold new agents')
    expect(t).toContain('7-day        52% used · resets in 72h00m')
    expect(t).toContain('$12.40 this session')
  })
})

describe('toasts', () => {
  test('80 and 95 once per window, hot once', () => {
    const s = snap(82, 150)
    const due = toastsDue(paceView(s), s.reading, [])
    expect(due.map(d => d.key.split(':')[1])).toEqual(['80', 'hot'])
    const fired = due.map(d => d.key)
    expect(toastsDue(paceView(s), s.reading, fired)).toEqual([])
    const s2 = snap(96, 150) // same window, later reading
    expect(toastsDue(paceView(s2), s2.reading, fired).map(d => d.key.split(':')[1])).toEqual(['95'])
  })

  test('a new window re-arms them; pruning drops old windows', () => {
    const s = snap(82, 150)
    const fired = toastsDue(paceView(s), s.reading, []).map(d => d.key)
    const next = snap(81, 290)
    expect(toastsDue(paceView(next), next.reading, fired).length).toBeGreaterThan(0)
    expect(pruneFired(fired, next.reading?.fiveHour?.resetsAt)).toEqual([])
  })

  test('nothing toasts without a reading or after a reset', () => {
    const s = snap(99, -1)
    expect(toastsDue(paceView(s), s.reading, [])).toEqual([])
  })
})

describe('sources', () => {
  test('status line record', () => {
    const text = JSON.stringify({
      receivedAt: '2026-10-02T11:58:00.000Z',
      rate_limits: { five_hour: { used_percentage: 46, resets_at: 1790989800 }, seven_day: { used_percentage: 52, resets_at: 1791331200 } },
    })
    const r = readingFromStatusline(text, '253721b8-977c.json')
    expect(r?.fiveHour).toEqual({ percentUsed: 46, resetsAt: 1790989800000 })
    expect(r?.observedAt).toBe(Date.parse('2026-10-02T11:58:00.000Z'))
    expect(readingFromStatusline('{"receivedAt":"2026-10-02T11:58:00Z"}', 'x.json')).toBeNull()
    expect(() => readingFromStatusline('not json', 'x.json')).toThrow()
  })

  test('session rate limits', () => {
    const r = readingFromSession([{ kind: 'five_hour', percentUsed: 23.5, resetsAt: '2026-10-02T14:30:00Z' }], NOW)
    expect(r?.fiveHour?.percentUsed).toBe(23.5)
    expect(r?.sevenDay).toBeNull()
    expect(readingFromSession([], NOW)).toBeNull()
  })

  test('freshest wins, the session on a tie', () => {
    const a = snap(10, 100).reading
    const b = { ...snap(20, 100, { ageMin: 0 }).reading!, source: 'statusline-file' as const }
    expect(freshest(a, b)).toBe(b)
    expect(freshest(a, { ...a!, source: 'statusline-file' })).toBe(a)
    expect(freshest(null, b)).toBe(b)
  })
})

describe('free-reset promo config', () => {
  // An example promo (not anyone's real one): weekly levels 80/97, open around NOW.
  const PROMO = {
    toastFrom: new Date(NOW - 24 * 60 * MIN).toISOString(),
    expiresAt: new Date(NOW + 5 * 24 * 60 * MIN).toISOString(),
    levels: [80, 97],
    minLeadHours: 12,
    dropPoints: 30,
    target: 'the example target',
    expiresLabel: 'the example expiry',
    where: 'the example settings page',
  }

  test('parses a valid file; anything malformed is no promo', () => {
    const cfg = parseFreeReset(JSON.stringify(PROMO))
    expect(cfg).toMatchObject({ toastFrom: NOW - 24 * 60 * MIN, minLeadMs: 12 * 60 * MIN, dropPts: 30, levels: [80, 97] })
    expect(parseFreeReset('not json')).toBe(null)
    expect(parseFreeReset('[]')).toBe(null)
    expect(parseFreeReset(JSON.stringify({ ...PROMO, toastFrom: 'someday' }))).toBe(null)
    expect(parseFreeReset(JSON.stringify({ ...PROMO, levels: [97, 80] }))).toBe(null)
    expect(parseFreeReset(JSON.stringify({ ...PROMO, levels: [] }))).toBe(null)
    expect(parseFreeReset(JSON.stringify({ ...PROMO, where: '' }))).toBe(null)
    expect(parseFreeReset(JSON.stringify({ ...PROMO, dropPoints: 0 }))).toBe(null)
  })

  test('without a config: no row, no toast, no tracking', () => {
    const s = snap(10, 180, { week: 98 })
    const v = paceView(s)
    expect(commandText(v)).not.toContain('free reset')
    expect(freeResetToast(v, [])).toEqual([])
    const prev = { usedAt: null, last: { percentUsed: 90, resetsAt: NOW + 3 * 24 * 60 * MIN, observedAt: NOW - 60 * MIN } }
    expect(trackFreeReset(prev, { ...s.reading!, sevenDay: { percentUsed: 5, resetsAt: NOW + 3 * 24 * 60 * MIN } }, NOW)).toBe(prev)
  })

  test('with a config: the row, the toast and press detection', () => {
    const cfg = parseFreeReset(JSON.stringify(PROMO))
    const s = snap(10, 180, { week: 98 })
    const v = paceView(s)
    expect(commandText(v, cfg)).toContain('free reset   unused · press at >=97% weekly (target the example target) · expires the example expiry')
    expect(freeResetToast(v, [], cfg).map(t => t.text)).toEqual(['Weekly at 98% with 3d 0h until it resets. Press the free reset now: the example settings page.'])
    expect(freeResetToast(paceView(snap(10, 180, { week: 85 })), [], cfg).map(t => t.text)).toEqual(['Weekly at 85%. Free-reset press is close; plan to press at 97%.'])
    const prev = { usedAt: null, last: { percentUsed: 90, resetsAt: NOW + 3 * 24 * 60 * MIN, observedAt: NOW - 60 * MIN } }
    const next = trackFreeReset(prev, { ...s.reading!, sevenDay: { percentUsed: 5, resetsAt: NOW + 3 * 24 * 60 * MIN } }, NOW, cfg)
    expect(next.usedAt).toBe(NOW)
  })

  test('a used free reset is reported in local wall-clock time', () => {
    const used = new Date(2026, 0, 5, 21, 42).getTime() // local date parts: holds in any time zone
    const v = paceView({ ...snap(10, 180), freeResetUsedAt: used })
    expect(commandText(v, parseFreeReset(JSON.stringify(PROMO))).replace(/\s/g, ' ')).toContain('free reset   used Mon, Jan 5, 9:42 PM')
  })
})

describe('times', () => {
  // Built from local date parts, so the expectation holds in any time zone the tests run in.
  const LOCAL = new Date(2026, 0, 5, 21, 42).getTime()

  test('fmtWhen shows the local wall-clock time, not a fixed zone', () => {
    expect(fmtWhen(LOCAL).replace(/\s/g, ' ')).toBe('Mon, Jan 5, 9:42 PM') // some ICU builds put U+202F before PM
  })
})
