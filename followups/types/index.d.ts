// Session state of the followups mod (`$.state`, owner `followups`).

/** How an item closed. */
export type ClosedBy =
  /** The matching command ran and succeeded (or the matching file was edited). */
  | 'command'
  /** The model called the Followups tool with evidence. */
  | 'model'
  /** The user typed /followups done or /followups clear. */
  | 'user'
  /** The old key for 'user', written before the name became a setting: read the same way, never written. */
  | 'owen'

export type Followup = {
  /** Short session-unique number, what /followups done <id> and the tool take. */
  id: number
  /** The rule that opened it. */
  rule: string
  /** Items with the same key merge: one per rule and project (repo root). */
  key: string
  /** What is owed, short, for the band ("regen search-index.json"). */
  label: string
  /** How to satisfy it: the exact command or edit, for the model. */
  how: string
  /** What opened it: file basenames or commands, newest last, capped. */
  triggers: string[]
  /** Steps that must all be seen before the item closes by itself (`['done']`, or `['393', '320']`). */
  needs: string[]
  /** Steps seen so far, each with what showed it. */
  progress: { step: string; evidence: string }[]
  openedAt: number
  isOpen: boolean
  closedBy?: ClosedBy
  /** What closed it: the command that ran, or the model's / the user's words. */
  evidence?: string
  closedAt?: number
  /** The one end-of-turn nudge this item gets has been spent. */
  isNudged: boolean
  /** The model said why it is leaving this open (tool `leave_open`, or its reply to the nudge); never nudged again. */
  leftOpen?: string
}

export type FollowupsSession = {
  nextId: number
  items: Followup[]
}

declare module 'claude-code' {
  interface PluginState {
    followups: { session: FollowupsSession }
  }
}
