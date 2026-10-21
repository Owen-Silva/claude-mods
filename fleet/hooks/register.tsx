// fleet: live visibility into this session's subagents, against the user's agent
// rules (~/.claude/CLAUDE.md): hand off at 32% context, never pass 40%, at
// most 5 running at once, every brief tagged [lane:<name>].
//
// Data: each subagent request's usage, live, from `turn.step` (its `agentId`
// names the loop): input + cache writes + cache reads + output, the count
// ~/.claude/tools/agent-context.js uses. Agents that started before the mod
// loaded (or whose steps fleet has not seen yet) are read from their
// transcript's tail, agent-context.js's method, by one short node process.
// Statuses come from `$.agent.list()`, briefs and models from `agent.spawn`.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { FleetAgent, FleetProbe } from '../types'
import {
  CAP,
  COLORS,
  RECENT_MS,
  applyProbe,
  bandText,
  columnsFor,
  crossings,
  ctxOf,
  elapsedText,
  fit,
  freshAgent,
  isRunning,
  laneOf,
  levelOf,
  mergeList,
  modelText,
  needsProbe,
  ordered,
  pctOf,
  pctText,
  summarize,
  withReading,
} from './core'
import type { Alert } from './core'
import {
  SHELL_TOOLS,
  TOOL_DESCRIPTION,
  TOOL_FULL_NAME,
  TOOL_NAME,
  TOOL_SCHEMA,
  WRITE_TOOLS,
  baseName,
  dueReceipts,
  finishToast,
  matches,
  newReceipt,
  receiptView,
  recordCall,
  withChecks,
  withPartialReceipts,
  writesOf,
} from './receipts'
import { PROBE_SCRIPT, parseProbe } from './probe'
import type { ProbeArgs } from './probe'

const PANE = 'fleet'
const TICK_MS = 12_000
const TOAST_MS = 10_000

const agentsA = atom({ plugin: 'fleet', key: 'agents' } as const, {})
const probeA = atom({ plugin: 'fleet', key: 'probe' } as const, { isOk: true, at: 0 })
const capA = atom({ plugin: 'fleet', key: 'capWarned' } as const, false)
const tickA = atom({ plugin: 'fleet', key: 'tick' } as const, 0)

const ACCENT = '#8a9bb0' // the one muted accent: a slate blue-grey

const noop = () => {}
const why = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 120)

/** Writes the rows through `change`, then shows the threshold toasts it found. */
async function commit($: EngineInterface, change: (cur: Record<string, FleetAgent>) => Record<string, FleetAgent>) {
  let alerts: Alert[] = []
  const after = await update($, agentsA, cur => {
    const checked = crossings(change(cur ?? {}))
    alerts = checked.alerts // reset on every try, so a retried write toasts once
    return checked.agents
  })
  for (const a of alerts) $.ui.toast(a.text, { timeoutMs: TOAST_MS })
  await checkCap($, after)
}

/** One toast when running agents first exceed the cap; re-armed once back under it. */
async function checkCap($: EngineInterface, agents: Record<string, FleetAgent>) {
  const running = summarize(agents).running
  let fire = false
  await update($, capA, was => {
    fire = false
    if (running > CAP && !was) {
      fire = true
      return true
    }
    return running > CAP
  })
  if (fire) $.ui.toast(`fleet: ${running} agents running, over the cap of ${CAP}: his PC lags. Hold new spawns.`, { timeoutMs: TOAST_MS })
}

/** Whether the file is on disk; a Git Bash `/c/...` path is also tried as `c:/...`. */
async function onDisk($: EngineInterface, path: string): Promise<boolean> {
  if (await $.fs.exists(path)) return true
  const m = /^\/([A-Za-z])\/(.*)$/.exec(path.replace(/\\/g, '/'))
  return m ? $.fs.exists(`${m[1]}:/${m[2]}`).catch(() => false) : false
}

