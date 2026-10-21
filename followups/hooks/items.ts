// The checklist itself, as pure functions over the session value: open (or
// merge into) an item, close items, choose what the end-of-turn nudge may
// mention, and the band and list text. No `$` here, so tests read it plainly.

import type { ClosedBy, Followup, FollowupsSession } from '../types'
import { capital, DEFAULT_NAME, possessive } from './user'

export const EMPTY: FollowupsSession = { nextId: 1, items: [] }

/** Closed items kept for /followups; older ones drop off. */
const KEEP_CLOSED = 30
/** Triggers remembered per item. */
const KEEP_TRIGGERS = 6

/** What a rule hands over when a call creates an obligation. */
export type Hit = {
  rule: string
  key: string
  label: string
  how: string
  trigger: string
  /** Steps the item needs before it closes by itself; default `['done']`. A merge keeps the union. */
  needs?: string[]
}

/** What a call contributed toward closing an item: the steps it showed, and how. */
export type Progress = { steps: string[]; evidence: string }

export function clip(text: string, n = 90): string {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length > n ? `${one.slice(0, n - 1)}…` : one
}

export const openItems = (s: FollowupsSession): Followup[] => s.items.filter(i => i.isOpen)

/**
 * Opens an item for the hit, or adds the trigger to the open item with the
 * same key. `opened` is the new item, undefined when it merged.
 */
export function openItem(s: FollowupsSession, hit: Hit, now: number): { next: FollowupsSession; opened: Followup | undefined } {
  const needs = hit.needs ?? ['done']
  const same = s.items.find(i => i.isOpen && i.key === hit.key)
  if (same !== undefined) {
    const triggers = [...same.triggers.filter(t => t !== hit.trigger), hit.trigger].slice(-KEEP_TRIGGERS)
    const isWider = needs.some(n => !same.needs.includes(n))
    // `how` follows the latest hit (it names what is missing now); the label widens with the steps.
    const isNarrower = same.needs.some(n => !needs.includes(n))
    const merged: Followup = isWider
      ? { ...same, triggers, needs: [...new Set([...same.needs, ...needs])], label: hit.label, how: hit.how }
      : isNarrower
        ? { ...same, triggers }
        : { ...same, triggers, how: hit.how }
    return { next: { ...s, items: s.items.map(i => (i === same ? merged : i)) }, opened: undefined }
  }
  const item: Followup = {
    id: s.nextId,
    rule: hit.rule,
    key: hit.key,
    label: hit.label,
    how: hit.how,
    triggers: [hit.trigger],
    needs,
    progress: [],
    openedAt: now,
    isOpen: true,
    isNudged: false,
  }
  return { next: prune({ nextId: s.nextId + 1, items: [...s.items, item] }), opened: item }
}

/**
 * Records steps a call showed for one open item; closes it (by `command`)
 * once every needed step is in. `closed` is the item when this closed it.
 */
export function addProgress(s: FollowupsSession, id: number, p: Progress, now: number): { next: FollowupsSession; closed: Followup | undefined } {
  const item = s.items.find(i => i.id === id && i.isOpen)
  if (item === undefined || p.steps.length === 0) return { next: s, closed: undefined }
  const fresh = p.steps.filter(st => item.needs.includes(st) && !item.progress.some(x => x.step === st))
  if (fresh.length === 0) return { next: s, closed: undefined }
  const progress = [...item.progress, ...fresh.map(step => ({ step, evidence: clip(p.evidence, 160) }))]
  const isDone = item.needs.every(n => progress.some(x => x.step === n))
  const evidence = [...new Set(progress.map(x => x.evidence))].join(' + ')
  const updated: Followup = isDone
    ? { ...item, progress, isOpen: false, closedBy: 'command', evidence: clip(evidence, 300), closedAt: now }
    : { ...item, progress }
  return { next: prune({ ...s, items: s.items.map(i => (i === item ? updated : i)) }), closed: isDone ? updated : undefined }
}

/** Closes every open item `pick` accepts. */
export function closeItems(
  s: FollowupsSession,
  pick: (i: Followup) => boolean,
  by: ClosedBy,
  evidence: string,
  now: number,
): { next: FollowupsSession; closed: Followup[] } {
  const closed: Followup[] = []
  const items = s.items.map(i => {
    if (!i.isOpen || !pick(i)) return i
    const done: Followup = { ...i, isOpen: false, closedBy: by, evidence: clip(evidence, 300), closedAt: now }
    closed.push(done)
    return done
  })
  return { next: prune({ ...s, items }), closed }
}

function prune(s: FollowupsSession): FollowupsSession {
  const closed = s.items.filter(i => !i.isOpen)
  if (closed.length <= KEEP_CLOSED) return s
  const drop = new Set(closed.slice(0, closed.length - KEEP_CLOSED))
  return { ...s, items: s.items.filter(i => !drop.has(i)) }
}

