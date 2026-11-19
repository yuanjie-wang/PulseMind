/**
 * media 权限门（PLAN-voice-input §3.5）。
 *
 * 收窄纪律：今天全仓没有 permission handler = 默认全放行——本刀**只收
 * `media` 一项**（麦克风），其余 permission 原样放行，防止打破 webview /
 * 通知 / 剪贴板等现状。media 的放行条件：
 *   - 仅自身 origin（file:// 打包态 / dev URL / local-file: 协议）；
 *   - mac 走 systemPreferences.askForMediaAccess('microphone')（系统 TCC 弹窗）；
 *   - win/linux 无系统级弹窗，getUserMedia 的许可语义就是 Chromium 自己的。
 *
 * install 前 idempotent：defaultSession 是全局的，重复 install 会顶掉前一次
 * 的 handler（第二次还闭包了新的 deny 集）——用模块级标志挡住。
 */

import { session, systemPreferences } from 'electron'

let installed = false

export function isOwnOrigin(url: string): boolean {
  try {
    const u = new URL(url)
    // file://（打包态）、app://（M0 门 6 的备选加载协议）、local-file:（自建协议）
    if (u.protocol === 'file:' || u.protocol === 'app:' || u.protocol === 'local-file:') return true
    // dev 态 Vite HMR（ELECTRON_RENDERER_URL）
    if ((u.protocol === 'http:' || u.protocol === 'https:') && (u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]')) return true
    return false
  } catch {
    return false
  }
}

export function installMediaPermissionHandlers(): void {
  if (installed) return
  installed = true
  const ses = session.defaultSession

  // 首次授权：renderer 的 getUserMedia 触发。media 以外的 permission 维持放行。
  ses.setPermissionRequestHandler((_wc, permission, callback, details) => {
    if (permission === 'media') {
      const origin = details.requestingUrl ?? ''
      if (!isOwnOrigin(origin)) {
        callback(false)
        return
      }
      if (process.platform === 'darwin' && typeof systemPreferences?.askForMediaAccess === 'function') {
        // mac 的 TCC 门：系统弹窗问一次用户；拒绝 → false，之后 getUserMedia 直接 NotAllowedError
        void systemPreferences
          .askForMediaAccess('microphone')
          .then((granted) => callback(!!granted))
          .catch(() => callback(false))
        return
      }
      callback(true)
      return
    }
    // 现状：默认全放行（本刀不收窄其它 permission）
    callback(true)
  })

  // 已授权检查（Chromium 会先问这个再决定要不要走 request 流程）
  ses.setPermissionCheckHandler((_wc, permission, requestingOrigin) => {
    if (permission === 'media') return isOwnOrigin(requestingOrigin)
    // 现状：默认放行
    return true
  })
}
