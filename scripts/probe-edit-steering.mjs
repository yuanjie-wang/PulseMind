/**
 * edit-form steering probe (2026-10-29) — an A/B behavioral test of the
 * 2026-10-29 batch, against the REAL model: did the manual/schema rewrite and
 * the new error tails actually move which edit FORM deepseek-v4.1-flash uses?
 * vitest can pin bytes and pure functions; only a live model can answer
 * "does the model follow it" — the question every 「提示词教学→硬约束」 note in
 * AGENTS.md is really about.
 *
 * Two bundles of the REAL modules, one scenario each way:
 *
 *   OLD = the five changed files as of HEAD (old「Which mode」table, old
 *         「More token-efficient」schema, old "regenerate the diff" error tails)
 *   NEW = the working tree (search/replace default, SWITCH_TO_REPLACE tails)
 *
 * Scenarios (real tool loop: the probe plays the executor — `read` returns the
 * real formatReadOutput shape with `%6d\t` numbering, `edit` runs the real
 * svcEditFile/svcPatchFile from main/services/file-ops.ts):
 *
 *   S1 form-choice — "three scattered changes in ONE file": the old manual
 *      steered exactly this shape to the diff form (measured 54–90% failure);
 *      the new one declares search/replace the default. Metric: which form
 *      the first edit call uses, and whether the file ends up correct.
 *   S2 steer-after-failure — the model is told to use the `diff` parameter,
 *      and the file silently gains 2 lines at the top after its read, so its
 *      hunk start is stale (the conv_20261028145742 failure shape). Metric:
 *      after the mismatch error, does the next edit call switch to
 *      search/replace (steered) or resend a diff?
 *
 * ⚠️ Talks to the network and spends the user's quota on the ACTIVE profile
 * (~12K prompt tokens per request, a few dozen requests per run — cents on a
 * flash model). Never prints the key.
 *
 * Usage: node --disable-warning=ExperimentalWarning scripts/probe-edit-steering.mjs [runsPerCell] [s1|s2]
 */

import { build } from 'esbuild'
import { execSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = new URL('..', import.meta.url).pathname
const RUNS = Math.max(1, parseInt(process.argv[2] ?? '3', 10) || 3)
const ONLY = process.argv[3] // optional: s1 | s2

// ── the five files whose OLD (HEAD) text defines the control variant ──
const VARIANT_FILES = [
  'src/renderer/src/tools/tool-instructions.ts',
  'src/renderer/src/tools/built-in-tools.ts',
  'src/shared/diff/edit-similarity.ts',
  'src/shared/diff/patch-utils.ts',
  'src/main/services/file-ops.ts',
]
const headText = new Map()
for (const rel of VARIANT_FILES) {
  headText.set(join(ROOT, rel), execSync(`git show HEAD:${rel}`, { cwd: ROOT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }))
}

async function bundle(variant) {
  const out = join(mkdtempSync(join(tmpdir(), `pm-steer-${variant}-`)), 'probe.mjs')
  const entry = join(out, '..', 'entry.ts')
  writeFileSync(
    entry,
    `export { buildSystemPrompt } from ${JSON.stringify(join(ROOT, 'src/renderer/src/agent/system-prompt-builder.ts'))}\n` +
      `export { BUILT_IN_TOOLS } from ${JSON.stringify(join(ROOT, 'src/renderer/src/tools/built-in-tools.ts'))}\n` +
      `export { buildToolProtocols } from ${JSON.stringify(join(ROOT, 'src/renderer/src/agent/engine/tool-collection.ts'))}\n` +
      `export { settingsStore } from ${JSON.stringify(join(ROOT, 'src/main/storage/settings-store.ts'))}\n` +
      `export { editMissError } from ${JSON.stringify(join(ROOT, 'src/shared/diff/edit-similarity.ts'))}\n` +
      `export { patchContent, parseMultiFileDiff } from ${JSON.stringify(join(ROOT, 'src/shared/diff/patch-utils.ts'))}\n`,
  )
  await build({
    entryPoints: [entry], bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'silent',
    plugins: [
      {
        name: 'electron-stub',
        setup(b) {
          b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'pm-electron-stub' }))
          b.onLoad({ filter: /.*/, namespace: 'pm-electron-stub' }, () => ({
            contents: `module.exports = { app: { isPackaged: false, getAppPath: () => ${JSON.stringify(ROOT)} }, safeStorage: { isEncryptionAvailable: () => false, decryptString: (v) => v } }`, loader: 'js',
          }))
        },
      },
      ...(variant === 'old'
        ? [{
            name: 'head-files',
            setup(b) {
              b.onLoad({ filter: /\/src\/(renderer\/src\/tools|shared\/diff|main\/services)\/(tool-instructions|built-in-tools|edit-similarity|patch-utils|file-ops)\.ts$/ }, (args) => ({
                contents: headText.get(args.path) ?? readFileSync(args.path, 'utf8'), loader: 'ts',
              }))
            },
          }]
        : []),
    ],
  })
  return import(pathToFileURL(out).href)
}

