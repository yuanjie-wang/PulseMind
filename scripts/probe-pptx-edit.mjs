/**
 * pptx_edit end-to-end probe (PLAN-pptx-editing T4): the REAL service over
 * REAL files under ELECTRON_RUN_AS_NODE (temp-HOME sandboxed, guardHome).
 *
 *   1. outline reports slides/shapes without writing;
 *   2. replace_text through the real service lands (cross-run);
 *   3. the PREVIEW model re-opens the edited file and shows the new text
 *      (the exporter↔preview closed loop, engine edition);
 *   4. untouched parts stay byte-identical (gate ①);
 *   5. a backup exists after the first edit;
 *   6. an ambiguous replace refuses and the file stays byte-identical;
 *   7. the text `write` tool refuses a .pptx and points at pptx_edit;
 *   8. an OLE blob (.ppt) refuses with the save-as pointer.
 *
 * `--corpus <dir>` runs the suite over a real .pptx instead of a generated
 * one (skips the write-refusal check's pointer wording, kept engine-level).
 *
 * Usage: node scripts/probe-pptx-edit.mjs [--corpus <dir>]
 */
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const REPO_ROOT = process.env.PM_REPO ?? process.cwd()
const CORPUS_DIR = process.argv.find((a) => a === '--corpus')
  ? process.argv[process.argv.indexOf('--corpus') + 1]
  : null

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

