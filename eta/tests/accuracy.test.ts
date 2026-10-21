// eta's accuracy: the history line, the scoring and backtest math, and the
// adjustment the band shows (a range while similar estimates spread wide,
// re-estimates as said).
import { describe, expect, test } from 'claude-code/testing'

import type { EtaCalSample, EtaHistoryRecord, EtaLive, EtaPlan } from '../types'
import {
  ADJUST,
  LEGACY_ADJUST,
  adjust,
  adjustRe,
  applyEta,
  backtest,
  bandSegments,
  bandText,
  calibration,
  emptyLive,
  endWork,
  etaView,
  historyRecord,
  parseHistory,
  reSamples,
  scorePairs,
  snapshotOf,
  startTurn,
  weightedQuantile,
} from '../hooks/core'

const MIN = 60_000
const NOW = Date.parse('2026-10-02T16:00:00Z')
const band = (live: EtaLive, now: number) => bandText(bandSegments(etaView(live, now), now, 0))
const working = (at = NOW): EtaLive => ({ ...startTurn(emptyLive(), at, 'build the eta mod'), self: { sessionId: 'abcdef1234567890', project: 'helm', cwd: 'C:/Users/you/helm' } })
const declare = (live: EtaLive, input: Record<string, unknown>, at: number) => applyEta(live, input, at).live
/** Finished first estimates of `said` minutes that took said × each ratio. */
const cal = (said: number, ratios: number[]): EtaCalSample[] => ratios.map((r, i) => ({ said, took: said * r, at: NOW - (ratios.length - i) * MIN }))
const withCal = (live: EtaLive, samples: EtaCalSample[], re: EtaCalSample[] = []): EtaLive => ({ ...live, learned: { ...live.learned, calibration: samples, reSamples: re } })
const r2 = (x: number | null | undefined) => (x == null ? x : Math.round(x * 100) / 100)

/** A finished task for the backtest: said `first`, took `took`, finished at `at` minutes past NOW. */
const rec = (first: number, took: number, at: number, re: [number, number][] = []): EtaHistoryRecord => {
  const finishedAt = NOW + at * MIN
  const firstAt = finishedAt - took * MIN
  return {
    v: 1, id: `t-${at}`, session: null, project: null, startedAt: firstAt, firstAt, finishedAt, first,
    estimates: [{ at: firstAt, min: first, f: null }, ...re.map(([minBefore, min]) => ({ at: finishedAt - minBefore * MIN, min, f: null }))],
    took, factor: null, factorSrc: 'shown', end: 'done', src: 'live',
  }
}

describe('the history line', () => {
  test('keeps every estimate with its time and the factor shown, and the session short id', () => {
    let live = withCal(working(), cal(20, [0.5, 0.5, 0.5]))
    live = declare(live, { minutes: 20, steps: ['a'], note: 'n' }, NOW)
    live = declare(live, { step: 1 }, NOW + MIN)
    live = declare(live, { minutes: 12 }, NOW + 5 * MIN)
    const out = applyEta(live, { done: true }, NOW + 15 * MIN)
    const r = out.record as EtaHistoryRecord
    expect(r.session).toBe('abcdef12')
    expect(r.project).toBe('helm')
    expect(r.id).toBe(`abcdef12-${NOW}`)
    expect(r.first).toBe(20)
    expect(r.took).toBe(15)
    expect(r.factor).toBe(0.75)
    expect(r.estimates).toEqual([{ at: NOW, min: 20, f: 0.75 }, { at: NOW + 5 * MIN, min: 12, f: null }])
    expect(r.end).toBe('done')
    expect(out.sample).toEqual({ said: 20, took: 15, at: NOW + 15 * MIN })
  })

  test('an idle end writes one too; a plan from before estimates were kept gets its first one back', () => {
    const live = declare(working(), { minutes: 10 }, NOW)
    const plan = { ...(live.plan as EtaPlan), estimates: undefined }
    const r = historyRecord(plan, NOW + 8 * MIN, 'idle', live.self) as EtaHistoryRecord
    expect(r.estimates).toEqual([{ at: NOW, min: 10, f: null }])
    const ended = endWork(live, NOW + 8 * MIN)
    expect(ended.record?.end).toBe('idle')
    expect(ended.record?.took).toBe(8)
    expect(historyRecord({ ...plan, originalMinutes: null, estimatedAt: null }, NOW, 'done', null)).toBe(null)
  })

  test('parseHistory keeps the records and counts the lines that are not', () => {
    const good = JSON.stringify(rec(10, 12, 0))
    const out = parseHistory(`${good}\n{"v":1,"first":"x"}\nnot json\n\n${good}\n`)
    expect(out.records.length).toBe(2)
    expect(out.bad).toBe(2)
  })
})

