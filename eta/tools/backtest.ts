// Backtests eta's calibration on its finished-task history (history.jsonl).
// Every task is predicted only from tasks finished before its first estimate
// (online). Candidates are chosen on the older two thirds and judged on the
// most recent third (held out); the legacy method is scored the same way.
// The loss counts running late LATE_WEIGHT times running early.
//
//   node tools/backtest.ts [--history <history.jsonl>] [--json]
import * as fs from 'node:fs'

import { ADJUST, LEGACY_ADJUST, backtest, etaDir, historyFileOf, parseHistory } from '../hooks/core.ts'
import type { AccuracyScore, AdjustOptions, EtaHistoryRecord, RangeScore } from '../hooks/core.ts'

const args = process.argv.slice(2)
const i = args.indexOf('--history')
const dir = etaDir({ configDir: process.env.CLAUDE_CONFIG_DIR, home: process.env.USERPROFILE || process.env.HOME })
const file = i >= 0 && args[i + 1] ? (args[i + 1] as string) : dir === null ? '' : historyFileOf(dir)
if (!file) throw new Error('no home folder (USERPROFILE / HOME unset): pass --history <file>')
const { records, bad } = parseHistory(fs.readFileSync(file, 'utf8'))
const recs: EtaHistoryRecord[] = [...records].sort((a, b) => a.finishedAt - b.finishedAt)
const cut = Math.floor((recs.length * 2) / 3)

const pct = (x: number | null) => (x === null ? '-' : `${Math.round(x * 100)}%`)
const num = (x: number | null, d = 2) => (x === null ? '-' : x.toFixed(d))
const line = (name: string, s: AccuracyScore) =>
  `${name.padEnd(40)} n=${String(s.n).padStart(3)}  ratio ${num(s.medianRatio)}  MALE ${num(s.male)}  ±25% ${pct(s.within25).padStart(4)}  ±50% ${pct(s.within50).padStart(4)}  late ${pct(s.lateShare).padStart(4)}  loss ${num(s.loss, 3)}`
const label = (o: AdjustOptions) => `${o.match} w=${Number.isFinite(o.window) ? o.window : 'all'} q=${o.quantile.toFixed(2)} min=${o.minRatio} hl=${o.halfLifeDays ?? '-'}`
const rng = (r: RangeScore) => `${pct(r.coverage)} of ${r.n}, median width ${num(r.medianWidth, 1)}x`
const train = (o: AdjustOptions) => backtest(recs, o, 0, cut)
const test = (o: AdjustOptions) => backtest(recs, o, cut, recs.length)

// First-estimate candidates, chosen by loss on the train part only.
const grid: AdjustOptions[] = []
for (const window of [30, Infinity])
  for (const match of ['near', 'bucket', 'all'] as const)
    for (const quantile of [0.5, 0.6, 2 / 3])
      for (const minRatio of [0.75, 0.5, 0.3])
        for (const halfLifeDays of [null, 3, 7]) grid.push({ ...LEGACY_ADJUST, window, match, quantile, minRatio, halfLifeDays })
const ranked = grid.map(o => ({ o, train: train(o).first.adjusted.loss ?? Infinity })).sort((a, b) => a.train - b.train)
const best = (ranked[0] as { o: AdjustOptions }).o

const L = { train: train(LEGACY_ADJUST), test: test(LEGACY_ADJUST) }
const B = { train: train(best), test: test(best) }
const S = { train: train(ADJUST), test: test(ADJUST) }
const ranges = ([[0.25, 0.75], [0.2, 0.8], [0.1, 0.9]] as [number, number][]).map(q => {
  const o: AdjustOptions = { ...ADJUST, rangeQ: q, rangeMinWidth: 0 }
  return { q, train: train(o), test: test(o) }
})

if (args.includes('--json')) {
  console.log(JSON.stringify({ file, records: recs.length, badLines: bad, cut, legacy: L, best: { options: best, ...B }, shipped: { options: ADJUST, ...S }, ranges }, null, 1))
} else {
  console.log(`${recs.length} finished tasks (${bad} bad lines); train ${cut}, held-out ${recs.length - cut} (finished from ${new Date((recs[cut] as EtaHistoryRecord).finishedAt).toISOString()})`)
  for (const part of ['train', 'test'] as const) {
    console.log(`First estimates, ${part === 'test' ? 'HELD-OUT third' : 'train two thirds'}:`)
    console.log(line('  raw (as said)', L[part].first.raw))
    console.log(line('  legacy calibration', L[part].first.adjusted))
    console.log(line(`  best on train: ${label(best)}`, B[part].first.adjusted))
    console.log(line('  shipped', S[part].first.adjusted))
    console.log(`Re-estimates, ${part === 'test' ? 'HELD-OUT' : 'train'}:`)
    console.log(line('  legacy (plan factor)', L[part].re.adjusted))
    console.log(line('  shipped (as said)', S[part].re.adjusted))
    console.log(`  shipped ranges: first ${rng(S[part].first.range)}; re ${rng(S[part].re.range)}`)
  }
  console.log('Range quantiles (no width floor), coverage train / held-out, first | re:')
  for (const r of ranges) console.log(`  q${r.q[0]}-${r.q[1]} (nominal ${pct(r.q[1] - r.q[0])}): ${pct(r.train.first.range.coverage)} / ${pct(r.test.first.range.coverage)} width ${num(r.test.first.range.medianWidth, 1)}x | ${pct(r.train.re.range.coverage)} / ${pct(r.test.re.range.coverage)} width ${num(r.test.re.range.medianWidth, 1)}x`)
  console.log('Top 5 first-estimate candidates on train (loss train -> held-out):')
  for (const r of ranked.slice(0, 5)) console.log(`  ${label(r.o)}: ${num(r.train, 3)} -> ${num(test(r.o).first.adjusted.loss, 3)}`)
}
