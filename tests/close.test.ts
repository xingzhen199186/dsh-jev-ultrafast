/**
 * Closing someone else's browser, checked without closing anything.
 *
 * What is worth pinning here is narrow and specific: the process list travels as environment
 * variables rather than being pasted into the script text, only pids are read back, the polite
 * pass comes first, and a browser that refuses to let go gets exactly one forceful retry. Every
 * command is injected, so no browser is started or closed by the test.
 */
import { describe, expect, it } from 'vitest'
import { closeBrowser, LIST_WINDOW_PROCESSES } from '../src/browser/close'

interface Call {
  file: string
  args: string[]
  env?: NodeJS.ProcessEnv
}

/** Records every command instead of running it. */
function harness(stdout = '') {
  const calls: Call[] = []
  const run = async (file: string, args: string[], env?: NodeJS.ProcessEnv) => {
    calls.push({ file, args, env })
    return { stdout, stderr: '' }
  }
  return { calls, run }
}

describe('closing the reader’s browser', () => {
  it('asks politely first, and reads the store to decide whether it worked', async () => {
    const { calls, run } = harness('1234\r\n5678\r\n')
    const report = await closeBrowser('edge', {
      profileDir: 'C:\\Users\\me\\AppData\\Local\\Microsoft\\Edge\\User Data',
      ownRoot: 'C:\\Users\\me\\.dsh\\jev-ultrafast',
      platform: 'win32',
      run,
      locked: async () => false,
    })

    expect(report).toEqual({ ok: true, asked: 2, forced: 0 })
    const list = calls.find((call) => call.file === 'powershell.exe')
    expect(list?.env?.JEV_PROCESS).toBe('msedge.exe')
    expect(list?.env?.JEV_OWN).toBe('C:\\Users\\me\\.dsh\\jev-ultrafast')
    const kills = calls.filter((call) => call.file === 'taskkill')
    expect(kills).toHaveLength(1)
    expect(kills[0].args).toEqual(['/PID', '1234', '/PID', '5678'])
  })

  it('forces what is left when the polite pass did not release the store', async () => {
    const { calls, run } = harness('4321\r\n')
    let checks = 0
    const report = await closeBrowser('edge', {
      profileDir: 'C:\\p',
      ownRoot: 'C:\\own',
      platform: 'win32',
      waitMs: 0,
      run,
      locked: async () => {
        checks += 1
        return checks <= 1
      },
    })

    expect(report.ok).toBe(true)
    expect(report.forced).toBe(1)
    const kills = calls.filter((call) => call.file === 'taskkill')
    expect(kills).toHaveLength(2)
    expect(kills[0].args).not.toContain('/F')
    expect(kills[1].args).toContain('/F')
  })

  it('says so plainly when the browser will not let go', async () => {
    const { run } = harness('99\r\n')
    const report = await closeBrowser('edge', {
      profileDir: 'C:\\p',
      platform: 'win32',
      waitMs: 0,
      run,
      locked: async () => true,
    })

    expect(report.ok).toBe(false)
    expect(report.note).toContain('登录数据仍被占着')
  })

  it('does not touch processes on a platform where it has not been built', async () => {
    const { calls, run } = harness()
    const report = await closeBrowser('edge', {
      profileDir: '/home/me/.config/microsoft-edge',
      platform: 'darwin',
      run,
      locked: async () => true,
    })

    expect(calls).toEqual([])
    expect(report.ok).toBe(false)
    expect(report.note).toContain('得你自己关掉它')
  })

  it('keeps paths and command lines out of the script, and echoes nothing but pids', () => {
    // Both halves of the failure this script exists to avoid: a path interpolated into the
    // script text (which arrives mangled through a Windows command line), and whole command
    // lines echoed back (which PowerShell rewraps, losing the path being looked for).
    expect(LIST_WINDOW_PROCESSES).toContain('$env:JEV_PROCESS')
    expect(LIST_WINDOW_PROCESSES).toContain('$env:JEV_OWN')
    expect(LIST_WINDOW_PROCESSES).not.toContain('--user-data-dir')
    expect(LIST_WINDOW_PROCESSES).not.toContain('$_.CommandLine) }')
    expect(LIST_WINDOW_PROCESSES).toContain('[Console]::Out.WriteLine($_.ProcessId)')
  })
})
