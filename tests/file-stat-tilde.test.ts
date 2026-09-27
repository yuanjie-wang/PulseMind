import { describe, it, expect } from 'vitest'

/**
 * svcFileStat must stat the guard's RESOLVED spelling (2026-09-27 feedback):
 * a `~/…` path is not a real fs path — the guard expands it, fs.stat does not,
 * and the read tool's content/line-count kept working only because the shell
 * expands tilde too. The result was `Size: 0 B (41 lines)` for a 1842-byte
 * file. Drives the real file-ops + guard glue inside a throwaway HOME.
 */
describe('svcFileStat — tilde paths resolve through the guard', () => {
  it('reports real bytes for ~/spelled paths, null for missing ones', async () => {
    const os = await import('node:os')
    const fs = await import('node:fs')
    const path = await import('node:path')
    const prevHome = process.env.HOME
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-stat-'))
    process.env.HOME = fixture // os.homedir() honors $HOME on POSIX, call time
    const body = '中文'.repeat(96) // 192 code units, 576 bytes
    fs.writeFileSync(path.join(fixture, 'probe.md'), body, 'utf-8')
    try {
      const { svcFileStat } = await import('../src/main/services/file-ops')
      const hit = await svcFileStat('~/probe.md')
      expect(hit?.size).toBe(Buffer.byteLength(body))
      // the absolute spelling of the same file keeps working
      const abs = await svcFileStat(path.join(fixture, 'probe.md'))
      expect(abs?.size).toBe(Buffer.byteLength(body))
      // missing file stays null — the renderer shows `?`, never a fake 0 B
      expect(await svcFileStat('~/missing.md')).toBeNull()
    } finally {
      process.env.HOME = prevHome
      fs.rmSync(fixture, { recursive: true, force: true })
    }
  })
})
