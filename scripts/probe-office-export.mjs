/**
 * Office export probe (real fs, real sandbox guard, real main-process modules,
 * no Electron window) — the PLAN-office-export M4 counterpart of
 * probe-docx-edit.mjs / probe-project-color-db.mjs.
 *
 * What only this probe can see:
 *   - the REAL guardFsTarget (vitest mocks it): an export aimed at ~/.ssh must
 *     be refused with a readable reason, and every decision — allowed or
 *     denied — must land in the audit_log table as `fs.write`;
 *   - the read-back gate against the REAL bytes on disk: with a corrupted
 *     docx builder patched in at bundle time, the service must refuse and
 *     leave ZERO files (no target, no tmp sibling);
 *   - the D6 conflict suffix on a real directory listing (报告.xlsx twice →
 *     报告-2.xlsx, first file untouched);
 *   - the sourcePath path through a real file read.
 *
 * How it runs: the probe bundles ITSELF with esbuild (electron stubbed to a
 * four-line module, better-sqlite3 external and required from the repo) and
 * executes the bundle under the Electron binary in ELECTRON_RUN_AS_NODE mode —
 * same V8/ABI so the native module loads. `HOME` points at a fresh temp dir,
 * so `homedir()/.pulsemind` and every exported file live inside the sandbox;
 * the phases refuse to start unless that holds. The user's real data is never
 * touched.
 *
 * Usage: node scripts/probe-office-export.mjs [--keep]
 *        (run from the repo root; needs `npx electron` to be installed)
 */
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const REPO_ROOT = process.env.PM_REPO ?? process.cwd()
const PHASE = process.env.PM_PHASE
const KEEP = process.argv.includes('--keep')

// ── reporting ──
const results = []
function check(name, pass, detail) {
  results.push({ name, pass: !!pass, detail: detail === undefined ? '' : String(detail) })
  console.log(`  ${pass ? '✓' : '✗'} ${name}${detail === undefined || detail === '' ? '' : ` — ${detail}`}`)
  return !!pass
}

/** Never let a phase touch anything but its own temp HOME. */
function guardHome(dataDir) {
  const home = process.env.PM_HOME
  if (!home) throw new Error('PM_HOME is not set — refusing to run against the real ~/.pulsemind')
  if (!dataDir.startsWith(home)) throw new Error(`DATA_DIR ${dataDir} is outside PM_HOME ${home} — refusing to touch it`)
}

const MD_TABLE = '| 名称 | 数量 |\n|---|---|\n| 甲 | 12 |\n| 乙 | 007 |'

