import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/** 记忆防重（2026-11-12）：合并组语义 + 写时正文撞重门。
 *
 *  `applyPageOps` / `upsertMemoryPage` 需要真表才能跑，而 better-sqlite3 是
 *  Electron-ABI，vitest 起不了库——所以这里钉源码接线，真库行为（同批 supersede
 * 只建一页、撞重真被顶回）由 `scripts/probe-memory-dedup.mjs` 断言。
 *  纯逻辑面（id 寻址、撞名 ignoreIds、歧义 target）已在
 *  `memory-pages-store.test.ts` / `memory-compile-pass.test.ts` 覆盖。 */

const store = readFileSync(new URL('../src/main/storage/memory-pages-store.ts', import.meta.url), 'utf8')

describe('正文撞重门（P1）', () => {
  it('门函数只认活页，且有最短正文门槛（样板话重合是噪声，不设门）', () => {
    expect(store).toContain('function findLivePageByBodyHash')
    expect(store).toContain('const BODY_HASH_GATE_MIN_CHARS = 24')
    expect(store).toContain('if (normalizeMemoryContent(body).length < BODY_HASH_GATE_MIN_CHARS) return null')
    expect(store).toContain('WHERE content_hash = ? AND superseded_by IS NULL AND retired_at IS NULL')
  })

  it('CREATE 与 supersede 都抛错拒插（正文相同的新页只是同一事实的第二个副本）', () => {
    // 两条「正文撞重: …」错误：create 一条、supersede 一条
    expect(store.match(/正文撞重: /g)?.length).toBeGreaterThanOrEqual(2)
    expect(store).toContain('dupBody) throw new Error(`正文撞重')
  })

  it('supersede 豁免自身与同组旧页（否则并回同名标题时第一个 op 就撞自己）', () => {
    expect(store).toContain('findLivePageByBodyHash(newBody, [targetId, ...groupIds])')
  })

  it('upsert 不抛错：跳过并返回既有页（启动期迁移不能崩），且不丢弃事务返回值', () => {
    expect(store).toContain('allowDuplicateBody')
    expect(store).toContain('duplicate body skipped')
    // 撞重短路的值必须被外层接住，否则会去查那个从未插入的新 id
    expect(store).toContain('return write() ?? getMemoryPageById(id)!')
  })
})

describe('supersede 合并组（P0-4）', () => {
  it('首个 op 建页后注册组；后续 op 只给旧页写 superseded_by，不再各建一页', () => {
    expect(store).toContain('ctx.groupOf.set(groupKey, newId)')
    expect(store).toContain('const existingGroupNewId = ctx.groupOf.get(groupKey)')
    expect(store).toContain("database.prepare('UPDATE memory_pages SET superseded_by = ?, updated_at = ? WHERE id = ?').run(existingGroupNewId, now, joinTargetId)")
  })

  it('只在同组真的有多页时才注册（单页 supersede 走老路径）', () => {
    expect(store).toContain('if ((ctx.groupTargets.get(groupKey) ?? []).length > 1) ctx.groupOf.set(groupKey, newId)')
  })

  it('合并组短路排在撞名检查之前——否则第一个 op 建出的新页立刻挡住第二个 op', () => {
    const joined = store.indexOf('const existingGroupNewId')
    const collide = store.indexOf('const collisions = findNameCollisions(index, { title: newTitle')
    expect(joined).toBeGreaterThan(0)
    expect(collide).toBeGreaterThan(0)
    expect(joined).toBeLessThan(collide)
  })

  it('撞名检查豁免同组旧页（ignoreIds）', () => {
    expect(store).toContain('ignoreId: targetId, ignoreIds')
  })
})

