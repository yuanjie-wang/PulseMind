// ── measurePreviewFrame: the main-process frame channel the HTML preview's
// zoom rides (fit-width + post-command re-centering). The frame traversal and
// JSON contract are plain logic; the Electron-only fact that the channel works
// against a sandboxed local-file frame is pinned by
// scripts/probe-html-frame-measure.mjs instead.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { measurePreviewFrame, type FrameHost } from '../src/main/preview/frame-measure'

interface MockFrame {
  name: string
  frames: MockFrame[]
  executeJavaScript: (code: string) => Promise<unknown>
}

function mockFrame(name: string, executeJavaScript: (code: string) => Promise<unknown>, children: MockFrame[] = []): MockFrame {
  return { name, frames: children, executeJavaScript }
}

function hostWith(frames: MockFrame[]): FrameHost {
  return { mainFrame: { frames } } as unknown as FrameHost
}

const METRICS = 'JSON.stringify({ w: 960, h: 8640 })'

describe('measurePreviewFrame', () => {
  it('finds the named frame among its siblings and parses the metrics', async () => {
    let ranCode = ''
    const target = mockFrame('pm-html-frame-x', async (code) => {
      ranCode = code
      return '{"w":960,"h":8640}'
    })
    const out = await measurePreviewFrame(hostWith([mockFrame('other', async () => METRICS), target]), 'pm-html-frame-x')
    expect(out).toEqual({ width: 960, height: 8640 })
    // Plain measure must not touch the frame's scroll.
    expect(ranCode).not.toContain('scrollLeft')
  })

  it('searches nested children, not just direct ones', async () => {
    const deep = mockFrame('deep-frame', async () => '{"w":100,"h":50}')
    const out = await measurePreviewFrame(hostWith([mockFrame('mid', async () => METRICS, [deep])]), 'deep-frame')
    expect(out).toEqual({ width: 100, height: 50 })
  })

  it('centerX requests the re-centering script in addition to the metrics', async () => {
    let ranCode = ''
    await measurePreviewFrame(
      hostWith([mockFrame('f', async (code) => { ranCode = code; return '{"w":960,"h":8640}' })]),
      'f',
      true,
    )
    expect(ranCode).toContain('scrollLeft = over / 2')
  })

  it('returns null when no frame carries the name', async () => {
    const out = await measurePreviewFrame(hostWith([mockFrame('other', async () => METRICS)]), 'missing')
    expect(out).toBeNull()
  })

  it('returns null on garbage answers (non-string, non-numeric, non-positive)', async () => {
    const garbage = (value: unknown) => hostWith([mockFrame('f', async () => value)])
    expect(await measurePreviewFrame(garbage(42), 'f')).toBeNull()
    expect(await measurePreviewFrame(garbage('{"w":"x","h":1}'), 'f')).toBeNull()
    expect(await measurePreviewFrame(garbage('{"w":0,"h":1}'), 'f')).toBeNull()
  })

  it('returns null when the frame dies mid-flight (executeJavaScript rejects)', async () => {
    const dying = mockFrame('f', async () => {
      throw new Error('Object has been destroyed')
    })
    expect(await measurePreviewFrame(hostWith([dying]), 'f')).toBeNull()
  })
})

describe('wiring (source scans)', () => {
  it('the preview iframe carries the per-mount name and re-centers on zoom', () => {
    const src = readFileSync('src/renderer/src/components/preview/HtmlPreview.tsx', 'utf-8')
    expect(src).toContain('name={frameName}')
    expect(src).toContain('measurePreviewFrame(frameName, true)')
    expect(src).toContain('fitKey="fitWidth"')
  })

  it('the channel is registered in main and bridged through preload', () => {
    expect(readFileSync('src/main/ipc/file-ops.handler.ts', 'utf-8')).toContain('IPC_CHANNELS.UTIL_MEASURE_PREVIEW_FRAME')
    expect(readFileSync('src/preload/index.ts', 'utf-8')).toContain('measurePreviewFrame: (frameName: string, centerX?: boolean)')
    expect(readFileSync('src/shared/types/electron-bridge.ts', 'utf-8')).toContain('measurePreviewFrame')
    expect(readFileSync('src/shared/ipc-channels.ts', 'utf-8')).toContain("UTIL_MEASURE_PREVIEW_FRAME: 'util:measure-preview-frame'")
  })
})
