const { readdirSync, existsSync, rmSync } = require('node:fs')
const { join } = require('node:path')

const KEEP_LANGS = new Set(['en', 'zh_CN', 'zh_TW', 'zh-Hans', 'zh-Hant'])

exports.default = async function (context) {
  if (context.electronPlatformName !== 'darwin') return

  const resourcesPath = join(
    context.appOutDir,
    context.packager.appInfo.productFilename + '.app',
    'Contents',
    'Frameworks',
    'Electron Framework.framework',
    'Resources'
  )

  if (!existsSync(resourcesPath)) return

  let removed = 0
  for (const entry of readdirSync(resourcesPath, { withFileTypes: true })) {
    if (!entry.name.endsWith('.lproj')) continue
    const lang = entry.name.replace(/\.lproj$/, '')
    if (KEEP_LANGS.has(lang)) continue

    const fullPath = join(resourcesPath, entry.name)
    rmSync(fullPath, { recursive: true, force: true })
    removed++
  }

  if (removed > 0) {
    console.log(`[strip-lproj] Removed ${removed} locale directories, kept en/zh_CN/zh_TW`)
  }
}
