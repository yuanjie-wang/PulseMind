// 记忆合并的配置播种（2026-10-09，95 条记忆不压缩的根因修复）。
//
// 实测：库里有 95 条可合并记忆（> MERGE_TOTAL_CAP=50，due 恒真），
// settings.json 里 memoryMergeWatermark 整个不存在——说明 ensureMemoryMerged
// 连一次「尝试」都没发生过（尝试会在 LLM 调用前盖 lastAttemptAt，
// runMemoryMergeSweep 会把裸尝试也落盘）。死因在守卫第一行：
//   if (this._compressing || !this.adapter || !this.apiKey) return false
// 合并读实例字段，而 M1.4 主进程托管后唯一干活的 MemoryManager
// （session-manager 里 new 的那个）从未被 setConfig——全仓库唯一调用点
// App.tsx:396 配置的是渲染进程自己的实例。提取不受影响：extractAndSaveAll
// 的 apiKey/baseURL/adapter/model 是参数传入的，这正是「提取正常、合并死」
// 的不对称根源。渲染侧的 App.tsx 启动合并触发因此也是僵尸路径（且它的
// 水印只在渲染实例内存里，主进程落盘逻辑永远看不到；主进程 sweep 修活后
// 它还会变成跨进程双跑竞态）——一并删除，合并只留主进程一个 owner。
//
// 跨文件契约，vitest 无法用真进程验证，按 wiring-scan 惯例钉源码形状。

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(__dirname, '..')
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8')

/** 抽取一个函数体（按签名起点到大括号配平），签名变了就红——防扫描空转。 */
function functionBody(source: string, signature: string): string {
  const start = source.indexOf(signature)
  expect(start).toBeGreaterThanOrEqual(0) // 签名不存在 = 契约被改名，直接红
  const open = source.indexOf('{', start)
  let depth = 0
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}') {
      depth--
      if (depth === 0) return source.slice(start, i + 1)
    }
  }
  throw new Error('unbalanced braces')
}

describe('memory merge LLM-config seeding (main-side owner)', () => {
  const sessionManager = read('src/main/agent/session-manager.ts')

  it('runMemoryMergeSweep seeds setConfig onto the manager BEFORE ensureMemoryMerged', () => {
    const body = functionBody(sessionManager, 'async runMemoryMergeSweep(profile?: LlmProfile)')
    const seed = body.indexOf('memoryManager.setConfig(')
    const merge = body.indexOf('memoryManager.ensureMemoryMerged()')
    expect(seed).toBeGreaterThan(-1)
    expect(merge).toBeGreaterThan(seed)
  })

  it('startup sweep falls back to the active profile when no session profile is given', () => {
    const body = functionBody(sessionManager, 'private async resolveActiveLlmProfile()')
    // 与 api-proxy 同一解析序：activeProfileId 命中，否则第一条。
    expect(body).toContain("settings.profiles.find((p) => p.id === settings.activeProfileId) ?? settings.profiles[0]")
  })

  it('the afterSession sweep passes the session profile (conversation-pinned model wins)', () => {
    expect(sessionManager).toMatch(/runMemoryMergeSweep\(profile\)\.catch\(/)
  })

  it('App.tsx no longer triggers the merge or configures MemoryManager (zombie path removed)', () => {
    const app = read('src/renderer/src/App.tsx')
    expect(app).not.toContain('ensureMemoryMerged')
    expect(app).not.toContain('memoryManager.setConfig(')
    // 知识编译仍在渲染例试图走这条配置——不能顺手误删。
    expect(app).toContain('knowledgeManager.setConfig(')
  })
})