/** Checks every recorded write of `agents` on disk: key -> exists, per agent. */
async function checkDisk($: EngineInterface, agents: readonly FleetAgent[]): Promise<Record<string, Record<string, boolean>>> {
  const out: Record<string, Record<string, boolean>> = {}
  for (const a of agents) {
    if (!a.receipt) continue
    const found: Record<string, boolean> = {}
    for (const [key, w] of Object.entries(a.receipt.writes)) found[key] = await onDisk($, w.path)
    out[a.id] = found
  }
  return out
}

/** Writes on-disk checks into the rows; marks the listed agents reported. */
async function applyChecks($: EngineInterface, checks: Record<string, Record<string, boolean>>, at: number, reported: readonly string[] = []) {
  const fresh: string[] = []
  const after = await update($, agentsA, cur => {
    fresh.length = 0 // reset on every try, so a retried write toasts once
    const out = { ...(cur ?? {}) }
    for (const [id, found] of Object.entries(checks)) {
      const a = out[id]
      if (!a?.receipt) continue
      let receipt = withChecks(a.receipt, found, at)
      if (reported.includes(id) && !receipt.isReported) {
        receipt = { ...receipt, isReported: true }
        fresh.push(id)
      }
      out[id] = { ...a, receipt }
    }
    return out
  })
  return fresh.map(id => after[id]).filter((a): a is FleetAgent => a !== undefined)
}

/** Agents whose run just ended: check what they wrote is on disk, then one toast each. */
async function settleReceipts($: EngineInterface) {
  const due = dueReceipts(await read($, agentsA))
  if (due.length === 0) return
  const checks = await checkDisk($, due)
  const done = await applyChecks($, checks, await $.clock.now(), due.map(a => a.id))
  for (const a of done) $.ui.toast(finishToast(a), { timeoutMs: TOAST_MS })
}

/** Records one subagent tool call that ran (or failed) on its receipt. */
async function recordReceipt($: EngineInterface, id: string, tool: string, input: Record<string, unknown>, isOk: boolean) {
  const now = await $.clock.now()
  await update($, agentsA, cur => {
    const a = cur?.[id] ?? freshAgent(id)
    const receipt = recordCall(a.receipt ?? newReceipt(now, false), tool, input, isOk, now)
    return { ...(cur ?? {}), [id]: { ...a, receipt } }
  })
}

/** The receipts tool's answer: each matching agent's receipt, its files checked on disk now. */
async function receiptsText($: EngineInterface, agent: unknown): Promise<string> {
  const q = typeof agent === 'string' ? agent : ''
  const now = await $.clock.now()
  const agents = await read($, agentsA)
  const first = ordered(agents, now)
  const all = [...first, ...Object.values(agents).filter(a => !first.includes(a))]
  const picked = all.filter(a => matches(a, q))
  if (picked.length === 0) {
    const known = all.map(a => a.lane).join(', ') || 'none'
    return JSON.stringify({ agents: [], note: q ? `no agent matches "${q}"; agents fleet knows: ${known}` : 'no subagents in this session yet' })
  }
  await applyChecks($, await checkDisk($, picked), now)
  const after = await read($, agentsA)
  const views = picked.map(a => receiptView(after[a.id] ?? a))
  return JSON.stringify({ checkedAt: new Date(now).toISOString(), agents: views }, null, 1)
}

let isRefreshing = false

/** Statuses from the engine, then the transcript reader for what has no reading. */
async function refresh($: EngineInterface) {
  if (isRefreshing) return
  isRefreshing = true
  try {
    const now = await $.clock.now()
    let listError: string | undefined
    try {
      const list = await $.agent.list()
      await commit($, cur => withPartialReceipts(mergeList(cur, list, now), now))
    } catch (err) {
      listError = `agent list unavailable: ${why(err)}`
    }
    await settleReceipts($).catch(err => $.ui.toast(`fleet: receipt check failed: ${why(err)}`, { timeoutMs: TOAST_MS }))

    const agents = await read($, agentsA)
    const ids = needsProbe(agents, now)
    let probe: FleetProbe = { ...(await read($, probeA)), listError }
    if (ids.length > 0) probe = { ...(await runProbe($, agents, ids, now)), listError }
    await update($, probeA, () => probe)
    if (summarize(agents).running > 0) await update($, tickA, n => (n ?? 0) + 1)
  } finally {
    isRefreshing = false
  }
}

