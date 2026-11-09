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

// 唯一 UI 入口：任务中心「我的任务」头部的导入分享按钮（2026-11-09 user：
// 「在日常任务面板的新建任务按钮左侧，增加导入按钮」）。此前入口随
// WorkflowSection 一起被删，两阶段导入整整失去落点——这里钉住它回到
// RoutineCenter，且左于「新建任务」、空列表也在。
describe('share import 渲染端入口', () => {
  const center = read('src/renderer/src/components/routine/RoutineCenter.tsx')

  it('任务中心挂 ShareImportModal，预览走 shareImportPreview 两阶段', () => {
    expect(center).toContain("import { ShareImportModal } from './ShareImportModal'")
    expect(center).toContain('<ShareImportModal')
    expect(center).toContain('shareImportPreview()')
    // 括号内的消毒失败要冒泡给用户（无 token 时 message.error 并止步）
    expect(center).toMatch(/r\.error && !r\.importToken[\s\S]{0,120}message\.error/)
    expect(center).toContain('data-action="share-import"')
    expect(center).toContain("t('share.import')")
  })

  it('导入按钮在「新建任务」左侧，且不随空列表消失（空态只剩它一颗）', () => {
    const action = center.slice(center.indexOf('data-section="tasks"'))
    const importAt = action.indexOf('data-action="share-import"')
    const createAt = action.indexOf("t('routine.createTask')")
    expect(importAt).toBeGreaterThan(-1)
    expect(createAt).toBeGreaterThan(importAt)
    // 「新建任务」仍由 cards.length 门控——空列表的创建面是卡片
    expect(center).toMatch(/cards\.length > 0 && \(\s*<Button type="primary"/)
  })

  it('关闭预览（提交或取消）都重拉列表——导入的行不必手动刷新', () => {
    expect(center).toMatch(/const closeImport = \(\): void => \{\s*setImportOpen\(false\)\s*void reload\(\)/)
    expect(center).toMatch(/onClose=\{closeImport\}/)
  })
})
