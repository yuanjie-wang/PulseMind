/** P1-B 接线护栏（2026-11-17）。
 *
 *  `lastCompaction` 本身是 public 的 observable state，缺的只是「冷启动时的
 *  carrier」：压缩事实必须落库（database.ts 补列 + conversation.db 的 set/get +
 *  session-manager 在 onCompaction 里写、在建引擎时读）。这三段散在三个文件里，
 *  没有任何运行时的类型约束把它们绑在一起——任一环被删掉都不会报错，只会让重启
 *  后的会话静默退回压缩前水位。所以按项目对 main 侧接线的既定测法扫源码（见
 *  staged-queue-wiring.test.ts）。
 *
 *  这里额外钉「顺序」：写库必须发生在 emit 之前。反过来的话，客户端先拿到事件、
 *  事实后落库，中间崩溃就永久丢掉了可恢复的那一半。 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const read = (rel: string): string => readFileSync(resolve(process.cwd(), rel), 'utf8')

const DATABASE = read('src/main/storage/database.ts')
const CONV_DB = read('src/main/storage/conversation.db.ts')
const SESSIONS = read('src/main/agent/session-manager.ts')

describe('P1-B lastCompaction 冷恢复接线', () => {
  it('conversations 表有 last_compaction 列（走 ALTER 补列）', () => {
    expect(DATABASE).toMatch(/ALTER TABLE conversations ADD COLUMN last_compaction TEXT/)
  })

  it('conversation.db 导出 setter 与 getter，签名带 null 语义', () => {
    expect(CONV_DB).toMatch(/export function setLastCompaction\(id: string, event: CompactionEvent \| null\): void/)
    expect(CONV_DB).toMatch(/export function getLastCompaction\(id: string\): CompactionEvent \| null/)
  })

  it('getter 把坏数据当缺席，不把解析异常抛给建引擎的调用方', () => {
    const at = CONV_DB.indexOf('export function getLastCompaction')
    expect(at).toBeGreaterThan(-1)
    const getter = CONV_DB.slice(at, CONV_DB.indexOf('export function setLastCompaction'))
    expect(getter).toMatch(/catch \{\s*return null\s*\}/)
  })

  it('setter 走 stub-insert 契约，但 null 不建行（stub 只收字符串绑定）', () => {
    const setter = CONV_DB.slice(CONV_DB.indexOf('export function setLastCompaction'))
    expect(setter).toMatch(/if \(r\.changes === 0 && json\)/)
    expect(setter).toMatch(/stubInsertConversation\(id, \{ last_compaction: json \}\)/)
  })

  it('建引擎后立刻读回，早于任何请求', () => {
    const at = SESSIONS.indexOf('const engine = new AgentEngine(')
    expect(at).toBeGreaterThan(-1)
    expect(SESSIONS.slice(at, at + 600)).toMatch(/engine\.lastCompaction = getLastCompaction\(sessionId\)/)
  })

  // 按花括号配对切出 handler 体：字符窗口（曾经的 at + 500）会随注释行数漂移——
  // 2026-11-17 给 onCompaction 加 try/catch 和说明，就把这条断言自己撑破了。配对提取
  // 对注释、缩进、try/catch 都免疫，钉的仍是「同一个 handler 内」。这一段里字符串中的
  // ${…} 与 { type: … } 都成对出现，净深度不变。
  function handlerBody(source: string, from: number): string {
    const open = source.indexOf('{', from)
    expect(open, 'handler must have a body').toBeGreaterThan(-1)
    let depth = 0
    for (let i = open; i < source.length; i++) {
      if (source[i] === '{') depth++
      else if (source[i] === '}' && --depth === 0) return source.slice(open, i + 1)
    }
    throw new Error('unbalanced handler body')
  }

  it('onCompaction 先写库再 emit，且不得退回单行 emit 形式', () => {
    const at = SESSIONS.indexOf('onCompaction:')
    expect(at).toBeGreaterThan(-1)
    const body = handlerBody(SESSIONS, at)
    expect(body).toMatch(/setLastCompaction\(sessionId, event\)/)
    // 若 emit 缺席则 indexOf 为 -1，这句会失败——正是想要的
    expect(body.indexOf('setLastCompaction')).toBeLessThan(body.indexOf('this.emit('))
    expect(body).not.toMatch(/onCompaction: \(event: CompactionEvent\) => this\.emit/)
    // 本次修复的核心不变量：写库被 try 包住时，emit 必须落在 catch 之后（即不在 try 内）。
    // 反过来写就是把 UI 事件关进 try——写库一抛，catch 连它一起吃，用户看不到压缩发生。
    const catchAt = body.indexOf('} catch')
    expect(catchAt, 'persist must be guarded by try/catch').toBeGreaterThan(-1)
    expect(body.indexOf('this.emit('), 'emit must sit outside the guarded block').toBeGreaterThan(catchAt)
  })
})