describe('scoring', () => {
  test('median ratio, mean absolute log error, within ±25%/±50%, late share, and late errors weighted double', () => {
    const s = scorePairs([
      { pred: 10, actual: 10, at: 0 }, // exact
      { pred: 10, actual: 20, at: 0 }, // late ×2
      { pred: 10, actual: 5, at: 0 }, // early ×0.5
      { pred: 10, actual: 12, at: 0 }, // within 25% of actual
    ])
    expect(s.n).toBe(4)
    expect(r2(s.medianRatio)).toBe(1.1)
    expect(r2(s.male)).toBe(r2((0 + Math.log(2) + Math.log(2) + Math.log(1.2)) / 4))
    expect(s.within25).toBe(0.5)
    expect(s.within50).toBe(0.75)
    expect(s.lateShare).toBe(0.25)
    expect(r2(s.loss)).toBe(r2((0 + 2 * Math.log(2) + Math.log(2) + 2 * Math.log(1.2)) / 4))
    expect(scorePairs([]).loss).toBe(null)
  })

  test('weightedQuantile: equal weights give the median; weight pulls it', () => {
    expect(weightedQuantile([1, 2, 3, 4], [1, 1, 1, 1], 0.5)).toBe(2.5)
    expect(weightedQuantile([1, 2, 3], [1, 1, 1], 0.5)).toBe(2)
    expect(weightedQuantile([1, 2, 3], [0, 0, 1], 0.5)).toBe(3)
    expect(weightedQuantile([5], [1], 0.9)).toBe(5)
  })
})

describe('the adjustment', () => {
  test('LEGACY_ADJUST and ADJUST give exactly the old calibration factor', () => {
    const samples = [...cal(10, [0.5, 1.2, 0.9, 2.5]), ...cal(60, [0.4, 0.6, 0.7, 0.3]), ...cal(200, [1.1, 0.8, 0.9])]
    for (const m of [5, 10, 15, 30, 60, 90, 200, 400]) {
      expect(adjust(samples, m, NOW, LEGACY_ADJUST).factor).toBe(calibration(samples, m).ratio)
      expect(adjust(samples, m, NOW, ADJUST).factor).toBe(calibration(samples, m).ratio)
    }
  })

  test('a range while the middle half of similar estimates spans 1.5× or more; one number once it narrows', () => {
    const wide = adjust(cal(30, [0.3, 0.5, 0.8, 1.2, 1.6, 2]), 30, NOW, ADJUST)
    expect(wide.range).not.toBe(null)
    const [lo, hi] = wide.range as [number, number]
    expect(lo).toBeLessThanOrEqual(wide.factor as number)
    expect(hi).toBeGreaterThanOrEqual(wide.factor as number)
    expect(hi / lo).toBeGreaterThanOrEqual(ADJUST.rangeMinWidth)
    expect(adjust(cal(30, [0.9, 0.95, 1, 1.05, 1.1, 1.2]), 30, NOW, ADJUST).range).toBe(null)
    // Fewer than rangeMinN similar ones: no range yet.
    expect(adjust(cal(30, [0.3, 1, 2]), 30, NOW, ADJUST).range).toBe(null)
    // Other sizes do not count.
    expect(adjust(cal(300, [0.3, 0.5, 0.8, 1.2, 1.6, 2]), 30, NOW, ADJUST).n).toBe(0)
  })

  test('a re-estimate is shown as said, ranged by past re-estimates of its size; legacy scales it by the plan factor', () => {
    const re = cal(10, [0.4, 0.7, 1, 1.5, 2.2])
    const a = adjustRe(re, 10, NOW, 0.75, ADJUST)
    expect(a.factor).toBe(null)
    expect(a.range).not.toBe(null)
    expect((a.range as [number, number])[0]).toBeLessThanOrEqual(1)
    expect((a.range as [number, number])[1]).toBeGreaterThanOrEqual(1)
    expect(adjustRe(re, 10, NOW, 0.75, LEGACY_ADJUST)).toEqual({ factor: 0.75, range: null, n: 0, spread: null })
  })

  test('reSamples: what remained at each re-estimate against what it really took', () => {
    expect(reSamples(rec(30, 40, 100, [[10, 15], [3, 2]]))).toEqual([
      { said: 15, took: 10, at: NOW + 100 * MIN },
      { said: 2, took: 3, at: NOW + 100 * MIN },
    ])
  })
})

