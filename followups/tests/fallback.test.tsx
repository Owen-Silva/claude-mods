// A missing hooks/rules.local.ts never silently disables followups: the import
// falls back to the tracked hooks/rules.local/index.ts (the example rules) and
// followups says so loudly, at session start and first in /followups. With a
// real rules.local.ts present nothing new is shown. The engine tests below run
// the branch that matches the rule set this checkout loaded.
import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, PromptOrigin } from 'claude-code'

import * as EXAMPLE from '../hooks/rules.example'
import { LOCAL_MISSING, RULES } from '../hooks/rules.local'
import * as FALLBACK from '../hooks/rules.local/index'

const H = 'C:\\Users\\you'
const MISSING = 'followups: hooks/rules.local.ts is missing, so followups is running the EXAMPLE rules. Copy hooks/rules.example.ts to hooks/rules.local.ts.'
const BACK_NOW = 'followups: hooks/rules.local.ts is there now, but followups loaded without it and is running the EXAMPLE rules. Restart Claude Code to load it.'
const GONE = 'followups: hooks/rules.local.ts is missing, so the next start runs the EXAMPLE rules (these rules loaded before it went). Copy hooks/rules.example.ts to hooks/rules.local.ts.'

type World = { exists: boolean | undefined; asked: string[]; toasts: { text: string; timeoutMs?: number }[] }

function world(on: On, exists: boolean | undefined): World {
  const w: World = { exists, asked: [], toasts: [] }
  mock.clock(on, { now: 0 })
  mock.env(on, { USERPROFILE: H })
  on('fs.exists', ($, e) => {
    w.asked.push(e.path.replace(/\\/g, '/'))
    return w.exists === undefined ? { deny: 'no file system here' } : { value: w.exists }
  })
  // A valid name setting, so the only file these tests ask about is hooks/rules.local.ts.
  on('fs.read', ($, e) => (/[\\/]user\.local\.json$/.test(e.path) ? { value: '{ "name": "Alex" }' } : { deny: `ENOENT: no such file ${e.path}` }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('tool.register', ($, e) => ({ value: { tool: `mcp__followups__${e.name}` } }))
  on('ui.toast', ($, e) => {
    w.toasts.push({ text: e.text, timeoutMs: (e as { timeoutMs?: number }).timeoutMs })
    return { value: undefined }
  })
  return w
}

const start = ($: Engine) => $.session.start({ cwd: H, surface: 'terminal', isInteractive: true })
async function followups($: Engine): Promise<string> {
  const r = await $.command.run({ command: 'followups', args: '', origin: { kind: 'composer' } as PromptOrigin, presentation: { isFullscreen: false, columns: 140 } })
  return r.text ?? ''
}

describe('the tracked fallback', () => {
  test('re-exports exactly what register imports, from the example, and says it is the fallback', () => {
    expect(Object.keys(FALLBACK).sort()).toEqual(['LOCAL_MISSING', 'RULES', 'TOOL_EXAMPLES'])
    expect(FALLBACK.LOCAL_MISSING).toBe(true)
    expect(FALLBACK.RULES).toBe(EXAMPLE.RULES)
    expect(FALLBACK.TOOL_EXAMPLES).toBe(EXAMPLE.TOOL_EXAMPLES)
    // A real rules file (and the example a user copies) says false.
    expect(EXAMPLE.LOCAL_MISSING).toBe(false)
  })
})

if (LOCAL_MISSING) {
  describe('running on the fallback (hooks/rules.local.ts missing)', () => {
    test('the example rules load, and a long toast at session start says why', async ($, on) => {
      expect(RULES).toBe(EXAMPLE.RULES)
      const w = world(on, false)
      await start($)
      expect(w.asked.length > 0 && w.asked.every(p => p.endsWith('/hooks/rules.local.ts'))).toBe(true)
      expect(w.toasts).toEqual([{ text: MISSING, timeoutMs: 60_000 }])
    })

    test('/followups leads with the same line, then the example rules', async ($, on) => {
      world(on, false)
      await start($)
      const list = await followups($)
      expect(list.split('\n')[0]).toBe(MISSING)
      expect(list).toContain('followups: 0 open, 0 closed this session')
      for (const r of EXAMPLE.RULES) expect(list).toContain(`  ${r.id.padEnd(18)} ${r.summary}`)
    })

    test('a check that cannot run still warns; a file that appeared since asks for a restart', async ($, on) => {
      const w = world(on, undefined)
      await start($)
      expect(w.toasts.map(t => t.text)).toEqual([MISSING])
      w.exists = true
      expect((await followups($)).split('\n')[0]).toBe(BACK_NOW)
    })
  })
} else {
  describe('running on a real hooks/rules.local.ts', () => {
    test('nothing new is shown when the file is there', async ($, on) => {
      const w = world(on, true)
      await start($)
      expect(w.asked.every(p => p.endsWith('/hooks/rules.local.ts'))).toBe(true)
      expect(w.toasts).toEqual([])
      expect((await followups($)).split('\n')[0]).toBe('followups: 0 open, 0 closed this session')
    })

    test('nothing new is shown when the check cannot run', async ($, on) => {
      const w = world(on, undefined)
      await start($)
      expect(w.toasts).toEqual([])
      expect((await followups($)).split('\n')[0]).toBe('followups: 0 open, 0 closed this session')
    })

    test('the file gone from disk since load is called out', async ($, on) => {
      const w = world(on, false)
      await start($)
      expect(w.toasts).toEqual([{ text: GONE, timeoutMs: 60_000 }])
      expect((await followups($)).split('\n')[0]).toBe(GONE)
    })
  })
}