describe('合并组自环守卫（review 2026-11-12 P3，实为 P2：静默 + 可达）', () => {
  it('join 前用批前快照重解析：target 解析到本组新页时不能写 superseded_by = 自身', () => {
    // 新页 updated_at = now 在索引里排第一，而规范标题常常就是某个成员的既有标题——
    // 那个 op 的裸标题会在本批索引里解析到新页自身（自环：目录看不见、recall 搜得到）
    expect(store).toContain('headIndex: PageIndexEntry[]')
    expect(store).toContain('{ groupOf, groupTargets, headIndex }')
    expect(store).toContain('if (joinTargetId === existingGroupNewId)')
    expect(store).toContain('const reResolved = resolvePageByRef(ctx.headIndex, targetRef)')
    expect(store).toContain('合并组 target 指向新页')
  })

  it('join 不再把 targetId 直接写进 UPDATE（那正是自环的来源）', () => {
    expect(store).not.toContain('run(existingGroupNewId, now, targetId)')
    expect(store).toContain('if (!reResolved || reResolved === existingGroupNewId)')
  })

  it('join 并入第 2..N 个 op 的 aliases/links 并同步 FTS（否则检索面静默缩水）', () => {
    expect(store).toContain('mergeUniqueNocase(groupPage.aliases, newAliases)')
    expect(store).toContain('mergeUniqueNocase(groupPage.links, [...(op.links ?? []), joinTarget.title])')
    expect(store).toContain('ftsUpsert({ id: existingGroupNewId')
  })

  it('files 并集按 path 去重（join 不并集 = 继任页丢脚本、maturity 掉回 narrative）', () => {
    expect(store).toContain('mergePageFiles(groupPage.files, joinTarget.files, newFiles)')
    expect(store).toContain('function mergePageFiles(...groups: Array<MemoryPageFile[] | null | undefined>): MemoryPageFile[]')
    expect(store).toContain('if (f && !seen.has(f.path)) seen.set(f.path, f)')
  })
})

describe('经验成员的取代链分流（review 2026-11-12 P2 修复）：experience_uses 不许进错页', () => {
  it('join 臂（新页非经验）对经验成员不写 memory_pages UPDATE——那行不存在，落 0 行就是静默不挂链', () => {
    expect(store).toContain("if (joinTarget.type !== 'experience') {\n        database.prepare('UPDATE memory_pages SET superseded_by = ?, updated_at = ? WHERE id = ?').run(existingGroupNewId, now, joinTargetId)")
    expect(store).toContain('if (joinTarget.type === \'experience\') {\n      ensureExperienceUses(joinTargetId, { updatedAt: now })\n      markExperienceSuperseded(joinTargetId, existingGroupNewId)')
  })

  it('join 臂（新页是经验）对非经验成员走 memory_pages 而不是 experience_uses——那表是 isExperienceId 的判定面', () => {
    const body = store.slice(store.indexOf('if (groupPage.type === \'experience\') {'))
    expect(body).toContain("let dbJoinTargetId: string | null = null")
    expect(body).toContain("dbJoinTargetId = joinTargetId")
    expect(body).toContain("database.prepare('UPDATE memory_pages SET superseded_by = ?, updated_at = ? WHERE id = ?').run(existingGroupNewId, now, dbJoinTargetId)")
  })

  it('getMemoryPageById 磁盘胜：经验残留行让位磁盘真源（与 listPageIndex 同一口径）', () => {
    expect(store).toContain("if (row && row.type !== 'experience') return rowToRecord(row)")
  })

  it('检索排经验残留行；type=experience 显式检索走磁盘活页并按 LIKE 档打分', () => {
    expect(store).toContain("if (record.type === 'experience') continue")
    expect(store).toContain("const diskScores = new Map<string, number>()")
    expect(store).toContain("if (input.type === 'experience') {")
    expect(store).toContain("diskScores.set(rec.id, headHit ? LIKE_HEAD_SCORE : LIKE_FALLBACK_SCORE)")
    // ids 为空不再一刀切早退（否则纯磁盘池上的经验检索永远拿空）
    expect(store).toContain("if (ids.length === 0 && input.type !== 'experience') return []")
  })

  it('检索记账跟真源：磁盘经验进 experience_uses，DB UPDATE 只写给非经验', () => {
    expect(store).toContain("if (h.record.type === 'experience') continue\n      stmt.run(now, h.record.id)")
    expect(store).toContain("for (const h of limited) if (h.record.type === 'experience') touchExperienceUse(h.record.id)")
  })
})
