// ── New-task mode store (PLAN-0.4.0 M8.4) ──
// The welcome page lets the user pick the form the NEXT task takes: a plain
// conversation (timestamped workspace under the global one) or a project
// conversation (the project's fixed workspace). useChatController reads this
// when it materializes the conversation row on the first message, so nothing
// is created until something is actually sent.
//
// `shake` is the 新建任务 guidance signal (user 2026-09-23): the sidebar button
// and the history list's + both land on the welcome view, and each click wiggles
// the surface the user is meant to act on next — the composer in chat mode, the
// whole project picker in project mode. It is a monotone {target, seq, at}
// triple rather than a boolean so a consumer that mounts AFTER the bump (a new
// conversation key remounts ChatView in the same click) still sees the request:
// the consumer compares against the grace window in utils/welcome-shake.ts.
// `target: null` is a cancel — the deliberate no-guide entries (项目行 新建任务
// has a preselected project, the command palette's new task is a plain one)
// bump seq with it so a just-clicked shake cannot ride their mount.

import { create } from 'zustand'

/** 新任务形态（PLAN-0.4.0 M8.4；PLAN-layout-modes 二期增 'browser'）：
 *  chat 普通对话 / project 项目对话 / browser 浏览器任务——物化会话时浏览器
 *  任务额外绑定该会话的浏览器主视图（模式跟任务走，useChatController）。 */
export type NewTaskMode = 'chat' | 'project' | 'browser'
export type NewTaskShakeTarget = 'composer' | 'projectPicker' | 'browserUrl'

export interface NewTaskShake {
  target: NewTaskShakeTarget | null
  seq: number
  /** Date.now() of the request; 0 on a cancel. */
  at: number
}

interface NewTaskState {
  mode: NewTaskMode
  /** Selected project for project mode; null = nothing picked yet. */
  projectId: string | null
  shake: NewTaskShake
  setMode: (mode: NewTaskMode) => void
  setProjectId: (projectId: string | null) => void
  requestShake: (target: NewTaskShakeTarget | null) => void
}

export const useNewTaskStore = create<NewTaskState>((set) => ({
  mode: 'chat',
  projectId: null,
  shake: { target: null, seq: 0, at: 0 },
  setMode: (mode) => set({ mode }),
  setProjectId: (projectId) => set({ projectId }),
  requestShake: (target) => set((s) => ({ shake: { target, seq: s.shake.seq + 1, at: target === null ? 0 : Date.now() } })),
}))
