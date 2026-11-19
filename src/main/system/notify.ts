// 桌面通知（best-effort）：主进程里唯一的实现，routine-runner 与
// pipeline-engine 共用。抽成独立模块的直接原因：pipeline-engine 在单测里被
// 真实加载，而 routine-runner 的模块图拉着 better-sqlite3（Electron ABI）——
// 引擎只为一条「工作流跑完了」的通知去 import 它，会把整条运行链拖进 native
// 依赖，vitest 当场加载失败。

import { BrowserWindow, Notification } from 'electron'

/** Best-effort desktop notification；点击把主窗口拉到前台。
 *  不支持/抛错都静默——通知不是任何结算路径的前置条件。 */
export function notify(title: string, body: string): void {
  try {
    if (!Notification.isSupported()) return
    const notification = new Notification({ title, body })
    notification.on('click', () => {
      const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed())
      if (win) {
        if (win.isMinimized()) win.restore()
        win.show()
        win.focus()
      }
    })
    notification.show()
  } catch {
    /* notifications are best-effort */
  }
}