// ── the phase: everything under test, against real fs + real guard ──
async function phaseMain() {
  const { DATA_DIR, ensureDataDir } = await import('../src/main/storage/index')
  guardHome(DATA_DIR)
  ensureDataDir()
  const { initializeDatabase, getDb } = await import('../src/main/storage/database')
  await initializeDatabase()

  const { svcExportDocument } = await import('../src/main/services/office-export')
  // Repo-anchored require: the bundle lives in the temp dir, so a plain
  // import() cannot resolve the repo's node_modules from there.
  const AdmZip = fromRepo('adm-zip')
  const ExcelJS = fromRepo('exceljs')

  // The workspace the exports land in: inside HOME, outside every deny root.
  const home = process.env.PM_HOME
  const ws = join(home, 'workspaces', 'conv_probe')
  const outside = join(home, '.ssh')

  // ① the three formats, end to end, with structural read-back ──
  const xlsx = await svcExportDocument({ format: 'xlsx', content: MD_TABLE, filePath: join(ws, '库存.xlsx') })
  check('xlsx export succeeds', xlsx.success === true, xlsx.error)
  if (xlsx.success) {
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(readFileSync(xlsx.path))
    const ws0 = wb.worksheets[0]
    check('xlsx read-back: values typed per D5', ws0.getRow(2).getCell(2).value === 12 && ws0.getRow(3).getCell(2).value === '007',
      `row2=${JSON.stringify(ws0.getRow(2).values)}`)
  }

  const docx = await svcExportDocument({ format: 'docx', content: '# 探针报告\n\n正文内容。', filePath: join(ws, '报告.docx') })
  check('docx export succeeds', docx.success === true, docx.error)
  if (docx.success) {
    const xml = new AdmZip(readFileSync(docx.path)).readAsText('word/document.xml')
    check('docx read-back: content in word/document.xml', xml.includes('探针报告') && xml.includes('正文内容。'))
  }

  // ①b fontSize: the body default lands in the real styles.xml, the headings
  //    scale with it AND keep their color (the lib replaces the whole run) ──
  const sized = await svcExportDocument({ format: 'docx', content: '# 标题\n\n正文内容。', fontSize: 14, filePath: join(ws, '字号.docx') })
  check('docx fontSize export succeeds', sized.success === true, sized.error)
  if (sized.success) {
    const styles = new AdmZip(readFileSync(sized.path)).readAsText('word/styles.xml')
    const docDefaults = styles.slice(styles.indexOf('<w:docDefaults>'), styles.indexOf('</w:docDefaults>'))
    check('fontSize 14 lands as the body default (sz 28)', docDefaults.includes('<w:sz w:val="28"/>'), docDefaults.slice(0, 200))
    const h1 = styles.match(/w:styleId="Heading1"[\s\S]*?<\/w:style>/)?.[0] ?? ''
    check('Heading1 scales to 41 half-points AND keeps its color', h1.includes('<w:sz w:val="41"/>') && h1.includes('2E74B5'))
  }
  const badSize = await svcExportDocument({ format: 'xlsx', content: MD_TABLE, fontSize: 14, filePath: join(ws, '字号.xlsx') })
  check('fontSize on xlsx is refused readably', badSize.success === false && (badSize.error ?? '').includes('fontSize'), badSize.error)
  if (docx.success) {
    // the conversion path never re-generates — the refusal must come BEFORE
    // the real converter (a BrowserWindow) would be needed
    const pdfSize = await svcExportDocument({ format: 'pdf', sourcePath: docx.path, fontSize: 14, filePath: join(ws, '转.pdf') })
    check('fontSize + pdf(existing docx) is refused with a docx_edit pointer', pdfSize.success === false && (pdfSize.error ?? '').includes('docx_edit'), pdfSize.error)
  }

  const csv = await svcExportDocument({ format: 'csv', content: MD_TABLE, filePath: join(ws, '库存.csv') })
  check('csv export succeeds', csv.success === true, csv.error)
  if (csv.success) {
    const raw = readFileSync(csv.path)
    check('csv read-back: first byte is the UTF-8 BOM', raw[0] === 0xef && raw.toString('utf8').charCodeAt(0) === 0xfeff)
  }

  // tmp+rename leaves no litter
  check('no .pm-tmp siblings survive', !readdirSync(ws).some((f) => f.includes('.pm-tmp')), readdirSync(ws).join(','))

  // ② D6: the same name twice never overwrites ──
  const again = await svcExportDocument({ format: 'xlsx', content: MD_TABLE, filePath: join(ws, '库存.xlsx') })
  check('second export with the same name succeeds', again.success === true, again.error)
  check('it lands on 库存-2.xlsx', again.path === join(ws, '库存-2.xlsx'), again.path)
  check('the first file is untouched', existsSync(join(ws, '库存.xlsx')))

  // ③ 越界: the guard refuses with a readable reason and records the denial ──
  const denied = await svcExportDocument({ format: 'xlsx', content: MD_TABLE, filePath: join(outside, 'steal.xlsx') })
  check('export into ~/.ssh is refused', denied.success === false)
  check('the refusal is readable (names the jail, no stack)', typeof denied.error === 'string' && denied.error.length > 0 && !denied.error.includes('Error: Error'), denied.error)

  // ④ sourcePath: a real md file converts ──
  const { writeFileSync: wf, mkdirSync: mkd } = await import('node:fs')
  mkd(ws, { recursive: true })
  wf(join(ws, 'source.md'), MD_TABLE, 'utf8')
  const viaSource = await svcExportDocument({ format: 'xlsx', sourcePath: join(ws, 'source.md'), filePath: join(ws, '转换.xlsx') })
  check('sourcePath (md → xlsx) succeeds', viaSource.success === true, viaSource.error)
  const badSource = await svcExportDocument({ format: 'xlsx', sourcePath: join(ws, 'source.png'), filePath: join(ws, 'x.xlsx') })
  check('a binary sourcePath is refused readably', badSource.success === false && (badSource.error ?? '').includes('sourcePath'), badSource.error)

  // ⑤ the audit trail: allowed writes AND the denial are on the record ──
  const audits = getDb().prepare(`SELECT action, decision, target FROM audit_log WHERE action = 'fs.write' ORDER BY ts`).all()
  const allowed = audits.filter((a) => a.decision === 'allowed')
  const deniedRows = audits.filter((a) => a.decision === 'denied')
  check('audit records the allowed fs.write exports', allowed.length >= 6, `${allowed.length} allowed row(s)`)
  check('an allowed row targets the exported file', allowed.some((a) => String(a.target).endsWith('库存.xlsx')))
  check('audit records the denial too', deniedRows.some((a) => String(a.target).includes('.ssh')), `${deniedRows.length} denied row(s)`)
}

