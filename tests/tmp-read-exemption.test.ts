import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/** ~/.pulsemind/tmp 整树读豁免（2026-11-11，ocr 工具读不到 tmp/screenshot）。
 *  渲染端把粘贴/附件/MCP 回传的图片统一改写到 tmp/screenshot（agent/image-utils.ts）
 *  并把绝对路径交给模型，而会话侧 ~/.pulsemind 是 deny root——app 自己递出去的
 *  路径被 app 自己拒绝，trunc（2026-10-10）/read-cache（2026-10-12）之后的第三个
 *  同类死链。修法与 E8 knowledge 同纪律：整树 read 豁免（extraReadableRoots），
 *  写监狱不变（workspace + skills/trunc/read-cache）。 */

import { guardPath, buildDenyRoots } from '../src/shared/sandbox/path-jail'

const HOME = '/home/u'
const TMP = `${HOME}/.pulsemind/tmp`
const denyRoots = buildDenyRoots(HOME, 'linux')
const readable = [{ dir: TMP, real: TMP }]

describe('tmp 整树读豁免（读过 deny、写仍拒）', () => {
  it('tmp/screenshot 下 read：放行（ocr 的主用例）', () => {
    const r = guardPath({
      target: `${TMP}/screenshot/screenshot_1794203353937_jzp55z.jpg`,
      operation: 'read',
      denyRoots,
      workspaceDir: `${HOME}/work/ws`,
      realTarget: `${TMP}/screenshot/screenshot_1794203353937_jzp55z.jpg`,
      extraReadableRoots: readable,
    })
    expect(r.ok).toBe(true)
  })

  it('tmp 其余子树 read 一并放行（proc-logs / html-cards / trunc / read-cache）', () => {
    for (const p of [
      `${TMP}/proc-logs/123.log`,
      `${TMP}/html-cards/card.html`,
      `${TMP}/trunc/abc.txt`,
      `${TMP}/read-cache/conv_abc.md`,
    ]) {
      const r = guardPath({
        target: p,
        operation: 'read',
        denyRoots,
        workspaceDir: `${HOME}/work/ws`,
        realTarget: p,
        extraReadableRoots: readable,
      })
      expect(r.ok, p).toBe(true)
    }
  })

  it('tmp 下 write：仍拒（豁免只解除 deny，不进写白名单）', () => {
    const r = guardPath({
      target: `${TMP}/screenshot/evil.jpg`,
      operation: 'write',
      denyRoots,
      workspaceDir: `${HOME}/work/ws`,
      realTarget: `${TMP}/screenshot/evil.jpg`,
      extraReadableRoots: readable,
    })
    expect(r.ok).toBe(false)
  })

  it('tmp 内符号链接逃逸到保护根：read 仍拒（realpath 同坐标判定）', () => {
    const r = guardPath({
      target: `${TMP}/link/id_rsa`,
      operation: 'read',
      denyRoots,
      workspaceDir: `${HOME}/work/ws`,
      realTarget: `${HOME}/.ssh/id_rsa`,
      extraReadableRoots: readable,
    })
    expect(r.ok).toBe(false)
  })

  it('兄弟前缀目录不误豁免（tmpx ≠ tmp）', () => {
    const p = `${HOME}/.pulsemind/tmpx/secret.txt`
    const r = guardPath({
      target: p,
      operation: 'read',
      denyRoots,
      workspaceDir: `${HOME}/work/ws`,
      realTarget: p,
      extraReadableRoots: readable,
    })
    expect(r.ok).toBe(false)
  })

  it('~/.pulsemind 其余子树保持 denied（settings.json / db / memory）', () => {
    for (const p of [
      `${HOME}/.pulsemind/settings.json`,
      `${HOME}/.pulsemind/db/pulsemind.db`,
      `${HOME}/.pulsemind/memory/MEMORY.md`,
      `${HOME}/.pulsemind/hooks/app-start.js`,
    ]) {
      const r = guardPath({
        target: p,
        operation: 'read',
        denyRoots,
        workspaceDir: `${HOME}/work/ws`,
        realTarget: p,
        extraReadableRoots: readable,
      })
      expect(r.ok, p).toBe(false)
    }
  })

  it('无 extraReadableRoots 时 tmp read 仍 denied（向后兼容）', () => {
    const r = guardPath({
      target: `${TMP}/screenshot/x.jpg`,
      operation: 'read',
      denyRoots,
      workspaceDir: `${HOME}/work/ws`,
    })
    expect(r.ok).toBe(false)
  })
})

describe('wiring：guard 侧 tmp 读豁免接线', () => {
  const ROOT = join(__dirname, '..')
  const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8')

  it('guard.ts 把 tmpRoot 放进 extraReadableRoots（会话侧读豁免）', () => {
    const g = read('src/main/sandbox/guard.ts')
    expect(g).toContain("join(homedir(), '.pulsemind', 'tmp')")
    expect(g).toContain('{ dir: tmpRoot, real: tmpReal }')
  })

  it('trunc / read-cache 写豁免不回归（仍在 extraWritableRoots）', () => {
    const g = read('src/main/sandbox/guard.ts')
    expect(g).toContain('{ dir: truncRoot, real: truncReal }')
    expect(g).toContain('{ dir: readCacheRoot, real: readCacheReal }')
  })

  it('ocr 与渲染端图片改写共用同一判词链（svcOcrImage 拒绝话术保留）', () => {
    const f = read('src/main/services/file-ops.ts')
    expect(f).toContain('ocr denied: ${guard.reason}')
  })
})
