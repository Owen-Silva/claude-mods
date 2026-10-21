// Just enough of bash and PowerShell to tell code from data (quotes,
// heredocs, here-strings, comments) and to split a command line into the
// simple commands it runs. Rails reads commands with this, never with a
// regex over the raw text, so a commit message or an echo that merely
// mentions `git push` is data and never trips a rule.

export type Shell = 'bash' | 'ps'

/** One simple command: its words with quoting removed, and what ended it. */
export type Segment = {
  words: string[]
  /** The command as written. */
  raw: string
  /** The operator that ended it ('|', '&&', ';', '\n', '(', '{', ...), '' at the end. */
  sep: string
}

export type Lexed = {
  segments: Segment[]
  /** Live backtick command substitutions (bash), each as written. */
  backticks: string[]
  /** A quote, heredoc or substitution never closed. */
  isUnbalanced: boolean
}

type Heredoc = { delim: string; isQuoted: boolean; isStripTabs: boolean }

export function lex(src: string, shell: Shell): Lexed {
  const out: Lexed = { segments: [], backticks: [], isUnbalanced: false }
  if (shell === 'bash') bashFrom(src, 0, false, out, 0)
  else psFrom(src, 0, false, out, 0)
  return out
}

const MAX_DEPTH = 8

/** A word builder shared by both lexers. */
class Words {
  word: string | null = null
  words: string[] = []
  isSkipNext = false
  segStart: number

  constructor(
    private readonly src: string,
    start: number,
    private readonly out: Lexed,
  ) {
    this.segStart = start
  }

  add(text: string): void {
    this.word = (this.word ?? '') + text
  }

  end(): void {
    if (this.word === null) return
    if (this.isSkipNext) this.isSkipNext = false
    else if (this.word !== '@') this.words.push(this.word)
    this.word = null
  }

  segment(at: number, sep: string): void {
    this.end()
    if (this.words.length > 0) {
      this.out.segments.push({
        words: this.words,
        raw: this.src.slice(this.segStart, at).trim(),
        sep,
      })
    }
    this.words = []
    this.segStart = at + sep.length
  }

  /** A redirection: a bare fd number before it is not a word, its target is skipped. */
  redirect(hasTarget: boolean): void {
    if (this.word !== null && /^[0-9*]$/.test(this.word)) this.word = null
    this.end()
    this.isSkipNext = hasTarget
  }
}

/* ------------------------------------------------------------------ bash */

/**
 * Lexes bash from `start`. With `stopAtParen` it returns the index of the
 * `)` that closes a `$(`; otherwise the end of the source.
 */
