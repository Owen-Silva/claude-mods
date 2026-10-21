/**
 * One rate-limit window as pace keeps it: how much is used (0 to 100) and
 * when the window resets, in epoch milliseconds.
 */
export type PaceWindow = { percentUsed: number; resetsAt: number }

/**
 * A rate-limit reading and where it came from. `observedAt` is when the
 * figures were reported (epoch ms), so its age can be shown.
 */
export type PaceReading = {
  fiveHour: PaceWindow | null
  sevenDay: PaceWindow | null
  observedAt: number
  source: 'session' | 'statusline-file'
  sourceDetail: string
}

/**
 * What the band, /pace and the prompt section are drawn from: the time it
 * was taken, the reading (null with `reason` saying why), and the session's
 * cost as Claude Code's own ledger totals it (null when it has none).
 */
export type PaceSnapshot = {
  now: number
  reading: PaceReading | null
  reason: string | null
  costUsd: number | null
  /** When the one-time free reset was detected as pressed (null or absent: unused). */
  freeResetUsedAt?: number | null
}

declare module 'claude-code' {
  interface PluginState {
    pace: { snapshot: PaceSnapshot | null }
  }
}
