/** 用户路径拼写的唯一语法（2026-11-10 UOS 附件 ENOENT）。
 *
 *  报障原文的落点：`stat '<ws>/file:/home/@x/…/x.png' ENOENT`。chip 里存的是
 *  文件管理器给出的 `file:/home/…` 单斜杠 URI，`[file:…]` 原样拼进 prompt 后，
 *  渲染端与主进程两处「非绝对 → 挂到 workspace 上」的 join 各自把 URI 当成相对
 *  文件名。修法是一条纯规则（shared/path-input）+ 四个入口都过它，本文件钉住
 *  规则本身与「没人绕过去」的接线。 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { fileUriToPath, normalizePathInput } from '../src/shared/path-input'

const REPO = join(__dirname, '..')
const read = (rel: string): string => readFileSync(join(REPO, rel), 'utf8')

describe('fileUriToPath — 本地 file: URI → 文件系统路径', () => {
  it('接受单斜杠简写（GNOME/UOS 文件管理器）', () => {
    expect(fileUriToPath('file:/home/u/Downloads/a.png')).toBe('/home/u/Downloads/a.png')
  })

  it('接受三斜杠 / 双斜杠 + localhost / 空 host', () => {
    expect(fileUriToPath('file:///home/u/a.png')).toBe('/home/u/a.png')
    expect(fileUriToPath('file://localhost/home/u/a.png')).toBe('/home/u/a.png')
  })

  it('接受大写的 scheme 与 local-file: 别名（应用自己的预览协议）', () => {
    expect(fileUriToPath('FILE:/home/u/a.png')).toBe('/home/u/a.png')
    expect(fileUriToPath('local-file:///home/u/a.png')).toBe('/home/u/a.png')
  })

  it('解码百分号转义（文件名带空格/中文）', () => {
    expect(fileUriToPath('file:///home/u/My%20Report%20%E6%8A%A5%E5%91%8A.png')).toBe(
      '/home/u/My Report 报告.png',
    )
  })

  it('Windows 盘符两种拼法都落到 C:/…', () => {
    expect(fileUriToPath('file:///C:/Users/x/a.pdf')).toBe('C:/Users/x/a.pdf')
    expect(fileUriToPath('file://C:/Users/x/a.pdf')).toBe('C:/Users/x/a.pdf')
  })

  it('多余的斜杠折叠掉（file:////home）', () => {
    expect(fileUriToPath('file:////home/u/a.png')).toBe('/home/u/a.png')
  })

  it('空白容错：首尾空白忽略', () => {
    expect(fileUriToPath('  file:/home/u/a.png  ')).toBe('/home/u/a.png')
  })

  it('拒绝远程主机（那是共享路径，不是本机文件）', () => {
    expect(fileUriToPath('file://remoteserver/share/a.pdf')).toBeNull()
  })

  it('拒绝多行文本（粘贴的一段话里引用了个 URL，不是路径）', () => {
    expect(fileUriToPath('file:/home/u/a.png\n第二行')).toBeNull()
  })

  it('拒绝非绝对结果的散文（`file: 见附件` 绝不能被当成路径吞掉）', () => {
    expect(fileUriToPath('file: 见附件')).toBeNull()
    expect(fileUriToPath('file:notes.txt')).toBeNull()
    expect(fileUriToPath('file://')).toBeNull()
  })

  it('拒绝坏掉的百分号转义与非 file 协议', () => {
    expect(fileUriToPath('file:///a%ZZ.png')).toBeNull()
    expect(fileUriToPath('https://example.com/a.png')).toBeNull()
    expect(fileUriToPath('/home/u/a.png')).toBeNull() // 裸路径不归它管
    expect(fileUriToPath('')).toBeNull()
  })
})

describe('normalizePathInput — 边界规则（只改 file: 拼写，其余逐字节不变）', () => {
  it('URI 落成路径', () => {
    expect(normalizePathInput('file:/home/u/a.png')).toBe('/home/u/a.png')
    expect(normalizePathInput('local-file:///home/u/a.png')).toBe('/home/u/a.png')
  })

  it('非 URI 原样返回（相对路径仍然表示 workspace 相对）', () => {
    expect(normalizePathInput('src/a.ts')).toBe('src/a.ts')
    expect(normalizePathInput('/etc/hosts')).toBe('/etc/hosts')
    expect(normalizePathInput('~/x')).toBe('~/x')
    expect(normalizePathInput('C:\\x\\a.txt')).toBe('C:\\x\\a.txt')
  })

  it('幂等：过两遍与过一遍相同', () => {
    const once = normalizePathInput('file:///home/u/a%20b.png')
    expect(once).toBe('/home/u/a b.png')
    expect(normalizePathInput(once)).toBe(once)
  })
})

describe('接线：四个入口都过同一条规则（绕过去就又是两个答案）', () => {
  it('shared/path-input 不碰 node:path / IO（渲染端也要能用）', () => {
    const src = read('src/shared/path-input.ts')
    expect(src).not.toContain("from 'node:")
    expect(src).not.toContain('require(')
  })

  it('沙箱闸门：guard 的 normalizeUserPath = URI strip + ~ 展开（file-ops 复用同一个）', () => {
    const g = read('src/main/sandbox/guard.ts')
    expect(g).toContain("import { normalizePathInput } from '../../shared/path-input'")
    expect(g).toContain('export function normalizeUserPath(target: string): string')
    expect(g).toContain('normalizePathInput(target)')
    expect(g).toContain('target = normalizeUserPath(target)')
    expect(g).not.toContain('expandTilde')
  })

  it('path-jail.resolveTarget 先归一：URI 是绝对路径，不能当相对名字挂到 workspace', () => {
    const jail = read('src/shared/sandbox/path-jail.ts')
    expect(jail).toContain("import { normalizePathInput } from '../path-input'")
    expect(jail).toContain('const input = normalizePathInput(target)')
    expect(jail).toContain('if (isAbsolute(input)) return resolve(input)')
  })

  it('file-ops：resolvePath 与 search 目录都走同一个 normalizeUserPath', () => {
    const ops = read('src/main/services/file-ops.ts')
    expect(ops).toContain("import { guardFsTarget, checkFsTarget, normalizeUserPath } from '../sandbox/guard'")
    expect(ops).toContain('const normalized = normalizeUserPath(input)')
    expect(ops).toContain('normalizeUserPath(String(input.dir')
    expect(ops).not.toContain('expandTilde')
  })

  it('渲染端 resolveToolFilePath 先归一（读前写账本与保护路径门同一个拼写）', () => {
    const utils = read('src/renderer/src/agent/agent-utils.ts')
    expect(utils).toContain("import { normalizePathInput } from '../../../shared/path-input'")
    expect(utils).toContain('const target = normalizePathInput(filePath)')
  })

  it('渲染端附件入口：chip 与 stat 都先归一', () => {
    const input = read('src/renderer/src/components/chat/InputArea.tsx')
    expect(input).toContain("import { normalizePathInput } from '../../../../shared/path-input'")
    expect(input).toContain('const normalized = paths.map((p) => normalizePathInput(p))')
    expect(input).toContain('const targets = paths.map((p) => normalizePathInput(p))')
  })

  it('历史转录里的 [file:file:/…] chip 也在渲染时归一（点开与取 birthtime 用同一个拼写）', () => {
    const chip = read('src/renderer/src/components/chat/FileRefChip.tsx')
    expect(chip).toContain("import { normalizePathInput } from '../../../../shared/path-input'")
    expect(chip).toContain('const path = normalizePathInput(args[2])')
  })

  it('quick-attach 的 fileUrlToPath 只是 shared 规则的转调（只一份语法）', () => {
    const qa = read('src/renderer/src/utils/quick-attach.ts')
    expect(qa).toContain("import { fileUriToPath } from '../../../shared/path-input'")
    expect(qa).toContain('return fileUriToPath(text)')
    // 旧的手写解析器要求 `file://` 两斜杠、对单斜杠简写直接返回 null——别再长回来
    expect(qa).not.toContain('/^file:\\/\\//i')
    expect(qa).not.toContain('decodeURIComponent')
  })

  it('OCR 的缺文件报错点名路径 + 出路，不再把裸 stat ENOENT 抛给用户', () => {
    const ops = read('src/main/services/file-ops.ts')
    expect(ops).toContain('图片不存在：${guard.resolved}')
    expect(ops).toContain('重新附加该文件后再试')
    // stat 必须在 try 里被翻译：函数里唯一一处裸 stat 是它的前提
    expect(ops).toMatch(/try \{\s*size = \(await stat\(guard\.resolved\)\)\.size/)
  })
})