function bashFrom(src: string, start: number, stopAtParen: boolean, out: Lexed, depth: number): number {
  const w = new Words(src, start, out)
  let heredocs: Heredoc[] = []
  let parens = 0
  let i = start

  while (i < src.length) {
    const c = src[i] as string
    const n = src[i + 1]

    if (c === "'") {
      const j = src.indexOf("'", i + 1)
      if (j < 0) {
        out.isUnbalanced = true
        w.add(src.slice(i + 1))
        i = src.length
        break
      }
      w.add(src.slice(i + 1, j))
      i = j + 1
      continue
    }
    if (c === '$' && n === "'") {
      const r = ansiC(src, i + 2)
      if (r.end < 0) out.isUnbalanced = true
      w.add(r.text)
      i = r.end < 0 ? src.length : r.end + 1
      continue
    }
    if (c === '"') {
      const r = bashDouble(src, i + 1, out, depth)
      w.add(r.text)
      i = r.end
      continue
    }
    if (c === '\\') {
      if (n !== '\n' && n !== undefined) w.add(n)
      i += 2
      continue
    }
    if (c === '`') {
      const r = bashBacktick(src, i, out, depth)
      w.add(r.text)
      i = r.end
      continue
    }
    if (c === '$' && n === '(') {
      if (src[i + 2] === '(') {
        const j = src.indexOf('))', i + 3)
        const end = j < 0 ? src.length : j + 2
        w.add(src.slice(i, end))
        i = end
        continue
      }
      const end = depth < MAX_DEPTH ? bashFrom(src, i + 2, true, out, depth + 1) : skipParens(src, i + 2)
      if (end >= src.length) {
        out.isUnbalanced = true
        w.add(src.slice(i))
        i = src.length
        break
      }
      w.add(src.slice(i, end + 1))
      i = end + 1
      continue
    }
    if (c === '$' && n === '{') {
      const j = src.indexOf('}', i + 2)
      const end = j < 0 ? src.length : j + 1
      w.add(src.slice(i, end))
      i = end
      continue
    }
    if (c === '#' && w.word === null) {
      const j = src.indexOf('\n', i)
      i = j < 0 ? src.length : j
      continue
    }
    if (c === '<' && n === '<') {
      if (src[i + 2] === '<') {
        w.end()
        i += 3
        continue
      }
      w.end()
      const r = heredocOperator(src, i + 2)
      if (r !== undefined) heredocs.push(r.doc)
      i = r?.end ?? i + 2
      continue
    }
    if (c === '>' || c === '<' || (c === '&' && n === '>')) {
      let j = i + 1
      while (j < src.length && '>&|'.includes(src[j] as string)) j++
      const op = src.slice(i, j)
      let hasTarget = true
      if (op.endsWith('&')) {
        while (j < src.length && /[0-9-]/.test(src[j] as string)) j++
        hasTarget = j === i + op.length
      }
      w.redirect(hasTarget)
      i = j
      continue
    }
    if (c === '\n') {
      w.segment(i, '\n')
      i++
      if (heredocs.length > 0) {
        i = readHeredocs(src, i, heredocs, out, stopAtParen)
        heredocs = []
        w.segStart = i
      }
      continue
    }
    if (c === ')') {
      if (parens === 0 && stopAtParen) {
        w.segment(i, ')')
        return i
      }
      parens = Math.max(0, parens - 1)
      w.segment(i, ')')
      i++
      continue
    }
    if (c === '(') {
      parens++
      w.segment(i, '(')
      i++
      continue
    }
    if (c === '&' || c === '|' || c === ';') {
      const op = n === c || (c === '|' && n === '&') ? c + n : c
      w.segment(i, op)
      i += op.length
      continue
    }
    if (c === ' ' || c === '\t' || c === '\r') {
      w.end()
      i++
      continue
    }
    w.add(c)
    i++
  }

  w.segment(src.length, '')
  if (stopAtParen) out.isUnbalanced = true
  return src.length
}

function skipParens(src: string, i: number): number {
  let depth = 0
  for (; i < src.length; i++) {
    if (src[i] === '(') depth++
    else if (src[i] === ')') {
      if (depth === 0) return i
      depth--
    }
  }
  return src.length
}

function ansiC(src: string, i: number): { text: string; end: number } {
  let text = ''
  for (; i < src.length; i++) {
    const c = src[i] as string
    if (c === '\\') {
      text += src[i + 1] ?? ''
      i++
      continue
    }
    if (c === "'") return { text, end: i }
    text += c
  }
  return { text, end: -1 }
}

function bashDouble(src: string, i: number, out: Lexed, depth: number): { text: string; end: number } {
  let text = ''
  while (i < src.length) {
    const c = src[i] as string
    const n = src[i + 1]
    if (c === '"') return { text, end: i + 1 }
    if (c === '\\') {
      if (n !== undefined && '$`"\\\n'.includes(n)) {
        if (n !== '\n') text += n
        i += 2
        continue
      }
      text += c
      i++
      continue
    }
    if (c === '`') {
      const r = bashBacktick(src, i, out, depth)
      text += r.text
      i = r.end
      continue
    }
    if (c === '$' && n === '(' && src[i + 2] !== '(') {
      const end = depth < MAX_DEPTH ? bashFrom(src, i + 2, true, out, depth + 1) : skipParens(src, i + 2)
      if (end >= src.length) {
        out.isUnbalanced = true
        return { text: text + src.slice(i), end: src.length }
      }
      text += src.slice(i, end + 1)
      i = end + 1
      continue
    }
    text += c
    i++
  }
  out.isUnbalanced = true
  return { text, end: src.length }
}

