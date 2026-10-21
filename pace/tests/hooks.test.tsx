// The mod's hooks against the engine: band, /pace, prompt section, toasts,
// the status line fallback and missing data.
import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const MIN = 60_000
const NOW = Date.parse('2026-10-02T12:00:00Z')
const DIR = 'C:/Users/you/mission-control/data/statusline'

type Limit = { kind: string; percentUsed: number; resetsAt?: string }
type World = {
  rateLimits?: Limit[]
  cost?: number
  files?: { name: string; mtimeMs: number; text: string }[]
  listError?: string
  /** free-reset.local.json's text beside the plugin (absent: no file). */
  freeReset?: string
  /** user.local.json's text beside the mod folders, the name setting (absent: no file). */
  user?: string
}

/** The engine hands paths over in the platform's spelling (backslashes on Windows). */
const norm = (p: string) => p.split('\\').join('/')
const iso = (ms: number) => new Date(ms).toISOString()
const fiveHour = (used: number, remainingMin: number): Limit => ({ kind: 'five_hour', percentUsed: used, resetsAt: iso(NOW + remainingMin * MIN) })
const sevenDay = (used: number): Limit => ({ kind: 'seven_day', percentUsed: used, resetsAt: iso(NOW + 3 * 24 * 60 * MIN) })

/** Tool names the mod registered in the current test. */
let registeredTools: string[] = []

/** Answers every noun the mod reaches beneath it, from memory. */
function world(on: On, w: World) {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on)
  mock.env(on, { USERPROFILE: 'C:\\Users\\you' })
  on('fs.exists', ($, e) => ({ value: norm(e.path) === DIR }))
  const toasts: string[] = []
  on('session.usage', () => ({
    value: { startedAt: NOW - 60 * MIN, context: { window: 1_000_000 }, rateLimits: w.rateLimits ?? [], cost: { usd: w.cost ?? 0 } },
  }))
  on('fs.list', ($, e) => {
    if (w.listError) return { deny: w.listError }
    expect(norm(e.path)).toBe(DIR)
    return { value: (w.files ?? []).map(f => ({ name: f.name, kind: 'file' as const, size: f.text.length, mtimeMs: f.mtimeMs, isLink: false })) }
  })
  on('fs.read', ($, e) => {
    if (w.freeReset !== undefined && norm(e.path).endsWith('/free-reset.local.json')) return { value: w.freeReset }
    if (w.user !== undefined && norm(e.path).endsWith('/user.local.json')) return { value: w.user }
    const f = (w.files ?? []).find(x => `${DIR}/${x.name}` === norm(e.path))
    if (!f) return { deny: `ENOENT ${e.path}` }
    return { value: f.text }
  })
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  registeredTools = []
  on('tool.register', ($, e) => {
    registeredTools.push(e.name)
    return { value: { tool: `mcp__pace__${e.name}` } }
  })
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.log', () => ({ value: undefined }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'You are Claude Code.', scope: 'shared' as const }] }))
  return { clock, toasts }
}

const BAND = {
  plugin: 'pace',
  component: 'AbovePrompt' as const,
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 160, scroll: { offset: 0, bodyRows: 10 }, view: {} },
}

const start = ($: Engine) =>
  $.session.start({ cwd: 'C:/Users/you', surface: 'terminal', isInteractive: true })

/** All the band's text, joined. */
async function bandText($: Engine, surface: 'terminal' | 'desktop'): Promise<string> {
  const ui = await $.ui.mount({ ...BAND, surface })
  const texts = (await ui.findAll({ type: 'Text' })) as { text?: string }[]
  await ui.unmount?.()
  return texts.map(t => t.text ?? '').join('')
}

