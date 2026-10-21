import type { EngineInterface, Register } from 'claude-code'

import type { RailsSession } from '../types'
import { toolMatches } from './rules'
import type { Ctx, PinText, Rule, ToolInput } from './rules'
// The active rule set: hooks/rules.local.ts, machine-local config (gitignored). When that
// file is missing this resolves to the tracked fallback, rules.local/index.ts: the EXAMPLE
// rules with LOCAL_MISSING = true, which localWarning makes loud. A fresh clone runs
// cp hooks/rules.example.ts hooks/rules.local.ts first.
import { LOCAL_MISSING, PIN_TEXT, RULES } from './rules.local'
import { capital, DEFAULT_NAME, readUser, userWarning } from './user'

const SESSION = { plugin: 'rails', key: 'session' } as const
const EMPTY: RailsSession = { prompt: null, off: [], allow: [], denies: {}, pin: null }

/** Prompt origins that are the user themself: typed, from their phone, or the SDK host they drive. */
const USER_ORIGINS = new Set(['composer', 'bridge', 'sdk'])

async function load($: EngineInterface): Promise<RailsSession> {
  const { value } = await $.state.get(SESSION)
  return value ?? EMPTY
}

/** Read-modify-write with the version check, retried on a race. */
async function mutate($: EngineInterface, fn: (s: RailsSession) => RailsSession): Promise<RailsSession> {
  for (let tries = 0; tries < 10; tries++) {
    const { value, version } = await $.state.get(SESSION)
    const next = fn(value ?? EMPTY)
    const { isSet } = await $.state.set(SESSION, next, { ifVersion: version })
    if (isSet) return next
  }
  throw new Error('rails state kept changing under a write')
}

function authorizes(rule: Rule, s: RailsSession, now: number): boolean {
  const { unlock } = rule
  if (unlock === undefined || s.prompt === null) return false
  return now - s.prompt.at <= unlock.ms && unlock.test(s.prompt.text)
}

function short(text: string, n = 90): string {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length > n ? `${one.slice(0, n - 1)}…` : one
}

function context($: EngineInterface, isModelCall: boolean): Ctx {
  let cwd: Promise<string> | undefined
  return {
    isModelCall,
    cwd: () => (cwd ??= $.session.cwd()),
    git: async (dir, args) => {
      try {
        const run = await $.process.run(['git', '-C', dir, ...args], { timeoutMs: 4000 })
        return run.exitCode === 0 ? run.stdout.trim() : undefined
      } catch {
        return undefined
      }
    },
    home: async () => {
      try {
        return (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))
      } catch {
        return undefined
      }
    },
    kind: async path => {
      try {
        const st = await $.fs.stat(path)
        return st.isLink ? 'link' : st.kind
      } catch {
        return undefined
      }
    },
    entries: async dir => {
      try {
        return (await $.fs.list(dir)).map(x => ({ name: x.name, isLink: x.isLink }))
      } catch {
        return undefined
      }
    },
    isLink: async path => {
      // The engine's own stat first: a link says so, or lands somewhere other than its own spelling.
      try {
        const st = await $.fs.stat(path, { resolve: true })
        if (st.isLink) return true
        const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
        const parent = cut <= 0 ? undefined : await $.fs.stat(path.slice(0, cut), { resolve: true })
        if (st.realPath !== undefined && parent?.realPath !== undefined) {
          const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
          return norm(st.realPath) !== `${norm(parent.realPath)}/${path.slice(cut + 1).toLowerCase()}`
        }
      } catch {
        try {
          if (!(await $.fs.exists(path))) return false
        } catch {
          // fall through to PowerShell
        }
      }
      // Then Windows' own word on it: LinkType is Junction or SymbolicLink for a link.
      try {
        const lit = path.replace(/'/g, "''")
        const run = await $.process.run(
          ['powershell', '-NoProfile', '-NonInteractive', '-Command', `$i = Get-Item -Force -LiteralPath '${lit}' -ErrorAction SilentlyContinue; if ($null -eq $i) { 'missing' } else { 'type:' + $i.LinkType }`],
          { timeoutMs: 8000 },
        )
        if (run.exitCode !== 0) return undefined
        const out = run.stdout.trim()
        if (out === 'missing') return false
        return out.startsWith('type:') ? /^type:(junction|symboliclink)$/i.test(out) : undefined
      } catch {
        return undefined
      }
    },
    pin: async (project, by) => {
      const at = await $.clock.now()
      const s = await mutate($, cur => (cur.pin == null ? { ...cur, pin: { project, by, at } } : cur))
      return s.pin ?? { project, by }
    },
  }
}