// ── the gate phase: a corrupted docx builder, bundled in via esbuild ──
async function phaseGate() {
  const { DATA_DIR, ensureDataDir } = await import('../src/main/storage/index')
  guardHome(DATA_DIR)
  ensureDataDir()
  const { initializeDatabase } = await import('../src/main/storage/database')
  await initializeDatabase()
  const { svcExportDocument } = await import('../src/main/services/office-export')

  const home = process.env.PM_HOME
  const ws = join(home, 'workspaces', 'gate')
  const result = await svcExportDocument({ format: 'docx', content: '# 任何内容', filePath: join(ws, '坏.docx') })
  check('corrupted builder output is refused by the read-back gate', result.success === false, result.error)
  check('the refusal names the gate, not a generic crash', (result.error ?? '').includes('读回门'), result.error)
  check('zero disk writes: no target file', !existsSync(join(ws, '坏.docx')))
  const left = (() => { try { return readdirSync(ws) } catch { return [] } })()
  check('zero disk writes: no tmp siblings either', !left.some((f) => f.includes('.pm-tmp')), left.join(','))
}

/** better-sqlite3 is `external` to the bundle and required from the repo. */
const fromRepo = createRequire(join(REPO_ROOT, 'package.json'))

async function run(phase, home, entry, extraPlugin) {
  const work = home
  const bundle = join(work, `harness-${phase}.cjs`)
  const { build } = await import('esbuild')
  await build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: bundle,
    // Heavy/pure-JS deps resolve at runtime from the repo (NODE_PATH) instead
    // of being bundled: exceljs drags optional deps (unzipper → @aws-sdk) that
    // esbuild cannot resolve, and playwright-core's chromium-bidi is the same
    // story. better-sqlite3 stays external for its native binding.
    external: ['better-sqlite3', 'esbuild', 'exceljs', 'adm-zip', 'playwright-core', 'unzipper'],
    plugins: [
      {
        name: 'electron-stub',
        setup(b) {
          b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'pm-electron-stub' }))
          b.onLoad({ filter: /.*/, namespace: 'pm-electron-stub' }, () => ({
            contents: `module.exports = { app: { isPackaged: false, getAppPath: () => ${JSON.stringify(REPO_ROOT)} } }`,
            loader: 'js',
          }))
        },
      },
      ...(extraPlugin ? [extraPlugin] : []),
    ],
    logLevel: 'warning',
  })
  // Resolve bare specifiers the way the app's own bundle does — node_modules
  // next to the bundle. NODE_PATH below only covers require(); a deferred
  // engine loads through import(), which walks parent directories and ignores
  // NODE_PATH, so the temp dir needs a real node_modules to walk into.
  const link = join(work, 'node_modules')
  if (!existsSync(link)) symlinkSync(join(REPO_ROOT, 'node_modules'), link, 'dir')
  const electronBin = fromRepo('electron')
  if (typeof electronBin !== 'string' || !existsSync(electronBin)) {
    throw new Error(`could not resolve the Electron binary (got ${JSON.stringify(electronBin)}) — run npm install`)
  }
  const report = join(work, `report-${phase}.json`)
  const res = spawnSync(electronBin, [bundle], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      PM_REPO: REPO_ROOT,
      PM_PHASE: phase,
      PM_HOME: home,
      PM_REPORT: report,
      HOME: home, // the sandbox
      NODE_PATH: join(REPO_ROOT, 'node_modules'),
    },
  })
  if (res.error) throw res.error
  let payload = { checks: [] }
  if (existsSync(report)) payload = JSON.parse(readFileSync(report, 'utf-8'))
  return { status: res.status, ...payload }
}