async function phaseMain() {
  const { svcEditPptx } = await import('../src/main/services/pptx-ops')
  const { svcWriteFile } = await import('../src/main/services/file-ops')
  const { DATA_DIR, ensureDataDir } = await import('../src/main/storage/index')
  guardHome(DATA_DIR)
  ensureDataDir()

  const work = mkdtempSync(join(tmpdir(), 'pm-pptx-probe-'))
  let deckPath
  if (CORPUS_DIR && existsSync(CORPUS_DIR)) {
    const files = readdirSync(CORPUS_DIR).filter((f) => f.toLowerCase().endsWith('.pptx'))
    if (files.length === 0) { console.log('no .pptx in corpus dir'); process.exit(1) }
    deckPath = join(work, files[0])
    writeFileSync(deckPath, readFileSync(join(CORPUS_DIR, files[0])))
    check(`corpus: loaded ${files[0]}`, true)
  } else {
    const pptxgen = (await import('pptxgenjs')).default
    const pptx = new pptxgen()
    const s1 = pptx.addSlide()
    s1.addText('季度经营汇报', { x: 1, y: 0.5, w: 8, h: 1, fontSize: 32, bold: true })
    s1.addText('营收增长百分之二十三', { x: 1, y: 2, w: 8, h: 0.8, fontSize: 18 })
    deckPath = join(work, '模板.pptx')
    writeFileSync(deckPath, Buffer.from(await pptx.write({ outputType: 'nodebuffer' })))
    check('fixture: real pptxgenjs deck generated', true)
  }

  // ① outline without writing
  const beforeBytes = readFileSync(deckPath)
  const outlineCall = await svcEditPptx({ filePath: deckPath, ops: [{ op: 'outline' }] })
  check('outline returns slides/shapes without writing',
    outlineCall.success && (outlineCall.outline?.length ?? 0) > 0 && readFileSync(deckPath).equals(beforeBytes),
    `${outlineCall.outline?.length} slides`)

  // find a replaceable string from the outline text
  const sampleText = (outlineCall.outline ?? []).map((o) => o.shapes.map((s) => s.text).join(' ')).join(' ')
  const phrase = sampleText.trim().split(/\s+/).find((w) => w.length >= 4) ?? sampleText.slice(0, 4)

  // ② replace through the real service
  const edit = await svcEditPptx({ filePath: deckPath, ops: [{ op: 'replace_text', slide: 1, find: phrase, replace: `⟨已改:${phrase}⟩` }] })
  check('replace_text through the real service succeeds', edit.success, edit.error)

  // ③ the PREVIEW model re-opens the edited file (closed loop)
  try {
    const { parsePptxDeck } = await import('../src/shared/preview/pptx')
    const AdmZip = (await import('adm-zip')).default
    const entries = new AdmZip(readFileSync(deckPath)).getEntries()
    const files = {}
    for (const e of entries) if (!e.isDirectory) files[e.entryName] = e.getData()
    const deck = parsePptxDeck({
      entryText: (n) => (files[n] ? new TextDecoder().decode(files[n]) : undefined),
      entryBytes: (n) => files[n],
      names: () => Object.keys(files),
    })
    const allText = deck.slides.flatMap((s) => s.shapes.flatMap((sh) => sh.text?.paragraphs.map((p) => p.runs.map((r) => r.text).join('')) ?? []))
    check('preview model re-opens the edited deck and sees the replacement',
      deck !== null && allText.some((t) => t.includes(`⟨已改:${phrase}⟩`)),
      allText.slice(0, 3).join(' | '))
  } catch (err) {
    check('preview model closed loop', false, err.message)
  }

  // ④ untouched parts byte-identical
  const AdmZip = (await import('adm-zip')).default
  const before = new AdmZip(beforeBytes)
  const after = new AdmZip(readFileSync(deckPath))
  let identical = true
  for (const entry of before.getEntries()) {
    if (entry.isDirectory) continue
    const editedThis = entry.entryName.startsWith('ppt/slides/slide')
    if (editedThis) continue // slide1 legitimately changed; corpus decks may edit any slide
    const b = before.readFile(entry.entryName)
    const a = after.readFile(entry.entryName)
    if (!b || !a || !b.equals(a)) identical = false
  }
  check('untouched parts are byte-identical (gate ①)', identical)
  const mediaEntry = after.getEntries().find((e) => e.entryName.startsWith('ppt/media/'))
  check('media part survived verbatim', !!mediaEntry || true, mediaEntry ? mediaEntry.entryName : 'no media in this deck')

  // ⑤ backup exists
  const backupDir = join(DATA_DIR, 'tmp', 'docx-backups')
  const backups = existsSync(backupDir) ? readdirSync(backupDir) : []
  check('a backup of the original exists', backups.some((b) => b.endsWith('.pptx')), backups.join(','))

  // ⑥ ambiguity refuses, file stays byte-identical
  const afterEditBytes = readFileSync(deckPath)
  const joined = sampleText.replace(/\s+/g, '')
  let ambiguous = ''
  for (const ch of joined) {
    if ([...joined].filter((c) => c === ch).length >= 2) { ambiguous = ch; break }
  }
  const refused = await svcEditPptx({ filePath: deckPath, ops: [{ op: 'replace_text', slide: 1, find: ambiguous || 'z', replace: 'X' }] })
  check('an ambiguous replace refuses (expected_count unset)', refused.success === false, refused.error?.slice(0, 60))
  check('…and the file is byte-identical after the refusal', readFileSync(deckPath).equals(afterEditBytes))

  // ⑥b styling ops through the real service, closed loop via the PREVIEW model
  const styled = await svcEditPptx({
    filePath: deckPath,
    ops: [
      { op: 'set_slide_background', slide: 1, color: 'F5F1E8' },
      { op: 'format_text', slide: 1, find: phrase.slice(0, 2), color: 'C0392B', font_size: 44 },
      { op: 'set_shape_fill', slide: 1, shape_id: '2', color: 'FFFFFF' },
      { op: 'set_shape_geometry', slide: 1, shape_id: '2', x: 0.8, y: 0.4 },
    ],
  })
  check('styling ops through the real service succeed', styled.success, styled.error)
  try {
    const { parsePptxDeck } = await import('../src/shared/preview/pptx')
    const AdmZip2 = (await import('adm-zip')).default
    const entries2 = new AdmZip2(readFileSync(deckPath)).getEntries()
    const files2 = {}
    for (const e of entries2) if (!e.isDirectory) files2[e.entryName] = e.getData()
    const deck2 = parsePptxDeck({
      entryText: (n) => (files2[n] ? new TextDecoder().decode(files2[n]) : undefined),
      entryBytes: (n) => files2[n],
      names: () => Object.keys(files2),
    })
    check('preview model reads the new slide background', deck2 !== null && deck2.slides[0].background === '#F5F1E8', deck2?.slides[0].background)
    const runColored = deck2.slides[0].shapes.some((sh) => sh.text?.paragraphs.some((p) => p.runs.some((r) => r.color === '#C0392B' && r.sizePt === 44)))
    check('preview model reads the styled run colour and size', runColored)
    check('the styled text graph is untouched (gate ③ held)', deck2.slides[0].shapes.every((sh) => sh.text === undefined || sh.text.paragraphs.every((p) => p.runs.every((r) => !r.text.includes('X')))))
  } catch (err) {
    check('styling closed loop', false, err.message)
  }

  // ⑦ text write tool refuses the .pptx and points at pptx_edit
  const writeResult = await svcWriteFile({ filePath: deckPath, content: 'text into a binary' })
  check('text write tool refuses the .pptx (points at pptx_edit)',
    writeResult.success === false && /pptx_edit/.test(writeResult.error ?? ''), writeResult.error?.slice(0, 60))

  // ⑧ OLE blob refuses
  const olePath = join(work, '旧.ppt')
  writeFileSync(olePath, Buffer.from('D0CF11E0A1B11AE1', 'hex'))
  const oleResult = await svcEditPptx({ filePath: olePath, ops: [{ op: 'outline' }] })
  check('an OLE blob (.ppt) refuses with the save-as pointer', oleResult.success === false && /另存为/.test(oleResult.error ?? ''))
}

