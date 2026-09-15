/** Content-script entry point: the in-page panel host (PLAN-browser-extension M1.2).
 *
 * Creates one host element with a Shadow Root, hands it to React, and relays
 * worker notifications into the UI. The host is created inside the isolated
 * world, so the page can neither read nor restyle the panel, and React needs no
 * second injection into the page's main world.
 *
 * The DOM pipeline (M2) must skip this subtree — it is marked with
 * `data-pulsemind-panel` and `content/page-tree.ts` will exclude it. */

import { createRoot } from 'react-dom/client'
import markdownTheme from '@ant-design/x-markdown/themes/light.css'
import { App } from '../ui/App'
import styles from '../ui/styles.css'
import { listen } from './bridge'

const HOST_FLAG = 'data-pulsemind-panel'

/** Guard against double-mount (an extension reload can re-inject into a page
 *  whose content script is still alive). */
function existingHost(): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[${HOST_FLAG}]`)
}

function mount(): void {
  const previous = existingHost()
  if (previous) {
    // Re-injection after an extension reload: drop the stale mount (its chrome
    // APIs belong to the previous context) and build a fresh one.
    previous.remove()
  }

  const host = document.createElement('div')
  host.setAttribute(HOST_FLAG, '')
  // The host itself must not affect the page's layout at all.
  host.style.cssText = 'all: initial; position: fixed; z-index: 2147483647;'
  const shadow = host.attachShadow({ mode: 'open' })

  // The transcript's markdown carries the chat's own class (`x-markdown-light`)
  // and the desktop gets its rules from `@ant-design/x-markdown/themes/light.css`
  // — the very same file, bundled as text here. Importing the CSS rather than
  // copying it is what keeps markdown identical while the theme package moves.
  //
  // Order is load-bearing: the theme goes in first, our stylesheet second, so a
  // correction of ours (a wide table that must scroll inside the panel) wins the
  // tie against the theme's own rule for the same element.
  const themeEl = document.createElement('style')
  themeEl.textContent = markdownTheme
  shadow.appendChild(themeEl)

  const styleEl = document.createElement('style')
  styleEl.textContent = styles
  shadow.appendChild(styleEl)

  const rootEl = document.createElement('div')
  rootEl.className = 'pm-root'
  shadow.appendChild(rootEl)

  // <html> can be absent on some XML-ish documents; body is required by manifest
  // (all_frames default false, document_idle) so it exists for http(s).
  document.body.appendChild(host)

  listen()
  createRoot(rootEl).render(<App />)
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', mount, { once: true })
} else {
  mount()
}
