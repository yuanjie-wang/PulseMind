import { serverManager } from './MCPServerManager'

// ── Helpers ──

/** Check an MCP tool call result for success, including isError flag in the result body. */
function isMcpResultOk(r: Awaited<ReturnType<typeof serverManager.callTool>>): r is { success: true; result: { content?: Array<{ type: string; text?: string }> } } {
  if (!r.success) return false
  const body = r.result as { isError?: boolean } | undefined
  if (body?.isError) return false
  return true
}

/** Extract the first text item from an MCP tool call result. */
function extractMcpText(r: Awaited<ReturnType<typeof serverManager.callTool>>): string | null {
  if (!r.success) return null
  const body = r.result as { content?: Array<{ type: string; text?: string }>; isError?: boolean } | undefined
  if (body?.isError) return null
  for (const item of body?.content || []) {
    if (item.type === 'text' && item.text) return item.text
  }
  return null
}

/** Extract error text from an MCP tool call result (handles both transport errors and isError responses). */
function extractMcpErrorText(r: Awaited<ReturnType<typeof serverManager.callTool>>): string {
  if (!r.success && r.error) return r.error
  const body = r.result as { content?: Array<{ type: string; text?: string }> } | undefined
  if (body?.content) {
    for (const item of body.content) {
      if (item.type === 'text' && item.text) return item.text.slice(0, 200)
    }
  }
  return 'Unknown MCP error'
}

// ── Chrome MCP fetch ──

/**
 * Use Chrome DevTools MCP to navigate to URL and extract page HTML.
 * Handles MCP server lifecycle, page load polling, and cross-origin iframe fallback.
 */
