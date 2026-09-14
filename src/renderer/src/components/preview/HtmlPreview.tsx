// ── HTML renderer for the preview pane (PLAN-preview-pane D8) ──
// Sandboxed iframe pointed at the local-file:// protocol: scripts run, no
// same-origin (no same-origin DOM/cookie access), subresources (relative
// css/js/img) load through the protocol. Requires the CSP `frame-src
// local-file:` opened in index.html. `reloadTick` remounts the frame so an
// agent edit shows up without a manual refresh.

import React from 'react'

export function HtmlPreview({ path, reloadTick }: { path: string; reloadTick: number }): React.ReactElement {
  const src = `local-file://${path.replace(/\\/g, '/')}`
  return (
    <iframe
      key={reloadTick}
      src={src}
      sandbox="allow-scripts"
      title="preview"
      style={{ display: 'block', width: '100%', height: '100%', border: 'none', background: '#fff' }}
    />
  )
}
