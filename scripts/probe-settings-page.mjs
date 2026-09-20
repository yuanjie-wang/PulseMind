/**
 * Settings page acceptance probe (PLAN-settings-restructure; LLM section
 * reworked 2026-09-21 for the grouped IA).
 *
 * The page's visible surface is the MENU — 环境设置 / 模型设置 / 浏览器插件 /
 * 快捷键 / 助手设置 / 记忆 / 经验 / 数据与运行 / 关于 — and none of it is
 * reviewable from source: jsdom has no layout or focus model, and "the tab
 * switched" only exists once a click lands. So this mounts the *real*
 * SettingsPage under the real ConfigProvider with a stubbed electronAPI,
 * drives a real mouse through the menu, the four switches, both retention
 * selects and their confirm modal, the LLM settings groups (advanced
 * collapse, footer action bar, dirty-leave guard), and asserts what the user
 * would see.
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

/** Two populated profiles: the fixture's active profile (DeepSeek, OpenAI-
 *  compatible) and a non-active one to switch to. Writes must carry them
 *  through untouched — asserted below on the auto-cleanup write. */
const FIXTURE_PROFILES = [
  { id: 'profile_a', name: 'DeepSeek 官方', provider: 'openai', baseURL: 'https://api.deepseek.com', model: 'deepseek-chat', maxTokens: 32768, contextLength: 65536, apiKey: 'sk-fixture-deepseek' },
  { id: 'profile_b', name: 'Claude 官方', provider: 'anthropic', baseURL: 'https://api.anthropic.com', model: 'claude-sonnet-4-20250514', maxTokens: 32768, contextLength: 200000 },
]

/** Fixture settings: retainers at 0 (永久保留) and git injection on, i.e. a fresh
 *  install. `activeProfileId` points at the first fixture profile. */