/** A live backtick span starting at `i`: recorded, and its command lexed. */
function bashBacktick(src: string, i: number, out: Lexed, depth: number): { text: string; end: number } {
  let j = i + 1
  while (j < src.length && src[j] !== '`') j += src[j] === '\\' ? 2 : 1
  if (j >= src.length) {
    out.isUnbalanced = true
    out.backticks.push(src.slice(i))
    return { text: src.slice(i), end: src.length }
  }
  const span = src.slice(i, j + 1)
  out.backticks.push(span)
  if (depth < MAX_DEPTH) {
    const inner = span.slice(1, -1).replace(/\\([`$\\])/g, '$1')
    bashFrom(inner, 0, false, out, depth + 1)
  }
  return { text: span, end: j + 1 }
}

function heredocOperator(src: string, i: number): { doc: Heredoc; end: number } | undefined {
  const isStripTabs = src[i] === '-'
  if (isStripTabs) i++
  while (src[i] === ' ' || src[i] === '\t') i++
  let delim = ''
  let isQuoted = false
  while (i < src.length) {
    const c = src[i] as string
    if (c === "'" || c === '"') {
      const j = src.indexOf(c, i + 1)
      if (j < 0) return undefined
      delim += src.slice(i + 1, j)
      isQuoted = true
      i = j + 1
      continue
    }
    if (c === '\\') {
      delim += src[i + 1] ?? ''
      isQuoted = true
      i += 2
      continue
    }
    if (/[\s;&|()<>]/.test(c)) break
    delim += c
    i++
  }
  if (delim === '') return undefined
  return { doc: { delim, isQuoted, isStripTabs }, end: i }
}

/** Consumes heredoc bodies starting at `i` (just past a newline); returns where code resumes. */
function readHeredocs(src: string, i: number, docs: readonly Heredoc[], out: Lexed, isInSubst: boolean): number {
  for (const doc of docs) {
    let isClosed = false
    while (i < src.length) {
      const nl = src.indexOf('\n', i)
      const lineEnd = nl < 0 ? src.length : nl
      const line = src.slice(i, lineEnd).replace(/\r$/, '')
      const bare = doc.isStripTabs ? line.replace(/^\t+/, '') : line
      if (bare === doc.delim) {
        i = nl < 0 ? src.length : nl + 1
        isClosed = true
        break
      }
      if (isInSubst && bare.startsWith(doc.delim) && bare.slice(doc.delim.length).trimStart().startsWith(')')) {
        i = i + line.indexOf(doc.delim) + doc.delim.length
        isClosed = true
        break
      }
      if (!doc.isQuoted) liveBackticksIn(line, out)
      i = nl < 0 ? src.length : nl + 1
    }
    if (!isClosed) out.isUnbalanced = true
  }
  return i
}

/** Backticks in an unquoted heredoc body run as commands. */
function liveBackticksIn(line: string, out: Lexed): void {
  let i = 0
  while (i < line.length) {
    if (line[i] === '\\') {
      i += 2
      continue
    }
    if (line[i] === '`') {
      let j = i + 1
      while (j < line.length && line[j] !== '`') j += line[j] === '\\' ? 2 : 1
      out.backticks.push(line.slice(i, j + 1))
      i = j + 1
      continue
    }
    i++
  }
}

/* ------------------------------------------------------------ PowerShell */

function psFrom(src: string, start: number, stopAtParen: boolean, out: Lexed, depth: number): number {
  const w = new Words(src, start, out)
  let parens = 0
  let i = start

  while (i < src.length) {
    const c = src[i] as string
    const n = src[i + 1]

    if (c === '@' && (n === "'" || n === '"') && /^[ \t]*\r?\n/.test(src.slice(i + 2, i + 40))) {
      const close = src.indexOf(`\n${n}@`, i + 2)
      const bodyStart = src.indexOf('\n', i + 2) + 1
      if (close < 0) {
        out.isUnbalanced = true
        w.add(src.slice(bodyStart))
        i = src.length
        break
      }
      w.add(src.slice(bodyStart, close).replace(/\r$/, ''))
      i = close + 3
      continue
    }
    if (c === "'") {
      let j = i + 1
      let text = ''
      while (j < src.length) {
        if (src[j] === "'" && src[j + 1] === "'") {
          text += "'"
          j += 2
          continue
        }
        if (src[j] === "'") break
        text += src[j]
        j++
      }
      if (j >= src.length) out.isUnbalanced = true
      w.add(text)
      i = j + 1
      continue
    }
    if (c === '"') {
      const r = psDouble(src, i + 1, out, depth)
      w.add(r.text)
      i = r.end
      continue
    }
    if (c === '`') {
      if (n !== '\n' && n !== undefined) w.add(n)
      i += 2
      continue
    }
    if (c === '$' && n === '(') {
      const end = depth < MAX_DEPTH ? psFrom(src, i + 2, true, out, depth + 1) : skipParens(src, i + 2)
      if (end >= src.length) {
        out.isUnbalanced = true
        w.add(src.slice(i))
        i = src.length
        break
      }
      w.add(src.slice(i, end + 1))
      i = end + 1
      continue
    }
    if (c === '$' && n === '{') {
      const j = src.indexOf('}', i + 2)
      const end = j < 0 ? src.length : j + 1
      w.add(src.slice(i, end))
      i = end
      continue
    }
    if (c === '<' && n === '#') {
      const j = src.indexOf('#>', i + 2)
      i = j < 0 ? src.length : j + 2
      continue
    }
    if (c === '#' && w.word === null) {
      const j = src.indexOf('\n', i)
      i = j < 0 ? src.length : j
      continue
    }
    if (c === '>') {
      let j = i + 1
      while (j < src.length && '>&'.includes(src[j] as string)) j++
      const op = src.slice(i, j)
      let hasTarget = true
      if (op.endsWith('&')) {
        while (j < src.length && /[0-9]/.test(src[j] as string)) j++
        hasTarget = false
      }
      w.redirect(hasTarget)
      i = j
      continue
    }
    if (c === '\n' || c === ';') {
      w.segment(i, c)
      i++
      continue
    }
    if (c === ')') {
      if (parens === 0 && stopAtParen) {
        w.segment(i, ')')
        return i
      }
      parens = Math.max(0, parens - 1)
      w.segment(i, ')')
      i++
      continue
    }
    if (c === '(') {
      parens++
      w.segment(i, '(')
      i++
      continue
    }
    if (c === '{' || c === '}') {
      w.segment(i, c)
      i++
      continue
    }
    if (c === '&' || c === '|') {
      const op = n === c ? c + n : c
      w.segment(i, op)
      i += op.length
      continue
    }
    if (c === ' ' || c === '\t' || c === '\r') {
      w.end()
      i++
      continue
    }
    w.add(c)
    i++
  }

  w.segment(src.length, '')
  if (stopAtParen) out.isUnbalanced = true
  return src.length
}

function psDouble(src: string, i: number, out: Lexed, depth: number): { text: string; end: number } {
  let text = ''
  while (i < src.length) {
    const c = src[i] as string
    const n = src[i + 1]
    if (c === '"' && n === '"') {
      text += '"'
      i += 2
      continue
    }
    if (c === '"') return { text, end: i + 1 }
    if (c === '`') {
      text += n ?? ''
      i += 2
      continue
    }
    if (c === '$' && n === '(') {
      const end = depth < MAX_DEPTH ? psFrom(src, i + 2, true, out, depth + 1) : skipParens(src, i + 2)
      if (end >= src.length) {
        out.isUnbalanced = true
        return { text: text + src.slice(i), end: src.length }
      }
      text += src.slice(i, end + 1)
      i = end + 1
      continue
    }
    text += c
    i++
  }
  out.isUnbalanced = true
  return { text, end: src.length }
}

/* -------------------------------------------------------------- commands */

/** A simple command as rails reads it. */
export type Cmd = {
  /** Lower-case basename of the program, `.exe` dropped (`git`, `stop-process`). */
  name: string
  /** The words after the program. */
  args: string[]
  raw: string
  /** The directory a `cd` earlier in the same command line moved to, if any. */
  dir: string | undefined
  /** Commands joined by `|` (or a script block inside one) share this number. */
  pipeline: number
}

const PREFIXES = new Set(['env', 'command', 'exec', 'builtin', 'nohup', 'time', 'sudo', 'call', '.', '&'])
const CD = new Set(['cd', 'chdir', 'pushd', 'set-location', 'sl', 'push-location'])
const STATEMENT_ENDS = new Set([';', '\n', '&&', '||', '&', ''])

/** The commands a command line runs, shells inside it (`bash -c`, `powershell -Command`) included. */
export function commands(src: string, shell: Shell): Cmd[] {
  const cmds: Cmd[] = []
  collect(src, shell, cmds, { dir: undefined, pipeline: 0 }, 0)
  return cmds
}

type Walk = { dir: string | undefined; pipeline: number }

function collect(src: string, shell: Shell, cmds: Cmd[], walk: Walk, depth: number): void {
  for (const seg of lex(src, shell).segments) {
    let words = seg.words
    while (words.length > 0) {
      const first = words[0] as string
      if (shell === 'bash' && /^[A-Za-z_][A-Za-z0-9_]*=/.test(first)) words = words.slice(1)
      else if (PREFIXES.has(first.toLowerCase())) words = words.slice(1)
      else break
    }
    const first = words[0]
    if (first !== undefined) {
      const name = programName(first)
      const args = words.slice(1)
      const inner = depth < 3 ? innerCommand(name, args) : undefined
      if (inner !== undefined) collect(inner.src, inner.shell, cmds, walk, depth + 1)
      else {
        if (CD.has(name)) {
          const target = args.find(a => !a.startsWith('-'))
          walk.dir = joinPath(walk.dir, target ?? '~')
        }
        cmds.push({ name, args, raw: seg.raw, dir: walk.dir, pipeline: walk.pipeline })
      }
    }
    if (STATEMENT_ENDS.has(seg.sep)) walk.pipeline++
  }
}

export function programName(word: string): string {
  const base = word.replace(/\\/g, '/').split('/').pop() ?? word
  return base.toLowerCase().replace(/\.exe$/, '')
}

/** The command a shell program runs from its arguments, when it is given one. */
function innerCommand(name: string, args: readonly string[]): { src: string; shell: Shell } | undefined {
  if (['bash', 'sh', 'zsh', 'dash'].includes(name)) {
    const k = args.findIndex(a => /^-[a-z]*c[a-z]*$/.test(a))
    const src = k < 0 ? undefined : args[k + 1]
    return src === undefined ? undefined : { src, shell: 'bash' }
  }
  if (name === 'powershell' || name === 'pwsh') {
    const k = args.findIndex(a => /^-(c|command|ec)$/i.test(a))
    if (k >= 0) return { src: args.slice(k + 1).join(' '), shell: 'ps' }
    const f = args.findIndex(a => /^-(f|file)$/i.test(a))
    if (f >= 0) return { src: args.slice(f + 1).map(quotePs).join(' '), shell: 'ps' }
    return undefined
  }
  if (name === 'cmd') {
    const k = args.findIndex(a => /^\/+[ck]$/i.test(a))
    return k < 0 ? undefined : { src: args.slice(k + 1).join(' '), shell: 'ps' }
  }
  return undefined
}

function quotePs(word: string): string {
  return /[\s;|&(){}]/.test(word) ? `'${word.replace(/'/g, "''")}'` : word
}

/* ----------------------------------------------------------------- paths */

/** Forward slashes, lower case, Git Bash's `/c/...` as `c:/...`, no trailing slash. */
export function normPath(p: string): string {
  let s = p.replace(/\\/g, '/').replace(/\/{2,}/g, '/').toLowerCase()
  const m = /^\/([a-z])(\/|$)/.exec(s)
  if (m !== null) s = `${m[1]}:/${s.slice(3)}`
  return s.length > 1 ? s.replace(/\/$/, '') : s
}

export function isAbsolutePath(p: string): boolean {
  return /^([a-z]:)?[\\/]/i.test(p) || /^(~|\$home|\$env:userprofile|\$\{?home\}?|%userprofile%)/i.test(p)
}

/** `p` resolved against `base`; with no base it stays relative (to the session's cwd). */
export function joinPath(base: string | undefined, p: string): string {
  if (isAbsolutePath(p) || base === undefined) return p
  return `${base.replace(/[\\/]+$/, '')}/${p}`
}
