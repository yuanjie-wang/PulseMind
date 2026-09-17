/**
 * Settings page acceptance probe (PLAN-settings-restructure).
 *
 * The page's visible surface is the MENU — 环境设置 / LLM 设置 / 助手设置 / 记忆 /
 * 经验 / 数据与运行 — and none of it is reviewable from source: jsdom has no layout
 * or focus model, and "the tab switched" only exists once a click lands. So this
 * mounts the *real* SettingsPage under the real ConfigProvider with a stubbed
 * electronAPI, drives a real mouse through the menu, the four switches, both
 * retention selects and their confirm modal, and asserts what the user would see.
 *
 * It doubles as the interactive fixture: the URL is printed, and `--keep-open`
 * leaves it up after the checks so the same page can be looked at by hand.
 *
 * Usage: node scripts/probe-settings-page.mjs [--headed] [--keep-open]
 */
import { build } from 'esbuild'
import { chromium } from 'playwright-core'
import { mkdirSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HEADED = process.argv.includes('--headed')
const KEEP_OPEN = process.argv.includes('--keep-open')
const SHOTS = process.env.PM_SHOT_DIR ?? join(tmpdir(), 'pm-settings-shots')
mkdirSync(SHOTS, { recursive: true })

const results = []
function check(name, pass, detail) {
  results.push({ name, pass, detail })
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

/** Fixture settings: retainers at 0 (永久保留) and git injection on, i.e. a fresh
 *  install. `activeProfileId`/`profiles` are here because a switch write must not
 *  disturb them. */
const HARNESS = `
import React from 'react'
import { createRoot } from 'react-dom/client'
import { ConfigProvider, App } from 'antd'
import SettingsPage from './src/renderer/src/components/settings/SettingsPage'
import { SettingsProvider } from './src/renderer/src/hooks/SettingsContext'
import { TranslationProvider } from './src/renderer/src/i18n/useTranslation'

let settings = { activeProfileId: '', profiles: [], theme: 'light', locale: 'zh', workspaceDir: '/fixture/workspace', autoCleanup: false, launchAtLogin: false, conversationRetentionDays: 0, routineRunRetentionDays: 0, git: { contextInjection: true } }
window.initialSettings = JSON.parse(JSON.stringify(settings))
window.settingsWrites = []
window.openedFolders = []
window.electronAPI = new Proxy({}, { get: (_, key) => {
 if (String(key).startsWith('on')) return () => () => {}
 if (key === 'getSettings') return async () => settings
 if (key === 'setSettings') return async value => { settings = value; window.settingsWrites.push(value) }
 if (key === 'getDataPaths') return async () => ({ dataDir: '/fixture/data', knowledgeDir: '/fixture/data/knowledge', workspaceDir: settings.workspaceDir })
 if (key === 'openFolder') return async path => { window.openedFolders.push(path) }
 if (key === 'getSystemInfo') return async () => ({platform: 'darwin', arch: 'arm64', homedir: '/fixture', hostname: 'fixture'})
 return async () => []
}})
// A render crash is otherwise invisible here: the page just stays empty and every
// structural check reads as "the feature is missing".
window.renderErrors = []
window.addEventListener('error', e => window.renderErrors.push(String(e.message)))
window.addEventListener('unhandledrejection', e => window.renderErrors.push(String(e.reason)))
createRoot(document.getElementById('app')).render(<ConfigProvider><App><SettingsProvider><TranslationProvider initialLocale="zh"><SettingsPage /></TranslationProvider></SettingsProvider></App></ConfigProvider>)
`

const result = await build({ stdin: { contents: HARNESS, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' }, loader: { '.css': 'text', '.woff': 'text', '.woff2': 'text', '.ttf': 'text' }, logLevel: 'error' })
const server = createServer((req, res) => {
  if (req.url === '/app.js') { res.setHeader('Content-Type', 'application/javascript'); res.end(result.outputFiles[0].text); return }
  res.setHeader('Content-Type', 'text/html')
  res.end('<!doctype html><html><head><title>Settings acceptance fixture</title></head><body style="margin:0"><div id="app" style="height:100vh"></div><script src="/app.js"></script></body></html>')
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const url = `http://127.0.0.1:${server.address().port}/`
console.log(`Settings fixture: ${url}`)

const browser = await chromium.launch({ headless: !HEADED })
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
await page.goto(url)
await page.waitForSelector('[data-settings-menu="environment"]')
// The default section (环境设置) renders before SettingsProvider has its settings,
// and every control is disabled until it does — the state a click must not be
// judged in. The switches themselves only exist on the 数据与运行 tab, so the gate
// has to be the pane plus a settings-derived value, not a switch that is not there.
await page.waitForFunction(() => {
  const pane = document.querySelector('.settings-scroll')
  return pane !== null && pane.textContent.trim().length > 0
})
await page.waitForTimeout(200)

// ── 1. The MENU: composition, order, labels ──
const menu = await page.evaluate(() => [...document.querySelectorAll('[data-settings-menu]')]
  .map((el) => ({ key: el.getAttribute('data-settings-menu'), label: el.textContent.trim() })))
check('菜单只剩六个分区（内置工具、收藏都已移出）',
  JSON.stringify(menu.map((m) => m.key)) === JSON.stringify(['environment', 'settings', 'assistant', 'memory', 'experiences', 'data']),
  JSON.stringify(menu.map((m) => m.key)))
check('菜单文案与顺序：环境设置 / LLM 设置 / 助手设置 / 记忆 / 经验 / 数据与运行',
  JSON.stringify(menu.map((m) => m.label)) === JSON.stringify(['环境设置', 'LLM 设置', '助手设置', '记忆', '经验', '数据与运行']),
  JSON.stringify(menu.map((m) => m.label)))
const stale = menu.filter((m) => ['收藏', '内置工具', '工具中心'].includes(m.label))
check('没有残留的「收藏」「内置工具」「工具中心」入口', stale.length === 0, stale.map((m) => m.label).join(','))

// ── 2. Default landing is 环境设置 (D8); 数据与运行 comes after a click ──
const wash = (key) => page.evaluate((k) => getComputedStyle(document.querySelector(`[data-settings-menu="${k}"]`)).backgroundColor, key)
const paneText = () => page.evaluate(() => document.querySelector('.settings-scroll').textContent)
check('默认落在环境设置（选中态在环境设置上）', (await wash('environment')) === 'rgb(240, 240, 240)', await wash('environment'))
check('未点开时页面里没有数据与运行的内容', !(await paneText()).includes('数据与运行'))
await page.screenshot({ path: join(SHOTS, 'settings-default.png') })

await page.locator('[data-settings-menu="data"]').click()
await page.waitForFunction(() => document.querySelector('.settings-scroll').textContent.includes('数据与运行'))
// Data paths arrive from main after the section mounts ('—' until then), and the
// switches stay disabled until SettingsProvider's load lands.
await page.waitForFunction(() => {
  const t = document.querySelector('[role="switch"][aria-label="开机自启"]')
  return t !== null && !t.disabled && document.querySelector('[data-directory="dataDir"]')?.textContent !== '—'
})
await page.waitForTimeout(200)
const dataText = await paneText()
check('点击后数据与运行真的渲染出来（两个保留项都在）',
  dataText.includes('会话最长保留') && dataText.includes('运行记录最长保留'))
check('选中态从环境设置移到了数据与运行',
  (await wash('data')) === 'rgb(240, 240, 240)' && (await wash('environment')) === 'rgba(0, 0, 0, 0)',
  `${await wash('data')} / ${await wash('environment')}`)
await page.screenshot({ path: join(SHOTS, 'settings-data.png') })

// ── 3. The three read-only paths come from main, and 打开 hands them to openFolder ──
const paths = await page.evaluate(() => Object.fromEntries(['dataDir', 'knowledgeDir', 'workspaceDir']
  .map((k) => [k, document.querySelector(`[data-directory="${k}"]`).textContent])))
check('三条只读路径渲染的是主进程给的值',
  paths.dataDir === '/fixture/data' && paths.knowledgeDir === '/fixture/data/knowledge' && paths.workspaceDir === '/fixture/workspace',
  JSON.stringify(paths))
check('三行的「打开」按钮都落在正文列内（没被裁掉）', await page.evaluate(() => {
  const pane = document.querySelector('.settings-scroll').getBoundingClientRect()
  return [...document.querySelectorAll('[data-directory]')].every((row) => {
    const r = row.parentElement.querySelector('button').getBoundingClientRect()
    return r.width > 0 && r.right <= pane.right + 1 && r.left >= pane.left - 1
  })
}))
await page.locator('button[aria-label="打开 知识库目录"]').click()
await page.waitForFunction(() => window.openedFolders.length > 0)
check('点「打开」把该目录交给 openFolder', await page.evaluate(() => window.openedFolders[0]) === '/fixture/data/knowledge',
  JSON.stringify(await page.evaluate(() => window.openedFolders)))
await page.getByText('打开日志目录', { exact: true }).click()
await page.waitForFunction(() => window.openedFolders.length > 1)
check('「打开日志目录」指向 logs/llm-requests',
  await page.evaluate(() => window.openedFolders[1]) === '/fixture/data/logs/llm-requests',
  await page.evaluate(() => window.openedFolders[1]))

// ── 4. Every switch writes exactly its own preference over the live settings ──
check('这一页正好四个开关（四个偏好）', await page.evaluate(() => document.querySelectorAll('button.ant-switch').length) === 4,
  String(await page.evaluate(() => document.querySelectorAll('button.ant-switch').length)))
const PROBE_KEYS = ['launchAtLogin', 'autoCleanup', 'debugLlmRequests', 'git', 'conversationRetentionDays', 'routineRunRetentionDays', 'workspaceDir', 'profiles', 'activeProfileId', 'locale', 'theme']
/** Which of the load-bearing fields the newest write moved relative to the write before it. */
const lastDiff = () => page.evaluate((keys) => {
  const writes = window.settingsWrites
  const last = writes[writes.length - 1]
  const base = writes.length > 1 ? writes[writes.length - 2] : window.initialSettings
  return keys.filter((k) => JSON.stringify(last[k]) !== JSON.stringify(base[k]))
}, PROBE_KEYS)
const toggle = async (label) => {
  const before = await page.evaluate(() => window.settingsWrites.length)
  await page.locator(`button[role="switch"][aria-label="${label}"]`).click()
  await page.waitForFunction((n) => window.settingsWrites.length > n, before)
  return { diff: await lastDiff(), write: await page.evaluate(() => window.settingsWrites[window.settingsWrites.length - 1]) }
}
const launch = await toggle('开机自启')
check('「开机自启」只改动 launchAtLogin', JSON.stringify(launch.diff) === '["launchAtLogin"]', JSON.stringify(launch.diff))
check('开机自启写入 true', launch.write.launchAtLogin === true, String(launch.write.launchAtLogin))
const cleanup = await toggle('自动清理会话')
check('「自动清理会话」只改动 autoCleanup', JSON.stringify(cleanup.diff) === '["autoCleanup"]', JSON.stringify(cleanup.diff))
check('自动清理写入 true，profiles 等字段原样带过',
  cleanup.write.autoCleanup === true && JSON.stringify(cleanup.write.profiles) === '[]' && cleanup.write.locale === 'zh')
const debug = await toggle('记录 LLM 请求报文')
check('「记录 LLM 请求报文」只改动 debugLlmRequests', JSON.stringify(debug.diff) === '["debugLlmRequests"]', JSON.stringify(debug.diff))
const git = await toggle('注入 Git 状态')
check('「注入 Git 状态」只改动 git，且仍是对象（不是散字段）',
  JSON.stringify(git.diff) === '["git"]' && git.write.git?.contextInjection === false, JSON.stringify(git.write.git))

// ── 5. Both retention selects offer the SAME four choices (shared retention-options) ──
const selectIndex = (label) => page.evaluate((l) => [...document.querySelectorAll('.ant-select')]
  .findIndex((el) => el.previousElementSibling?.textContent?.trim() === l), label)
const openSelect = async (label) => {
  const idx = await selectIndex(label)
  await page.locator('.ant-select').nth(idx).click()
  await page.waitForSelector('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option')
  return page.evaluate(() => [...document.querySelectorAll('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option-content')]
    .map((el) => el.textContent.trim()))
}
const conversationOptions = await openSelect('会话最长保留')
check('会话保留选项 = 永久保留 / 保留 7 天 / 保留 30 天 / 保留 90 天',
  JSON.stringify(conversationOptions) === JSON.stringify(['永久保留', '保留 7 天', '保留 30 天', '保留 90 天']),
  JSON.stringify(conversationOptions))

// A positive window deletes old conversations, so it must ask before it writes.
const writesBeforeConfirm = await page.evaluate(() => window.settingsWrites.length)
await page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden)')
  .getByText('保留 30 天', { exact: true }).click()
await page.waitForSelector('.ant-modal-confirm')
const confirmText = (await page.locator('.ant-modal-confirm').innerText()).replace(/\n/g, ' / ')
check('选 30 天先弹确认框，文案点名 30 天与不可撤销',
  confirmText.includes('30 天') && confirmText.includes('不可撤销'), confirmText)
check('确认之前一次写入都没有发生',
  await page.evaluate(() => window.settingsWrites.length) === writesBeforeConfirm,
  String(await page.evaluate(() => window.settingsWrites.length)))
await page.locator('.ant-modal-confirm-btns .ant-btn-primary').click()
await page.waitForFunction((n) => window.settingsWrites.length > n, writesBeforeConfirm)
const retentionWrite = await page.evaluate(() => window.settingsWrites[window.settingsWrites.length - 1])
check('确认后才写入 conversationRetentionDays = 30，运行记录保留没被顺手改掉',
  retentionWrite.conversationRetentionDays === 30 && retentionWrite.routineRunRetentionDays === 0,
  JSON.stringify({ c: retentionWrite.conversationRetentionDays, r: retentionWrite.routineRunRetentionDays }))
// Read the root's text, not a named inner class: antd 6 moved the value node
// around (v5's `.ant-select-selection-item` is not where it was), and what the
// user sees is the control's text either way.
const retentionDisplay = await page.locator('.ant-select').nth(await selectIndex('会话最长保留')).innerText()
check('选择框显示的是新值（写入回灌到控件）', retentionDisplay.includes('保留 30 天'),
  retentionDisplay.replace(/\n/g, ' '))

const runOptions = await openSelect('运行记录最长保留')
check('运行记录保留用的是同一份选项（两处不会漂移）',
  JSON.stringify(runOptions) === JSON.stringify(conversationOptions), JSON.stringify(runOptions))
await page.keyboard.press('Escape')

// ── 6. The copy that explains the toggles is on screen ──
const text = await paneText()
check('调试说明点名 logs/llm-requests（报文落盘位置）', text.includes('logs/llm-requests'))
check('自动清理说明点名 100 条上限与关掉的后果', text.includes('100 条上限') && text.includes('无法新建'))
check('开机自启说明点名与托盘菜单同步', text.includes('托盘菜单'))

// ── 7. Geometry: 160px menu inside a capped, centered column ──
const geometry = await page.evaluate(() => {
  const item = document.querySelector('[data-settings-menu="environment"]')
  const pane = document.querySelector('.settings-scroll')
  return {
    menuWidth: getComputedStyle(item.parentElement.parentElement).width,
    cap: getComputedStyle(pane.firstElementChild).maxWidth,
    wrapperWidth: getComputedStyle(pane.parentElement).maxWidth,
    pageWidth: document.getElementById('app').getBoundingClientRect().width,
  }
})
check('菜单仍是 160px', parseFloat(geometry.menuWidth) === 160, JSON.stringify(geometry))
check('内容列的宽度上限 = 菜单 160 + PAGE_COLUMN_MAX_WIDTH，且窄于窗口',
  parseFloat(geometry.wrapperWidth) === 160 + parseFloat(geometry.cap) && parseFloat(geometry.cap) < geometry.pageWidth,
  JSON.stringify(geometry))

check('页面没有渲染期报错', await page.evaluate(() => window.renderErrors.length) === 0,
  JSON.stringify(await page.evaluate(() => window.renderErrors)))

if (KEEP_OPEN) {
  console.log(`fixture left running (--keep-open): ${url}`)
} else {
  await browser.close()
  server.close()
}

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
console.log(`screenshots: ${SHOTS}`)
if (failed.length > 0) {
  console.error(`failed:\n  ${failed.map((f) => f.name).join('\n  ')}`)
  process.exit(1)
}
