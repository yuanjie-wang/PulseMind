// Screenshot `save` destinations (2026-11-11, user ruling 「还是有点复杂，能不能
// 全放开，但是不覆盖原文件」). The contract pinned here:
//   • ANY destination path is accepted (`~`, absolute, relative-under-Downloads,
//     or the portable `desktop/名称.png` tokens); missing folders are created
//     by the caller;
//   • the ONE carve-out is the app's own data dir (`~/.pulsemind`), where a NEW
//     file is executed/injected on the next launch;
//   • an existing file is NEVER overwritten — resolved by an atomic `wx` write
//     with a `-2`, `-3` … fallback, not by a check-then-write race.
// Windows rules (drive letters, backslashes, case-insensitive compare, UNC)
// are exercised from this POSIX host by injecting `platform`.
import { afterEach, describe, it, expect } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  resolveScreenshotSave,
  screenshotFileName,
  screenshotStamp,
  writeScreenshotFile,
  type ScreenshotDirs,
} from '../src/main/browser/screenshot-save'

const AT = new Date(2026, 10, 11, 9, 5, 7, 42) // 2026-11-11 09:05:07.042 local
const AUTO = 'pulsemind-screenshot-20261111-090507-042.png'

const MAC: ScreenshotDirs = {
  home: '/Users/me',
  downloads: '/Users/me/Downloads',
  desktop: '/Users/me/Desktop',
  documents: '/Users/me/Documents',
  pictures: '/Users/me/Pictures',
}

// Linux resolves the same tokens through XDG; the folder names can be
// localized (`~/下载`, `~/桌面`), which is exactly why the model must not
// hardcode English names and why app.getPath is the source of truth.
const LINUX_ZH: ScreenshotDirs = {
  home: '/home/me',
  downloads: '/home/me/下载',
  desktop: '/home/me/桌面',
  documents: '/home/me/文档',
  pictures: '/home/me/图片',
}

const WIN: ScreenshotDirs = {
  home: 'C:\\Users\\me',
  downloads: 'C:\\Users\\me\\Downloads',
  desktop: 'C:\\Users\\me\\Desktop',
  documents: 'C:\\Users\\me\\Documents',
  pictures: 'C:\\Users\\me\\Pictures',
}

const posix = (save: boolean | string, dirs = MAC, platform: NodeJS.Platform = 'darwin') =>
  resolveScreenshotSave(save, { dirs, now: AT, platform })
const win = (save: boolean | string) =>
  resolveScreenshotSave(save, { dirs: WIN, now: AT, platform: 'win32' })

describe('screenshot-save names', () => {
  it('auto-names from the clock when save is true or blank', () => {
    expect(screenshotFileName(true, AT)).toBe(AUTO)
    expect(screenshotFileName('', AT)).toBe(AUTO)
    expect(screenshotFileName('   ', AT)).toBe(AUTO)
  })

  it('stamp pads every field and includes milliseconds (same-second shots must not collide)', () => {
    expect(screenshotStamp(new Date(2026, 0, 2, 3, 4, 5, 6))).toBe('20260102-030405-006')
  })

  it('keeps an explicit filename and forces the .png extension', () => {
    expect(screenshotFileName('首页截图', AT)).toBe('首页截图.png')
    expect(screenshotFileName('shot.jpg', AT)).toBe('shot.png')
    expect(screenshotFileName('shot.PNG', AT)).toBe('shot.png')
  })

  it('rejects a separator in a bare name, pointing at the path spelling', () => {
    expect(() => screenshotFileName('sub/shot.png', AT)).toThrow(/路径分隔符/)
    expect(() => screenshotFileName('C:\\Users\\me\\shot.png', AT)).toThrow(/路径分隔符/)
    expect(() => screenshotFileName('../escape.png', AT)).toThrow(/Desktop/)
  })

  it('strips characters that break Windows/macOS filesystems', () => {
    expect(screenshotFileName('a:b*c?"d".png', AT)).toBe('abcd.png')
    expect(screenshotFileName('a\u0001b.png', AT)).toBe('ab.png')
  })

  it('trims leading dots, trailing dots/spaces, and collapses whitespace', () => {
    expect(screenshotFileName('..hidden.png', AT)).toBe('hidden.png')
    expect(screenshotFileName('name. .png', AT)).toBe('name.png')
    expect(screenshotFileName('a   b.png', AT)).toBe('a b.png')
  })

  it('falls back to the auto name when sanitizing leaves nothing', () => {
    expect(screenshotFileName('???', AT)).toBe(AUTO)
    expect(screenshotFileName('.', AT)).toBe(AUTO)
  })

  it('prefixes Windows reserved device stems', () => {
    expect(screenshotFileName('CON.png', AT)).toBe('shot-CON.png')
    expect(screenshotFileName('lpt1', AT)).toBe('shot-lpt1.png')
    expect(screenshotFileName('console.png', AT)).toBe('console.png') // not reserved
  })

  it('caps the stem at 80 chars', () => {
    const name = screenshotFileName('x'.repeat(200), AT)
    expect(name).toBe(`${'x'.repeat(80)}.png`)
  })
})

