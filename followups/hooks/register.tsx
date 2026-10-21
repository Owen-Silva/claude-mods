// followups: a live checklist of the user's "after X, always do Y" rules.
// A successful edit or command that triggers a rule opens an item; the band
// above the prompt shows open items; the matching command (or edit) closes
// it; the end of a turn nudges the model once per item, never twice.

import type { EngineInterface, Register } from 'claude-code'

import type { FollowupsSession } from '../types'
import { addProgress, bandLine, clip, closeItems, EMPTY, listText, markLeftOpen, markNudged, nudgeable, nudgeText, openItem, openItems, toolList } from './items'
import { callOf, setHome } from './rules'
import type { Call, Ctx } from './rules'
// The active rules and the description's examples: personal, untracked (a fresh clone copies rules.example.ts).
// When hooks/rules.local.ts is missing this resolves to the tracked fallback, hooks/rules.local/index.ts.
import { LOCAL_MISSING, RULES, TOOL_EXAMPLES } from './rules.local'
import { normPath } from './shell'
import { capital, possessive, readUser } from './user'

const SESSION = { plugin: 'followups', key: 'session' } as const

/** Prompt origins that are the user themself: typed, from their phone, or the SDK host they drive. */
const USER_ORIGINS = new Set(['composer', 'bridge', 'sdk'])

const TOOL_NAME = 'Followups'
const TOOL_FULL = 'mcp__followups__Followups'

const WATCHED = new Set(['Edit', 'Write', 'NotebookEdit', 'Bash', 'PowerShell'])

// Static for the session: registered once at its start, so the tool list caches.
// `name` is the name setting (hooks/user.ts).
function toolDescription(name: string): string {
  return [
    `${capital(possessive(name))} follow-up checklist: obligations that memory rules attach to edits and commands`,
    TOOL_EXAMPLES,
    'Items open by themselves when a matching edit or command succeeds and close by themselves when the matching command runs.',
    'action "list": the open items with what to do. action "done": close one you have satisfied another way;',
    `give \`id\` and \`evidence\` (the command you ran and what it showed); ${capital(name)} sees the evidence.`,
    `action "leave_open": keep one open on purpose (it waits for ${name}, or does not apply); give \`id\` and a one-line \`reason\`.`,
  ].join(' ')
}

const TOOL_SCHEMA = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['list', 'done', 'leave_open'] },
    id: { type: 'number', description: 'The item number (#3 is 3). Required for done and leave_open.' },
    evidence: { type: 'string', description: 'done: what you ran and what it showed.' },
    reason: { type: 'string', description: 'leave_open: why it stays open.' },
  },
  required: ['action'],
}

async function load($: EngineInterface): Promise<FollowupsSession> {
  const { value } = await $.state.get(SESSION)
  return value ?? EMPTY
}

