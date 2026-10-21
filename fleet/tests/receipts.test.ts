import { describe, expect, test } from 'claude-code/testing'

import type { FleetAgent } from '../types'
import { freshAgent } from '../hooks/core'
import {
  dueReceipts,
  finishToast,
  matches,
  newReceipt,
  pathKey,
  receiptView,
  recordCall,
  shellWrites,
  withChecks,
  withPartialReceipts,
  writesOf,
} from '../hooks/receipts'

const NOW = 1_800_000_000_000

describe('receipts', () => {
  test('only successful Edit / Write / NotebookEdit calls are recorded, with edit counts', () => {
    let r = newReceipt(NOW, true)
    r = recordCall(r, 'Edit', { file_path: 'C:\\m\\rules.ts' }, true, NOW)
    r = recordCall(r, 'Edit', { file_path: 'c:/m/rules.ts' }, true, NOW + 1) // same file, other spelling
    r = recordCall(r, 'Write', { file_path: 'C:\\m\\register.ts' }, true, NOW)
    r = recordCall(r, 'NotebookEdit', { notebook_path: 'C:\\m\\n.ipynb' }, true, NOW)
    r = recordCall(r, 'Edit', { file_path: 'C:\\m\\failed.ts' }, false, NOW)
    r = recordCall(r, 'Read', { file_path: 'C:\\m\\read.ts' }, true, NOW)
    const ws = writesOf(r)
    expect(ws.map(w => [w.path, w.edits])).toEqual([
      ['C:\\m\\rules.ts', 2],
      ['C:\\m\\n.ipynb', 1],
      ['C:\\m\\register.ts', 1],
    ])
    expect(r.failedEdits).toBe(1)
    expect(r.shellCommands).toBe(0)
  })

  test('shell writes are parsed best-effort: absolute targets only, null devices and logs skipped', () => {
    expect(shellWrites('echo hi > /c/m/a.txt && cat x >> "C:/m/b c.txt"')).toEqual(['/c/m/a.txt', 'C:/m/b c.txt'])
    expect(shellWrites('npm test 2>/dev/null > /tmp/out.log 2>&1')).toEqual(['/tmp/out.log'])
    expect(shellWrites('echo x > rel.txt; node -e "a => b"')).toEqual([])
    expect(shellWrites('Set-Content -Path C:\\m\\s.txt -Value hi')).toEqual(['C:\\m\\s.txt'])
    expect(shellWrites('"x" | Out-File C:\\m\\o.txt -Encoding utf8')).toEqual(['C:\\m\\o.txt'])
    expect(shellWrites('cp -r /a/src /c/m/dst')).toEqual(['/c/m/dst'])
    expect(shellWrites('Copy-Item C:\\a.txt -Destination C:\\b.txt')).toEqual(['C:\\b.txt'])
    expect(shellWrites('ls | tee /c/m/list.txt')).toEqual(['/c/m/list.txt'])
    let r = recordCall(newReceipt(NOW, true), 'Bash', { command: 'git status' }, true, NOW)
    r = recordCall(r, 'Bash', { command: 'echo > /c/m/a.txt' }, true, NOW)
    expect(r.shellCommands).toBe(2)
    expect(writesOf(r)[0]?.via).toBe('shell')
    expect(pathKey('/c/m/a.txt')).toBe(pathKey('C:\\M\\A.txt'))
  })

  test('finish toast names the files, flags missing ones, and says NO files outright', () => {
    let r = newReceipt(NOW, true)
    for (const p of ['/proj/rules.ts', '/proj/register.ts', '/proj/rails.test.ts']) r = recordCall(r, 'Edit', { file_path: p }, true, NOW)
    const done = (receipt = r): FleetAgent => freshAgent('a1', { lane: 'mod-rails2', status: 'completed', receipt })
    expect(finishToast(done())).toBe('fleet: mod-rails2 finished · wrote 3 files (rails.test.ts, register.ts, rules.ts)')
    const checked = withChecks(r, { '/proj/rules.ts': true, '/proj/register.ts': true, '/proj/rails.test.ts': false }, NOW)
    expect(finishToast(done(checked))).toMatch(/wrote 3 files .* · 1 MISSING on disk: rails\.test\.ts$/)
    expect(finishToast(done(newReceipt(NOW, true)))).toBe('fleet: mod-rails2 finished · wrote NO files')
    expect(finishToast(done(newReceipt(NOW, false)))).toMatch(/no full receipt: started before fleet loaded; no writes seen since/)
  })

  test('due once ended and unreported; partial receipts only for running agents met mid-run', () => {
    const rows: Record<string, FleetAgent> = {
      run: freshAgent('run', { status: 'running', receipt: newReceipt(NOW, true) }),
      done: freshAgent('done', { status: 'completed', receipt: newReceipt(NOW, true) }),
      told: freshAgent('told', { status: 'completed', receipt: { ...newReceipt(NOW, true), isReported: true } }),
      never: freshAgent('never', { status: 'completed' }),
    }
    expect(dueReceipts(rows).map(a => a.id)).toEqual(['done'])
    const withPartial = withPartialReceipts({ ...rows, old: freshAgent('old', { status: 'running' }) }, NOW)
    expect(withPartial.old?.receipt?.isComplete).toBe(false)
    expect(withPartial.never?.receipt).toBeUndefined()
    expect(withPartial.run?.receipt?.isComplete).toBe(true)
    const resumed = withPartialReceipts({ r: freshAgent('r', { status: 'running', receipt: { ...newReceipt(NOW, true), isReported: true } }) }, NOW)
    expect(resumed.r?.receipt?.isReported).toBe(false)
  })

  test('tool view: files with exists, partial and none receipts said plainly; lane matching', () => {
    let r = recordCall(newReceipt(NOW, true), 'Write', { file_path: '/proj/a.ts' }, true, NOW)
    r = withChecks(r, { '/proj/a.ts': false }, NOW)
    const a = freshAgent('a1', { lane: 'mod-rails2', hasLaneTag: true, status: 'completed', receipt: r })
    const v = receiptView(a)
    expect(v.receipt).toBe('complete')
    expect(v.files).toEqual([{ path: '/proj/a.ts', edits: 1, via: 'tool', exists: false }])
    expect(v.verdict).toBe('wrote 1 file, 1 MISSING on disk')
    expect(receiptView(freshAgent('x', { status: 'completed' })).receipt).toBe('none')
    expect(receiptView(freshAgent('y', { receipt: newReceipt(NOW, false) })).verdict).toMatch(/^partial receipt \(started before fleet loaded\)/)
    expect(matches(a, '[lane:mod-rails2]')).toBe(true)
    expect(matches(a, 'mod-pace')).toBe(false)
  })
})