/**
 * Why rails is not running the user's own rules, or will not next session; undefined when
 * hooks/rules.local.ts loaded and is still on disk (the normal case: nothing is shown).
 */
async function localWarning($: EngineInterface): Promise<string | undefined> {
  const isMissing: boolean = LOCAL_MISSING
  let onDisk: boolean | undefined
  try {
    onDisk = await $.fs.exists(`${$.plugin.root}/hooks/rules.local.ts`)
  } catch {
    onDisk = undefined
  }
  if (isMissing && onDisk === true) {
    return 'rails: hooks/rules.local.ts is on disk but did not load, so rails is running the EXAMPLE rules. Restart the session to load it.'
  }
  if (isMissing) {
    return 'rails: hooks/rules.local.ts is missing, so rails is running the EXAMPLE rules. Copy hooks/rules.example.ts to hooks/rules.local.ts.'
  }
  if (onDisk === false) {
    return 'rails: hooks/rules.local.ts is no longer on disk; this session keeps the rules it loaded, but the next one will run the EXAMPLE rules. Copy hooks/rules.example.ts to hooks/rules.local.ts.'
  }
  return undefined
}

async function statusText($: EngineInterface): Promise<string> {
  const s = await load($)
  const now = await $.clock.now()
  const total = Object.values(s.denies).reduce((a, b) => a + b, 0)
  const width = Math.max(...RULES.map(r => r.id.length))
  const warnings = [await localWarning($), userWarning('rails', await readUser($))].filter((w): w is string => w !== undefined)
  const lines = [...(warnings.length === 0 ? [] : [...warnings, '']), `rails: ${RULES.length} rules, ${total} ${total === 1 ? 'deny' : 'denies'} this session`, '']
  for (const rule of RULES) {
    const state = s.off.includes(rule.id) ? 'off' : 'on '
    const count = String(s.denies[rule.id] ?? 0).padStart(3)
    const extra = [s.allow.includes(rule.id) ? 'one bypass armed' : '', authorizes(rule, s, now) ? 'authorized by your last prompt' : '']
      .filter(Boolean)
      .join(', ')
    lines.push(`  ${state} ${rule.id.padEnd(width)} ${count}  ${rule.summary}${extra === '' ? '' : `  [${extra}]`}`)
  }
  const pin = s.pin ?? null
  // A rule set without session-separation exports PIN_TEXT = null: nothing pins, so no Project line.
  const pinText: PinText | null = PIN_TEXT
  if (pinText !== null) {
    if (pin === null) lines.push('', `Project: ${pinText.none}`)
    else {
      const mins = Math.round((now - pin.at) / 60_000)
      lines.push('', `Project: ${pinText.name(pin.project)} (pinned ${mins} min ago by: ${short(pin.by, 70)})`)
    }
  }
  if (s.prompt !== null) {
    const mins = Math.round((now - s.prompt.at) / 60_000)
    lines.push('', `Last prompt read (${mins} min ago): "${short(s.prompt.text, 70)}"`)
  }
  lines.push('', '/rails allow <id>  let the next blocked call through once', '/rails off <id|all>  /rails on <id|all>  for this session')
  return lines.join('\n')
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'rails',
      description: 'Guardrails: list rules and denies; allow, off or on a rule',
      argumentHint: '[allow|off|on <rule-id>]',
      immediate: true,
    })
    // Never silent: running the example rules (or about to) is said at every session start.
    const warning = await localWarning($)
    if (warning !== undefined) $.ui.toast(warning, { timeoutMs: 30_000 })
    // The name setting too: once here, never again on a deny (a deny just uses the default name).
    const named = userWarning('rails', await readUser($))
    if (named !== undefined) $.ui.toast(named, { timeoutMs: 30_000 })
    return next(e)
  })

  // The user's own latest prompt is what unlocks a gated action ("go", "buy it").
  on('prompt.submit', async ($, e, next) => {
    if (USER_ORIGINS.has(e.origin.kind) && !e.text.trimStart().startsWith('/')) {
      const at = await $.clock.now()
      await mutate($, s => ({ ...s, prompt: { text: e.text.slice(0, 2000), at } }))
    }
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const input = e as unknown as ToolInput
    const rules = RULES.filter(rule => toolMatches(rule, input.tool))
    if (rules.length === 0) return next(e)

    const s = await load($)
    const ctx = context($, next.origin.plugin === 'engine')
    for (const rule of rules) {
      if (s.off.includes(rule.id)) continue
      const hit = await rule.check(input, ctx)
      if (hit === undefined) continue

      if (authorizes(rule, s, await $.clock.now())) {
        $.ui.toast(`rails: ${rule.id} allowed, your last prompt authorized it`)
        continue
      }
      let isBypass = false
      await mutate($, cur => {
        isBypass = cur.allow.includes(rule.id)
        return isBypass ? { ...cur, allow: cur.allow.filter(id => id !== rule.id) } : cur
      })
      if (isBypass) {
        $.ui.toast(`rails: ${rule.id} let through once (/rails allow)`)
        continue
      }

      await mutate($, cur => ({ ...cur, denies: { ...cur.denies, [rule.id]: (cur.denies[rule.id] ?? 0) + 1 } }))
      $.ui.toast(`rails blocked ${rule.id}: ${short(hit)}`, { timeoutMs: 10_000 })
      const unlock = rule.unlock === undefined ? '' : ` It unlocks when ${rule.unlock.hint}.`
      // Who can type /rails: the model reads this too, and must not take it as something it can do.
      // readUser never throws; the guard here is belt and braces, since a throw would reach .catch and let the call through.
      let who = capital(DEFAULT_NAME)
      try {
        who = capital((await readUser($)).name)
      } catch {
        // keep the default name; the deny still goes out
      }
      return {
        deny: `[rails/${rule.id}] ${rule.reason(hit, input)}${unlock} ${who} can let one call through with /rails allow ${rule.id}.`,
      }
    }
    return next(e)
  }).catch(($, e, next) => {
    // A broken check must not block the user's work, but it must not be silent either.
    $.ui.toast(`rails: check failed (${next.error.message ?? next.error.kind}); call allowed unchecked`, { timeoutMs: 10_000 })
    return next(e)
  })

  on('command.run', { command: 'rails' }, async ($, e) => {
    const [verb = '', id = ''] = e.args.trim().toLowerCase().split(/\s+/)
    if (verb === '' || verb === 'list' || verb === 'status') return { text: await statusText($) }
    if (!['allow', 'off', 'on'].includes(verb)) return { text: `rails: unknown "${verb}". Use /rails, /rails allow <id>, /rails off <id|all>, /rails on <id|all>.` }
    if (!USER_ORIGINS.has(e.origin.kind)) return { text: `rails: only ${(await readUser($)).name} can change rails (by typing /rails), not the model or a plugin.` }

    const ids = RULES.map(r => r.id)
    const targets = id === 'all' && verb !== 'allow' ? ids : ids.filter(x => x === id)
    if (targets.length === 0) return { text: `rails: no rule "${id}". Rules: ${ids.join(', ')}` }

    if (verb === 'allow') {
      await mutate($, s => ({ ...s, allow: [...new Set([...s.allow, id])] }))
      $.ui.toast(`rails: next ${id} call will be let through once`)
      return { text: `rails: the next call blocked by ${id} will be let through once (this session).` }
    }
    await mutate($, s => ({
      ...s,
      off: verb === 'off' ? [...new Set([...s.off, ...targets])] : s.off.filter(x => !targets.includes(x)),
    }))
    $.ui.toast(`rails: ${targets.length === ids.length ? 'all rules' : id} ${verb} for this session`)
    return { text: `rails: ${targets.join(', ')} ${verb === 'off' ? 'OFF' : 'on'} for this session.` }
  })
}
