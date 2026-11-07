/**
 * docx→PDF end-to-end probe (PLAN-office-export: pdf target). The REAL
 * svcExportDocument over REAL files, converting through the REAL hidden-window
 * pipeline (docx2pdf page + printToPDF) — which needs a REAL Electron runtime,
 * so unlike the ELECTRON_RUN_AS_NODE probes this one spawns the electron
 * binary bare (no stub, no RUN_AS_NODE). One file, two phases:
 *
 *   launcher (node):    esbuild-bundles ITSELF as the child entry, spawns
 *                       `electron bundle` with a temp-HOME sandbox, then
 *                       verifies the produced PDFs with pdfjs-dist.
 *   child (electron):   PM_PHASE=child — svcExportDocument pdf through the
 *                       full guard chain; structural checks (%PDF magic /
 *                       readable refusals / D6 suffix / no tmp litter).
 *
 * The pdfjs half closes the loop the vitest half cannot: a broken @page chain
 * silently falls back to the print default (A4), so the page size is compared
 * against the docx's own sectPr instead of a constant.
 *
 * Usage: node scripts/probe-docx-pdf.mjs
 */
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { inflateSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = process.env.PM_REPO ?? process.cwd()

const results = []
function check(name, pass, detail) {
  results.push({ name, pass: !!pass, detail: detail === undefined ? '' : String(detail) })
  console.log(`  ${pass ? '✓' : '✗'} ${name}${detail === undefined || detail === '' ? '' : ` — ${detail}`}`)
}

function guardHome(dataDir) {
  const home = process.env.PM_HOME
  if (!home) throw new Error('PM_HOME is not set — refusing to run against the real ~/.pulsemind')
  if (!dataDir.startsWith(home)) throw new Error(`DATA_DIR outside PM_HOME — refusing`)
}

const CONTRACT_MD = '# 聘用合同\n\n甲方：星辰科技有限公司。\n\n乙方：王小明。\n\n## 第一条 合同期限\n\n本合同为固定期限合同，自 2026 年 10 月 1 日起生效。\n\n## 第二条 报告要求\n\n| 项目 | 要求 |\n|---|---|\n| 周报 | 每周五 18:00 前 |\n| 月报 | 每月最后一个工作日 |'

// ── long fixture for the pagination half (P0/P1) ──
// A generated docx carries NO page-break hints at all (no w:br type=page, no
// w:lastRenderedPageBreak), so docx-preview renders it as ONE continuous
// sheet and printToPDF's own paginator slices that sheet wherever it likes —
// ignoring the docx margins entirely. This fixture is long enough that the
// slicing would be unmistakable (text at the paper edge, a second page
// starting without a top margin), and it carries many headings so a fit test
// that forgets margins strands one.
const LONG_TITLE = '长文分页验收'
const LONG_SECTIONS = 22
function longMarkdown() {
  const lead = '智能风控引擎在交易链路中承担实时评分与拦截职责，本文逐节说明设计取舍与实现细节，供后续维护者对照代码阅读。'
  const detail = '评分服务以规则引擎与模型服务双通道并行，任一通道超时即降级为规则结果，保证主链路在高峰期的可用性。'
  const sections = Array.from({ length: LONG_SECTIONS }, (_, i) => {
    const n = i + 1
    return `## ${n}. 第 ${n} 节 设计说明\n\n${lead}\n\n${detail}\n\n${lead}`
  })
  return `# ${LONG_TITLE}\n\n${sections.join('\n\n')}`
}

// ── electron child phase (PM_PHASE=child) ───────────────────────────────
async function phaseChild() {
  const { app } = await import('electron')
  // Probe lifecycle: the converter destroys its window when done, and this
  // child has no other window — without a listener, Electron's DEFAULT
  // window-all-closed behavior quits the app mid-flow. (The real app has its
  // own handler in main/index.ts; this is the probe's stand-in for it.)
  app.on('window-all-closed', () => {})
  const { svcExportDocument } = await import('../src/main/services/office-export')
  const { DATA_DIR, ensureDataDir } = await import('../src/main/storage/index')
  guardHome(DATA_DIR)
  ensureDataDir()

  const out = process.env.PM_PDF_OUT
  const work = join(out, 'work')
  const checks = []

  // ① inline content through the REAL service: markdown → docx → PDF
  const inline = await svcExportDocument({ format: 'pdf', content: CONTRACT_MD, filePath: join(work, '合同.pdf') })
  checks.push(['inline export succeeds through the real guard chain', inline.success === true, inline.error])
  if (inline.success) {
    const bytes = readFileSync(inline.path)
    checks.push(['the bytes are a PDF (%PDF magic)', bytes.subarray(0, 5).toString('latin1') === '%PDF-', `${bytes.length} bytes`])
    checks.push(['the stream is complete (%%EOF trailer)', bytes.subarray(Math.max(0, bytes.length - 64)).toString('latin1').includes('%%EOF')])
    checks.push(['the pdf is non-trivial', bytes.length > 2000, `${bytes.length} bytes`])
  }

  // ② sourcePath: an existing .docx converts (the 编好的合同 → PDF path).
  // The docx then gets zip surgery to LANDSCAPE: A4 portrait is also
  // printToPDF's fallback default, so only a non-default page size proves the
  // @page measurement chain actually ran.
  const docxSrc = await svcExportDocument({ format: 'docx', content: CONTRACT_MD, filePath: join(work, '协议.docx') })
  checks.push(['the docx source itself exports', docxSrc.success === true, docxSrc.error])
  const AdmZipMod = await import('adm-zip')
  const AdmZip = AdmZipMod.default ?? AdmZipMod
  const zip = new AdmZip(readFileSync(docxSrc.path))
  let xml = zip.readAsText('word/document.xml')
  const pgSz = xml.match(/<w:pgSz[^/>]*/)
  checks.push(['the docx carries a pgSz to flip', !!pgSz, pgSz?.[0]])
  let originalPgSzPt = null
  if (pgSz) {
    const w = pgSz[0].match(/w:w="(\d+)"/)?.[1]
    const h = pgSz[0].match(/w:h="(\d+)"/)?.[1]
    // the ORIGINAL size is the inline pdf's expected page (it is built from
    // the same markdown and default sectPr, before this flip)
    if (w && h) originalPgSzPt = { w: Math.round((Number(w) / 20) * 100) / 100, h: Math.round((Number(h) / 20) * 100) / 100 }
    xml = xml.replace(pgSz[0], `<w:pgSz w:w="${h}" w:h="${w}" w:orient="landscape"/>`)
    zip.updateFile('word/document.xml', Buffer.from(xml, 'utf8'))
    writeFileSync(docxSrc.path, zip.toBuffer())
  }
  const converted = await svcExportDocument({ format: 'pdf', sourcePath: docxSrc.path, filePath: join(work, '协议.pdf') })
  checks.push(['sourcePath .docx → pdf succeeds (landscape doc)', converted.success === true, converted.error])

  // ③ refusals stay readable and touch nothing
  const both = await svcExportDocument({ format: 'pdf', content: '# x', sourcePath: docxSrc.path, filePath: join(work, 'both.pdf') })
  checks.push(['content + sourcePath still refuse (二选一)', both.success === false && /二选一/.test(both.error ?? '')])
  const wrongSrc = await svcExportDocument({ format: 'pdf', sourcePath: join(work, '表.xlsx'), filePath: join(work, 'wrong.pdf') })
  checks.push(['a .xlsx sourcePath refuses with the .docx pointer', wrongSrc.success === false && /\.docx/.test(wrongSrc.error ?? ''), wrongSrc.error])
  const badFmt = await svcExportDocument({ format: 'rtf', content: '# x', filePath: join(work, 'x.rtf') })
  checks.push(['an unknown format refuses', badFmt.success === false])

  // ④ D6: a second export to the same path never overwrites
  const again = await svcExportDocument({ format: 'pdf', content: CONTRACT_MD, filePath: join(work, '合同.pdf') })
  checks.push(['the second export lands on 合同-2.pdf (D6)', again.success === true && /合同-2\.pdf$/.test(again.path ?? ''), again.path])
  checks.push(['no tmp litter remains', readdirSync(work).every((f) => !f.includes('.pm-tmp'))])

  // ⑤ frontmatter design (PLAN-docx-native-styles): cover section, real
  // header/footer parts with PAGE fields, TOC field with cached entries —
  // the design lands in the real bytes, then converts to PDF for the
  // launcher's per-page verification.
  const DESIGN_MD = `---
title: 年度技术报告
subtitle: 2026 财年
author: 王元杰
date: 2026-10-07
toc: true
header: 内部资料
footer: total
---

# 年度技术报告

本章为正文开篇。

## 发现

数据见表。

## 结论

结论如下。

\`\`\`chart
{"type": "column", "categories": ["一月", "二月", "三月"], "series": [{"name": "营收", "values": [120, 90, 150]}]}
\`\`\`
`
  const designed = await svcExportDocument({ format: 'docx', content: DESIGN_MD, filePath: join(work, '设计.docx') })
  checks.push(['frontmatter docx exports through the real chain', designed.success === true, designed.error])
  if (designed.success) {
    const dz = new AdmZip(readFileSync(designed.path))
    const dxml = dz.readAsText('word/document.xml')
    checks.push(['frontmatter docx is ONE section with titlePg (docx-preview paginates on the explicit break, not section bounds)', (dxml.match(/<w:sectPr/g) || []).length === 1 && dxml.includes('<w:titlePg/>'), `sectPr=${(dxml.match(/<w:sectPr/g) || []).length} titlePg=${dxml.includes('<w:titlePg/>')}`])
    checks.push(['the cover ends with an explicit page break (the pagination both engines honor)', /<w:br w:type="page"\/>[^<]*<\/w:p>[\s\S]*?目录/.test(dxml) || (dxml.indexOf('<w:br w:type="page"/>') > -1 && dxml.indexOf('<w:br w:type="page"/>') < dxml.indexOf('目录')), `break@${dxml.indexOf('<w:br w:type="page"/>')} toc@${dxml.indexOf('目录')}`])
    checks.push(['header part carries the 页眉 text', dz.readAsText('word/header1.xml').includes('内部资料')])
    const footer = dz.readAsText('word/footer1.xml')
    checks.push(['footer carries PAGE + SECTIONPAGES fields', footer.includes('PAGE') && footer.includes('SECTIONPAGES')])
    const countIn = (n, h) => h.split(n).length - 1
    checks.push(['TOC cached entries = body heading projection', countIn('发现', dxml) >= 2 && countIn('结论', dxml) >= 2])
    checks.push(['settings updateFields on', dz.readAsText('word/settings.xml').includes('updateFields')])
    checks.push(['chart fence embeds a drawing', dxml.includes('<w:drawing>'), `drawing=${dxml.includes('<w:drawing>')}`])
    const mediaPng = dz.getEntries().find((e) => e.entryName.startsWith('word/media/') && e.entryName.endsWith('.png') && e.header.size > 2000)
    checks.push(['chart PNG rasterized non-trivial (real Chromium, 2x)', !!mediaPng, mediaPng ? `${mediaPng.entryName} ${mediaPng.header.size}B` : 'no media png >2KB'])
    const designedPdf = await svcExportDocument({ format: 'pdf', sourcePath: designed.path, filePath: join(work, '设计.pdf') })
    checks.push(['the designed docx converts to PDF', designedPdf.success === true, designedPdf.error])
  }

  // ⑥ 长文分页（P0/P1）：生成的 docx 一个断页提示都没有，docx-preview 会画成
  // 一张连续长纸；转换页必须自己量测分页。夹具跨 4+ 页，launcher 侧逐页量
  // 页边距、末行孤行标题、页码与 PDF 大纲/Title。
  const longDoc = await svcExportDocument({ format: 'pdf', content: longMarkdown(), filePath: join(work, '长文.pdf') })
  checks.push(['long fixture (multi-page) exports as pdf', longDoc.success === true, longDoc.error])

  writeFileSync(process.env.PM_REPORT, JSON.stringify({ checks, originalPgSzPt, longTitle: LONG_TITLE, longHeadings: LONG_SECTIONS + 1 }), 'utf-8')
  app.exit(checks.every((c) => c[1]) ? 0 : 1)
}

// ── launcher phase ──────────────────────────────────────────────────────
async function launcher() {
  // The child bundle lives INSIDE the repo (scripts/.tmp is gitignored
  // scratch): the externals (exceljs, better-sqlite3, pdfjs-dist) must resolve
  // node_modules by walking up from the bundle's own path, and a real
  // Electron ignores NODE_PATH.
  const work = join(REPO_ROOT, 'scripts', '.tmp', 'probe-docx-pdf')
  rmSync(work, { recursive: true, force: true })
  const out = mkdtempSync(join(tmpdir(), 'pm-docx-pdf-run-'))
  const entry = join(work, 'child.cjs')
  const report = join(out, 'main.json')

  const { build } = await import('esbuild')
  await build({
    entryPoints: [fileURLToPath(import.meta.url)],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: entry,
    // electron stays external: under a REAL electron runtime require('electron')
    // resolves to the full API — the stub of the RUN_AS_NODE probes would
    // break BrowserWindow/printToPDF. The rest mirror probe-docx-edit's
    // known-good list (native/ESM/heavy packages stay in node_modules);
    // pdfjs joins because its legacy build is ESM and must not be inlined
    // into a CJS bundle.
    external: ['electron', 'better-sqlite3', 'esbuild', 'playwright-core', 'chromium-bidi', 'unzipper', '@aws-sdk/client-s3', 'exceljs', 'pdfjs-dist', 'adm-zip'],
    logLevel: 'warning',
  })

  const require = createRequire(join(REPO_ROOT, 'package.json'))
  const electronBin = require('electron')
  if (typeof electronBin !== 'string' || !existsSync(electronBin)) throw new Error('electron binary missing — run npm install')

  const home = mkdtempSync(join(tmpdir(), 'pm-home-docx-pdf-'))
  // REAL electron (no ELECTRON_RUN_AS_NODE): the conversion window needs
  // BrowserWindow + printToPDF. HOME points into the sandbox so the guard's
  // homedir() and DATA_DIR stay off the user's data; PM_DOCX2PDF_HTML names
  // the already-built conversion page (the child's getAppPath is the bundle's
  // tmp dir, not the repo).
  const res = spawnSync(electronBin, [entry], {
    cwd: REPO_ROOT, stdio: 'inherit',
    env: {
      ...process.env,
      PM_PHASE: 'child',
      PM_REPO: REPO_ROOT, PM_HOME: home, PM_REPORT: report, PM_PDF_OUT: out,
      PM_DOCX2PDF_HTML: join(REPO_ROOT, 'out', 'docx2pdf', 'index.html'),
      HOME: home, NODE_PATH: join(REPO_ROOT, 'node_modules'),
    },
  })
  let payload = { checks: [], originalPgSzPt: null }
  if (existsSync(report)) payload = JSON.parse(readFileSync(report, 'utf-8'))
  for (const [name, pass, detail] of payload.checks) check(name, pass, detail)
  if (res.status !== 0) check('electron child exited 0', false, `status ${res.status}`)

  // ── pdfjs verification from the launcher: count, CJK text, page size.
  // 合同.pdf (inline) rides the docx default page — its size check is a
  // sanity bound only, since A4 portrait is ALSO printToPDF's fallback.
  // 协议.pdf (converted) was zipped to LANDSCAPE in the child — a broken
  // @page chain prints portrait A4 and fails the swap decisively.
  const flipped = join(out, 'work', '协议.docx')
  const inlineExpect = payload.originalPgSzPt ?? (docxPagePt(flipped) ? { w: 595.3, h: 841.9 } : null)
  await verifyPdfWithExpected(join(out, 'work', '合同.pdf'), inlineExpect, 'inline 导出', false)
  await verifyPdfWithExpected(join(out, 'work', '协议.pdf'), docxPagePt(flipped), 'sourcePath 转换', true)
  await verifyDesignedPdf(join(out, 'work', '设计.pdf'))
  await verifyPaginatedPdf(
    join(out, 'work', '长文.pdf'),
    payload.longTitle ?? LONG_TITLE,
    payload.longHeadings ?? LONG_SECTIONS + 1
  )

  const failed = results.filter((r) => !r.pass).length
  console.log(`\n${results.length - failed}/${results.length} checks passed`)
  rmSync(home, { recursive: true, force: true })
  rmSync(work, { recursive: true, force: true })
  rmSync(out, { recursive: true, force: true })
  process.exit(failed === 0 ? 0 : 1)
}

/** Parse one PDF back with pdfjs and assert count / CJK text / page size.
 *  `expectLandscape` demands width>height AND an exact sectPr match — the
 *  non-vacuous half of the size check (A4 portrait equals the print fallback). */
async function verifyPdfWithExpected(pdfPath, expected, label, expectLandscape = false) {
  if (!existsSync(pdfPath)) {
    check(`${label}: pdf exists`, false, 'missing — cannot verify')
    return
  }
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const doc = await pdfjs.getDocument({ data: new Uint8Array(readFileSync(pdfPath)), isEvalSupported: false }).promise
  check(`${label}: pdfjs parses the real product`, doc.numPages >= 1, `${doc.numPages} page(s)`)

  const page = await doc.getPage(1)
  const content = await page.getTextContent()
  // Chromium's fallback-font ToUnicode maps some CJK glyphs to their Kangxi
  // radical codepoints (⽅ U+2F64 instead of 方 U+7528) — the RENDERED glyph
  // is correct, the extracted text layer just carries the radical form.
  // NFKC folds radicals back to unified ideographs, which is what a text
  // consumer should compare against.
  const text = content.items.map((it) => it.str ?? '').join('').normalize('NFKC')
  const sample = ['聘用合同', '甲方', '合同期限'].filter((s) => text.includes(s))
  check(`${label}: CJK text survives printToPDF (font fallback works)`, sample.length >= 2,
    `found: ${sample.join(' / ') || 'NONE'}; first 80 chars: ${text.slice(0, 80)}`)

  if (expected) {
    const vp = page.getViewport({ scale: 1 })
    const dW = Math.abs(vp.width - expected.w)
    const dH = Math.abs(vp.height - expected.h)
    const name = expectLandscape
      ? `${label}: page size follows the FLIPPED docx sectPr (@page chain proven, not fallback)`
      : `${label}: page size matches the docx sectPr (sanity; A4 == print fallback)`
    check(name, dW <= 2 && dH <= 2 && (!expectLandscape || vp.width > vp.height),
      `pdf ${vp.width.toFixed(1)}×${vp.height.toFixed(1)}pt vs docx ${expected.w}×${expected.h}pt`)
  } else {
    check(`${label}: page size check ran`, false, 'expected sectPr unavailable')
  }
}

/** The frontmatter-designed docx → PDF, page by page: page 1 is the COVER
 *  alone (title, no TOC/body), page 2 opens the body with the TOC label, its
 *  cached entries, the header text and the footer frame. docx-preview renders
 *  the header/footer parts and the static text runs; PAGE-field NUMBERS may be
 *  renderer-dependent, so only the literal frame is load-bearing here. */
async function verifyDesignedPdf(pdfPath) {
  if (!existsSync(pdfPath)) {
    check('frontmatter 设计: designed pdf exists', false, 'missing — the child conversion failed')
    return
  }
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const doc = await pdfjs.getDocument({ data: new Uint8Array(readFileSync(pdfPath)), isEvalSupported: false }).promise
  const pageText = async (n) => {
    const page = await doc.getPage(n)
    const content = await page.getTextContent()
    return content.items.map((it) => it.str ?? '').join('').normalize('NFKC')
  }
  const cover = await pageText(1)
  check('frontmatter 设计: cover page is page 1 and carries the title', doc.numPages >= 2 && cover.includes('年度技术报告') && cover.includes('王元杰'), `${doc.numPages} pages; p1: ${cover.slice(0, 60)}`)
  check('frontmatter 设计: cover page carries NO body/TOC content', !cover.includes('目录') && !cover.includes('结论'), `p1 has 目录=${cover.includes('目录')} 结论=${cover.includes('结论')}`)
  check('frontmatter 设计: cover page is exempt from header/footer (empty first parts, both engines)', !cover.includes('内部资料') && !/第[\s\S]*共/.test(cover), `p1 has header=${cover.includes('内部资料')} footerFrame=${/第[\s\S]*共/.test(cover)}`)
  const body = await pageText(2)
  check('frontmatter 设计: body page 2 opens with the TOC (label + cached entries)', body.includes('目录') && body.includes('发现') && body.includes('结论'), `p2: ${body.slice(0, 60)}`)
  check('frontmatter 设计: header text renders on body pages', body.includes('内部资料'), `p2 has header=${body.includes('内部资料')}`)
  // 页 lands as ⻚ (CJK Radicals Supplement U+2ED2) in the fallback-font text
  // layer — NFKC folds Kangxi Radicals (U+2F00 block) but NOT this block, so
  // accept both forms. PAGE-field NUMBERS may stay blank (docx-preview doesn't
  // evaluate fields); the literal frame is the load-bearing part.
  const pageChar = /(页|⻚)/
  check('frontmatter 设计: footer frame renders on body pages (第 X 页 共 Y 页)', pageChar.test(body) && body.includes('第') && body.includes('共'), `p2 footer frame=${pageChar.test(body) && body.includes('第') && body.includes('共')}`)
}

/** P0/P1 acceptance on a long, hint-free document. Four things must hold:
 *  (a) every page's content sits inside the docx margins — a hint-free docx
 *      that pages itself badly gets sliced by Chromium's own print paginator,
 *      which produced text 13pt from the paper edge and a 1.3pt top gap;
 *  (b) no page ends on a heading (keep-with-next carried it) and no page count
 *      disagrees with the folio denominator (which is the SECTION count — an
 *      extra Chromium slice would show up as a page carrying no folio);
 *  (c) the PDF outline exists and counts the document's real headings;
 *  (d) Title = the document's first heading, and headings use a real bold
 *      face rather than the 400 face with synthetic bold. */
/** Every font name the artifact actually names. Chromium writes the Latin
 *  dictionaries as plain objects and everything else inside compressed streams
 *  (object streams for font descriptors), so the raw scan alone reported two
 *  names for a six-font document — measured, not assumed. Both layers are read
 *  here: `/BaseFont` is the embedded subset's PostScript name (the ground truth
 *  for "which face drew this"), `/FontName` adds Type3/Form references. */
function pdfFontNames(raw) {
  const names = new Set()
  const scan = (buf) => {
    const text = buf.toString('latin1')
    for (const re of [/\/BaseFont\s*\/([A-Za-z0-9+.-]+)/g, /\/FontName\s*\/([A-Za-z0-9+.-]+)/g]) {
      for (const m of text.matchAll(re)) names.add(m[1])
    }
  }
  scan(raw)
  const text = raw.toString('latin1')
  let at = text.indexOf('stream')
  let inflated = 0
  while (at !== -1) {
    let start = at + 'stream'.length
    if (text[start] === '\r') start++
    if (text[start] === '\n') start++
    const end = text.indexOf('endstream', start)
    if (end === -1) break
    try {
      scan(inflateSync(raw.subarray(start, end)))
      inflated++
    } catch {
      // Not a deflated stream (image data, or `stream` inside a binary blob) —
      // the raw pass already covered the uncompressed dictionaries.
    }
    at = text.indexOf('stream', end + 'endstream'.length)
  }
  return { names: [...names], inflated }
}

async function verifyPaginatedPdf(pdfPath, expectedTitle, headingCount) {
  if (!existsSync(pdfPath)) {
    check('长文分页: pdf exists', false, 'missing — the child conversion failed')
    return
  }
  const raw = readFileSync(pdfPath)
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const doc = await pdfjs.getDocument({ data: new Uint8Array(raw), isEvalSupported: false }).promise
  check('长文分页: the fixture really spans multiple pages', doc.numPages >= 3, `${doc.numPages} pages`)

  const meta = await doc.getMetadata()
  check('长文分页: PDF Title = 文档首个标题（不是转换页的 docx→pdf）',
    meta?.info?.Title === expectedTitle, `Title="${meta?.info?.Title}" expect="${expectedTitle}"`)
  check('长文分页: PDF Language 跟随文档（zh-CN）', !meta?.info?.Language || meta.info.Language === 'zh-CN', `Language="${meta?.info?.Language}"`)

  const outline = await doc.getOutline()
  const outlineTitles = []
  const walk = (items) => {
    for (const item of items ?? []) {
      outlineTitles.push(item.title)
      walk(item.items)
    }
  }
  walk(outline)
  check('长文分页: 大纲条目数 = 标题数（promoteHeadings 产出真 h1..h6）',
    outlineTitles.length >= headingCount,
    `outline=${outlineTitles.length} expect>=${headingCount}${outlineTitles.length ? `; ${outlineTitles.slice(0, 3).join(' | ')}` : ''}`)
  check('长文分页: 大纲首条是文档标题', String(outlineTitles[0] ?? '').includes(expectedTitle), outlineTitles[0])

  // Real bold faces: the weight-700 aliases name PostScript faces
  // (PingFangSC-Semibold …). Without them the PDF names only the 400 face.
  const { names: fonts, inflated } = pdfFontNames(raw)
  const read = (re) => fonts.some((f) => re.test(f))
  const fontList = `${fonts.join(', ') || 'NONE'} (${inflated} deflated streams scanned)`
  check('长文分页: 标题用真粗体字面（不是 Regular + 合成加粗）', read(/Bold|Semibold/i), fontList)
  check(
    '长文分页: 中文字面来自别名表（PingFang / Songti / Heiti / Kaiti）',
    read(/PingFang|Songti|Heiti|Kaiti|STSong|STHeiti/i),
    fontList
  )

  // The generated docx declares no pgMar → the docx library's default 72pt on
  // all four sides. Anything within ~60pt of an edge means the page was laid
  // out by Chromium instead of the docx. The folio deliberately lives IN the
  // bottom margin, so its `n / N` runs are excluded from the measurement.
  const folioRe = /^(\d+)\s*\/\s*(\d+)$/
  const headingPt = 13.5
  const gap = { top: Infinity, bottom: Infinity, left: Infinity, right: Infinity }
  const stranded = []
  const folios = []
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n)
    const vp = page.getViewport({ scale: 1 })
    const content = await page.getTextContent()
    const body = []
    for (const item of content.items) {
      const text = (item.str ?? '').trim()
      if (!text) continue
      if (folioRe.test(text)) {
        folios.push({ page: n, text })
        continue
      }
      const x = item.transform[4]
      const y = item.transform[5]
      const h = item.height || 0
      body.push({ top: vp.height - (y + h), bottom: vp.height - y, left: x, right: x + (item.width || 0), h, text })
    }
    if (body.length === 0) continue
    gap.top = Math.min(gap.top, Math.min(...body.map((b) => b.top)))
    gap.bottom = Math.min(gap.bottom, Math.min(...body.map((b) => b.bottom)))
    gap.left = Math.min(gap.left, Math.min(...body.map((b) => b.left)))
    gap.right = Math.min(gap.right, vp.width - Math.max(...body.map((b) => b.right)))
    const last = body[body.length - 1]
    if (n < doc.numPages && last.h >= headingPt) stranded.push(`p${n}: ${last.text.slice(0, 12)}`)
  }
  const MIN_GAP = 60
  const round1 = (v) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : 'n/a')
  check('长文分页: 每页内容都落在 docx 页边距内（没有被 Chromium 切到纸边）',
    gap.top >= MIN_GAP && gap.bottom >= MIN_GAP && gap.left >= MIN_GAP && gap.right >= MIN_GAP,
    `worst gaps top=${round1(gap.top)} bottom=${round1(gap.bottom)} left=${round1(gap.left)} right=${round1(gap.right)} (need >=${MIN_GAP})`)
  check('长文分页: 每页都有 n / N 页码，且 N = PDF 页数（没有多出的切片页）',
    folios.length === doc.numPages && folios.every((f) => f.text === `${f.page} / ${doc.numPages}`),
    `${folios.length}/${doc.numPages} folios; ${folios.slice(0, 4).map((f) => f.text).join(', ')}`)
  check('长文分页: 没有页尾孤行标题（keep-with-next 生效）', stranded.length === 0,
    stranded.length ? stranded.join('; ') : 'no page ends on a heading')
}

/** w:pgSz twips → print points, from the docx that fed this pdf. */
function docxPagePt(docxPath) {
  try {
    const AdmZip = createRequire(join(REPO_ROOT, 'package.json'))('adm-zip')
    const xml = new AdmZip(readFileSync(docxPath)).readAsText('word/document.xml')
    const m = xml.match(/<w:pgSz[^>]*w:w="(\d+)"[^>]*w:h="(\d+)"/)
    if (!m) return null
    return { w: Math.round((Number(m[1]) / 20) * 100) / 100, h: Math.round((Number(m[2]) / 20) * 100) / 100 }
  } catch {
    return null
  }
}

if (process.env.PM_PHASE === 'child') {
  phaseChild().catch((err) => {
    console.error('child phase failed:', err)
    if (process.env.PM_REPORT) writeFileSync(process.env.PM_REPORT, JSON.stringify({ checks: [] }), 'utf-8')
    process.exit(1)
  })
} else {
  launcher().catch((err) => {
    console.error('probe failed:', err)
    process.exit(1)
  })
}
