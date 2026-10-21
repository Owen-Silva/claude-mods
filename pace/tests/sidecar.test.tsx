// The mission-control sidecar: SDK sessions (no statusLine hook) still write
// data/statusline/<id>.json in the status line's shape; terminal sessions don't.
import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { statuslineDir } from '../hooks/sidecar'

const MIN = 60_000
const NOW = Date.parse('2026-10-12T12:00:00Z')
const DIR = 'C:/Users/you/mission-control/data/statusline'
const ID = 'abcd1234-0000-0000-0000-000000000000'
const norm = (p: string) => p.split('\\').join('/')

type Limit = { kind: string; percentUsed: number; resetsAt?: string }

function world(on: On, rateLimits: Limit[], existing?: string, env: Record<string, string> = { USERPROFILE: 'C:\\Users\\you' }, folders: string[] = [DIR]) {
  mock.clock(on, { now: NOW })
  mock.store(on)
  mock.env(on, env)
  on('fs.exists', ($, e) => ({ value: folders.includes(norm(e.path)) }))
  const writes: { path: string; text: string }[] = []
  on('session.usage', () => ({ value: { startedAt: NOW - 60 * MIN, context: { window: 1_000_000, tokens: 50_000, percent: 5 }, rateLimits, cost: { usd: 3.25 } } }))
  on('session.id', () => ({ value: ID }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('fs.list', () => ({ value: [] }))
  on('fs.read', ($, e) => (existing && norm(e.path) === `${DIR}/${ID}.json` ? { value: existing } : { deny: `ENOENT ${e.path}` }))
  on('fs.write', ($, e) => {
    writes.push({ path: norm(e.path), text: e.text })
    return { value: undefined }
  })
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('tool.register', ($, e) => ({ value: { tool: `mcp__pace__${e.name}` } }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.measure', ($, e) => ({ changed: e.changed }))
  return writes
}

const limits = (): Limit[] => [
  { kind: 'five_hour', percentUsed: 41, resetsAt: new Date(NOW + 90 * MIN).toISOString() },
  { kind: 'seven_day', percentUsed: 17.5, resetsAt: new Date(NOW + 3 * 24 * 60 * MIN).toISOString() },
]

describe('statusline sidecar', () => {
  test('an SDK session writes the status line record mission-control reads', async ($, on) => {
    const writes = world(on, limits())
    await $.session.start({ cwd: 'C:/Users/you', surface: null, isInteractive: false })
    const mine = writes.filter(w => w.path === `${DIR}/${ID}.json`)
    expect(mine.length).toBeGreaterThan(0)
    const rec = JSON.parse(mine[mine.length - 1]!.text)
    expect(rec.session_id).toBe(ID)
    expect(rec.rate_limits.five_hour.used_percentage).toBe(41)
    expect(rec.rate_limits.five_hour.resets_at).toBe(Math.round((NOW + 90 * MIN) / 1000))
    expect(rec.rate_limits.seven_day.used_percentage).toBe(17.5)
    expect(rec.cost.total_cost_usd).toBe(3.25)
    expect(rec.context_window.context_window_size).toBe(1_000_000)
    expect(rec.receivedAt).toBe(new Date(NOW).toISOString())
  })

  test('a later measurement updates it, keeping fields only the status line had', async ($, on) => {
    const prev = JSON.stringify({ session_id: ID, cwd: 'C:\\Users\\you', version: '2.1.295', model: { id: 'claude-opus-5-5', display_name: 'Opus 5.5' } })
    const writes = world(on, [], prev)
    await $.session.start({ cwd: 'C:/Users/you', surface: null, isInteractive: false })
    await $.session.measure({ context: { window: 1_000_000 }, rateLimits: limits(), cost: { usd: 9 }, changed: ['rateLimits', 'cost'] })
    const last = JSON.parse(writes[writes.length - 1]!.text)
    expect(last.cwd).toBe('C:\\Users\\you')
    expect(last.model.display_name).toBe('Opus 5.5')
    expect(last.cost.total_cost_usd).toBe(9)
    expect(last.rate_limits.seven_day.used_percentage).toBe(17.5)
  })

  test('an interactive terminal session leaves the record to bin/statusline.js', async ($, on) => {
    const writes = world(on, limits())
    await $.session.start({ cwd: 'C:/Users/you', surface: 'terminal', isInteractive: true })
    await $.session.measure({ context: { window: 1_000_000 }, rateLimits: limits(), cost: { usd: 1 }, changed: ['cost'] })
    expect(writes.filter(w => w.path.startsWith(DIR)).length).toBe(0)
  })

  test('no status line folder on this machine: nothing is written, no folder is made', async ($, on) => {
    const writes = world(on, limits(), undefined, { USERPROFILE: 'C:\\Users\\you' }, [])
    await $.session.start({ cwd: 'C:/Users/you', surface: null, isInteractive: false })
    await $.session.measure({ context: { window: 1_000_000 }, rateLimits: limits(), cost: { usd: 1 }, changed: ['cost'] })
    expect(writes.length).toBe(0)
  })

  test('PACE_STATUSLINE_DIR moves the record folder', async ($, on) => {
    const writes = world(on, limits(), undefined, { PACE_STATUSLINE_DIR: 'D:\\dash\\statusline\\', HOME: '/home/you' }, ['D:/dash/statusline'])
    await $.session.start({ cwd: 'D:/work', surface: null, isInteractive: false })
    expect(writes.map(w => w.path)).toContain(`D:/dash/statusline/${ID}.json`)
  })

  test('HOME stands in for USERPROFILE', async ($, on) => {
    const writes = world(on, limits(), undefined, { HOME: 'D:\\home\\you' }, ['D:/home/you/mission-control/data/statusline'])
    await $.session.start({ cwd: 'D:/home/you', surface: null, isInteractive: false })
    expect(writes.map(w => w.path)).toContain(`D:/home/you/mission-control/data/statusline/${ID}.json`)
  })

  test('statuslineDir: forward slashes, override first, null without a home', () => {
    expect(statuslineDir({ home: 'C:\\Users\\you' })).toBe(DIR)
    expect(statuslineDir({ override: 'E:/x/', home: 'C:\\Users\\you' })).toBe('E:/x')
    expect(statuslineDir({ override: '', home: null })).toBe(null)
  })
})