/** Read-modify-write with the version check, retried on a race. */
async function mutate<T>($: EngineInterface, fn: (s: FollowupsSession) => { next: FollowupsSession; out: T }): Promise<T> {
  for (let tries = 0; tries < 10; tries++) {
    const { value, version } = await $.state.get(SESSION)
    const { next, out } = fn(value ?? EMPTY)
    if (next === (value ?? EMPTY)) return out
    const { isSet } = await $.state.set(SESSION, next, { ifVersion: version })
    if (isSet) return out
  }
  throw new Error('followups state kept changing under a write')
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

const LOCAL_FILE = 'hooks/rules.local.ts'

/**
 * A loud line when followups runs the EXAMPLE rules because hooks/rules.local.ts was missing
 * at load, or when the file on disk disagrees with what loaded; undefined when all is well.
 */
async function localWarning($: EngineInterface): Promise<string | undefined> {
  let exists: boolean | undefined
  try {
    exists = await $.fs.exists(`${$.plugin.root}/${LOCAL_FILE}`)
  } catch {
    exists = undefined
  }
  if (LOCAL_MISSING && exists !== true) {
    return `followups: ${LOCAL_FILE} is missing, so followups is running the EXAMPLE rules. Copy hooks/rules.example.ts to ${LOCAL_FILE}.`
  }
  if (LOCAL_MISSING) return `followups: ${LOCAL_FILE} is there now, but followups loaded without it and is running the EXAMPLE rules. Restart Claude Code to load it.`
  if (exists === false) {
    return `followups: ${LOCAL_FILE} is missing, so the next start runs the EXAMPLE rules (these rules loaded before it went). Copy hooks/rules.example.ts to ${LOCAL_FILE}.`
  }
  return undefined
}

/** What `~` and the home variables in a call expand to: read before every call is, so none is read without it. */
async function readHome($: EngineInterface): Promise<void> {
  let raw: string | undefined
  try {
    raw = await $.env.get('USERPROFILE')
    if (raw === undefined || raw === '') raw = await $.env.get('HOME')
  } catch {
    raw = undefined
  }
  setHome(raw)
}

/** What the rules may reach: git, node, files, the clock, a toast, and which keys are open right now. */
function context($: EngineInterface, cwd: string, view: { s: FollowupsSession }): Ctx {
  return {
    cwd,
    git: async (dir, args) => {
      try {
        const run = await $.process.run(['git', '-C', dir, ...args], { timeoutMs: 4000 })
        return run.exitCode === 0 ? run.stdout.trim() : undefined
      } catch {
        return undefined
      }
    },
    run: async argv => {
      const r = await $.process.run(argv, { timeoutMs: 15_000 })
      return { exitCode: r.exitCode ?? -1, stdout: r.stdout, stderr: r.stderr }
    },
    read: path => $.fs.read(path),
    list: async path => (await $.fs.list(path)).map(f => ({ name: f.name, isDir: f.kind === 'dir' })),
    now: () => $.clock.now(),
    warn: text => $.ui.toast(text, { timeoutMs: 10_000 }),
    hasOpen: key => view.s.items.some(i => i.isOpen && i.key === key),
  }
}

/** What the model read back from a shell call: stdout, stderr and the joined text. */
function outputOf(r: { text?: string; result?: unknown }): string {
  const res = (r.result ?? {}) as { stdout?: unknown; stderr?: unknown }
  return [res.stdout, res.stderr, r.text].filter((x): x is string => typeof x === 'string').join('\n')
}

/** Runs every rule over one successful call: progress on open items first, then new items. Returns notes for the model. */
async function apply($: EngineInterface, call: Call, cwd: string): Promise<string[]> {
  const notes: string[] = []
  const now = await $.clock.now()
  const view = { s: await load($) }
  const ctx = context($, cwd, view)

  for (const rule of RULES) {
    if (rule.progress === undefined) continue
    const open = openItems(await load($)).filter(i => i.rule === rule.id)
    for (const item of open) {
      let p
      try {
        p = await rule.progress(call, item, ctx)
      } catch (err) {
        $.ui.toast(`followups: rule ${rule.id} clear check failed (${clip(errText(err), 80)})`, { timeoutMs: 10_000 })
        continue
      }
      if (p === undefined) continue
      const closed = await mutate($, s => {
        const r = addProgress(s, item.id, p, now)
        return { next: r.next, out: r.closed }
      })
      if (closed !== undefined) $.ui.toast(`followups: #${closed.id} ${closed.label} closed (${clip(closed.evidence ?? '', 70)})`)
    }
  }

  for (const rule of RULES) {
    if (rule.open === undefined) continue
    view.s = await load($)
    let hits
    try {
      hits = await rule.open(call, ctx)
    } catch (err) {
      $.ui.toast(`followups: rule ${rule.id} check failed (${clip(errText(err), 80)})`, { timeoutMs: 10_000 })
      continue
    }
    for (const hit of hits) {
      const opened = await mutate($, s => {
        const r = openItem(s, hit, now)
        return { next: r.next, out: r.opened }
      })
      if (opened !== undefined) {
        notes.push(`[followups] Opened #${opened.id} "${opened.label}" (from ${opened.triggers[0] ?? ''}): ${opened.how}`)
      }
    }
  }
  return notes
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const r = await next(e)
    try {
      await $.command.register({
        name: 'followups',
        description: 'Follow-up checklist: open and closed items; done <id> or clear',
        argumentHint: '[done <id>|clear]',
        immediate: true,
      })
    } catch (err) {
      $.ui.toast(`followups: /followups could not be registered (${errText(err)})`, { timeoutMs: 10_000 })
    }
    try {
      await $.tool.register({ name: TOOL_NAME, description: toolDescription((await readUser($)).name), inputSchema: TOOL_SCHEMA })
    } catch (err) {
      $.ui.toast(`followups: the Followups tool could not be registered (${errText(err)})`, { timeoutMs: 10_000 })
    }
    const warning = await localWarning($)
    if (warning !== undefined) $.ui.toast(warning, { timeoutMs: 60_000 })
    return r
  })

  // Only a call that SUCCEEDED opens or closes anything.
  on('tool.call', async ($, e, next) => {
    if (!WATCHED.has(e.tool)) return next(e)
    const r = await next(e)
    if (r.deny !== undefined || r.isError === true) return r
    const result = r.result as { interrupted?: boolean; backgroundTaskId?: string } | undefined
    if (result?.interrupted === true || result?.backgroundTaskId !== undefined) return r

    try {
      const cwd = normPath(await $.session.cwd())
      await readHome($)
      const call = callOf(e as unknown as { tool: string; [k: string]: unknown }, cwd, outputOf(r))
      if (call === undefined) return r
      const notes = await apply($, call, cwd)
      if (notes.length === 0) return r
      return { ...r, context: [...(r.context ?? []), notes.join('\n')] }
    } catch (err) {
      $.ui.toast(`followups: check failed (${clip(errText(err), 80)}); this call was not tracked`, { timeoutMs: 10_000 })
      return r
    }
  })

  // The model's own tool: list, close with evidence, or leave open with a reason.
  on('tool.call', { tool: TOOL_FULL }, async ($, e) => {
    const input = e as unknown as { action?: string; id?: number; evidence?: string; reason?: string }
    const action = input.action ?? 'list'
    if (action === 'list') return { result: toolList(await load($)) }

    const id = Number(input.id)
    const s = await load($)
    const item = s.items.find(i => i.id === id)
    if (item === undefined || !item.isOpen) {
      return { result: `No open follow-up #${input.id ?? '?'}. ${toolList(s)}` }
    }
    const now = await $.clock.now()
    if (action === 'done') {
      const evidence = (input.evidence ?? '').trim()
      if (evidence.length < 8) return { result: `Not closed: "done" needs evidence (what you ran and what it showed) for #${id} ${item.label}.` }
      await mutate($, cur => ({ next: closeItems(cur, i => i.id === id, 'model', evidence, now).next, out: null }))
      $.ui.toast(`followups: model closed #${id} ${item.label}: "${clip(evidence, 90)}"`, { timeoutMs: 10_000 })
      return { result: `Closed #${id} ${item.label}. ${capital((await readUser($)).name)} sees your evidence.` }
    }
    if (action === 'leave_open') {
      const reason = (input.reason ?? '').trim()
      if (reason.length < 4) return { result: `Not changed: "leave_open" needs a one-line reason for #${id} ${item.label}.` }
      await mutate($, cur => ({
        next: { ...cur, items: cur.items.map(i => (i.id === id ? { ...i, leftOpen: clip(reason, 200) } : i)) },
        out: null,
      }))
      $.ui.toast(`followups: model left #${id} ${item.label} open: "${clip(reason, 90)}"`, { timeoutMs: 10_000 })
      return { result: `#${id} stays open on ${possessive((await readUser($)).name)} band; you will not be reminded of it again.` }
    }
    return { result: `Unknown action "${action}". Use list, done or leave_open.` }
  })

  // End of the main turn: one nudge per item, ever. Loop-proof:
  //  - a Stop raised by a Stop-hook continuation (stop_hook_active) never blocks;
  //    the items the nudge named and the model left open get its reply as their reason;
  //  - an item is nudged once in its life (isNudged), and never once left open;
  //  - nothing is spent while agents still run in the background.
  on('classic.Stop', async ($, e, next) => {
    const r = await next(e)
    if (r.block !== undefined || r.preventContinuation === true) return r
    try {
      if (e.stop_hook_active) {
        const marked = await mutate($, s => {
          const m = markLeftOpen(s, e.last_assistant_message ?? '')
          return { next: m.next, out: m.marked }
        })
        if (marked.length > 0) $.ui.toast(`followups: model stopped with ${marked.map(i => `#${i.id}`).join(', ')} still open`, { timeoutMs: 10_000 })
        return r
      }
      const agentsRunning = (e.background_tasks ?? []).some(t => /agent|workflow|teammate/i.test(t.type))
      if (agentsRunning) return r
      const due = nudgeable(await load($))
      if (due.length === 0) return r
      await mutate($, s => ({ next: markNudged(s, due.map(i => i.id)), out: null }))
      return { ...r, block: nudgeText(due, (await readUser($)).name) }
    } catch (err) {
      $.ui.toast(`followups: end-of-turn check failed (${clip(errText(err), 80)})`, { timeoutMs: 10_000 })
      return r
    }
  })

  on('command.run', { command: 'followups' }, async ($, e) => {
    const [verb = '', arg = ''] = e.args.trim().toLowerCase().split(/\s+/)
    if (verb === '' || verb === 'list') {
      const warning = await localWarning($)
      const list = listText(await load($), RULES, (await readUser($)).name)
      return { text: warning === undefined ? list : `${warning}\n\n${list}` }
    }
    if (verb !== 'done' && verb !== 'clear') return { text: `followups: unknown "${verb}". Use /followups, /followups done <id>, /followups clear.` }
    if (!USER_ORIGINS.has(e.origin.kind)) return { text: `followups: only ${(await readUser($)).name} closes items by command; the model uses the Followups tool with evidence.` }
    const now = await $.clock.now()
    if (verb === 'clear') {
      const closed = await mutate($, s => {
        const c = closeItems(s, () => true, 'user', 'cleared with /followups clear', now)
        return { next: c.next, out: c.closed }
      })
      return { text: `followups: closed ${closed.length} open item${closed.length === 1 ? '' : 's'}.` }
    }
    const id = Number(arg.replace(/^#/, ''))
    const closed = await mutate($, s => {
      const c = closeItems(s, i => i.id === id, 'user', 'closed with /followups done', now)
      return { next: c.next, out: c.closed }
    })
    if (closed.length === 0) return { text: `followups: no open item #${arg}. ${openItems(await load($)).map(i => `#${i.id}`).join(' ') || 'Nothing is open.'}` }
    return { text: `followups: closed #${id} ${closed[0]?.label ?? ''}.` }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    if (e.props.hasSurvey) return below
    const line = bandLine(await load($))
    if (line === undefined) return below
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        {below}
        <Box key="followups" flexDirection="row">
          <Text dimColor wrap="truncate-end">
            {line}
          </Text>
        </Box>
      </Box>
    )
  })
}
