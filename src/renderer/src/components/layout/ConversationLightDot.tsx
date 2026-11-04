// ── The conversation task-status dot ──
// One dot for every ConversationLight state, shared by the sidebar rows
// (ConversationRows) and the immersive window's header conversation switcher
// (PopoutApp's projectMenu) so the two surfaces read the same status language:
// running keeps the link blue and is the only animated state — a slow opacity
// blink (no scale, no ripple; user ruling 2026-09-30: the ring read badly);
// the other three are static solid dots: the approval/ask amber (`--pm-warn`,
// the held-approval family — not the gold accent, which marked the retired
// retrying state), the api-exception red and the completed-unread green (the
// status pair from the palette: antd red-5 / green-6).

import React from 'react'
import type { ConversationLight } from '../../hooks/useConversationEngine'

export const LIGHT_DOT_COLOR: Record<ConversationLight, string> = {
  running: 'var(--pm-link)',
  waiting: 'var(--pm-warn)',
  error: 'var(--pm-error-status)',
  unread: 'var(--pm-success-status)'
}

/** The 6px dot. One shape for every state; only the running dot animates. */
export function ConversationLightDot({ light }: { light: ConversationLight }): React.ReactElement {
  return (
    <span style={{
      width: 6, height: 6, borderRadius: '50%',
      background: LIGHT_DOT_COLOR[light],
      animation: light === 'running' ? 'conv-dot-blink 2s ease-in-out infinite' : undefined
    }} />
  )
}

/** The blink keyframes, mounted once per dot-bearing surface — @keyframes is
 *  document-global and the dot itself renders many times; the surfaces live in
 *  DIFFERENT windows (main sidebar / immersive switcher), so each mounts its
 *  own copy beside its dots. */
export function ConversationLightDotStyle(): React.ReactElement {
  return (
    <style>{`
      @keyframes conv-dot-blink {
        0%, 100% { opacity: 1; }
        50% { opacity: 0.35; }
      }
    `}</style>
  )
}