describe('band', () => {
  test('shows 5H, time left, verdict, week and cost on every surface', async ($, on) => {
    world(on, { rateLimits: [fiveHour(20, 150), sevenDay(52)], cost: 12.4 })
    await start($)
    for (const surface of ['terminal', 'desktop'] as const) {
      const text = await bandText($, surface)
      expect(text).toContain('5H 20% · 2h30m left · under pace — room for ~9 more rounds of 3 agents · WK 52% · $12.40')
    }
  })

  test('missing data shows why, never a number', async ($, on) => {
    world(on, { rateLimits: [], listError: 'EACCES: permission denied' })
    await start($)
    const text = await bandText($, 'terminal')
    expect(text).toContain('5H pace: no reading — ')
    expect(text).toContain('no rate-limit reading yet')
    expect(text).toContain('status line folder unreadable')
    expect(text).toContain('EACCES')
  })

  test('falls back to the newest status line record before the first response', async ($, on) => {
    const rec = (used: number, at: number) =>
      JSON.stringify({ receivedAt: iso(at), rate_limits: { five_hour: { used_percentage: used, resets_at: Math.floor((NOW + 150 * MIN) / 1000) } } })
    world(on, {
      rateLimits: [],
      files: [
        { name: 'old-session.json', mtimeMs: NOW - 30 * MIN, text: rec(5, NOW - 30 * MIN) },
        { name: 'new-session.json', mtimeMs: NOW - 2 * MIN, text: rec(44, NOW - 2 * MIN) },
      ],
    })
    await start($)
    const text = await bandText($, 'terminal')
    expect(text).toContain('5H 44% · 2h30m left · under pace')
  })

  test('the window resetting under a held reading turns the band to "reset"', async ($, on) => {
    const { clock } = world(on, { rateLimits: [fiveHour(70, 10)] })
    await start($)
    expect(await bandText($, 'terminal')).toContain('5H 70%')
    await clock.advance(15 * MIN)
    const text = await bandText($, 'terminal')
    expect(text).toContain('reset 5m ago; waiting for a fresh reading')
    expect(text).not.toContain('70%')
  })
})

describe('/pace', () => {
  test('prints the breakdown', async ($, on) => {
    world(on, { rateLimits: [fiveHour(60, 180), sevenDay(52)], cost: 3.5 })
    await start($)
    const r = await $.command.run({ command: 'pace', args: '' } as never)
    expect(r.text).toContain('30.0%/h average')
    expect(r.text).toContain('hot — 100% in 1h20m')
    expect(r.text).toContain('next round   none — hold new agents')
    expect(r.text).toContain('$3.50 this session')
  })
})

describe('free-reset promo config', () => {
  // An example promo, not anyone's real one: open around NOW, weekly levels 80/97.
  const PROMO = JSON.stringify({
    toastFrom: iso(NOW - 24 * 60 * MIN),
    expiresAt: iso(NOW + 5 * 24 * 60 * MIN),
    levels: [80, 97],
    minLeadHours: 12,
    dropPoints: 30,
    target: 'the example target',
    expiresLabel: 'the example expiry',
    where: 'the example settings page',
  })

  test('no config file: no row, no toast', async ($, on) => {
    const { toasts } = world(on, { rateLimits: [fiveHour(10, 180), sevenDay(96)] })
    await start($)
    const r = await $.command.run({ command: 'pace', args: '' } as never)
    expect(r.text).not.toContain('free reset')
    expect(toasts.filter(t => t.includes('free reset'))).toEqual([])
  })

  test('an invalid config file is the same as none', async ($, on) => {
    const { toasts } = world(on, { rateLimits: [fiveHour(10, 180), sevenDay(96)], freeReset: '{"levels": "soon"}' })
    await start($)
    const r = await $.command.run({ command: 'pace', args: '' } as never)
    expect(r.text).not.toContain('free reset')
    expect(toasts.filter(t => t.includes('free reset'))).toEqual([])
  })

  test('a config file: the /pace row and the press-now toast', async ($, on) => {
    const { toasts } = world(on, { rateLimits: [fiveHour(10, 180), sevenDay(98)], freeReset: PROMO })
    await start($)
    const r = await $.command.run({ command: 'pace', args: '' } as never)
    expect(r.text).toContain('free reset   unused · press at >=97% weekly (target the example target) · expires the example expiry')
    expect(toasts.filter(t => t.includes('Press the free reset now: the example settings page.')).length).toBe(1)
  })
})

