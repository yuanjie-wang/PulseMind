import React from 'react'
import ReactDOM from 'react-dom/client'
import { App as AntdApp } from 'antd'
import App from './App'
import { PopoutApp } from './popout/PopoutApp'
import { parsePopoutParam, parseProjectParam } from './popout/boot'
import { loadAndApplyPopoutSeed } from './popout/seed'
import { applyThemePreference, installThemeVars, readThemeMirror } from './theme/dom'
import { setThemeMode } from './theme/mode'
import { resolveThemePreference } from './theme/palette'

// Theme before React: the CSS variable sheet must exist for the first paint,
// and a dark session must not flash light while settings load over IPC — the
// mirror (written on every apply in AppContent) carries the previous session's
// preference. The mode store is primed from the same resolution so the first
// render already picks the dark markdown class and the dark Prism style;
// AppContent re-applies both with the real settings once they arrive.
installThemeVars()
const bootThemePref = readThemeMirror()
if (bootThemePref) {
  const systemDark = window.matchMedia('(prefers-color-scheme: dark)').matches
  applyThemePreference(bootThemePref, systemDark)
  setThemeMode(resolveThemePreference(bootThemePref, systemDark))
}

// Secondary windows (PLAN-conversation-popout): the window loads this same
// entry with ?popout=<convId> (a conversation popout) or ?project=<projectId>
// (an immersive project window) and boots the reduced app. Both ride the same
// root component — the project window is the popout bound to a project instead
// of a fixed conversation. The parse also arms the IS_POPOUT /
// IS_PROJECT_WINDOW flags for the few bindings that branch on them.
const popout = parsePopoutParam()
const project = parseProjectParam()

function renderRoot(): void {
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      {/* App's body hooks call AntdApp.useApp() (useChatController toasts), but the
          <AntdApp> App renders in its own JSX is a DESCENDANT of those call sites —
          context lookup never sees it. This root provider is the one they resolve;
          component={false} keeps the DOM byte-identical (Fragment, no wrapper div). */}
      <AntdApp component={false}>
        {project ? (
          <PopoutApp projectId={project.projectId} />
        ) : popout ? <PopoutApp convId={popout.convId} /> : <App />}
      </AntdApp>
    </React.StrictMode>,
  )
}

if (popout) {
  // 2026-10-31 裁定「弹出携带侧边窗口的打开状态」：donor 在 popoutOpen 时把
  // 工作台开态 + 预览文件页签交给主进程的内存登记表，这里在 React 挂载之前
  // 取回播种——WorkbenchPane/页签条首帧即复原，useBrowserPaneBinding 的首次
  // pane-state 推送就带正确的 browserActive。窗口本身 show:false 到
  // ready-to-show，这段取种等待用户不可见；取种失败照常渲染（关态启动 =
  // 旧行为）。种子只走这条链，不落任何持久化。
  loadAndApplyPopoutSeed(popout.convId).then(renderRoot)
} else {
  renderRoot()
}
