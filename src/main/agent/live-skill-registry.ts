// ── 共享 SkillManager 的活体登记口（2026-11-04，UI zip 导入场景）──
// ensureManagers 只在首个会话创建时扫一次盘（listImported），此后主进程共享
// 注册表不再看磁盘。UI 的 zip 导入/删除若只动盘（skills.handler 原状），引
// 擎侧 pick_skill 要到重启才能看见；delete 更糟——freshSkillDefinition 在文
// 件消失后回落注册表旧副本（tool-executors.ts），一个已删除的技能在对话里
// 继续吐全文。IPC handler 不能反向 import session-manager（会拖入整条
// better-sqlite3 链），这里用与 client-registry 同形的绑定式小模块：
// ensureManagers 装配完把共享 manager 绑进来，handler 只对「已装配」的注
// 册表做增量；未装配时 no-op——之后第一次 ensureManagers 的 listImported
// 自然覆盖盘上的新技能。
//
// 对话内 install 工具不经过这里：它在引擎进程里直接 registerSkill+enable
// （executors/install-tool.ts），两个安装门保持同一对调用、同一行为。

import type { SkillManager } from '../../renderer/src/skills/SkillManager'
import type { SkillDefinition } from '../../shared/types/skill-types'

let liveManager: SkillManager | null = null

/** ensureManagers 装配共享 managers 时的绑定点。 */
export function bindLiveSkillManager(manager: SkillManager | null): void {
  liveManager = manager
}

/**
 * zip 导入后的登记。registerSkill 对同名已注册项返回 false 且保留其原
 * enabled 态，所以必须补一次 enable——与 install 工具的引擎内登记同一对
 * 调用，两个安装门行为一致。
 */
export function registerLiveSkills(defs: SkillDefinition[]): void {
  if (!liveManager) return
  for (const def of defs) {
    liveManager.registerSkill(def)
    liveManager.enable(def.name)
  }
}

/**
 * UI 删除已导入技能后的摘除。内置技能（builtIn）被 FeatureManager.unregister
 * 拒绝——删除门本就只该作用于导入技能（zip 侧对盘上同名目录也是「already
 * exists — skipped」，不存在覆盖内置的路径）。
 */
export function unregisterLiveSkill(name: string): void {
  liveManager?.unregister(name)
}