describe('prompt section', () => {
  const compose = ($: Engine) =>
    $.prompt.compose({ model: 'claude-opus-5-5', promptModel: 'claude-opus-5-5', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] })

  test('adds one static line after the engine sections, byte-identical across readings', async ($, on) => {
    const w: World = { rateLimits: [fiveHour(20, 150), sevenDay(52)] }
    const { clock } = world(on, w)
    await start($)
    const first = await compose($)
    const last = first.sections[first.sections.length - 1]
    expect(first.sections[0]?.id).toBe('intro')
    expect(last?.id).toBe('pace:pace')
    expect(last?.scope).toBe('session')
    expect(last?.text.split('\n').length).toBe(1)
    expect(last?.text).toContain('call the Pace tool')
    expect(last?.text).toContain('(the user wants the 5H limit used up near the end of the window)')
    // A very different reading, a measurement and an hour later: same bytes.
    w.rateLimits = [fiveHour(91, 30), sevenDay(70)]
    await $.session.measure({ context: { window: 1_000_000 }, rateLimits: w.rateLimits, changed: ['rateLimits'] })
    await clock.advance(60 * MIN)
    const later = await compose($)
    expect(later.sections[later.sections.length - 1]?.text).toBe(last?.text)
    w.rateLimits = []
    await clock.advance(MIN)
    const missing = await compose($)
    expect(missing.sections[missing.sections.length - 1]?.text).toBe(last?.text)
  })

  test('names the user from the name setting, the same on every reading', async ($, on) => {
    const w: World = { rateLimits: [fiveHour(20, 150), sevenDay(52)], user: '{ "name": "Alex" }' }
    world(on, w)
    await start($)
    const first = (await compose($)).sections.at(-1)?.text
    expect(first).toContain('(Alex wants the 5H limit used up near the end of the window)')
    expect((await compose($)).sections.at(-1)?.text).toBe(first)
  })
})

describe('Pace tool', () => {
  test('is registered and returns the live figures', async ($, on) => {
    const w: World = { rateLimits: [fiveHour(60, 180), sevenDay(52)], cost: 3.5 }
    world(on, w)
    await start($)
    expect(registeredTools).toContain('Pace')
    const r = await $.tool.call({ tool: 'mcp__pace__Pace' } as never)
    const text = String(r.result)
    expect(text).toContain('5-hour       60% used · 2h00m elapsed · resets in 3h00m')
    expect(text).toContain('30.0%/h average')
    expect(text).toContain('100% in 1h20m, 1h40m before the reset')
    expect(text).toContain('verdict      hot')
    expect(text).toContain('next round   none — hold new agents')
    expect(text).toContain('7-day        52% used')
    // Follows the reading: a later, lighter reading changes the answer.
    w.rateLimits = [fiveHour(20, 150), sevenDay(52)]
    const r2 = await $.tool.call({ tool: 'mcp__pace__Pace' } as never)
    expect(String(r2.result)).toContain('next round   up to 5 agents now')
  })

  test('says why when there is no reading', async ($, on) => {
    world(on, { rateLimits: [], listError: 'EACCES: permission denied' })
    await start($)
    const r = await $.tool.call({ tool: 'mcp__pace__Pace' } as never)
    expect(String(r.result)).toContain('no reading — this session has no rate-limit reading yet')
    expect(String(r.result)).toContain('EACCES')
  })
})

describe('toasts', () => {
  test('80% toasts once, 95% once more, across ticks', async ($, on) => {
    const w: World = { rateLimits: [fiveHour(82, 150)] }
    const { clock, toasts } = world(on, w)
    await start($)
    expect(toasts.filter(t => t.startsWith('5H at 82%')).length).toBe(1)
    expect(toasts.filter(t => t.startsWith('5H pace hot')).length).toBe(1)
    await clock.advance(MIN)
    expect(toasts.length).toBe(2)
    w.rateLimits = [fiveHour(96, 149)]
    await $.session.measure({ context: { window: 1_000_000 }, rateLimits: w.rateLimits, changed: ['rateLimits'] })
    expect(toasts.length).toBe(3)
    expect(toasts[2]).toContain('5H at 96%')
  })
})
