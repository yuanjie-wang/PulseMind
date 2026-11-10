// Linux 运行时适配的钉子（2026-11-11，UOS 20 交付面）。
//
// 三处「在 mac/win 上正确、到 Linux 静默失效」的差异，全部由 Electron 的平台
// 注解坐实：
//   • app.setLoginItemSettings 是 @platform darwin,win32 —— Linux 上调用即空转，
//     「开机自启」开关曾经只写设置、OS 永远不知道。等价物是 XDG autostart 条目。
//   • BrowserWindow.setOpacity 在 Linux 上 does nothing —— splash 的淡入淡出
//     在那边会退化成「spinner 停 350ms 后被硬切掉」。Linux 直接同帧换窗。
//   • 登录 shell 的 PATH 探测用 `echo "$PATH"`：fish 的 $PATH 是空格分隔的列表、
//     csh 的引用规则也不同，按 ':' 切会得到一串垃圾。`env` 在所有 shell 里都是
//     `PATH=a:b:c`。
//
// 卸载器一并删 autostart 条目：不删的话下次登录会拉起一个已被删除的可执行文件。

import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  autostartExec,
  autostartFilePath,
  buildAutostartDesktopEntry,
  applyLinuxAutostart,
} from '../src/main/utils/autostart'
import { extractShellPath, mergePath } from '../src/main/utils/user-path'

const ROOT = join(__dirname, '..')
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8')

const made: string[] = []
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pm-autostart-'))
  made.push(dir)
  return dir
}
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true })
})

describe('autostartFilePath', () => {
  it('respects $XDG_CONFIG_HOME', () => {
    expect(autostartFilePath({ XDG_CONFIG_HOME: '/tmp/xdg' }, '/home/u')).toBe(
      '/tmp/xdg/autostart/pulsemind.desktop',
    )
  })

  it('falls back to ~/.config when the variable is missing or blank', () => {
    expect(autostartFilePath({}, '/home/u')).toBe('/home/u/.config/autostart/pulsemind.desktop')
    expect(autostartFilePath({ XDG_CONFIG_HOME: '   ' }, '/home/u')).toBe(
      '/home/u/.config/autostart/pulsemind.desktop',
    )
  })
})

describe('buildAutostartDesktopEntry', () => {
  it('writes a minimal XDG entry around the exec line', () => {
    const entry = buildAutostartDesktopEntry({ execPath: '/opt/PulseMind/pulsemind' })
    expect(entry).toContain('[Desktop Entry]')
    expect(entry).toContain('Type=Application')
    expect(entry).toContain('Exec=/opt/PulseMind/pulsemind')
    expect(entry).toContain('X-GNOME-Autostart-enabled=true')
    expect(entry?.endsWith('\n')).toBe(true)
  })

  it('prefers $APPIMAGE over the per-run mount path', () => {
    // AppImage 每次启动挂在 /tmp/.mount_<random>，退出即卸载 —— 那个路径到
    // 下次登录必然不存在。外层 .AppImage 文件才是稳定目标。
    expect(
      autostartExec({
        execPath: '/tmp/.mount_PulseM1ab2Cd/pulsemind',
        appImagePath: '/home/u/Apps/PulseMind-0.5.1.AppImage',
      }),
    ).toBe('/home/u/Apps/PulseMind-0.5.1.AppImage')
  })

  it('refuses to write an entry whose target cannot survive a reboot', () => {
    expect(autostartExec({ execPath: '/tmp/.mount_PulseM1ab2Cd/pulsemind' })).toBeNull()
    expect(buildAutostartDesktopEntry({ execPath: '/tmp/.mount_x/pulsemind' })).toBeNull()
    expect(autostartExec({ execPath: '   ' })).toBeNull()
  })

  it('quotes whitespace and the characters the Desktop Entry spec reserves', () => {
    expect(autostartExec({ execPath: '/home/u/My Apps/PulseMind/pulsemind' })).toBe(
      '"/home/u/My Apps/PulseMind/pulsemind"',
    )
    expect(autostartExec({ execPath: '/home/u/$dir/pulsemind' })).toBe(
      '"/home/u/\\$dir/pulsemind"',
    )
    expect(autostartExec({ execPath: '/opt/PulseMind/pulsemind' })).toBe('/opt/PulseMind/pulsemind')
  })

  it('mirrors --no-sandbox so a hardened kernel keeps booting the same way', () => {
    // UOS 加固关掉非特权 userns 时，桌面入口带 --no-sandbox 才起得来；自启条目
    // 不带就是「登录后静默失败」。
    expect(autostartExec({ execPath: '/opt/PulseMind/pulsemind', noSandbox: true })).toBe(
      '/opt/PulseMind/pulsemind --no-sandbox',
    )
    expect(autostartExec({ execPath: '/opt/PulseMind/pulsemind', noSandbox: false })).toBe(
      '/opt/PulseMind/pulsemind',
    )
  })
})