describe('screenshot-save destinations — POSIX', () => {
  it('true / blank still means an auto-named PNG in Downloads', () => {
    expect(posix(true)).toEqual({ dir: '/Users/me/Downloads', name: AUTO })
    expect(posix('  ', MAC, 'linux').dir).toBe('/Users/me/Downloads')
  })

  it('a bare filename keeps the legacy Downloads behaviour', () => {
    expect(posix('首页.png')).toEqual({ dir: '/Users/me/Downloads', name: '首页.png' })
  })

  it('desktop/ names the Desktop on every platform (case-insensitive token)', () => {
    expect(posix('desktop/baidu-home.png')).toEqual({
      dir: '/Users/me/Desktop',
      name: 'baidu-home.png',
    })
    expect(posix('Desktop/baidu-home.png').dir).toBe('/Users/me/Desktop')
  })

  it('documents/, downloads/ and pictures/ work, with optional subfolders', () => {
    expect(posix('Documents/项目/shot.jpg')).toEqual({
      dir: '/Users/me/Documents/项目',
      name: 'shot.jpg', // explicit path names are used verbatim, extension included
    })
    expect(posix('pictures/')).toEqual({ dir: '/Users/me/Pictures', name: AUTO })
    expect(posix('downloads/sub/x.png').dir).toBe('/Users/me/Downloads/sub')
  })

  it('resolves localized XDG roots through app.getPath, not through English names', () => {
    // The Chinese spellings are NOT tokens; the English token lands in the
    // directory the OS reports — which is what makes one spelling portable.
    expect(posix('desktop/截图.png', LINUX_ZH, 'linux')).toEqual({
      dir: '/home/me/桌面',
      name: '截图.png',
    })
    // An arbitrary path is accepted literally — including a localized folder.
    expect(posix('桌面/截图.png', LINUX_ZH, 'linux')).toEqual({
      dir: '/home/me/下载/桌面',
      name: '截图.png',
    })
  })

  it('accepts ~/… anywhere under home (no folder allowlist)', () => {
    expect(posix('~/Desktop/a.png')).toEqual({ dir: '/Users/me/Desktop', name: 'a.png' })
    expect(posix('~/Documents/项目/')).toEqual({ dir: '/Users/me/Documents/项目', name: AUTO })
    expect(posix('~/work/shots/deep/a.png')).toEqual({
      dir: '/Users/me/work/shots/deep',
      name: 'a.png',
    })
    // `~/` is the home directory itself → auto-named file inside it.
    expect(posix('~/')).toEqual({ dir: '/Users/me', name: AUTO })
    expect(posix('~')).toEqual({ dir: '/Users/me', name: AUTO })
  })

  it('accepts any absolute path', () => {
    expect(posix('/tmp/shot.png')).toEqual({ dir: '/tmp', name: 'shot.png' })
    expect(posix('/Users/me/.ssh/shot.png')).toEqual({ dir: '/Users/me/.ssh', name: 'shot.png' })
    expect(posix('/Users/me/DesktopSibling/shot.png').dir).toBe('/Users/me/DesktopSibling')
    // `..` is ordinary path syntax now — resolved, then taken as-is.
    expect(posix('/Users/me/Documents/sub/../x.png')).toEqual({
      dir: '/Users/me/Documents',
      name: 'x.png',
    })
    expect(posix('desktop/../Documents/a.png')).toEqual({
      dir: '/Users/me/Documents',
      name: 'a.png',
    })
  })

  it('relative paths start from Downloads', () => {
    expect(posix('sub/shot.png')).toEqual({ dir: '/Users/me/Downloads/sub', name: 'shot.png' })
    expect(posix('./shot.png')).toEqual({ dir: '/Users/me/Downloads', name: 'shot.png' })
    expect(posix('home/shot.png').dir).toBe('/Users/me/Downloads/home')
  })

  it('an existing directory (or trailing separator) gets an auto-named file inside', () => {
    const isDir = (path: string) => path === '/Users/me/Desktop' || path === '/tmp/shots'
    expect(resolveScreenshotSave('/Users/me/Desktop', { dirs: MAC, now: AT, platform: 'darwin' }, isDir)).toEqual({
      dir: '/Users/me/Desktop',
      name: AUTO,
    })
    expect(
      resolveScreenshotSave('/tmp/shots', { dirs: MAC, now: AT, platform: 'darwin' }, isDir),
    ).toEqual({ dir: '/tmp/shots', name: AUTO })
    expect(
      resolveScreenshotSave('/tmp/new-dir/', { dirs: MAC, now: AT, platform: 'darwin' }, () => false),
    ).toEqual({ dir: '/tmp/new-dir', name: AUTO })
  })

  it('keeps an explicit filename verbatim — non-PNG extensions and dots included', () => {
    expect(posix('~/Desktop/chart.svg')).toEqual({ dir: '/Users/me/Desktop', name: 'chart.svg' })
    expect(posix('~/Desktop/report.final')).toEqual({
      dir: '/Users/me/Desktop',
      name: 'report.final',
    })
  })

  it('refuses the app data directory — but only that tree', () => {
    const at = (save: string) =>
      resolveScreenshotSave(save, {
        dirs: MAC,
        now: AT,
        platform: 'darwin',
        protectedRoots: ['/Users/me/.pulsemind'],
      })
    for (const raw of [
      '~/.pulsemind/shot.png',
      '~/.pulsemind/hooks/app-start.png',
      '~/.pulsemind/skills/x/SKILL.md.png',
      '~/.pulsemind',
      '/Users/me/.pulsemind/../.pulsemind/x.png',
    ]) {
      expect(() => at(raw), raw).toThrow(/应用数据目录/)
    }
    // Sibling names and `..` out of the tree are fine — lexical containment.
    expect(at('~/.pulsemind-notes/x.png').dir).toBe('/Users/me/.pulsemind-notes')
    expect(at('~/.pulsemind/../x.png')).toEqual({ dir: '/Users/me', name: 'x.png' })
  })
})

