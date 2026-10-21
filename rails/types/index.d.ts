// Session state of the rails mod (`$.state`, owner `rails`).

/** The user's latest own prompt (typed, from the bridge or the SDK host), not a slash command. */
export type RailsPrompt = { text: string; at: number }

/** The project a session works, by the name session-separation's rules give it. */
export type RailsProject = string

/** What pinned the session to a project: its first write to one. */
export type RailsPin = { project: RailsProject; by: string; at: number }

export type RailsSession = {
  prompt: RailsPrompt | null
  /** Rule ids switched off for this session (/rails off). */
  off: string[]
  /** Rule ids with a one-shot bypass waiting (/rails allow). */
  allow: string[]
  /** Denies this session, by rule id. */
  denies: { [rule: string]: number }
  /** The project this session is pinned to; null until its first write; absent in state stored before session-separation. */
  pin?: RailsPin | null
}

declare module 'claude-code' {
  interface PluginState {
    rails: { session: RailsSession }
  }
}