async function launcher() {
  // `process.argv[1]` rather than `import.meta.url`: the phases are spawned
  // from a CJS bundle, where import.meta is empty (the color probe's lesson).
  const entry = process.argv[1]
  const home = mkdtempSync(join(tmpdir(), 'pm-home-export-'))
  const gateHome = mkdtempSync(join(tmpdir(), 'pm-home-gate-'))
  let failed = 0
  let total = 0

  console.log(`① service end-to-end (real guard, real fs, audit)  HOME=${home}`)
  const main = await run('main', home, entry)
  total += main.checks.length
  failed += main.checks.filter((c) => !c.pass).length
  if (main.status !== 0) { failed++; console.log(`  ✗ phase main exited with ${main.status}`) }

  console.log(`\n② read-back gate vs corrupted bytes            HOME=${gateHome}`)
  // The stub replaces the docx builder ONLY in this bundle: every docx export
  // produces non-zip bytes, so the gate — nothing else — must catch it.
  const gatePlugin = {
    name: 'garbage-docx-builder',
    setup(b) {
      b.onResolve({ filter: /office-export[\\/]md-to-docx/ }, (args) => ({
        path: args.path,
        namespace: 'pm-garbage-docx',
      }))
      b.onLoad({ filter: /.*/, namespace: 'pm-garbage-docx' }, () => ({
        contents: `export async function markdownToDocxBuffer() { return Buffer.from('definitely not a zip archive') }`,
        loader: 'js',
      }))
    },
  }
  const gate = await run('gate', gateHome, entry, gatePlugin)
  total += gate.checks.length
  failed += gate.checks.filter((c) => !c.pass).length
  if (gate.status !== 0) { failed++; console.log(`  ✗ phase gate exited with ${gate.status}`) }

  if (KEEP) console.log(`\nkept: ${home} ${gateHome}`)
  else {
    for (const dir of [home, gateHome]) {
      // Unlink the node_modules link itself before the recursive sweep: rmSync
      // must never have the repo's node_modules in its path.
      rmSync(join(dir, 'node_modules'), { force: true })
      rmSync(dir, { recursive: true, force: true })
    }
  }

  console.log(`\n${total - failed}/${total} checks passed${failed === 0 ? ' — ALL GREEN' : ''}`)
  process.exit(failed === 0 ? 0 : 1)
}

if (PHASE) {
  (PHASE === 'gate' ? phaseGate() : phaseMain())
    .then(() => {
      if (process.env.PM_REPORT) {
        const { writeFileSync } = require('node:fs')
        writeFileSync(process.env.PM_REPORT, JSON.stringify({ checks: results }))
      }
      process.exit(results.every((r) => r.pass) ? 0 : 1)
    })
    .catch((err) => {
      console.error(`\n✗ phase ${PHASE} threw: ${err?.stack || err}`)
      process.exit(1)
    })
} else {
  launcher().catch((err) => {
    console.error(`\n✗ ${err?.stack || err}`)
    process.exit(1)
  })
}