/** Open items the end-of-turn nudge may still mention: each gets one nudge, ever. */
export const nudgeable = (s: FollowupsSession): Followup[] =>
  openItems(s).filter(i => !i.isNudged && i.leftOpen === undefined)

export function markNudged(s: FollowupsSession, ids: readonly number[]): FollowupsSession {
  return { ...s, items: s.items.map(i => (ids.includes(i.id) ? { ...i, isNudged: true } : i)) }
}

/** Items nudged and still open when the model stops again: its reply is its reason. */
export function markLeftOpen(s: FollowupsSession, reply: string): { next: FollowupsSession; marked: Followup[] } {
  const marked: Followup[] = []
  const reason = clip(reply === '' ? '(no reply text)' : reply, 200)
  const items = s.items.map(i => {
    if (!i.isOpen || !i.isNudged || i.leftOpen !== undefined) return i
    const m = { ...i, leftOpen: `stopped after the nudge: ${reason}` }
    marked.push(m)
    return m
  })
  return { next: { ...s, items }, marked }
}

function triggerNote(i: Followup): string {
  const last = i.triggers[i.triggers.length - 1] ?? ''
  const more = i.triggers.length > 1 ? ` +${i.triggers.length - 1}` : ''
  return `${clip(last, 40)}${more}`
}

/** The band's one line, or undefined when nothing is open. */
export function bandLine(s: FollowupsSession): string | undefined {
  const open = openItems(s)
  if (open.length === 0) return undefined
  const parts = open.map(i => {
    const steps = i.needs.length > 1 ? ` ${i.progress.length}/${i.needs.length}` : ''
    return `#${i.id} ${i.label}${steps} (${triggerNote(i)})${i.leftOpen === undefined ? '' : ' [left open]'}`
  })
  return `${open.length} follow-up${open.length === 1 ? '' : 's'}: ${parts.join(' · ')}`
}

/**
 * Who closed an item, as /followups lists it: the user's own close shows their name (the
 * name setting). 'owen' is the old stored key for 'user' and still reads the same way.
 */
function byLabel(by: ClosedBy | undefined, name: string): string {
  if (by === 'command') return 'ran'
  if (by === 'model') return 'model said'
  return capital(name)
}

function itemLine(i: Followup, name: string): string {
  const head = `  #${String(i.id).padEnd(3)} ${i.label}`
  const from = `      from: ${i.triggers.join(', ')}`
  if (i.isOpen) {
    const lines = [head, `      do:   ${i.how}`, from]
    if (i.needs.length > 1) {
      const seen = i.needs.map(n => `${n} ${i.progress.some(x => x.step === n) ? 'seen' : 'missing'}`)
      lines.push(`      steps: ${seen.join(', ')}`)
    }
    if (i.leftOpen !== undefined) lines.push(`      left open: ${i.leftOpen}`)
    return lines.join('\n')
  }
  return [head, `      ${byLabel(i.closedBy, name)}: ${i.evidence ?? ''}`, from].join('\n')
}

export function listText(s: FollowupsSession, rules: readonly { id: string; summary: string }[], name: string = DEFAULT_NAME): string {
  const open = openItems(s)
  const closed = s.items.filter(i => !i.isOpen).slice(-10)
  const lines = [`followups: ${open.length} open, ${closed.length} closed this session`, '']
  if (open.length > 0) lines.push('Open', ...open.map(i => itemLine(i, name)), '')
  if (closed.length > 0) lines.push('Closed (latest 10)', ...closed.map(i => itemLine(i, name)), '')
  lines.push('Rules', ...rules.map(r => `  ${r.id.padEnd(18)} ${r.summary}`), '')
  lines.push('/followups done <id>   close one        /followups clear   close all open')
  return lines.join('\n')
}

/** The Followups tool's list answer for the model. */
export function toolList(s: FollowupsSession): string {
  const open = openItems(s)
  if (open.length === 0) return 'No open follow-ups.'
  return [
    `${open.length} open follow-up${open.length === 1 ? '' : 's'}:`,
    ...open.map(
      i =>
        `#${i.id} ${i.label}\n  do: ${i.how}\n  opened by: ${i.triggers.join(', ')}${i.leftOpen === undefined ? '' : `\n  left open: ${i.leftOpen}`}`,
    ),
  ].join('\n')
}

/** The block reason the Stop nudge hands the model: every item it names gets this one nudge only. */
export function nudgeText(items: readonly Followup[], name: string = DEFAULT_NAME): string {
  return [
    `[followups] ${items.length} follow-up${items.length === 1 ? ' is' : 's are'} still open from this session's edits or commands (${possessive(name)} "after X, always do Y" rules):`,
    ...items.map(i => `- #${i.id} ${i.label}: ${i.how} (opened by ${i.triggers.join(', ')})`),
    '',
    `Do each one now if it applies. If one is already done, call the Followups tool with action "done", the id and evidence (the command you ran and what it printed). If one should wait or does not apply, call it with action "leave_open", the id and a one-line reason. This is the only reminder for these items; they stay on ${possessive(name)} band until closed.`,
  ].join('\n')
}