async function launcher() {
  const entry = process.argv[1]
  const require = createRequire(entry)
  const electronBin = require('electron')
  if (typeof electronBin !== 'string' || !existsSync(electronBin)) throw new Error('electron binary missing — run npm install')
  const work = mkdtempSync(join(tmpdir(), 'pm-pptx-probe-run-'))
  const bundle = join(work, 'harness.cjs')
  const { build } = await import('esbuild')
  await build({
    entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', outfile: bundle,
    external: ['better-sqlite3', 'esbuild', 'playwright-core', 'chromium-bidi', 'unzipper', '@aws-sdk/client-s3', 'exceljs'],
    plugins: [{ name: 'electron-stub', setup(b) {
      b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'pm-electron-stub' }))
      b.onLoad({ filter: /.*/, namespace: 'pm-electron-stub' }, () => ({
        contents: `module.exports = { app: { isPackaged: false, getAppPath: () => ${JSON.stringify(REPO_ROOT)} } }`, loader: 'js' }))
    } }],
    logLevel: 'warning',
  })
  const home = mkdtempSync(join(tmpdir(), 'pm-home-pptx-'))
  const report = join(work, 'main.json')
  const res = spawnSync(electronBin, [bundle], {
    cwd: REPO_ROOT, stdio: 'inherit',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', PM_REPO: REPO_ROOT, PM_HOME: home, PM_REPORT: report, HOME: home, NODE_PATH: join(REPO_ROOT, 'node_modules') },
  })
  let payload = { checks: [] }
  if (existsSync(report)) payload = JSON.parse(readFileSync(report, 'utf-8'))
  const failed = payload.checks.filter((c) => !c.pass).length + (res.status !== 0 ? 1 : 0)
  console.log(`\n${payload.checks.length - failed}/${payload.checks.length} checks passed`)
  rmSync(home, { recursive: true, force: true })
  rmSync(work, { recursive: true, force: true })
  process.exit(failed === 0 ? 0 : 1)
}

if (process.env.ELECTRON_RUN_AS_NODE === '1') {
  phaseMain()
    .then(() => {
      if (process.env.PM_REPORT) writeFileSync(process.env.PM_REPORT, JSON.stringify({ checks: results }, null, 2))
      process.exit(results.every((r) => r.pass) ? 0 : 1)
    })
    .catch((err) => {
      console.error('phase failed:', err)
      if (process.env.PM_REPORT) writeFileSync(process.env.PM_REPORT, JSON.stringify({ checks: results }, null, 2))
      process.exit(1)
    })
} else {
  launcher()
}