export async function fetchUrlViaChromeMCP(url: string, depth = 0, signal?: AbortSignal): Promise<string | null> {
  try {
    const chromeServerId = 'chrome-devtools'
    const servers = serverManager.listServers()
    const chromeServer = servers.find(s => s.id === chromeServerId)

    // Start Chrome DevTools MCP if not connected
    if (!chromeServer || chromeServer.status !== 'connected') {
      if (!chromeServer || chromeServer.status === 'stopped') {
        await serverManager.start(chromeServerId)
      } else {
        // connecting or error — wait briefly
        for (let i = 0; i < 20; i++) {
          await new Promise(r => setTimeout(r, 500))
          const s = serverManager.listServers().find(x => x.id === chromeServerId)
          if (s?.status === 'connected') break
          if (s?.status === 'error') throw new Error(`Chrome DevTools MCP error: ${s.error}`)
        }
      }
    }

    signal?.throwIfAborted()

    // Navigate to URL (pass type='url' explicitly per MCP tool schema)
    // On "page has been closed", restart the MCP server and retry once
    let navResult: Awaited<ReturnType<typeof serverManager.callTool>>
    const doNav = () => serverManager.callTool(chromeServerId, 'navigate_page', {
      type: 'url', url, timeout: 60_000
    }, signal)
    navResult = await doNav()
    if (!isMcpResultOk(navResult) && extractMcpErrorText(navResult).includes('page has been closed')) {
      console.warn(`[ChromeFetcher] Page was closed for ${url} — restarting Chrome DevTools MCP`)
      await serverManager.stop(chromeServerId)
      await serverManager.start(chromeServerId)
      navResult = await doNav()
    }
    if (!isMcpResultOk(navResult)) {
      const errText = extractMcpErrorText(navResult)
      throw new Error(`navigate_page: ${errText}`)
    }

    signal?.throwIfAborted()

    // Wait for document.readyState === 'complete' (poll every 500ms, max 60s)
    // Also checks same-origin iframes for content
    let loaded = false
    for (let i = 0; i < 120; i++) {
      const readyResult = await serverManager.callTool(chromeServerId, 'evaluate_script', {
        function: `() => {
  const mainReady = document.readyState === 'complete' && document.body !== null
  if (!mainReady) return false
  if (document.body.textContent.trim().length > 100) return true
  for (const f of document.querySelectorAll('iframe')) {
    if ((f.offsetWidth || 0) < 100 || (f.offsetHeight || 0) < 100) continue
    try {
      const doc = f.contentDocument || (f.contentWindow && f.contentWindow.document)
      if (doc && doc.readyState === 'complete' && doc.body && doc.body.textContent.trim().length > 100) return true
    } catch (_) {}
  }
  return false
}`
      }, signal)
      const readyText = extractMcpText(readyResult)
      if (readyText) {
        try { if (JSON.parse(readyText) === true) { loaded = true; break } } catch { /* retry */ }
      }
      await new Promise(r => setTimeout(r, 500))
    }
    if (!loaded) console.warn(`[ChromeFetcher] Page load wait timed out for ${url}`)

    signal?.throwIfAborted()

    // Extra wait for dynamic content (AJAX, lazy-load) to finish rendering
    await new Promise(r => setTimeout(r, 3000))

    signal?.throwIfAborted()

    // Extract HTML (from the frame with the most content — handles iframe-based pages)
    const evalResult = await serverManager.callTool(chromeServerId, 'evaluate_script', {
      function: `() => {
  const byContent = (a, b) => (b.textContent || '').length - (a.textContent || '').length
  const docs = [document]
  for (const f of document.querySelectorAll('iframe')) {
    try { const d = f.contentDocument || (f.contentWindow && f.contentWindow.document); if (d) docs.push(d) } catch (_) {}
  }
  docs.sort(byContent)
  return docs[0].documentElement.outerHTML
}`
      }, signal)
    if (!isMcpResultOk(evalResult)) {
      const errText = extractMcpErrorText(evalResult)
      throw new Error(`evaluate_script: ${errText}`)
    }

    // Parse the MCP result to extract main document HTML
    let mainHtml: string | null = null
    const mcpResult = evalResult.result
    if (mcpResult?.content) {
      for (const item of mcpResult.content) {
        if (item.type === 'text' && item.text) {
          const jsonMatch = item.text.match(/```json\n([\s\S]*?)\n```/)
          if (jsonMatch) {
            try {
              mainHtml = JSON.parse(jsonMatch[1])
              break
            } catch { /* fall through */ }
          }
          try {
            mainHtml = JSON.parse(item.text)
            break
          } catch { /* fall through */ }
        }
      }
    }

    // Recursive call: return as-is, no further iframe crawling
    if (depth > 0) {
      if (mainHtml) return mainHtml
      throw new Error('Could not extract HTML from MCP response')
    }

    // ── Cross-origin iframe fallback ───────────────────────────────
    // The main document may be a thin wrapper around a cross-origin
    // iframe. Navigate to iframe src URLs and fetch their content,
    // then merge with the main document for Readability processing.
    let iframeHtml: string | null = null
    signal?.throwIfAborted()

    const iframeSrcs: string[] = []
    const srcResult = await serverManager.callTool(chromeServerId, 'evaluate_script', {
      function: `() => {
  const iframes = document.querySelectorAll('iframe')
  return Array.from(iframes)
    .filter(f => {
      const src = f.src || ''
      return (src.startsWith('http://') || src.startsWith('https://')) && (f.offsetWidth || 0) >= 100 && (f.offsetHeight || 0) >= 100
    })
    .map(f => ({ src: f.src, w: f.offsetWidth, h: f.offsetHeight }))
    .sort((a, b) => (b.w * b.h) - (a.w * a.h))
    .slice(0, 3)
    .map(f => f.src)
}`
    }, signal)
    if (isMcpResultOk(srcResult)) {
      const srcText = extractMcpText(srcResult)
      if (srcText) {
        const jsonBlock = srcText.match(/```(?:json)?\n([\s\S]*?)\n```/)
        const raw = jsonBlock ? jsonBlock[1] : srcText
        try {
          const parsed = JSON.parse(raw)
          if (Array.isArray(parsed)) iframeSrcs.push(...parsed)
        } catch {}
      }
    }
    for (const iframeSrc of iframeSrcs) {
      try {
        const innerHtml = await fetchUrlViaChromeMCP(iframeSrc, 1, signal)
        if (innerHtml && innerHtml.length > 500) {
          iframeHtml = innerHtml
          break
        }
      } catch (err) {
        console.warn(`[ChromeFetcher] Iframe fallback failed for ${iframeSrc}:`, err)
      }
    }

    // ── Merge ──────────────────────────────────────────────────────
    // Combine main + iframe content so both go through
    // Readability → turndown in importUrl.
    if (mainHtml && iframeHtml) {
      return mainHtml + '\n' + iframeHtml
    }
    if (mainHtml) return mainHtml
    if (iframeHtml) return iframeHtml

    throw new Error('Could not extract HTML from MCP response')
  } catch (err) {
    console.warn('[ChromeFetcher] Failed:', err)
    return null
  }
}
