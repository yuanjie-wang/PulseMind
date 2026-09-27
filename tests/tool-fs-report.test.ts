import { describe, it, expect, afterEach } from 'vitest'
import { ToolExecutor } from '../src/renderer/src/agent/tool-executors'
import { setHost } from '../src/renderer/src/agent/host'
import type { PulseHost } from '../src/renderer/src/agent/host/types'
import type { AgentEngineOptions } from '../src/renderer/src/agent/types'
import type { ToolUseBlock } from '../src/shared/types/agent'

/**
 * The fs tools' self-report calibers (2026-09-27 feedback):
 *  - `write` must report UTF-8 bytes actually on disk, not UTF-16 code units —
 *    for CJK-heavy content the old `content.length` read ~50% under the real
 *    size, which reads as a truncated write and forces a shasum/diff to clear.
 *  - `read` must never print a fake `Size: 0 B`: a missing stat renders `?`,
 *    so 0 B stays meaningful ("genuinely empty file").
 */

interface Seen { id: string; content: string; isError?: boolean }

function makeExecutor(seen: Seen[]) {
  return new ToolExecutor(
    { conversationId: 'conv_1' } as AgentEngineOptions,
    new Map(),
    null as never,
    null as never,
    (id, content, isError) => seen.push({ id, content, isError }),
    () => {},
  )
}

afterEach(() => setHost(null as unknown as PulseHost))

describe('write reports real UTF-8 bytes', () => {
  it('counts bytes, not code units — astral chars weigh 4 bytes in 2 units', async () => {
    const seen: Seen[] = []
    setHost({ writeFile: async () => ({ success: true }) } as unknown as PulseHost)
    // 128 CJK chars (3 bytes each = 384) + 1 astral char (2 code units, 4
    // bytes): String.length says 130, the file gets 388 bytes.
    const content = '中文'.repeat(64) + '𝄞'
    const t = { id: 'w1', name: 'write', input: { file_path: '/tmp/x.md', content } } as unknown as ToolUseBlock
    await makeExecutor(seen).execWorkspaceTool(t)
    expect(seen[0].content).toBe('Written 388 bytes to /tmp/x.md')
    expect(t.exitCode).toBe(0)
  })

  it('keeps the (appended) marker and the error passthrough on the same caliber', async () => {
    const seen: Seen[] = []
    setHost({ writeFile: async () => ({ success: true }) } as unknown as PulseHost)
    const t = { id: 'w2', name: 'write', input: { file_path: '/tmp/x.md', content: '日志', append: true } } as unknown as ToolUseBlock
    await makeExecutor(seen).execWorkspaceTool(t)
    expect(seen[0].content).toBe('Written 6 bytes to /tmp/x.md (appended)')

    const bad: Seen[] = []
    setHost({ writeFile: async () => ({ success: false, error: 'Path is protected' }) } as unknown as PulseHost)
    const t2 = { id: 'w3', name: 'write', input: { file_path: '/tmp/y.md', content: '日志' } } as unknown as ToolUseBlock
    await makeExecutor(bad).execWorkspaceTool(t2)
    expect(bad[0].content).toBe('Error: Path is protected')
    expect(t2.exitCode).toBe(1)
  })
})

describe('read Size header never fakes 0 B', () => {
  function readHost(stat: { size: number } | null) {
    return {
      getFileStat: async () => (stat === null ? null : { size: stat.size, birthtime: '', mtime: '', isDirectory: false }),
      // first call = the read itself, the `wc -l` call = the line count
      execCommandSync: async (cmd: string) => cmd.includes('wc -l')
        ? { code: 0, output: '2 /tmp/sk.md' }
        : { code: 0, output: '第一行\n第二行\n' },
    } as unknown as PulseHost
  }

  it('shows the stat size when the file stats', async () => {
    const seen: Seen[] = []
    setHost(readHost({ size: 1842 }))
    const t = { id: 'r1', name: 'read', input: { file_path: '/tmp/sk.md' } } as unknown as ToolUseBlock
    await makeExecutor(seen).execReadOnlyTools([t])
    // 1842 B = the reported real size of create_skill/SKILL.md in the report
    expect(seen[0].content).toContain('Size: 1.8 KB (2 lines)')
  })

  it('shows `?` when the stat is missing (the old `~/` path reported 0 B here)', async () => {
    const seen: Seen[] = []
    setHost(readHost(null))
    const t = { id: 'r2', name: 'read', input: { file_path: '~/x/SKILL.md' } } as unknown as ToolUseBlock
    await makeExecutor(seen).execReadOnlyTools([t])
    expect(seen[0].content).toContain('Size: ? (2 lines)')
  })

  it('keeps `0 B` meaningful — a genuine empty file still reads 0 B', async () => {
    const seen: Seen[] = []
    setHost(readHost({ size: 0 }))
    const t = { id: 'r3', name: 'read', input: { file_path: '/tmp/empty.md' } } as unknown as ToolUseBlock
    await makeExecutor(seen).execReadOnlyTools([t])
    expect(seen[0].content).toContain('Size: 0 B (2 lines)')
  })
})