async function runProbe($: EngineInterface, agents: Record<string, FleetAgent>, ids: string[], now: number): Promise<FleetProbe> {
  try {
    const args: ProbeArgs = {
      sid: await $.session.id(),
      ids,
      running: ids.filter(id => agents[id] && isRunning(agents[id])),
      recentMs: RECENT_MS,
    }
    const r = await $.process.run(['node', '-'], { stdin: PROBE_SCRIPT, env: { FLEET_ARGS: JSON.stringify(args) }, timeoutMs: 15_000 })
    if (r.exitCode !== 0) throw new Error(`node exited ${r.exitCode}: ${r.stderr.trim().split('\n').pop() ?? ''}`)
    const out = parseProbe(r.stdout)
    if (!out.isRootReadable) throw new Error(`cannot list ${out.root}`)
    await commit($, cur => applyProbe(cur, out.hits, now))
    return { isOk: true, at: now }
  } catch (err) {
    return { isOk: false, at: now, error: why(err) }
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'fleet',
      description: 'Subagents of this session: lane, model, elapsed, context % (32/40 rule), cap 5. /fleet close (or Esc) closes it',
      immediate: true,
    })
    try {
      await $.tool.register({ name: TOOL_NAME, description: TOOL_DESCRIPTION, inputSchema: TOOL_SCHEMA })
    } catch (err) {
      $.ui.toast(`fleet: the ${TOOL_NAME} tool could not be registered (${why(err)}); verify reports with git diff`, { timeoutMs: TOAST_MS })
    }
    $.clock.every(TICK_MS, () => void refresh($).catch(noop))
    void refresh($).catch(noop)

    return next(e)
  })

  on('command.run', { command: 'fleet' }, async ($, e) => {
    if (/^(close|x|off|hide)$/i.test(e.args.trim())) {
      await $.ui.close({ id: PANE })
      return { text: 'Fleet pane closed.' }
    }
    // Esc closes it too; the engine's x and ctrl+x x always do.
    await $.ui.open({ id: PANE, title: 'Fleet', closeOnEscape: true })
    void refresh($).catch(noop)
    const s = summarize(await read($, agentsA))

    return { text: `Fleet pane opened: ${s.running} running, ${s.over32} over 32%.` }
  })

  // Who it is: the brief's lane tag, its type, its model.
  on('agent.spawn', async ($, e, next) => {
    const r = await next(e)
    const id = r.agentId
    if (id) {
      const now = await $.clock.now()
      const lane = laneOf(e.prompt)
      await commit($, cur => ({
        ...cur,
        [id]: {
          ...(cur[id] ?? freshAgent(id)),
          // Seen from spawn: every write it makes is recorded (any already seen kept).
          receipt: { ...(cur[id]?.receipt ?? newReceipt(now, true)), isComplete: true },
          lane: lane ?? (e.description || id),
          hasLaneTag: lane !== null,
          description: e.description,
          type: e.subagentType,
          model: r.model,
          status: 'running',
          parentId: e.parentAgentId,
          startedAt: cur[id]?.startedAt ?? now,
        },
      }))
      $.clock.after(1500, () => void refresh($).catch(noop))
    }

    return r
  })

  // How full it is: every subagent request's usage, as it lands.
  on('turn.step', async function* ($, e, next) {
    const r = yield* next(e)
    const id = e.agentId
    if (id && r && r.usage) {
      const ctx = ctxOf(r.usage)
      const model = r.usage.model || e.model
      void $.clock
        .now()
        .then(now => commit($, cur => ({ ...cur, [id]: withReading(cur[id] ?? freshAgent(id), ctx, model, now, 'live') })))
        .catch(noop)
    }

    return r
  })

  // What it is doing: its last tool. What it wrote: each write that succeeded.
  // Also serves the receipts tool (matched by name here: a matcher on a tool
  // not yet registered does not type-check).
  on('tool.call', async ($, e, next) => {
    if (String(e.tool) === TOOL_FULL_NAME) return { result: await receiptsText($, (e as unknown as { agent?: unknown }).agent) }
    const id = e.agentId
    if (!id) return next(e)
    const tool = String(e.tool)
    void update($, agentsA, cur => {
      const a = cur?.[id]
      return a && a.lastTool !== tool ? { ...cur, [id]: { ...a, lastTool: tool } } : (cur ?? {})
    }).catch(noop)

    const isTracked = tool in WRITE_TOOLS || SHELL_TOOLS.has(tool)
    if (!isTracked) return next(e)
    const input = e as unknown as Record<string, unknown>
    let r: Awaited<ReturnType<typeof next>>
    try {
      r = await next(e)
    } catch (err) {
      await recordReceipt($, id, tool, input, false).catch(noop)
      throw err
    }
    const isOk = !r.deny && !r.isError
    await recordReceipt($, id, tool, input, isOk).catch(noop)
    return r
  })

  // A subagent's run ended: its status flips shortly after.
  on('turn.complete', ($, e, next) => {
    if (e.agentId) {
      $.clock.after(1000, () => void refresh($).catch(noop))
      $.clock.after(5000, () => void refresh($).catch(noop))
    }

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const agents = await read($, agentsA)
    const probe = await read($, probeA)
    const s = summarize(agents)
    const problem = !probe.isOk ? probe.error : probe.listError
    const text = bandText(s, problem)
    if (text === null || e.props.hasSurvey) return next(e)

    const { Box, Text } = $.ui.resolve(e)
    const level = s.over40 > 0 ? 'over' : s.over32 > 0 || s.running > CAP ? 'warn' : 'ok'
    const mine = (
      <Box key="fleet-band" flexDirection="row" width={e.props.bodyColumns}>
        <Text color={ACCENT}>fleet </Text>
        <Text color={level === 'ok' ? undefined : COLORS[level]} dimColor={level === 'ok'} wrap="truncate-end">
          {text}
        </Text>
      </Box>
    )
    const below = await next(e)

    return (
      <Box flexDirection="column">
        {mine}
        {below}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const agents = await read($, agentsA)
    const probe = await read($, probeA)
    await read($, tickA) // redraw on each tick, so elapsed moves
    const now = await $.clock.now()
    const s = summarize(agents)
    const rows = ordered(agents, now)
    const c = columnsFor(e.props.bodyColumns)
    const head = (label: string, n: number) => (n > 0 ? fit(label, n) : '')

    const capColor = s.running > CAP ? COLORS.warn : undefined
    const notes = rows.filter(a => a.note && a.ctx === undefined)

    /** A finished agent's receipt, one compact line under its row; a missing file in red. */
    const receiptLine = (a: FleetAgent) => {
      const r = a.receipt
      const key = `receipt-${a.id}`
      const indent = '   '
      if (!r) return (
        <Text key={key} dimColor wrap="truncate-end">
          {indent}no receipt: fleet never saw it running
        </Text>
      )
      const ws = writesOf(r)
      const shell = r.shellCommands > 0 ? ` · ${r.shellCommands} shell cmd${r.shellCommands === 1 ? '' : 's'} (best-effort)` : ''
      const partial = r.isComplete ? '' : 'partial (started before fleet loaded) · '
      if (ws.length === 0) return (
        <Box key={key} flexDirection="row">
          <Text color={r.isComplete ? COLORS.warn : undefined} dimColor={!r.isComplete} wrap="truncate-end">
            {indent}
            {partial}
            {r.isComplete ? 'wrote NO files' : 'no writes seen'}
            {r.failedEdits ? ` · ${r.failedEdits} failed edit${r.failedEdits === 1 ? '' : 's'}` : ''}
            {shell}
          </Text>
        </Box>
      )
      const shown = ws.slice(0, 6)
      return (
        <Box key={key} flexDirection="row">
          <Text dimColor>
            {indent}
            {partial}wrote {ws.length}:{' '}
          </Text>
          {shown.map((w, i) => (
            <Text key={`${key}-${i}`} color={w.exists === false ? COLORS.over : undefined} dimColor={w.exists !== false} wrap="truncate-end">
              {baseName(w.path)}
              {w.edits > 1 ? ` x${w.edits}` : ''}
              {w.exists === false ? ' MISSING' : ''}
              {i < shown.length - 1 ? ', ' : ''}
            </Text>
          ))}
          <Text dimColor wrap="truncate-end">
            {ws.length > shown.length ? ` +${ws.length - shown.length} more` : ''}
            {shell}
          </Text>
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        {/* 4 columns short of the body: the engine's close x sits at the top-right of this row. */}
        <Box key="head" flexDirection="row" width={Math.max(10, e.props.bodyColumns - 4)} overflow="hidden">
          <Text bold color={capColor}>
            {s.running} running
          </Text>
          <Text dimColor> / cap {CAP}</Text>
          <Text dimColor>
            {'  ·  '}
            {s.over32} over 32%{'  ·  '}
            {s.over40} over 40%
          </Text>
          {s.peak && (
            <Text dimColor wrap="truncate-end">
              {'  ·  '}peak {pctText(s.peak.pct)} ({s.peak.lane})
            </Text>
          )}
        </Box>
        {!probe.isOk && (
          <Box key="probe-error">
            <Text color={COLORS.over} wrap="wrap">
              Transcript readings unavailable: {probe.error}. Live per-request readings still arrive.
            </Text>
          </Box>
        )}
        {probe.listError && (
          <Box key="list-error">
            <Text color={COLORS.over} wrap="wrap">
              Statuses unavailable: {probe.listError}.
            </Text>
          </Box>
        )}
        {rows.length === 0 ? (
          <Text dimColor>No subagents in this session yet.</Text>
        ) : (
          <Box flexDirection="column" marginTop={1}>
            <Text dimColor>
              {head('lane', c.lane)}
              {head('type / model', c.model)}
              {head('state', c.state)}
              {head('elapsed', c.elapsed)}
              {head('ctx', c.ctx)}
              {head('last tool', c.tool)}
            </Text>
            {rows.flatMap(a => {
              const pct = pctOf(a)
              const level = levelOf(pct)
              const isDone = !isRunning(a)
              const lane = (a.parentId ? '↳ ' : '') + a.lane
              const who = [a.type, modelText(a.model)].filter(Boolean).join(' · ')
              const receipt = isDone ? receiptLine(a) : null
              const row = (
                <Box key={`row-${a.id}`} flexDirection="row">
                  <Text dimColor={isDone} color={isDone ? undefined : ACCENT}>
                    {fit(lane, c.lane)}
                  </Text>
                  {c.model > 0 && <Text dimColor>{fit(who, c.model)}</Text>}
                  <Text dimColor={isDone}>{fit(isDone ? a.status : 'running', c.state)}</Text>
                  <Text dimColor>{fit(elapsedText(a, now), c.elapsed)}</Text>
                  <Text color={isDone ? undefined : COLORS[level]} dimColor={isDone}>
                    {fit(pctText(pct) + (a.ctxSource === 'transcript' && !isDone ? '*' : ''), c.ctx)}
                  </Text>
                  {c.tool > 0 && <Text dimColor>{fit(a.lastTool ?? '', c.tool)}</Text>}
                </Box>
              )
              return receipt ? [row, receipt] : [row]
            })}
          </Box>
        )}
        {notes.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            {notes.map(a => (
              <Text key={`note-${a.id}`} dimColor wrap="truncate-end">
                {a.lane}: {a.note}
              </Text>
            ))}
          </Box>
        )}
        <Box marginTop={1}>
          <Text dimColor wrap="wrap">
            Hand off at 32%, never past 40%. * = read from the transcript tail; the rest are live. Finished agents stay {RECENT_MS / 60000} min, each with its receipt: files its successful edits wrote, MISSING if gone from disk.
          </Text>
        </Box>
      </Box>
    )
  })
}
