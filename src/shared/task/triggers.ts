// ── 任务事件触发的共享词表（两种任务家族同一套）──
// The webhook route is a contract between three places that used to hardcode
// it independently: the main-side listener (task-triggers), the editor copy
// that shows the fire URL, and the tests. One table, so a renamed route can
// never land on only one side. `kind` matches the wizard's kind and the
// manager's task key family.

export type TaskKind = 'routine' | 'workflow'

/** URL path segment per family: /routine/<id>/fire · /workflow/<id>/fire. */
export const TASK_TRIGGER_PATH: Record<TaskKind, string> = {
  routine: 'routine',
  workflow: 'workflow',
}

/** The full loopback fire URL, or null when the pieces are not all there yet
 *  (draft without an id, no token minted, port not resolved). The editor shows
 *  the copy button only for a non-null URL. */
export function taskWebhookUrl(kind: TaskKind, id: string, port: number, token: string): string | null {
  if (!id || !token || port <= 0) return null
  return `http://127.0.0.1:${port}/${TASK_TRIGGER_PATH[kind]}/${id}/fire?token=${token}`
}
