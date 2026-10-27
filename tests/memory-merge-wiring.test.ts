// 页面编译 sweep 的配置播种（PLAN-memory-wiki M6，2026-10-25）——纪律自旧
// 合并层 wiring（2026-10-09「95 条记忆不压缩」根因）原样移植：编译读
// MemoryManager 实例字段，主进程 sweep 必须先 resolve + seed 再编译；
// setConfig 在编译飞行中拒绝换配置。旧机器（runMemoryMergeSweep/
// MemoryCompressionAgent/memoryMergeWatermark 写入）整体退役。
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(__dirname, '..')
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8')

const sessionManager = read('src/main/agent/session-manager.ts')
const managerSrc = read('src/renderer/src/memory/MemoryManager.ts')

function functionBody(source: string, signature: string): string {
  const start = source.indexOf(signature)
  expect(start).toBeGreaterThanOrEqual(0)
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

describe('页面编译 sweep 接线（主进程唯一 owner）', () => {
  it('启动 3 分钟定时器 + sweep 自身先 resolve → seed → 编译（顺序不变量）', () => {
    expect(sessionManager).toContain('runMemoryCompileSweep()')
    const body = functionBody(sessionManager, 'async runMemoryCompileSweep(profile?: LlmProfile): Promise<boolean>')
    const resolve = body.indexOf('await this.resolveActiveLlmProfile()')
    const seed = body.indexOf('this.seedLlmConfig(memoryManager, p)')
    const compile = body.indexOf('await memoryManager.ensurePagesCompiled()')
    expect(resolve).toBeGreaterThan(-1)
    expect(seed).toBeGreaterThan(resolve)
    expect(compile).toBeGreaterThan(seed)
  })

  it('watermark 双向：seed 读 memoryCompileWatermark，sweep 每次触碰落盘', () => {
    const seed = functionBody(sessionManager, 'private seedCompileWatermark(memoryManager: MemoryManager, settings: AppSettings)')
    expect(seed).toContain('settings.memoryCompileWatermark')
    expect(sessionManager).toContain('memoryCompileWatermark:')
    expect(sessionManager).toContain('this.seedCompileWatermark(this.managers.memoryManager, startupSettings)')
  })

  it('seedLlmConfig 转发完整 profile；setConfig 飞行中拒换（中4/中5 纪律移植）', () => {
    const seed = functionBody(sessionManager, 'private seedLlmConfig(memoryManager: MemoryManager, profile: LlmProfile)')
    for (const frag of ["profile.apiKey ?? ''", 'profile.baseURL', "createLlmAdapter(profile.provider ?? 'anthropic')", 'profile.model', 'profile.maxTokens']) {
      expect(seed).toContain(frag)
    }
    expect(managerSrc).toContain('if (this._compiling) return')
  })

  it('旧机器退役：runMemoryMergeSweep / ensureMemoryMerged / MemoryCompressionAgent 全库无引用', () => {
    for (const banned of ['runMemoryMergeSweep', 'ensureMemoryMerged', 'MemoryCompressionAgent', 'setMergeWatermark', 'getMergeWatermark']) {
      expect(sessionManager).not.toContain(banned)
      expect(managerSrc).not.toContain(banned)
    }
  })
})
