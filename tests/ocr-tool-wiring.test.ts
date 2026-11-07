// ocr 工具五点接线 — 源扫描（vitest 这里是 node-env，IPC/preload 面挂不起来），
// 形状对齐 office-tools-wiring.test.ts。每条断言的都是「删掉它功能就会静默失效」
// 的内容，而不是「文件里存在某个词」。

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { BUILT_IN_TOOLS } from '../src/renderer/src/tools/built-in-tools'
import { READ_TIER_TOOLS, tierOfTool } from '../src/renderer/src/agent/engine/tool-tiers'

const ROOT = join(__dirname, '..')
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')

describe('ocr tool wiring', () => {
  it('is registered as a built-in file tool with a required file_path', () => {
    const tool = BUILT_IN_TOOLS.find(t => t.name === 'ocr')
    expect(tool).toBeDefined()
    expect(tool!.category).toBe('file')
    expect(tool!.builtIn).toBe(true)
    expect(tool!.input_schema.required).toEqual(['file_path'])
    expect(Object.keys(tool!.input_schema.properties)).toContain('file_path')
    // 描述与指令必须同时说清「离线」和「read 读不了图片」：只说识别不说分流，
    // 模型仍会先拿 read 去试，然后拿到一坨二进制。
    expect(tool!.description).toContain('offline')
    expect(tool!.instructions).toContain('read')
  })

  it('sits on the read tier, so execReadOnlyTools dispatches it and it needs no approval', () => {
    expect(READ_TIER_TOOLS.has('ocr')).toBe(true)
    expect(tierOfTool('ocr')).toBe('read')
  })

  it('is wired through all five layers', () => {
    expect(read('src/shared/ipc-channels.ts')).toContain("UTIL_OCR_IMAGE: 'util:ocr-image'")
    expect(read('src/main/ipc/file-ops.handler.ts')).toContain('IPC_CHANNELS.UTIL_OCR_IMAGE')
    expect(read('src/preload/index.ts')).toContain('ocrImage: (filePath: string)')
    expect(read('src/shared/types/electron-bridge.ts')).toContain('ocrImage: (filePath: string)')
    expect(read('src/renderer/src/agent/host/types.ts')).toContain("'ocrImage'")
    expect(read('src/main/agent/main-host.ts')).toContain('ocrImage: (filePath) =>')
  })

  it('the executor actually calls it — a definition alone changes nothing', () => {
    const executors = read('src/renderer/src/agent/tool-executors.ts')
    expect(executors).toContain("if (t.name === 'ocr')")
    expect(executors).toContain('getHost().ocrImage(')
  })

  it('the service keeps the deny-roots gate and rejects non-images before paying OCR cost', () => {
    const svc = read('src/main/services/file-ops.ts')
    expect(svc).toContain('export async function svcOcrImage')
    expect(svc).toContain("checkFsTarget(filePath, 'read')")
    expect(svc).toContain('IMAGE_EXTENSIONS.includes(ext)')
    expect(svc).toContain('isOcrSupported()')
  })

  it('read steers images here instead of letting them fall through to cat', () => {
    expect(read('src/renderer/src/tools/tool-instructions.ts')).toContain('Call \\`ocr { file_path }\\` instead')
  })
})
