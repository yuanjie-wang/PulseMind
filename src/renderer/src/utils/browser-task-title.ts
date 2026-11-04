// ── 浏览器任务空态里的「页名」──
// 零消息的浏览器任务容器没有可提炼的标题（auto-title 不参与），开场白要指
// 名道姓就只能读 pane 快照：标题先到就用标题，标题未落（SPA 首帧、about:blank）
// 就退回域名，两者都没有就返回 null——调用方据此显示「正在打开」，而不是编
// 一个名字。

/** 标题 → 域名（去 www.）→ null。about:blank / 空串都落到 null。 */
export function browserTaskDisplayName(title: string | null | undefined, url: string | null | undefined): string | null {
  const heading = (title ?? '').trim()
  if (heading) return heading
  const raw = (url ?? '').trim()
  if (!raw) return null
  try {
    const host = new URL(raw).hostname.replace(/^www\./, '')
    return host || null
  } catch {
    return null
  }
}
