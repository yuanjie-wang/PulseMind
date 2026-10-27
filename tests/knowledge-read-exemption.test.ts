import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/** E8 knowledge/ 只读豁免 + knowledge_read 退役（PLAN-capability-followups）。
 *  沙箱判定是纯逻辑（guardPath），这里钉三层：读写分流、边界对齐、wiring；
 *  真库侧由 probe-memory-pages-db / 既有探针覆盖运行时。 */

import { guardPath, buildDenyRoots } from '../src/shared/sandbox/path-jail'

const HOME = '/home/u'
const KNOWLEDGE = `${HOME}/.pulsemind/knowledge`
const denyRoots = buildDenyRoots(HOME, 'linux')
const readable = [{ dir: KNOWLEDGE }]

describe('extraReadableRoots（E8：读过 deny、写仍拒）', () => {
  it('knowledge/ 下 read：豁免后放行（会话侧）', () => {
    const r = guardPath({
      target: `${KNOWLEDGE}/bases/default/wiki/entities/x.md`,
      operation: 'read',
      denyRoots,
      workspaceDir: `${HOME}/work/ws`,
      extraReadableRoots: readable,
    })
    expect(r.ok).toBe(true)
  })

  it('knowledge/ 下 write：仍拒（豁免只过 deny，不进写白名单）', () => {
    const r = guardPath({
      target: `${KNOWLEDGE}/bases/default/wiki/entities/x.md`,
      operation: 'write',
      denyRoots,
      workspaceDir: `${HOME}/work/ws`,
      extraReadableRoots: readable,
    })
    expect(r.ok).toBe(false)
  })

  it('兄弟前缀目录不误豁免（knowledge-tmp ≠ knowledge）', () => {
    const r = guardPath({
      target: `${HOME}/.pulsemind/knowledge-tmp/secret.md`,
      operation: 'read',
      denyRoots,
      workspaceDir: `${HOME}/work/ws`,
      extraReadableRoots: readable,
    })
    expect(r.ok).toBe(false)
  })

  it('~/.pulsemind 其余子树保持 denied', () => {
    for (const p of [`${HOME}/.pulsemind/db/pulsemind.db`, `${HOME}/.pulsemind/settings.json`, `${HOME}/.pulsemind/experiences/a/SKILL.md`]) {
      const r = guardPath({
        target: p,
        operation: 'read',
        denyRoots,
        workspaceDir: `${HOME}/work/ws`,
        extraReadableRoots: readable,
      })
      expect(r.ok, p).toBe(false)
    }
  })

  it('无 extraReadableRoots 时 knowledge/ read 仍 denied（向后兼容）', () => {
    const r = guardPath({
      target: `${KNOWLEDGE}/x.md`,
      operation: 'read',
      denyRoots,
      workspaceDir: `${HOME}/work/ws`,
    })
    expect(r.ok).toBe(false)
  })
})

describe('wiring：knowledge_read 退役 + 豁免接线', () => {
  const ROOT = join(__dirname, '..')
  const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8')

  it('knowledge_read 全库无注册/手册/执行器', () => {
    for (const f of [
      'src/renderer/src/tools/built-in-tools.ts',
      'src/renderer/src/tools/tool-instructions.ts',
      'src/renderer/src/agent/executors/domain-tools.ts',
      'src/renderer/src/agent/tool-executors.ts',
    ]) {
      expect(read(f), f).not.toContain("'knowledge_read'")
      expect(read(f), f).not.toContain('knowledge_read: `##')
    }
  })

  it('guard 侧 extraReadableRoots 接线（会话侧 only）', () => {
    const g = read('src/main/sandbox/guard.ts')
    expect(g).toContain('extraReadableRoots')
    expect(g).toContain("join(homedir(), '.pulsemind', 'knowledge')")
  })

  it('path-jail：inReadable 只解除 deny、不进写白名单（结构断言）', () => {
    const jail = read('src/shared/sandbox/path-jail.ts')
    expect(jail).toContain('extraReadableRoots')
    expect(jail).toContain('!inReadable && hitsDenyRoots')
    expect(jail).toContain('const writableRoots: string[] = [input.workspaceDir]')
  })
})
