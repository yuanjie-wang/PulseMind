// PLAN-share-import-export：导入语义钉子（源码扫描面）+ roundtrip 探针配方。
// 语义级断言（冲突副本/覆盖保留 id/roundtrip）在 scripts/probe-share-roundtrip.mjs
// ——真 store + 真文件（ELECTRON_RUN_AS_NODE 配方），本文件钉 handler 的
// 通道纪律与「导入必经 store、绝不裸写」。

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..')
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf-8')

describe('share import 通道纪律', () => {
  const handler = read('src/main/ipc/share.handler.ts')

  it('提交通道只收 importToken：渲染端不回传 payload 本体', () => {
    expect(handler).toMatch(/SHARE_IMPORT_COMMIT/)
    expect(handler).toContain('pendingImports.get(String(params?.importToken')
    // token 过期/不匹配即拒（单槽 + 新预览覆盖旧 token）
    expect(handler).toContain('导入会话已过期')
    expect(handler).toContain('pendingImports.delete')
  })

  it('导入必经 store.create/update / workflowStore.save——绝不裸写 routines/、workflows/ 目录', () => {
    expect(handler).toContain('routineStore.create(')
    expect(handler).toContain('routineStore.update(')
    expect(handler).toContain('workflowStore.save(')
    // 禁裸写：share.handler 里不得出现 routines 目录 join 写入或 writeFileSync
    // 到存储目录（导出的 writeFileSync 只写用户选的分享文件路径）
    expect(handler).not.toMatch(/routines['"`]/)
    expect(handler).not.toMatch(/workflows['"`]/)
  })

  it('冲突语义：创建副本加「（导入）」后缀；覆盖更新保留 targetId（原 id 的行）', () => {
    expect(handler).toContain('（导入）')
    expect(handler).toMatch(/mode === 'overwrite' && res\.targetId[\s\S]{0,200}routineStore\.update/)
    expect(handler).toMatch(/mode === 'overwrite' && res\.targetId[\s\S]{0,200}workflowStore\.save/)
  })

  it('导出消毒在主进程完成（sanitizeRoutineForExport / workflowExportPayload）', () => {
    expect(handler).toContain('sanitizeRoutineForExport(')
    expect(handler).toContain('workflowExportPayload(')
    expect(handler).toContain('buildEnvelope(')
  })
})
