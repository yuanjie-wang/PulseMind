// ── New-task mode store (PLAN-0.4.0 M8.4) ──
// The welcome page lets the user pick the form the NEXT task takes: a plain
// conversation (timestamped workspace under the global one) or a project
// conversation (the project's fixed workspace). useChatController reads this
// when it materializes the conversation row on the first message, so nothing
// is created until something is actually sent.

import { create } from 'zustand'

export type NewTaskMode = 'chat' | 'project'

interface NewTaskState {
  mode: NewTaskMode
  /** Selected project for project mode; null = nothing picked yet. */
  projectId: string | null
  setMode: (mode: NewTaskMode) => void
  setProjectId: (projectId: string | null) => void
}

export const useNewTaskStore = create<NewTaskState>((set) => ({
  mode: 'chat',
  projectId: null,
  setMode: (mode) => set({ mode }),
  setProjectId: (projectId) => set({ projectId }),
}))
