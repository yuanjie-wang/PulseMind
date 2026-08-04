import type { MCPClientConfig } from '../MCPClient'

/**
 * Chrome DevTools MCP server preset.
 *
 * Uses system-installed Chrome via puppeteer-core (no bundled browser).
 * Full tool set: navigation, input automation, screenshot, console, network,
 * performance, emulation, memory, scripting, and more.
 *
 * Requirements:
 * - Chrome/Chromium installed on the system
 *
 * Bundled as a project dependency — no npx download needed at runtime.
 */
export function createChromeDevToolsConfig(
  overrides?: Partial<MCPClientConfig>
): MCPClientConfig {
  const { env: overrideEnv, ...rest } = overrides || {}
  // Use the ungated CLI entry (chrome-devtools-mcp-main.js). The published
  // bin wrapper exits unless Node >= 20.19, but Electron 33 embeds Node
  // 20.18.3, so running that wrapper would make the server die on startup.
  let binPath = require.resolve('chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp-main.js')
  // Packaged builds: the package is unpacked to app.asar.unpacked, but
  // require.resolve returns the app.asar path. A spawned subprocess cannot
  // read inside an asar archive, so point it at the real file on disk.
  if (binPath.includes('app.asar')) {
    binPath = binPath.replace('app.asar', 'app.asar.unpacked')
  }

  return {
    name: 'Chrome DevTools',
    // Spawn with Electron's embedded Node (ELECTRON_RUN_AS_NODE) instead of
    // system `node`, which is not on PATH inside a packaged app.
    command: process.execPath,
    args: [binPath, '--autoConnect', '--no-sandbox'],
    env: {
      ELECTRON_RUN_AS_NODE: '1',
      CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS: '1',
      ...overrideEnv,
    },
    ...rest,
  } as MCPClientConfig
}