describe('screenshot-save destinations — Windows', () => {
  it('token paths use backslashes or forward slashes and land in the Windows root', () => {
    expect(win('desktop\\shot.png')).toEqual({ dir: 'C:\\Users\\me\\Desktop', name: 'shot.png' })
    expect(win('Documents/项目/shot.jpg')).toEqual({
      dir: 'C:\\Users\\me\\Documents\\项目',
      name: 'shot.jpg',
    })
    expect(win('pictures\\')).toEqual({ dir: 'C:\\Users\\me\\Pictures', name: AUTO })
  })

  it('accepts ~/… on win32', () => {
    expect(win('~\\Desktop\\a.png')).toEqual({ dir: 'C:\\Users\\me\\Desktop', name: 'a.png' })
    expect(win('~/work/a.png')).toEqual({ dir: 'C:\\Users\\me\\work', name: 'a.png' })
  })

  it('accepts absolute paths on any drive and UNC shares', () => {
    expect(win('c:/users/ME/desktop/Shot.JPG')).toEqual({
      dir: 'c:\\users\\ME\\desktop', // taken literally: no case canonicalization
      name: 'Shot.JPG',
    })
    expect(win('D:\\shots\\a.png')).toEqual({ dir: 'D:\\shots', name: 'a.png' })
    expect(win('\\\\server\\share\\shot.png')).toEqual({
      dir: '\\\\server\\share\\', // win32 keeps the UNC root's trailing separator
      name: 'shot.png',
    })
  })

  it('an existing directory (or trailing separator) gets an auto-named file inside', () => {
    const isDir = (path: string) => path === 'C:\\Users\\me\\Desktop'
    expect(
      resolveScreenshotSave(
        'C:\\Users\\me\\Desktop',
        { dirs: WIN, now: AT, platform: 'win32' },
        isDir,
      ),
    ).toEqual({ dir: 'C:\\Users\\me\\Desktop', name: AUTO })
  })

  it('rejects drive-relative paths, which name no real place', () => {
    for (const raw of ['C:Desktop\\shot.png', 'C:shot.png']) {
      expect(() => win(raw), raw).toThrow(/盘符相对路径/)
    }
  })

  it('compares the protected app dir case-insensitively on NTFS', () => {
    expect(() =>
      resolveScreenshotSave('c:/users/ME/.PULSEMIND/hooks/app-start.png', {
        dirs: WIN,
        now: AT,
        platform: 'win32',
        protectedRoots: ['C:\\Users\\me\\.pulsemind'],
      }),
    ).toThrow(/应用数据目录/)
    expect(() =>
      resolveScreenshotSave('D:\\shots\\a.png', {
        dirs: WIN,
        now: AT,
        platform: 'win32',
        protectedRoots: ['C:\\Users\\me\\.pulsemind'],
      }),
    ).not.toThrow()
  })
})