// ── profile: the REAL store, the ACTIVE profile (same as the app uses) ──
const probe = await bundle('new')
const settings = await probe.settingsStore.get()
const profile = settings.profiles.find((p) => p.id === settings.activeProfileId)
if (!profile) { console.log('no active profile resolved — nothing to probe'); process.exit(1) }
if ((profile.provider ?? 'openai') !== 'openai') { console.log(`active profile apiFormat "${profile.provider}" — probe speaks OpenAI shape only`); process.exit(1) }
const url = profile.baseURL.replace(/\/+$/, '') + '/chat/completions'

const TOOL_NAMES = ['read', 'edit']
const tools = probe.BUILT_IN_TOOLS.filter((t) => TOOL_NAMES.includes(t.name)).map((t) => ({
  type: 'function',
  function: { name: t.name, description: t.description, parameters: t.input_schema },
}))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const resolvable = (p, ws) => (isAbsolute(p) && exists(p) ? p : join(ws, p))
const exists = (p) => { try { statSync(p); return true } catch { return false } }

// read output in the real formatReadOutput shape (metadata header + %6d\t body)
function formatRead(filePath, content, offset, limit) {
  const all = content.endsWith('\n') ? content.slice(0, -1) : content
  const fileLines = content === '' ? [] : all.split('\n')
  const page = fileLines.slice(offset - 1, offset - 1 + limit)
  const body = page.map((l, i) => `${String(offset + i).padStart(6)}\t${l}`).join('\n')
  return [
    '--- File Metadata ---',
    `  Path: ${filePath}`,
    `  Size: ${Buffer.byteLength(content)} B${` (${fileLines.length} lines)`}`,
    `  Range: lines ${offset}-${offset + page.length - 1}`,
    `  Numbering: each content line is prefixed with its absolute line number ("N\\t", cat -n style) — a coordinate for referencing (e.g. "edit around line 350"), NOT part of the file. Strip the prefixes when passing text to edit old_str/new_str or write.`,
    '--- End File Metadata ---',
    '',
    body,
  ].join('\n')
}

async function chat(system, messages) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + profile.apiKey, ...(profile.headers ?? {}) },
    body: JSON.stringify({ model: profile.model, max_tokens: 2048, stream: false, tools, messages: [{ role: 'system', content: system }, ...messages] }),
  })
  const json = await res.json()
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${JSON.stringify(json).slice(0, 200)}`)
  return { message: json.choices?.[0]?.message ?? {}, usage: json.usage ?? {} }
}

const fixture = [
  '// notification preferences for the desktop client',
  'export const NOTIFY_DEFAULTS = {',
  '  soundEnabled: true,',
  '  quietHours: false,',
  '  RETRIES: 2,',
  '}',
  '',
  'export function shouldNotify(event: string): boolean {',
  '  if (event === "heartbeat") return false',
  '  return NOTIFY_DEFAULTS.soundEnabled',
  '}',
  '',
  'export function retryDelay(attempt: number): number {',
  '  return Math.min(1000 * 2 ** attempt, 30_000)',
  '}',
  '',
  'export function label(kind: string): string {',
  '  const names = { message: "消息", todo: "待办", system: "系统" }',
  '  return names[kind] ?? kind',
  '}',
].join('\n')

const S1_TASK = (f) =>
  `在 ${f} 里做三处修改：1) NOTIFY_DEFAULTS 里的 quietHours 从 false 改成 true；2) shouldNotify 里 "heartbeat" 的判断改成同时排除 "tick"；3) label 的 names 表里加一项 error: "错误"。三处都在同一个文件里。改完简单说一句改了什么。`
// Suggests the diff form (so a hunk failure happens) without forbidding
// old_str — a 「必须用 diff、不要用 old_str」 wording makes the model obey the
// user over the error tail, which measures obedience, not steering.
const S2_TASK = (f) =>
  `读取 ${f}，然后用 \`diff\` 参数（unified diff 形态）把 NOTIFY_DEFAULTS 里的 RETRIES 从 2 改成 8。`

