import { powerSaveBlocker } from 'electron'

/**
 * 运行期间阻止系统休眠（user request 2026-09-22，同日加开关；默认关——高级面板
 * 的开关一律默认关闭）：一个会话在干活时，机器不能睡过去把 LLM 流、工具调用和
 * 日常任务批量行掐断。设置 → 高级 → 「运行期间阻止休眠」
 * （settings.keepAwakeEnabled，保存即生效）。
 *
 * 三个裁定值得写下来：
 * - 范围是「正在工作」，不是「回合未结束」。awaiting_approval / awaiting_user_input /
 *   awaiting_extension / awaiting_continue 都是等用户决策的停靠——用户可能已经走人，
 *   为一个没人回答的问题把机器亮一整晚是错的；用户回来一按，引擎回到
 *   executing，这里立刻重新持有。retrying / queued 是回合自己的间隙（退避重试、
 *   等并发槽位），算运行。
 * - 用 'prevent-app-suspension' 而不是防止屏幕休眠那一档：屏幕可以关
 *   （无人值守的例行任务恰恰不需要亮屏），系统不能睡。
 * - 开关关掉只停止「持有」，不停止「记账」：active 表照常跟踪，所以任务运行
 *   中途关掉立即释放，重新打开时若有会话还在跑就立刻回补——不依赖下一次
 *   状态变化才生效。
 *
 * 挂钩点在 session-manager（makeCallbacks 的 onStatusChanged、ask 的排队 emit、
 * engineCall 'dispose'）——那是所有托管会话（桌面聊天、专家、子代理、例行任务、
 * 插件托管会话）状态变化的必经之路。
 */

/** 引擎处于这些状态时持有休眠阻止器。白名单而不是黑名单：一个未来新增的
 *  停靠状态宁可放机器睡，也不能把机器钉在常亮。 */
export const KEEP_AWAKE_ACTIVE_STATUSES: ReadonlySet<string> = new Set(['streaming', 'executing', 'retrying', 'queued'])

function startBlocker(): number | null {
  try {
    // Guarded, not assumed: the module is also imported under vitest (stubbed
    // electron) and under the probe bundles' own electron stubs — a stub
    // without powerSaveBlocker must degrade to a no-op, not break the status
    // path this is wired into.
    if (typeof powerSaveBlocker?.start !== 'function') return null
    return powerSaveBlocker.start('prevent-app-suspension')
  } catch (err) {
    console.warn('[KeepAwake] powerSaveBlocker.start failed:', err)
    return null
  }
}

export class KeepAwakeGuard {
  /** sessionId → the active status that put it here. One engine per session,
   *  one status at a time, so membership IS the refcount. */
  private active = new Map<string, string>()
  /** Intent, not the OS handle: held even when startBlocker() returned null
   *  (stubbed runtime), so the state machine still transitions exactly once. */
  private holding = false
  private blockerId: number | null = null
  /** The 设置 → 高级 master switch. Default OFF (every toggle in the 高级
   *  panel defaults off) — the pre-seed value mirrors the product default, so
   *  even a missed push cannot hold the machine against the ruling. Pushed at
   *  startup (index.ts) and on every settings save (settings.handler).
   *  Flipping does NOT clear `active` — see the module comment's third ruling. */
  private enabled = false

  /** 推入开关值（启动初值 + 每次设置保存）。false 立即释放；true 在仍有
   *  运行中的会话时立即回补。 */
  setEnabled(value: boolean): void {
    if (value === this.enabled) return
    this.enabled = value
    console.log(`[KeepAwake] 阻止休眠开关：${value ? '开启' : '关闭'}`)
    this.sync()
  }

  /** One engine status change = one call. Holding is decided by whether ANY
   *  session is currently in an active status (and the switch is on); a session
   *  moving between two active statuses must not re-start the blocker, and the
   *  last one leaving must release it. */
  update(sessionId: string, status: string): void {
    if (KEEP_AWAKE_ACTIVE_STATUSES.has(status)) this.active.set(sessionId, status)
    else this.active.delete(sessionId)
    this.sync()
  }

  /** The session is gone (engineCall 'dispose'). Its last status must not pin
   *  the blocker — dispose may fire while the engine's final notify still says
   *  executing, and no further status event will ever arrive to clear it. */
  forget(sessionId: string): void {
    if (this.active.delete(sessionId)) this.sync()
  }

  private sync(): void {
    const should = this.enabled && this.active.size > 0
    if (should === this.holding) return
    this.holding = should
    if (should) {
      this.blockerId = startBlocker()
      console.log(`[KeepAwake] 阻止系统休眠（${this.active.size} 个会话运行中）`)
    } else {
      const id = this.blockerId
      this.blockerId = null
      try {
        if (id !== null && powerSaveBlocker?.isStarted?.(id)) powerSaveBlocker.stop(id)
      } catch {
        /* best-effort release */
      }
      console.log('[KeepAwake] 恢复系统休眠（开关关闭或无运行中的会话）')
    }
  }

  /** Diagnostics (tests / future surfaces). */
  isHolding(): boolean {
    return this.holding
  }

  isEnabled(): boolean {
    return this.enabled
  }

  activeCount(): number {
    return this.active.size
  }
}

export const keepAwake = new KeepAwakeGuard()