describe('screenshot-save write (real directory)', () => {
  const made: string[] = []
  const tmp = () => {
    const dir = mkdtempSync(join(tmpdir(), 'pulsemind-shot-'))
    made.push(dir)
    return dir
  }
  afterEach(() => {
    while (made.length) rmSync(made.pop() as string, { recursive: true, force: true })
  })

  it('writes the PNG at the resolved path', async () => {
    const dir = tmp()
    const path = await writeScreenshotFile({ dir, name: 'shot.png' }, Buffer.from('png-bytes'))
    expect(path).toBe(join(dir, 'shot.png'))
    expect(readFileSync(path, 'utf8')).toBe('png-bytes')
  })

  it('appends -2, -3 … instead of replacing an existing file (content stays intact)', async () => {
    const dir = tmp()
    writeFileSync(join(dir, 'shot.png'), 'original')
    expect(await writeScreenshotFile({ dir, name: 'shot.png' }, Buffer.from('second'))).toBe(
      join(dir, 'shot-2.png'),
    )
    expect(await writeScreenshotFile({ dir, name: 'shot.png' }, Buffer.from('third'))).toBe(
      join(dir, 'shot-3.png'),
    )
    expect(readFileSync(join(dir, 'shot.png'), 'utf8')).toBe('original')
    expect(readFileSync(join(dir, 'shot-2.png'), 'utf8')).toBe('second')
    expect(readFileSync(join(dir, 'shot-3.png'), 'utf8')).toBe('third')
  })

  it('keeps a non-PNG or extensionless name intact while uniquifying', async () => {
    const dir = tmp()
    writeFileSync(join(dir, 'report.final'), 'old')
    expect(await writeScreenshotFile({ dir, name: 'report.final' }, Buffer.from('new'))).toBe(
      join(dir, 'report-2.final'),
    )
    writeFileSync(join(dir, 'noext'), 'old')
    expect(await writeScreenshotFile({ dir, name: 'noext' }, Buffer.from('new'))).toBe(
      join(dir, 'noext-2'),
    )
  })

  it('does not create the directory itself (the caller owns mkdir) and surfaces real errors', async () => {
    const dir = tmp()
    const missing = join(dir, 'missing', 'shot.png')
    await expect(writeScreenshotFile({ dir: join(dir, 'missing'), name: 'shot.png' }, Buffer.from('x'))).rejects.toThrow(
      /ENOENT/,
    )
    expect(existsSync(missing)).toBe(false)
  })
})

describe('screenshot-save wiring', () => {
  const serviceSrc = readFileSync(join(__dirname, '../src/main/browser/BrowserService.ts'), 'utf-8')
  const docsSrc = readFileSync(join(__dirname, '../src/shared/browser-client/documentation.ts'), 'utf-8')

  it('BrowserService resolves destinations from all five app.getPath folders', () => {
    expect(serviceSrc).toContain('resolveScreenshotSave(cmd.save, {')
    for (const key of ['home', 'downloads', 'desktop', 'documents', 'pictures']) {
      expect(serviceSrc).toContain(`app.getPath('${key}')`)
    }
  })

  it('passes the app data dir as the one protected root', () => {
    expect(serviceSrc).toContain('protectedRoots: [DATA_DIR]')
  })

  it('creates missing parents and writes through the no-overwrite path', () => {
    expect(serviceSrc).toContain('mkdir(dest.dir, { recursive: true })')
    expect(serviceSrc).toContain('writeScreenshotFile(dest, buffer)')
    // The old check-then-write path is gone: a race could overwrite there.
    expect(serviceSrc).not.toContain('screenshotSavePath')
  })

  it('the model-facing docs advertise arbitrary paths and no-overwrite', () => {
    expect(docsSrc).toContain("save: '~/Desktop/名称.png'")
    expect(docsSrc).toContain('NEVER overwritten')
    expect(docsSrc).toContain('macOS, Windows and Linux')
    expect(docsSrc).not.toContain('A FILENAME only')
    expect(docsSrc).not.toContain('anything outside them is rejected')
  })
})