describe('backtest', () => {
  test('predicts each task only from tasks finished before its first estimate', () => {
    // Took/said 0.5, 0.5, 2 (median 0.5, clamped to 0.75); then a ×3 task finishing at 200 while
    // the last one (first estimate at 150) runs: had it leaked in, the median would be 1.25.
    const recs = [rec(20, 10, 10), rec(20, 10, 20), rec(20, 40, 30), rec(20, 60, 200), rec(20, 100, 250)]
    const b = backtest(recs, LEGACY_ADJUST)
    expect(b.n).toBe(5)
    expect(b.first.raw.medianRatio).toBe(2)
    const last = backtest(recs, LEGACY_ADJUST, 4)
    expect(last.n).toBe(1)
    expect(r2(last.first.adjusted.medianRatio)).toBe(r2(100 / 15))
    // The first three had fewer than 3 finished before them: shown as said.
    expect(backtest(recs, LEGACY_ADJUST, 0, 3).first.adjusted).toEqual(backtest(recs, LEGACY_ADJUST, 0, 3).first.raw)
  })

  test('re-estimates: plan factor (legacy) against as said (shipped)', () => {
    const recs = [rec(20, 10, 10), rec(20, 10, 20), rec(20, 10, 30), rec(20, 20, 100, [[10, 10]])]
    const legacy = backtest(recs, LEGACY_ADJUST, 3)
    const shipped = backtest(recs, ADJUST, 3)
    expect(legacy.re.adjusted.n).toBe(1)
    // The re-estimate said 10 with 10 left: as said is exact, the plan's 0.75× runs late.
    expect(shipped.re.adjusted.within25).toBe(1)
    expect(legacy.re.adjusted.lateShare).toBe(1)
  })
})

describe('the band with a range', () => {
  const spread = cal(30, [0.3, 0.5, 0.8, 1.2, 1.6, 2])

  test('shows the middle half of how similar estimates went, counts both ends down, then "up to"', () => {
    const live = declare(withCal(working(), spread), { minutes: 30 }, NOW)
    const v = etaView(live, NOW)
    expect(v.declared?.range).not.toBe(null)
    const text = band(live, NOW)
    expect(text).toMatch(/^eta ~\d+m–\d+m left \(said 30m; similar ones took [\d.]+–[\d.]+× that\) · done ~\d+:\d\d–\d+:\d\d PM$/)
    const [, hi] = v.declared?.range as [number, number]
    const late = band(live, hi - 5 * MIN)
    expect(late).toMatch(/^eta up to ~5m left/)
    expect(late).toContain('· done by ~')
    // Past the point estimate but inside the range: not overdue, in the band or the snapshot.
    const mid = (v.finishAt as number) + MIN
    expect(etaView(live, mid).isOverdue).toBe(false)
    expect(snapshotOf(live, mid)?.isOverdue).toBe(false)
    // Past the top: over by, against the range.
    expect(band(live, hi + 3 * MIN)).toMatch(/^eta over by 3m \(\d+m–\d+m range, said 30m\)/)
    expect(snapshotOf(live, hi + 3 * MIN)?.isOverdue).toBe(true)
  })

  test('accurate history: one number, as before', () => {
    const live = declare(withCal(working(), cal(30, [0.8, 0.8, 0.8, 0.8, 0.8])), { minutes: 30 }, NOW)
    expect(band(live, NOW)).toBe('eta ~24m left (said 30m; work takes ~0.8× the estimate) · done ~4:24 PM')
  })

  test('a re-estimate is shown as said (no plan factor), with its own range once past re-estimates exist', () => {
    let live = declare(withCal(working(), cal(30, [0.8, 0.8, 0.8, 0.8, 0.8])), { minutes: 30 }, NOW)
    live = declare(live, { minutes: 20 }, NOW + 10 * MIN)
    expect(band(live, NOW + 10 * MIN)).toBe('eta ~20m left · done ~4:30 PM')
    const ranged = { ...live, learned: { ...live.learned, reSamples: cal(20, [0.4, 0.7, 1, 1.5, 2.2]) } }
    expect(band(ranged, NOW + 10 * MIN)).toMatch(/^eta ~\d+m–\d+m left \(said 20m; re-estimates like it took [\d.]+–[\d.]+× that\)/)
  })
})