const HARNESS = `
import React from 'react'
import { createRoot } from 'react-dom/client'
import { ConfigProvider, App } from 'antd'
import SettingsPage from './src/renderer/src/components/settings/SettingsPage'
import { SettingsProvider } from './src/renderer/src/hooks/SettingsContext'
import { TranslationProvider } from './src/renderer/src/i18n/useTranslation'

let settings = { activeProfileId: 'profile_a', profiles: ${JSON.stringify(FIXTURE_PROFILES)}, theme: 'light', locale: 'zh', workspaceDir: '/fixture/workspace', autoCleanup: false, launchAtLogin: false, conversationRetentionDays: 0, routineRunRetentionDays: 0, git: { contextInjection: true } }
window.initialSettings = JSON.parse(JSON.stringify(settings))
window.settingsWrites = []
window.openedFolders = []
window.electronAPI = new Proxy({}, { get: (_, key) => {
 if (String(key).startsWith('on')) return () => () => {}
 if (key === 'getSettings') return async () => settings
 if (key === 'setSettings') return async value => { settings = value; window.settingsWrites.push(value) }
 if (key === 'getDataPaths') return async () => ({ dataDir: '/fixture/data', skillsDir: '/fixture/data/skills', knowledgeDir: '/fixture/data/knowledge', workspaceDir: settings.workspaceDir })
 if (key === 'getPlatformInfo') return async () => ({ platform: 'darwin', platformName: 'macOS', release: '24.6.0', arch: 'arm64', ripgrepPath: null })
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
  // The page styles itself with --pm-* custom properties from the app's global
  // stylesheet, which this harness does not load — define the ones the page
  // paints with, so selected/hover/background states are observable.
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.end(`<!doctype html><html><head><title>Settings acceptance fixture</title>
<style>:root { --pm-bg: #ffffff; --pm-fill: #fafafa; --pm-border-hairline: #f0f0f0; --pm-border: #d9d9d9; --pm-text-strong: #171717; --pm-text-secondary: #5c5c5c; --pm-text-soft: #8c8c8c; }</style>
</head><body style="margin:0"><div id="app" style="height:100vh"></div><script src="/app.js"></script></body></html>`)
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
check('菜单九个分区（插件 / 快捷键 / 关于都在设置页里）',
  JSON.stringify(menu.map((m) => m.key)) === JSON.stringify(['environment', 'settings', 'extension', 'shortcuts', 'assistant', 'memory', 'experiences', 'data', 'about']),
  JSON.stringify(menu.map((m) => m.key)))
check('菜单文案与顺序：环境设置 / 模型设置 / 浏览器插件 / 快捷键 / 助手设置 / 记忆 / 经验 / 数据与运行 / 关于',
  JSON.stringify(menu.map((m) => m.label)) === JSON.stringify(['环境设置', '模型设置', '浏览器插件', '快捷键', '助手设置', '记忆', '经验', '数据与运行', '关于']),
  JSON.stringify(menu.map((m) => m.label)))
const stale = menu.filter((m) => ['收藏', '内置工具', '工具中心'].includes(m.label))
check('没有残留的「收藏」「内置工具」「工具中心」入口', stale.length === 0, stale.map((m) => m.label).join(','))

// ── 2. Default landing is 环境设置 (D8); 数据与运行 comes after a click ──
const wash = (key) => page.evaluate((k) => getComputedStyle(document.querySelector(`[data-settings-menu="${k}"]`)).backgroundColor, key)
const paneText = () => page.evaluate(() => document.querySelector('.settings-scroll').textContent)
check('默认落在环境设置（选中态在环境设置上）', (await wash('environment')) === 'rgb(240, 240, 240)', await wash('environment'))
check('未点开时页面里没有数据与运行的内容', !(await paneText()).includes('数据与运行'))
await page.screenshot({ path: join(SHOTS, 'settings-default.png') })

// ── 3. 环境设置 is the ONE directory surface: values from main, 打开 hands them to openFolder ──
// (The directory rows moved here out of 数据与运行; DataRuntimeSettings no longer repeats them.)
await page.waitForFunction(() => [...document.querySelectorAll('.settings-scroll input')]
  .some((el) => el.value === '/fixture/data'))
// A row is the deepest div that carries the label AND an input (ancestors match
// hasText too, and they precede it in document order — hence .last()).
const envRow = (label) => page.locator('.settings-scroll div')
  .filter({ hasText: label })
  .filter({ has: page.locator('input') })
  .last()
const rowValue = async (label) => envRow(label).locator('input').inputValue()
check('目录行渲染的是主进程给的值（配置 / 技能 / 知识库 / 工作目录）',
  (await rowValue('配置目录')) === '/fixture/data' &&
  (await rowValue('技能目录')) === '/fixture/data/skills' &&
  (await rowValue('知识库目录')) === '/fixture/data/knowledge' &&
  (await rowValue('工作目录')) === '/fixture/workspace',
  JSON.stringify({ config: await rowValue('配置目录'), skills: await rowValue('技能目录'), knowledge: await rowValue('知识库目录'), workspace: await rowValue('工作目录') }))
check('操作系统行渲染主进程给的平台信息', (await envRow('操作系统').locator('input').inputValue()).includes('macOS'))
check('目录行的「打开」按钮都落在正文列内（没被裁掉）', await page.evaluate(() => {
  const pane = document.querySelector('.settings-scroll').getBoundingClientRect()
  return ['配置目录', '技能目录', '知识库目录', '工作目录'].every((label) => {
    const row = [...document.querySelectorAll('.settings-scroll div')]
      .find((d) => d.childElementCount === 2 && d.firstElementChild?.textContent === label)
    if (!row) return false
    const r = row.querySelector('button').getBoundingClientRect()
    return r.width > 0 && r.right <= pane.right + 1 && r.left >= pane.left - 1
  })
}))
await envRow('知识库目录').locator('button').click()
await page.waitForFunction(() => window.openedFolders.length > 0)
check('点「打开」把该目录交给 openFolder', await page.evaluate(() => window.openedFolders[0]) === '/fixture/data/knowledge',
  JSON.stringify(await page.evaluate(() => window.openedFolders)))
await envRow('工作目录').locator('button').click()
await page.waitForFunction(() => window.openedFolders.length > 1)
check('工作目录行的「打开」打开的是当前工作区', await page.evaluate(() => window.openedFolders[1]) === '/fixture/workspace',
  await page.evaluate(() => window.openedFolders[1]))

// ── 4. 数据与运行: every switch writes exactly its own preference over the live settings ──
await page.locator('[data-settings-menu="data"]').click()
await page.waitForFunction(() => document.querySelector('.settings-scroll').textContent.includes('会话最长保留'))
await page.waitForFunction(() => {
  const t = document.querySelector('[role="switch"][aria-label="开机自启"]')
  return t !== null && !t.disabled
})
await page.waitForTimeout(200)
check('选中态从环境设置移到了数据与运行',
  (await wash('data')) === 'rgb(240, 240, 240)' && (await wash('environment')) === 'rgba(0, 0, 0, 0)',
  `${await wash('data')} / ${await wash('environment')}`)
await page.screenshot({ path: join(SHOTS, 'settings-data.png') })
check('这一页正好五个开关（五个偏好）', await page.evaluate(() => document.querySelectorAll('button.ant-switch').length) === 5,
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
check('自动清理写入 true，profiles 原样带过（不被写路径搅动）',
  cleanup.write.autoCleanup === true && JSON.stringify(cleanup.write.profiles) === JSON.stringify(FIXTURE_PROFILES) && cleanup.write.locale === 'zh')
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
await page.getByText('打开日志目录', { exact: true }).click()
await page.waitForFunction(() => window.openedFolders.length > 2)
check('「打开日志目录」指向 logs/llm-requests',
  await page.evaluate(() => window.openedFolders[2]) === '/fixture/data/logs/llm-requests',
  await page.evaluate(() => window.openedFolders[2]))

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

// ── 8. LLM 设置：分组 / 高级折叠 / 底部动作条 / 脏离开守卫 ──
await page.locator('[data-settings-menu="settings"]').click()
await page.waitForFunction(() => document.querySelector('.settings-scroll').textContent.includes('配置名称'))
await page.waitForTimeout(200)
const llmText = () => page.evaluate(() => document.querySelector('.settings-scroll').textContent)
// textContent counts hidden DOM (antd keeps the fold's content mounted);
// innerText is what the user can actually see.
const llmVisibleText = () => page.evaluate(() => document.querySelector('.settings-scroll').innerText)
// The profile select is the pane's first (provider select comes later, in 连接).
const profileSelect = page.locator('.ant-select').first()
const profileSelectText = async () => (await profileSelect.innerText()).replace(/\n/g, ' ')

check('选择器内联展示「当前使用」标记（收起态就可见）',
  (await profileSelectText()).includes('DeepSeek 官方') && (await profileSelectText()).includes('当前使用'),
  await profileSelectText())
check('没有「当前使用中」假按钮（状态并入选择器）', !(await llmText()).includes('当前使用中'))
check('连接分组标题在页面上', (await llmText()).includes('连接'))
check('高级组是一个折叠头，默认收起（调参内容不可见）',
  (await page.getByText('高级设置', { exact: true }).count()) === 1 &&
  !(await llmVisibleText()).includes('最大输出 Token'))

// Footer: editing the ACTIVE profile and clean → save-only, disabled.
const saveBtn = page.getByRole('button', { name: '已保存' })
check('底部动作条：干净状态下只有置灰的「已保存」',
  await saveBtn.isVisible() && await saveBtn.isDisabled())
check('底部动作条：激活配置不出现「使用此配置」',
  (await page.getByRole('button', { name: '使用此配置' }).count()) === 0)
check('脏提示在干净状态下不可见', await page.getByText('有未保存的更改').isHidden())
await page.screenshot({ path: join(SHOTS, 'settings-llm.png') })

// Expand 高级设置: the tuning knobs live inside the fold. The arrow's aria-label
// (expanded/collapsed) and the panel's -panel-active class are the open gates
// (antd 6 renamed the content node: .ant-collapse-panel, not -content).
await page.getByText('高级设置', { exact: true }).click()
await page.locator('.ant-collapse-arrow[aria-label="expanded"]').waitFor()
await page.locator('.ant-collapse-panel-active').waitFor({ state: 'visible' })
await page.waitForTimeout(300) // let the expand motion settle before the shot
check('展开后调参项与自定义 Headers 都在（且可见）',
  (await llmVisibleText()).includes('最大输出 Token') && (await llmVisibleText()).includes('添加 Header'))
await page.screenshot({ path: join(SHOTS, 'settings-llm-expanded.png') })

// Switch to the NON-active profile — a clean switch asks nothing.
await profileSelect.click()
await page.waitForSelector('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option')
await page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option', { hasText: 'Claude 官方' }).click()
await page.waitForFunction(() => document.querySelector('.settings-scroll').textContent.includes('使用此配置'))
check('切到非激活配置：选择器不再挂「当前使用」，出现「使用此配置」，保存仍置灰',
  !(await profileSelectText()).includes('当前使用') &&
  await page.getByRole('button', { name: '使用此配置' }).isVisible() &&
  await page.getByRole('button', { name: '已保存' }).isDisabled())

// Dirty via a name edit: hint appears, save lights up.
await page.getByLabel('配置名称').fill('Claude 工作号')
await page.waitForFunction(() => document.querySelector('.settings-scroll').textContent.includes('保存配置'))
const dirtySave = page.getByRole('button', { name: '保存配置' })
check('编辑后：脏提示可见，保存亮起',
  await page.getByText('有未保存的更改').isVisible() && await dirtySave.isEnabled())

// Leave guard: switching tabs with unsaved edits asks first.
await page.locator('[data-settings-menu="environment"]').click()
await page.waitForSelector('.ant-modal-confirm')
const guardText = (await page.locator('.ant-modal-confirm').innerText()).replace(/\n/g, ' / ')
check('带脏改动切分区先弹放弃确认（点名该配置当前的名字）',
  guardText.includes('放弃未保存的更改') && guardText.includes('Claude 工作号'), guardText)
await page.locator('.ant-modal-confirm-btns .ant-btn:not(.ant-btn-primary)').click()
await page.waitForFunction(() => document.querySelector('.settings-scroll').textContent.includes('配置名称'))
check('取消后留在本分区，编辑未丢', (await page.getByLabel('配置名称').inputValue()) === 'Claude 工作号')
await page.locator('[data-settings-menu="environment"]').click()
await page.waitForSelector('.ant-modal-confirm')
await page.locator('.ant-modal-confirm-btns .ant-btn-primary').click()
await page.waitForFunction(() => document.querySelector('.settings-scroll').textContent.includes('操作系统'))
await page.waitForTimeout(300) // the menu's selected background eases in over 0.15s — read it settled
check('确认放弃后落到目标分区（环境设置）', (await wash('environment')) === 'rgb(240, 240, 240)', await wash('environment'))
await page.locator('[data-settings-menu="settings"]').click()
await page.waitForFunction(() => document.querySelector('.settings-scroll').textContent.includes('配置名称'))
// Navigating away unmounted the section: on return the editing target resets to
// the ACTIVE profile — the discarded rename is gone with the mount.
check('回到本分区：编辑已弃置（回到激活配置的已存值，无脏提示）',
  (await page.getByLabel('配置名称').inputValue()) === 'DeepSeek 官方' && await page.getByText('有未保存的更改').isHidden())

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