const S3_TASK = (ws) =>
  `在 ${ws} 下有两个文件：mod_a.ts 和 mod_b.ts。把 mod_a.ts 里的 RETRIES: 2 改成 8，mod_b.ts 里的 VERSION 从 1.0.0 改成 1.1.0。这两个改动必须一起落地（同一次调用完成，省略 file_path 用多文件 diff）。`

async function runScenario(variant, scenario, runIndex, mod) {
  const ws = mkdtempSync(join(tmpdir(), `pm-steer-ws-${variant}-`))
  const file = join(ws, 'notify.ts')
  const log = (s) => console.log(`  [${variant}/${scenario}#${runIndex}] ${s}`)

  const opts = {
    apiKey: null, baseURL: profile.baseURL, model: profile.model, maxTokens: 2048,
    myName: 'Yuanjie', soul: 'terse, technical', yourName: 'Pulse', locale: 'zh',
    workspaceDir: ws, memoryManager: { getManualMemoryContext: async () => '' },
  }
  const task = scenario === 's1' ? S1_TASK('notify.ts') : scenario === 's3' ? S3_TASK(ws) : S2_TASK('notify.ts')
  const sp = await mod.buildSystemPrompt({ opts, messages: [], plan: null, toolProtocols: mod.buildToolProtocols(mod.BUILT_IN_TOOLS.filter((t) => TOOL_NAMES.includes(t.name))) })
  const system = sp.systemPrompt
  const messages = [{ role: 'user', content: task }, { role: 'user', content: sp.stateBlock }]

  writeFileSync(file, fixture)
  const fileB = join(ws, 'mod_b.ts')
  if (scenario === 's3') {
    const fa = join(ws, 'mod_a.ts')
    writeFileSync(fa, fixture)
    writeFileSync(fileB, `// module b\nexport const VERSION = '1.0.0'\nexport const LABEL = 'mod-b'\n`)
  }
  const calls = []
  let drifted = false

  for (let i = 0; i < 8; i++) {
    let r
    try { r = await chat(system, messages) } catch (e) { log(`chat error: ${e.message}`); break }
    await sleep(400)
    const m = r.message
    if (!m.tool_calls?.length) break
    messages.push({ role: 'assistant', content: m.content ?? '', tool_calls: m.tool_calls })
    for (const tc of m.tool_calls) {
      const fn = tc.function?.name
      let input = {}
      try { input = JSON.parse(tc.function?.arguments ?? '{}') } catch { /* keep {} */ }
      let out = ''
      if (fn === 'read') {
        const p = resolvable(input.file_path ?? '', ws)
        if (!exists(p)) { out = `Error: file not found: ${input.file_path}` }
        else if (!statSync(p).isFile()) { out = `Error: ${input.file_path} is a directory — read takes a file path` }
        else out = formatRead(input.file_path, readFileSync(p, 'utf8'), Math.max(1, input.offset ?? 1), Math.min(1000, input.limit ?? 500))
      } else if (fn === 'edit') {
        // S2: after the model has read the file, drift it by 2 lines so the
        // hunk start it computed is stale (real disk drift, no gate here —
        // the point is the mismatch error's steering).
        if (scenario === 's2' && !drifted) {
          drifted = true
          writeFileSync(file, '// auto-generated header\n// do not edit this line\n' + readFileSync(file, 'utf8'))
        }
        if (scenario === 's3' && !drifted) {
          drifted = true
          writeFileSync(fileB, '// auto-generated header\n// do not edit this line\n' + readFileSync(fileB, 'utf8'))
        }
        // multi-file diff: svcPatchFiles' core (validate/lock layers skipped,
        // all-or-nothing kept; the heldBack suffix is the exact shipped text —
        // HEAD's file-ops has none)
        if (input.diff !== undefined && !input.file_path) {
          const sections = mod.parseMultiFileDiff(input.diff)
          if (!sections || sections.length === 0) {
            calls.push({ form: 'multi-file diff', ok: false, single: false, error: 'no sections' })
            log('edit multi  → FAIL: no sections parsed')
            messages.push({ role: 'tool', tool_call_id: tc.id, content: 'Error: no `diff --git` sections found in the diff' })
            continue
          }
          let failure = null
          const patched = []
          for (const sec of sections) {
            const target = resolvable(sec.path, ws)
            const raw = exists(target) && statSync(target).isFile() ? readFileSync(target, 'utf8') : null
            if (raw === null) { failure = `${sec.path}: file not found`; break }
            const applied = mod.patchContent(raw, sec.diff)
            if (!applied.success) { failure = `${sec.path}: ${applied.error}`; break }
            patched.push([target, applied.content])
          }
          const other = sections.length - (failure ? sections.findIndex((x) => failure.startsWith(x.path)) : sections.length) - 1
          const heldBack = failure && variant === 'new' && sections.length > 1
            ? ` — nothing was written: the other ${Math.max(0, other)} section(s) of this diff are held back by this one (all-or-nothing). If these files need not land together, send them as separate single-file search/replace edits so one bad hunk cannot block the rest.`
            : ''
          if (failure) {
            calls.push({ form: 'multi-file diff', ok: false, single: false, error: failure + heldBack })
            log(`edit multi  → FAIL: ${(failure + heldBack).slice(0, 130)}`)
            messages.push({ role: 'tool', tool_call_id: tc.id, content: 'Error: ' + failure + heldBack })
            continue
          }
          for (const [t, c] of patched) writeFileSync(t, c)
          calls.push({ form: 'multi-file diff', ok: true, single: false })
          log(`edit multi  → ok (${patched.length} files)`)
          messages.push({ role: 'tool', tool_call_id: tc.id, content: `Applied ${patched.length} file(s).` })
          continue
        }
        const target = resolvable(input.file_path || (scenario === 's3' ? 'mod_a.ts' : 'notify.ts'), ws)
        // svcEditFile/svcPatchFile's core semantics (file-ops minus the
        // office/sandbox/lock layers, which are irrelevant to a temp file):
        // exact-match replace with CRLF tolerance / patchContent on disk bytes.
        const raw = exists(target) ? readFileSync(target, 'utf8') : null
        let res2
        if (input.diff !== undefined) {
          if (raw === null) res2 = { success: false, replacements: 0, error: `file not found: ${input.file_path}` }
          else {
            const applied = mod.patchContent(raw, input.diff)
            res2 = applied.success ? (writeFileSync(target, applied.content), { success: true, replacements: applied.replacements }) : { success: false, replacements: 0, error: applied.error }
          }
          calls.push({ form: 'diff', ok: res2.success, single: true, error: res2.error })
          log(`edit diff[${target.split('/').pop()}] → ${res2.success ? 'ok' : 'FAIL: ' + (res2.error ?? '').slice(0, 110)}`)
        } else {
          if (raw === null) res2 = { success: false, replacements: 0, error: `file not found: ${input.file_path}` }
          else {
            const oldStr = (input.old_str ?? '').replace(/\r\n/g, '\n')
            const newStr = (input.new_str ?? '').replace(/\r\n/g, '\n')
            const content = raw.replace(/\r\n/g, '\n')
            const count = oldStr === '' ? 0 : content.split(oldStr).length - 1
            if (count === 0) res2 = { success: false, replacements: 0, error: mod.editMissError(input.file_path, content, oldStr) }
            else {
              const replaced = input.multi === true ? content.replaceAll(oldStr, newStr) : content.replace(oldStr, newStr)
              writeFileSync(target, replaced)
              res2 = { success: true, replacements: count }
            }
          }
          calls.push({ form: 'old_str', ok: res2.success, single: true, error: res2.error })
          log(`edit replace→ ${res2.success ? 'ok' : 'FAIL: ' + (res2.error ?? '').slice(0, 110)}`)
        }
        out = res2.success ? `Applied ${res2.replacements} replacement(s) to ${input.file_path}.` : `Error: ${res2.error}`
      } else {
        out = `Error: tool ${fn} is not available in this probe (read/edit only)`
      }
      messages.push({ role: 'tool', tool_call_id: tc.id, content: out })
    }
  }

  const after = readFileSync(file, 'utf8')
  const checks = {
    quietHours: /quietHours:\s*true/.test(after),
    heartbeatTick: /event !== "heartbeat" && event !== "tick"/.test(after) || /!?\[\s*"heartbeat",\s*"tick"\s*\]/.test(after) || /exclude.*tick|tick.*exclude|!== "tick"/.test(after),
    errorLabel: /error:\s*"错误"/.test(after),
    retries8: /RETRIES:\s*8/.test(after),
  }
  const firstEdit = calls[0]
  const firstFailIdx = calls.findIndex((c) => !c.ok)
  const afterFail = firstFailIdx >= 0 ? calls[firstFailIdx + 1] : undefined
  const switched = afterFail
    ? (scenario === 's2' ? afterFail.form === 'old_str' : afterFail.single === true)
    : null
  const result = {
    variant, scenario, run: runIndex,
    forms: calls.map((c) => c.form + (c.ok ? '' : '!')).join(' ') || '(no edit)',
    firstForm: firstEdit?.form ?? '(none)',
    failed: calls.filter((c) => !c.ok).length,
    switched: switched === null ? '—' : (switched ? 'yes' : 'no'),
    taskOk: scenario === 's1' ? (checks.quietHours && checks.errorLabel)
      : scenario === 's3' ? (/RETRIES:\s*8/.test(readFileSync(join(ws, 'mod_a.ts'), 'utf8')) && /1\.1\.0/.test(readFileSync(fileB, 'utf8')))
      : checks.retries8,
    totalTokens: 0,
  }
  return result
}

