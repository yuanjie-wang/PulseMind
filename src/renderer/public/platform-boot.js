// ── Platform stamp, parsed before first paint (moved out of index.html) ──
// Sets html[data-platform='win32'] for the CSS that disables expensive
// backdrop-filter blur on Windows (see index.html's stylesheet). This MUST
// stay an external classic script: the renderer CSP carries
// `script-src 'self'` with no 'unsafe-inline' (review 2026-09-25 P1), so an
// inline boot script would never execute — and it must stay synchronous in
// <head>, before the body parses, or the blur-off rule paints one frame of
// Windows blur first. A classic <script src> blocks parsing exactly like the
// inline form did; a `type="module"` would not (deferred).
;(function () {
  document.documentElement.dataset.platform = navigator.platform.includes('Win') ? 'win32' : ''
})()
