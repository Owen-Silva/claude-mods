// What the mods call the person at the keyboard, in text the model reads and the person sees
// ("The user can let one call through with /rails allow <id>."). It is a machine-local
// setting: user.local.json in the mods checkout, beside the mod folders (gitignored, like
// every *.local.* file; a fresh clone copies user.example.json). When that file is missing
// or not valid, the mods use the public default, "the user": never an error, never a mod
// that stops working. rails says why at session start and at the top of /rails.
//
// The same file sits in each mod that names the person, so every mod stays self-contained.

import type { EngineInterface } from 'claude-code'

/** The public default: what the mods say when no name is set. */
export const DEFAULT_NAME = 'the user'
/** The setting's file name, in the folder that holds the mod folders. */
export const USER_FILE = 'user.local.json'
/** The tracked template a fresh clone copies to USER_FILE. */
export const USER_EXAMPLE = 'user.example.json'

const MAX_LEN = 40

export type UserSetting = {
  /** The name as written mid-sentence: the file's ("Alex"), or DEFAULT_NAME. */
  name: string
  /** Why DEFAULT_NAME is in use; absent when the file supplied the name. */
  problem?: 'missing' | 'invalid' | 'unreadable'
  /** What was wrong, for the warning ("not valid JSON"). */
  detail?: string
}

/** USER_FILE's path: the folder above this mod's own folder. */
export function userFile(pluginRoot: string): string {
  const root = pluginRoot.replace(/[\\/]+$/, '')
  const cut = Math.max(root.lastIndexOf('/'), root.lastIndexOf('\\'))
  return `${cut <= 0 ? root : root.slice(0, cut)}/${USER_FILE}`
}

/** The name in USER_FILE's text, or what is wrong with it. */
export function parseUser(text: string): { name: string } | { error: string } {
  let raw: unknown
  try {
    raw = JSON.parse(text.replace(/^﻿/, ''))
  } catch {
    return { error: 'not valid JSON' }
  }
  const name = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as { name?: unknown }).name : undefined
  if (typeof name !== 'string') return { error: 'no "name" string in it' }
  const t = name.trim()
  if (t === '') return { error: '"name" is empty' }
  if (t.length > MAX_LEN) return { error: `"name" is longer than ${MAX_LEN} characters` }
  if (/[\u0000-\u001f\u007f]/.test(t)) return { error: '"name" has a control character in it' }
  return { name: t }
}

function errText(err: unknown): string {
  if (err instanceof Error) return err.message
  const m = (err as { message?: unknown } | null)?.message
  return typeof m === 'string' ? m : String(err)
}

/**
 * The name to use, read fresh from USER_FILE. Never throws: a guard must not fail open
 * because a setting could not be read, so every failure is DEFAULT_NAME plus the reason.
 */
export async function readUser($: EngineInterface): Promise<UserSetting> {
  try {
    let text: string
    try {
      text = String(await $.fs.read(userFile($.plugin.root)))
    } catch (err) {
      const why = errText(err)
      // Missing or unreadable: the disk's own word first, then the error's.
      let isMissing: boolean
      try {
        isMissing = !(await $.fs.exists(userFile($.plugin.root)))
      } catch {
        const code = (err as { code?: unknown } | null)?.code
        isMissing = code === 'ENOENT' || /ENOENT|no such file|not found|does not exist|cannot find/i.test(why)
      }
      return { name: DEFAULT_NAME, problem: isMissing ? 'missing' : 'unreadable', detail: why }
    }
    const parsed = parseUser(text)
    return 'name' in parsed ? { name: parsed.name } : { name: DEFAULT_NAME, problem: 'invalid', detail: parsed.error }
  } catch (err) {
    return { name: DEFAULT_NAME, problem: 'unreadable', detail: errText(err) }
  }
}

/** The name at the start of a sentence: "The user", "Alex". */
export function capital(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1)
}

/** "the user's", "Alex's". */
export function possessive(name: string): string {
  return `${name}'s`
}

/** One line on why the default name is in use, led by the mod's name; undefined when the file supplied it. */
export function userWarning(mod: string, u: UserSetting): string | undefined {
  if (u.problem === undefined) return undefined
  const fix = `Copy ${USER_EXAMPLE} to ${USER_FILE} beside the mod folders and put your name in it.`
  if (u.problem === 'missing') return `${mod}: ${USER_FILE} is missing, so the mods call you "${DEFAULT_NAME}". ${fix}`
  const what = u.problem === 'invalid' ? `is not valid (${u.detail ?? 'unknown'})` : `could not be read (${u.detail ?? 'unknown'})`
  return `${mod}: ${USER_FILE} ${what}, so the mods call you "${DEFAULT_NAME}" until it is fixed. It should read {"name": "Your name"}.`
}
