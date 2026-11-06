/**
 * Which resource file carries the app mark, per platform, for the two surfaces
 * that are NOT the packaged app icon: a BrowserWindow's icon and the tray.
 *
 * One lookup instead of a ternary repeated at every call site, because the
 * three platforms want genuinely different framings:
 *
 *  • macOS draws its own squircle plate around the bundle icon and ignores
 *    BrowserWindow.icon entirely (the Dock shows the bundle's .icns), so it
 *    keeps the mac-grid master — artwork at 80.5%, the ratio Apple's grid is
 *    built for — and the knocked-out tray glyph that `setTemplateImage`
 *    recolors to match the menu-bar appearance.
 *  • Windows reads the .ico's own frames, so the app .ico already suits the
 *    window/taskbar. The tray gets its OWN .ico: a notification-area glyph needs
 *    margin that an app icon should not have (see TRAY_INSET in
 *    scripts/generate-icons.mjs).
 *  • Linux has neither an OS-drawn plate nor template-image support. The mac
 *    framing reads as undersized in a title bar, and the knocked-out white glyph
 *    vanishes on a light panel (UOS ships one by default), so Linux takes the
 *    full-bleed window PNG and a colour tray tile.
 *
 * `platform` is a parameter so tests can pin all three branches from any host.
 */
export function windowIconName(platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') return 'pulseMind-win.ico'
  if (platform === 'darwin') return 'pulseMind.png'
  return 'pulseMind-window.png'
}

export function trayIconName(platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') return 'pulseMind-win-tray.ico'
  if (platform === 'darwin') return 'pulseMind_tray.png'
  return 'pulseMind-tray-color.png'
}
