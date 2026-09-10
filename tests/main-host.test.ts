import { describe, expect, it, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mainHost } from '../src/main/agent/main-host'

/**
 * Main-process PulseHost smoke tests (M1.4): exercises the host's fs/terminal
 * capabilities under plain Node. DB-backed methods are covered indirectly by
 * the settings-store suite (same temp-HOME SQLite-free approach); full DB
 * coverage needs the Electron-ABI runner (see AGENTS.md known gap).
 */

beforeEach(() => {
  process.env.HOME = mkdtempSync(join(tmpdir(), 'pulsemind-mainhost-'))
})

describe('mainHost', () => {
  it('exposes the full PulseHost capability surface', () => {
    for (const key of ['apiFetchStream', 'executeCommand', 'readFile', 'writeFile', 'editFile', 'mcpCallTool', 'gitInvoke', 'saveConversation', 'getSettings', 'saveMemory', 'knowledgeSearchContent'] as const) {
      expect(typeof mainHost[key]).toBe('function')
    }
  })

  it('fs roundtrip: writeFile → readFile → fileStat', async () => {
    const file = join(process.env.HOME as string, 'probe.txt')
    const writeResult = await mainHost.writeFile({ filePath: file, content: 'hello m1.4\n' })
    expect(writeResult.success).toBe(true)

    const content = await mainHost.readFile(file)
    expect(content).toBe('hello m1.4\n')

    const stat = await mainHost.getFileStat(file)
    expect(stat?.size).toBe('hello m1.4\n'.length)
  })

  it('editFile replaces oldStr with CRLF tolerance', async () => {
    const file = join(process.env.HOME as string, 'edit.txt')
    await mainHost.writeFile({ filePath: file, content: 'alpha\nbeta\n' })
    const result = await mainHost.editFile({ filePath: file, oldStr: 'beta', newStr: 'gamma', multi: false })
    expect(result.success).toBe(true)
    expect(await mainHost.readFile(file)).toBe('alpha\ngamma\n')
  })

  it('execCommandSync captures output and exit code', async () => {
    const result = await mainHost.execCommandSync('echo pulsemind-probe')
    expect(result.code).toBe(0)
    expect(result.output).toContain('pulsemind-probe')
  })

  it('getSettings falls back to defaults for a fresh data dir', async () => {
    const s = await mainHost.getSettings()
    expect(Array.isArray(s.profiles)).toBe(true)
    expect(s.locale).toBe('zh')
  })
})