describe('applyLinuxAutostart', () => {
  it('creates the file (and its directory) on enable, removes it on disable', () => {
    const dir = tmp()
    const file = join(dir, '.config', 'autostart', 'pulsemind.desktop')

    const on = applyLinuxAutostart(true, { execPath: '/opt/PulseMind/pulsemind' }, file)
    expect(on.ok).toBe(true)
    expect(on.filePath).toBe(file)
    expect(readFileSync(file, 'utf-8')).toContain('Exec=/opt/PulseMind/pulsemind')

    const off = applyLinuxAutostart(false, { execPath: '/opt/PulseMind/pulsemind' }, file)
    expect(off.ok).toBe(true)
    expect(existsSync(file)).toBe(false)
  })

  it('disabling an entry that was never written is not an error', () => {
    const file = join(tmp(), 'autostart', 'pulsemind.desktop')
    expect(applyLinuxAutostart(false, { execPath: '/x' }, file).ok).toBe(true)
  })

  it('reports failure instead of throwing when the target is unstable', () => {
    const file = join(tmp(), 'autostart', 'pulsemind.desktop')
    const result = applyLinuxAutostart(true, { execPath: '/tmp/.mount_x/pulsemind' }, file)
    expect(result.ok).toBe(false)
    expect(result.error).toContain('stable executable path')
    expect(existsSync(file)).toBe(false)
  })
})

describe('shell PATH probe', () => {
  it('reads the last PATH= line and ignores banner noise', () => {
    const stdout = 'Welcome to the machine!\nnpm notice\nPATH=/usr/local/bin:/usr/bin:/bin\n'
    expect(extractShellPath(stdout)).toBe('/usr/local/bin:/usr/bin:/bin')
  })

  it('a later PATH wins (same as a real shell), and CRLF is tolerated', () => {
    expect(extractShellPath('PATH=/first\r\nPATH=/second\r\n')).toBe('/second')
  })

  it('keeps "=" inside values and ignores keys that merely end in PATH', () => {
    expect(extractShellPath('PATH=/a=b:/c\n')).toBe('/a=b:/c')
    expect(extractShellPath('MYPATH=/nope\n')).toBeNull()
  })

  it('skips an empty assignment and falls back to the previous one', () => {
    expect(extractShellPath('PATH=/real\nPATH=\n')).toBe('/real')
  })

  it('returns null when the dump carries no PATH at all', () => {
    expect(extractShellPath('HOME=/home/u\n')).toBeNull()
  })

  it('mergePath dedupes and appends the inherited PATH after the shell one', () => {
    // 登录 shell 的 PATH 优先：nvm/brew 这些只在 profile 里加的东西必须在前。
    expect(mergePath('/shell/bin:/usr/bin', '/usr/bin:/app/bin')).toBe('/shell/bin:/usr/bin:/app/bin')
    expect(mergePath('/a::/a', '/b:')).toBe('/a:/b')
    expect(mergePath('/a')).toBe('/a')
  })
})

describe('wiring', () => {
  it('tray applies XDG autostart on Linux only, with the AppImage path', () => {
    const src = read('src/main/tray.ts')
    expect(src).toContain("if (process.platform === 'linux')")
    expect(src).toContain('app.isPackaged')
    expect(src).toContain('applyLinuxAutostart(enabled, {')
    expect(src).toContain('process.env.APPIMAGE')
    expect(src).toContain("process.argv.includes('--no-sandbox')")
    // mac/win 臂保持原样
    expect(src).toContain('app.setLoginItemSettings({ openAtLogin: enabled })')
  })

  it('splash skips the no-op opacity animation on Linux', () => {
    const src = read('src/main/index.ts')
    // Linux 的 fadeIn 不做 tick，直接 show + 完成
    expect(src).toMatch(
      /if \(process\.platform === 'linux'\) \{\n {4}mainWindow\.show\(\)\n {4}fadeCompleted = true\n {4}maybeNotifyHooksCompleted\(\)/,
    )
    // Linux 的 fadeOut 不做 tick，直接关窗
    expect(src).toMatch(
      /if \(process\.platform === 'linux'\) \{\n {4}splashWindow\.close\(\)\n {4}splashWindow = null\n {4}return/,
    )
    // 换窗同帧完成，不再 setTimeout(FADE_MS - OVERLAP_MS)
    expect(src).toContain('fadeInMainWindow()\n      fadeOutSplash()\n      return')
    // win/mac 的动画臂没有被删掉
    expect(src).toContain('mainWindow.setOpacity(p)')
    expect(src).toContain('splashWindow.setOpacity(1 - p)')
  })

  it('PATH probe asks the shell for `env`, never an echoed "$PATH"', () => {
    const src = read('src/main/utils/user-path.ts')
    expect(src).toContain("['-lic', 'env']")
    expect(src).not.toContain('echo "$PATH"')
  })

  it('the no-root uninstaller removes the autostart entry too', () => {
    const sh = read('scripts/install-linux-noroot.sh')
    expect(sh).toContain('AUTOSTART_FILE="${XDG_CONFIG_HOME:-$HOME/.config}/autostart/pulsemind.desktop"')
    expect(sh).toMatch(/rm -f -- "\$DESKTOP_FILE" "\$ICON_DEST" "\$AUTOSTART_FILE"/)
  })
})