console.log(`model: ${profile.model}  endpoint: ${new URL(url).host}  runs/cell: ${RUNS}\n`)
const oldMod = await bundle('old')
const rows = []
for (const scenario of ['s1', 's2', 's3'].filter((x) => !ONLY || x === ONLY)) {
  for (const variant of ['old', 'new']) {
    for (let i = 1; i <= RUNS; i++) {
      try { rows.push(await runScenario(variant, scenario, i, variant === 'new' ? probe : oldMod)) } catch (e) { console.log(`  [${variant}/${scenario}#${i}] probe error: ${e.message}`) }
      await sleep(300)
    }
  }
}

console.log('\n=== A/B result ===')
const cell = (v, s) => rows.filter((r) => r.variant === v && r.scenario === s)
for (const s of ['s1', 's2', 's3']) {
  console.log(`\n${s === 's1' ? 'S1 单文件三处改动（看 firstForm 是否 search/replace、taskOk）' : s === 's2' ? 'S2 建议 diff + 行号漂移（看失败后是否换 search/replace）' : 'S3 双文件同落多文件 diff + 单文件漂移（看失败后是否拆单文件）'}`)
  for (const v of ['old', 'new']) {
    const rs = cell(v, s)
    if (!rs.length) continue
    const forms = rs.map((r) => r.firstForm)
    const switched = rs.filter((r) => r.switched === 'yes').length
    const taskOk = rs.filter((r) => r.taskOk).length
    console.log(`  ${v.toUpperCase().padEnd(4)} firstForm=${forms.join(',').padEnd(30)} failed-calls=${rs.reduce((a, r) => a + r.failed, 0)}  switched=${switched}/${rs.filter((r) => r.switched !== '—').length}  taskOk=${taskOk}/${rs.length}`)
    for (const r of rs) console.log(`        #${r.run}: ${r.forms}`)
  }
}
