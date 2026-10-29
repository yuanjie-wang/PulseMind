// ── 2026-10-29：这条是行为验证，不是文本钉 ──
// tests/search-engine-failure.test.ts 钉的是 wiring 的存在性；本文件把 execFile
// 换成可控桩，真的去问 svcSearchWiki：「rg 起不来」时你给空数组还是给错误。
// 这正是原缺陷的要害——storage 层 resolve([]) 让上一个栈帧无法区分两者。
import { afterEach, describe, expect, it, vi } from 'vitest'

// vi.mock 会被提到 import 之上，所以可变状态必须走 vi.hoisted（let/const 在工厂
// 首次执行时仍在 TDZ）。
const state = vi.hoisted(() => ({ nextError: null as unknown }))

vi.mock('node:child_process', () => ({
  execFile: (
    _cmd: string,
    _args: string[],
    _opts: unknown,
    cb: (err: unknown, stdout: string) => void,
  ) => { cb(state.nextError, '') },
}))

// searchDir 跳过不存在的 wiki 目录，工厂里造一个真的。
vi.mock('../src/main/storage', async () => {
  const { mkdtempSync, mkdirSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const base = mkdtempSync(join(tmpdir(), 'pm-engfail-'))
  const wiki = join(base, 'wiki')
  mkdirSync(wiki, { recursive: true })
  return {
    getBaseRawDir: () => join(base, 'raw'),
    getBaseWikiDir: () => wiki,
  }
})

// 只换二进制路径，isSearchEngineFailure / buildRgSearchArgs 走真实现——本文件的
// 全部意义就在那个判定函数上，桩掉它等于什么都没验。
vi.mock('../src/main/utils/ripgrep', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/main/utils/ripgrep')>()
  return { ...actual, ripgrepBinary: () => '/usr/bin/rg' }
})

vi.mock('../src/main/storage/knowledge-store', () => {
  const names = [
    'importLocalFiles', 'importUrl', 'reextractKnowledge', 'abortKnowledgeImport', 'prepareImport',
    'readRawContent', 'readWikiContent', 'listWikiFiles', 'saveExperienceToRaw', 'saveFavoriteToRaw',
    'getStats', 'markFileCompiled', 'applyWikiChanges', 'appendWikiLog', 'clearAllKnowledge',
    'rebuildWikiIndex', 'searchContent', 'listAllFiles', 'listAllFilesAdvanced', 'getFile',
    'deleteFile', 'getSchemaContent', 'isValidWikiPagePath', 'wikiFtsCount', 'rebuildWiki',
    'listAllBases', 'createKnowledgeBase', 'renameKnowledgeBaseById', 'removeKnowledgeBase',
    'moveKnowledgeFileToBase', 'moveKnowledgeFilesToBase',
  ]
  const mod: Record<string, unknown> = {}
  // 0 → FTS 包装器短路 → 走 rg 回退（本文件要测的那条）
  for (const n of names) mod[n] = n === 'wikiFtsCount' ? () => 0 : () => undefined
  return mod
})

vi.mock('../src/main/storage/database', () => ({ getDb: () => { throw new Error('no db in this test') } }))

import { svcSearchWiki } from '../src/main/services/knowledge-queries'

afterEach(() => { state.nextError = null })

describe('svcSearchWiki：引擎不可用不许伪装成空库', () => {
  it('rg 起不来（ENOENT）→  rejecting，交给上层的 swallowSource 记账', async () => {
    state.nextError = { code: 'ENOENT' }
    await expect(svcSearchWiki('alpha beta', 'base1')).rejects.toThrow(/engine unavailable/)
  })

  it('被 timeout 杀掉（killed）同样算失败——扫描没跑完，不能说「没有」', async () => {
    state.nextError = { code: null, killed: true }
    await expect(svcSearchWiki('alpha beta', 'base1')).rejects.toThrow(/engine unavailable/)
  })

  it('rg 退出码 1 是「确实没匹配」→ resolves([]) 干净空数组，这是真话', async () => {
    state.nextError = { code: 1 }
    await expect(svcSearchWiki('alpha beta', 'base1')).resolves.toEqual([])
  })

  it('rg 跑完但零输出（err 为 null）→ 同样是干净空数组', async () => {
    state.nextError = null
    await expect(svcSearchWiki('alpha beta', 'base1')).resolves.toEqual([])
  })
})
