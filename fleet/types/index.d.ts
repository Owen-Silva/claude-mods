// fleet's contract: the values it keeps in $.state (no noun is added to $).

/** One subagent of this session as fleet tracks it. */
export type FleetAgent = {
  /** The agent id `$.agent.list()` and the agent's `tool.call`s carry. */
  id: string
  /** The `[lane:<name>]` tag of its brief, else its description. */
  lane: string
  /** True when `lane` came from a `[lane:...]` tag. */
  hasLaneTag: boolean
  description: string
  /** Its agent type (`opus-high`, `Explore`, ...). */
  type: string
  /** The model it runs on, when known. */
  model?: string
  /** `running`, `completed`, `failed`, `killed`, ... (the engine's task status). */
  status: string
  parentId?: string
  /** Epoch ms it started, when known. */
  startedAt?: number
  /** Epoch ms it was first seen not running. */
  endedAt?: number
  /** Tokens of the last request's context (input + cache + output). */
  ctx?: number
  /** The largest request seen, for the window guess. */
  maxCtx?: number
  /** Its context window in tokens. */
  window?: number
  /** Epoch ms of the reading. */
  ctxAt?: number
  /** Where the reading came from: a live `turn.step` or its transcript tail. */
  ctxSource?: 'live' | 'transcript'
  /** The last tool it called, when seen. */
  lastTool?: string
  /** Highest threshold already toasted: 0, 32 or 40. */
  warned: number
  /** True once its transcript was read (brief, start time, seed reading). */
  isProbed?: boolean
  /** Epoch ms of the last transcript read. */
  probedAt?: number
  /** Why its transcript gave no reading, when it did not. */
  note?: string
  /**
   * The files it actually wrote, from its own tool calls that succeeded.
   * Absent on an agent fleet only ever saw already finished.
   */
  receipt?: FleetReceipt
}

/** One file a subagent wrote, as its successful tool calls show it. */
export type FleetWrite = {
  /** The path as the agent named it. */
  path: string
  /** Successful writes: Edit / Write / NotebookEdit calls plus parsed shell writes. */
  edits: number
  /** `tool`: Edit / Write / NotebookEdit; `shell`: parsed from a Bash / PowerShell command; `both`. */
  via: 'tool' | 'shell' | 'both'
  /** Epoch ms of its last write. */
  lastAt: number
  /** Whether it was on disk at the last check; absent before any check. */
  exists?: boolean
}

/** A subagent's ground-truth record of what it wrote. */
export type FleetReceipt = {
  /**
   * True when fleet saw the agent spawn, so every write is recorded. False
   * when it started before fleet loaded: only writes since `since`.
   */
  isComplete: boolean
  /** Epoch ms recording began. */
  since: number
  /** Keyed by the normalized path (slashes forward, a drive path lowercased). */
  writes: Record<string, FleetWrite>
  /** Edit / Write / NotebookEdit calls that were denied or errored: not recorded as writes. */
  failedEdits: number
  /** Bash / PowerShell calls that ran; their writes are parsed best-effort only. */
  shellCommands: number
  /** True once the finish toast went out; cleared if the agent is resumed. */
  isReported: boolean
  /** Epoch ms of the last on-disk check. */
  checkedAt?: number
}

/** How the transcript reader fared on its last run. */
export type FleetProbe = {
  isOk: boolean
  /** Epoch ms of the last run; 0 before any. */
  at: number
  /** Why it failed, shown in the pane and band. */
  error?: string
  /** Why `$.agent.list()` failed, when it did. */
  listError?: string
}

declare module 'claude-code' {
  interface PluginState {
    fleet: {
      agents: Record<string, FleetAgent>
      probe: FleetProbe
      capWarned: boolean
      tick: number
    }
  }
}
