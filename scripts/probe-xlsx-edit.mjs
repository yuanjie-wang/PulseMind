/**
 * xlsx_edit probe (PLAN-office-editing T15): the REAL service over a REAL
 * .xlsx built by exceljs — set_cell (value/formula/format) with read-back,
 * find_replace value-only semantics, scan refusals (.xls, charts) and the
 * L11 text-write guard. Same ELECTRON_RUN_AS_NODE + temp-HOME recipe.
 *
 * Usage: node scripts/probe-xlsx-edit.mjs
 */
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import AdmZip from 'adm-zip'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'

const REPO_ROOT = process.env.PM_REPO ?? process.cwd()
const results = []
function check(name, pass, detail) {
  results.push({ name, pass: !!pass, detail: detail === undefined ? '' : String(detail) })
  console.log(`  ${pass ? '✓' : '✗'} ${name}${detail === undefined || detail === '' ? '' : ` — ${detail}`}`)
}
function guardHome(dataDir) {
  const home = process.env.PM_HOME
  if (!home) throw new Error('PM_HOME is not set')
  if (!dataDir.startsWith(home)) throw new Error('DATA_DIR outside PM_HOME')
}

async function phaseMain() {
  const ExcelJS = (await import('exceljs')).default
  const { svcEditXlsx } = await import('../src/main/services/xlsx-ops')
  const { svcWriteFile } = await import('../src/main/services/file-ops')
  const { DATA_DIR, ensureDataDir } = await import('../src/main/storage/index')
  guardHome(DATA_DIR)
  ensureDataDir()

  // Build a workbook with a value, a formula, and a second sheet.
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('Data')
  ws.getCell('A1').value = '预算'
  ws.getCell('B1').value = 100
  ws.getCell('B2').value = { formula: 'B1*2' }
  const wb2 = wb.addWorksheet('Config')
  wb2.getCell('A1').value = 'debug=true'
  const buffer = Buffer.from(await wb.xlsx.writeBuffer())
  const path = join(mkdtempSync(join(tmpdir(), 'pm-xlsx-')), 'book.xlsx')
  writeFileSync(path, buffer)

  // ① inspect + set_cell with read-back
  const inspect = await svcEditXlsx({ filePath: path, ops: [{ op: 'inspect' }] })
  check('inspect lists both sheets', inspect.success && inspect.outline?.length === 2, JSON.stringify(inspect.outline))
  const setCell = await svcEditXlsx({ filePath: path, ops: [
    { op: 'set_cell', sheet: 'Data', cell: 'B1', value: 250, number_format: '#,##0' },
    { op: 'set_cell', sheet: 'Data', cell: 'C1', value: '已审核' },
  ] })
  check('set_cell writes value + number format (read-back verified)', setCell.success, setCell.error)

  // verify on disk
  const checkWb = new ExcelJS.Workbook()
  await checkWb.xlsx.load(readFileSync(path))
  check('B1 reads back 250 with the format', checkWb.getWorksheet('Data').getCell('B1').value === 250)
  check('C1 reads back the CJK string', checkWb.getWorksheet('Data').getCell('C1').value === '已审核')

  // ② find_replace touches values, NOT formulas (L7)
  const fr = await svcEditXlsx({ filePath: path, ops: [{ op: 'find_replace', sheet: 'Config', find: 'debug', replace: 'release' }] })
  check('find_replace replaces the value cell', fr.success)
  const wbFinal = new ExcelJS.Workbook()
  await wbFinal.xlsx.load(readFileSync(path))
  check('…the Config cell reads back replaced', wbFinal.getWorksheet('Config').getCell('A1').value === 'release=true')
  check('…the formula is untouched', wbFinal.getWorksheet('Data').getCell('B2').formula === 'B1*2', String(wbFinal.getWorksheet('Data').getCell('B2').formula))

  // ③ formula write with read-back
  const formula = await svcEditXlsx({ filePath: path, ops: [{ op: 'set_cell', sheet: 'Data', cell: 'B3', formula: 'SUM(B1:B2)' }] })
  check('set_cell formula writes and reads back', formula.success && wbFinal ? true : false)
  const wb3 = new ExcelJS.Workbook()
  await wb3.xlsx.load(readFileSync(path))
  check('…B3 carries the formula', (wb3.getWorksheet('Data').getCell('B3').formula ?? '').includes('SUM(B1:B2)'))

  // ④ ambiguous find_replace refuses
  const ambiguous = await svcEditXlsx({ filePath: path, ops: [{ op: 'find_replace', find: 'e', replace: 'E', expected_count: 1 }] })
  check('ambiguous find_replace refuses via expected_count', ambiguous.success === false)

  // ⑤ the scan refusals
  const ole = join(mkdtempSync(join(tmpdir(), 'pm-xlsx-')), 'old.xls')
  writeFileSync(ole, Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0]), Buffer.alloc(32)]))
  const oleResult = await svcEditXlsx({ filePath: ole, ops: [{ op: 'inspect' }] })
  check('.xls (OLE) refuses with the save-as hint', oleResult.success === false && /另存为/.test(oleResult.error ?? ''))

  const charted = new AdmZip()
  charted.addFile('[Content_Types].xml', Buffer.from('<Types/>'))
  charted.addFile('xl/workbook.xml', Buffer.from('<workbook/>'))
  charted.addFile('xl/charts/chart1.xml', Buffer.from('<chart/>'))
  const chartPath = join(mkdtempSync(join(tmpdir(), 'pm-xlsx-')), 'chart.xlsx')
  writeFileSync(chartPath, charted.toBuffer())
  const chartResult = await svcEditXlsx({ filePath: chartPath, ops: [{ op: 'inspect' }] })
  check('a workbook with charts refuses (L6)', chartResult.success === false && /图表/.test(chartResult.error ?? ''))

  // ⑥ the text write tool refuses .xlsx
  const writeResult = await svcWriteFile({ filePath: path, content: 'text' })
  check('text write tool refuses the .xlsx (L11)', writeResult.success === false && /xlsx_edit/.test(writeResult.error ?? ''))

  for (const dir of [join(dirname(path))]) rmSync(dir, { recursive: true, force: true })
}
// ── runner ──
async function launcher() {
  const entry = process.argv[1]
  const require = createRequire(entry)
  const electronBin = require('electron')
  const work = mkdtempSync(join(tmpdir(), 'pm-xlsx-probe-run-'))
  const bundle = join(work, 'harness.cjs')
  const { build } = await import('esbuild')
  await build({
    entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', outfile: bundle,
    external: ['better-sqlite3', 'esbuild', 'playwright-core', 'chromium-bidi', 'unzipper', '@aws-sdk/client-s3'],
    plugins: [{ name: 'electron-stub', setup(b) {
      b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'pm-electron-stub' }))
      b.onLoad({ filter: /.*/, namespace: 'pm-electron-stub' }, () => ({
        contents: `module.exports = { app: { isPackaged: false, getAppPath: () => ${JSON.stringify(REPO_ROOT)} } }`, loader: 'js' }))
    } }],
    logLevel: 'warning',
  })
  const home = mkdtempSync(join(tmpdir(), 'pm-home-xlsx-'))
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
