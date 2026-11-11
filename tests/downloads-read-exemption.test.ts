import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/** 浏览器下载树读豁免（2026-11-11，与 tmp 同一轮审计的第二个死链）。
 *  agent 发起的页面下载落在 ~/.pulsemind/workspace/downloads/<conversationId>/——
 *  会话自己的 workspace 是兄弟时间戳目录，而 `browsers.tabs.listDownloads`
 *  （BrowserService）把里面的绝对路径递给模型去 read/ocr/convert：deny root
 *  整树拒绝。读豁免与 tmp/knowledge 同纪律；写监狱不变；**兄弟会话目录不豁免**
 *  ——跨会话隔离是刻意的，只有这棵 app 自管、对外递路径的子树放行。 */

import { guardPath, buildDenyRoots } from '../src/shared/sandbox/path-jail'

const HOME = '/home/u'
const DOWNLOADS = `${HOME}/.pulsemind/workspace/downloads`
const denyRoots = buildDenyRoots(HOME, 'linux')
const readable = [{ dir: DOWNLOADS, real: DOWNLOADS }]

describe('workspace/downloads 读豁免（读过 deny、写仍拒）', () => {
  it('downloads/<convId>/ 下 read：放行（listDownloads 的主用例）', () => {
    const p = `${DOWNLOADS}/conv_abc/report.pdf`
    const r = guardPath({
      target: p,
      operation: 'read',
      denyRoots,
      workspaceDir: `${HOME}/.pulsemind/workspace/20261111-1000-ab12`,
      realTarget: p,
      extraReadableRoots: readable,
    })
    expect(r.ok).toBe(true)
  })

  it('downloads 下 write：仍拒（豁免只解除 deny，不进写白名单）', () => {
    const p = `${DOWNLOADS}/conv_abc/evil.txt`
    const r = guardPath({
      target: p,
      operation: 'write',
      denyRoots,
      workspaceDir: `${HOME}/.pulsemind/workspace/20261111-1000-ab12`,
      realTarget: p,
      extraReadableRoots: readable,
    })
    expect(r.ok).toBe(false)
  })

  it('兄弟会话工作区不误豁免（跨会话隔离保持）', () => {
    const p = `${HOME}/.pulsemind/workspace/20261110-0900-xy99/notes.md`
    const r = guardPath({
      target: p,
      operation: 'read',
      denyRoots,
      workspaceDir: `${HOME}/.pulsemind/workspace/20261111-1000-ab12`,
      realTarget: p,
      extraReadableRoots: readable,
    })
    expect(r.ok).toBe(false)
  })

  it('downloads 内符号链接逃逸到保护根：read 仍拒（realpath 同坐标判定）', () => {
    const r = guardPath({
      target: `${DOWNLOADS}/conv_abc/link/id_rsa`,
      operation: 'read',
      denyRoots,
      workspaceDir: `${HOME}/.pulsemind/workspace/20261111-1000-ab12`,
      realTarget: `${HOME}/.ssh/id_rsa`,
      extraReadableRoots: readable,
    })
    expect(r.ok).toBe(false)
  })

  it('~/.pulsemind 其余子树保持 denied（settings.json / db / hooks）', () => {
    for (const p of [
      `${HOME}/.pulsemind/settings.json`,
      `${HOME}/.pulsemind/db/pulsemind.db`,
      `${HOME}/.pulsemind/hooks/app-start.js`,
    ]) {
      const r = guardPath({
        target: p,
        operation: 'read',
        denyRoots,
        workspaceDir: `${HOME}/.pulsemind/workspace/20261111-1000-ab12`,
        realTarget: p,
        extraReadableRoots: readable,
      })
      expect(r.ok, p).toBe(false)
    }
  })
})

describe('wiring：guard 侧 downloads 读豁免接线', () => {
  const ROOT = join(__dirname, '..')
  const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8')

  it('guard.ts 把 downloadsRoot 放进 extraReadableRoots（读豁免）', () => {
    const g = read('src/main/sandbox/guard.ts')
    expect(g).toContain("join(homedir(), '.pulsemind', 'workspace', 'downloads')")
    expect(g).toContain('{ dir: downloadsRoot, real: downloadsReal }')
  })

  it('下载路径的唯一对外出口是 listDownloads（BrowserService）', () => {
    const b = read('src/main/browser/BrowserService.ts')
    expect(b).toContain("join(WORKSPACE_DIR, 'downloads', scopeId)")
    expect(b).toContain('listDownloads(scopeId)')
  })
})
