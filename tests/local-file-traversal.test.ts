// local-file:// 的纵深缺口（2026-10-10 审计 #8）：全仓唯一不经路径裁决的
// 读取面。两道门：原始 wire URL（URL 构造器解析时会折叠 `..`/`%2e%2e` 段，
// 解析后的路径永远看不到穿越——必须在解析前查）；解析后的路径（兜 win32
// hostname 分支与构造器失败的 fallback 分支）。
import { describe, expect, it } from 'vitest'
import {
  hasPathTraversal,
  resolveLocalFilePath,
  serveLocalFile,
  urlRefusedForTraversal,
} from '../src/main/preview/serve-preview'

const serve = (url: string) => serveLocalFile({ url } as unknown as Request)

describe('hasPathTraversal / urlRefusedForTraversal', () => {
  it('rejects .. on both separators, decoded percent-encoding, and undecodable junk', () => {
    expect(urlRefusedForTraversal('local-file:///a/../../etc/passwd')).toBe(true)
    expect(urlRefusedForTraversal('local-file:///a/..%2f..%2fetc/passwd')).toBe(true)
    expect(urlRefusedForTraversal('local-file:///a/%2e%2e/%2e%2e/etc/shadow')).toBe(true)
    expect(urlRefusedForTraversal('local-file://C:/Users/../../Windows/system32/config/sam')).toBe(true)
    expect(urlRefusedForTraversal('local-file:///a/%zz-broken')).toBe(true) // 解不开 → fail closed
  })

  it('lets legitimate absolute paths (and queries) through', () => {
    expect(urlRefusedForTraversal('local-file:///Users/x/workspace/index.html?pmPreview=1')).toBe(false)
    expect(urlRefusedForTraversal('local-file:///home/x/.pulsemind/knowledge/default/raw/a.md')).toBe(false)
    // 三个点不是父目录段
    expect(hasPathTraversal('/a/file...name.html')).toBe(false)
  })
})

describe('serveLocalFile refuses traversal before any IO', () => {
  it('a raw and an encoded traversal both 403', async () => {
    const raw = await serve('local-file:///Users/x/workspace/../../etc/passwd')
    expect(raw.status).toBe(403)
    const encoded = await serve('local-file:///Users/x/%2e%2e/%2e%2e/etc/passwd')
    expect(encoded.status).toBe(403)
  })

  it('a legitimate miss passes the guard and 404s (no false positive)', async () => {
    const res = await serve('local-file:///Users/x/workspace/definitely-not-here.html?pmPreview=1')
    expect(res.status).toBe(404)
  })

  it('the parser collapses dot segments — which is why the RAW gate runs first', () => {
    // Documented, load-bearing: `..`/`%2e%2e`/win32 drive forms all parse to a
    // clean absolute path, so a check on the parsed path is vacuous. The raw
    // gate is the one that sees the traversal, and it runs before any parse.
    expect(new URL('local-file:///a/../../etc/passwd').pathname).toBe('/etc/passwd')
    expect(new URL('local-file://C:/Users/../Windows/sam').pathname).toBe('/Windows/sam')
    expect(urlRefusedForTraversal('local-file://C:/Users/../Windows/sam')).toBe(true)
    // The URL-failure fallback (undecodable %-sequence) keeps its dots — gate
    // two still refuses, and gate one already failed it closed.
    expect(hasPathTraversal('/a/%zz../..')).toBe(true)
  })
})
