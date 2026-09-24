// PLAN-browser-favorites — real store + real SQLite + one BrowserService pass.
// Recipe: teardown probe's (esbuild bundle + ELECTRON_RUN_AS_NODE + temp HOME).
import { build } from 'esbuild'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = process.cwd()
const work = mkdtempSync(join(tmpdir(), 'pm-favorites-'))
const home = join(work, 'home')
const require = createRequire(join(root, 'package.json'))
const source = `
import assert from 'node:assert/strict'

let checks = 0
const check = (label, fn) => { fn(); checks++; console.log('  ok  ' + label) }

async function main() {
  if (process.env.HOME !== ${JSON.stringify(home)}) throw new Error('Unsafe HOME')
  const { ensureDataDir } = await import('./src/main/storage/index')
  ensureDataDir()
  const { initializeDatabase, getDb } = await import('./src/main/storage/database')
  await initializeDatabase()
  const { browserFavoriteStore, MAX_BROWSER_FAVORITES } = await import('./src/main/storage/browser-favorite-store')
  const { normalizeFavoriteUrl } = await import('./src/shared/browser/pane')
  const count = () => (getDb().prepare('SELECT COUNT(*) c FROM browser_favorites').get()).c

  // ── add: normalize + idempotent upsert ──
  {
    const r1 = browserFavoriteStore.add('https://Zhihu.com/', '知乎')
    const r2 = browserFavoriteStore.add('https://zhihu.com#top', '知乎（重访）')
    check('同一页面（大小写/尾斜杠/hash 差异）两次 add → 一条（幂等 upsert）', () => {
      assert.equal(r1.created, true)
      assert.equal(r2.created, false)
      assert.equal(count(), 1)
    })
    check('重访刷新标题', () => {
      const row = browserFavoriteStore.list()[0]
      assert.equal(row.title, '知乎（重访）')
    })
    check('标题缺省的重复 add 保留旧标题', () => {
      browserFavoriteStore.add('https://zhihu.com')
      assert.equal(browserFavoriteStore.list()[0].title, '知乎（重访）')
    })
  }

  // ── has / query / remove ──
  {
    browserFavoriteStore.add('https://github.com/pulsemind', 'GitHub')
    check('has 走同一规范化键', () => {
      assert.equal(browserFavoriteStore.has('https://GITHUB.com/pulsemind#x'), true)
      assert.equal(browserFavoriteStore.has('https://gitlab.com'), false)
    })
    check('query 按 title/url 联想，最新在前', () => {
      const hits = browserFavoriteStore.query('git')
      assert.equal(hits.length, 1)
      assert.equal(hits[0].url, 'https://github.com/pulsemind')
    })
    check('remove 幂等可逆', () => {
      assert.equal(browserFavoriteStore.remove('https://github.com/pulsemind'), true)
      assert.equal(browserFavoriteStore.remove('https://github.com/pulsemind'), false)
      assert.equal(browserFavoriteStore.has('https://github.com/pulsemind'), false)
    })
  }

  // ── cap: over-limit add THROWS (never evicts) ──
  {
    const target = MAX_BROWSER_FAVORITES - count()
    for (let i = 0; i < target; i++) {
      browserFavoriteStore.add('https://example.com/' + i)
    }
    const before = count()
    let threw = null
    try { browserFavoriteStore.add('https://overflow.example.com') } catch (e) { threw = e }
    check('上限 200 只防炸：到顶 add 报错且不逐出任何收藏', () => {
      assert.ok(threw, 'over-cap add throws')
      assert.match(threw.message, /收藏已满/)
      assert.equal(count(), before)
    })
  }

  // ── BrowserService protocol layer (not the store directly) ──
  {
    const { browserService } = await import('./src/main/browser/BrowserService')
    browserFavoriteStore.clear()
    const scope = 'conv_probe'
    const run = async (payload) => (await browserService.executeCommand(payload, scope)).value
    const addedRaw = await browserService.executeCommand({ method: 'addFavorite', url: 'https://News.cn/', title: '新华网' }, scope)
    const added = addedRaw?.value ?? addedRaw
    check('协议层 addFavorite：规范化 + added 标记给模型回话', () => {
      assert.equal(added.url, 'https://news.cn')
      assert.ok(added.added === true || added.added === 'already')
    })
    const again = await run({ method: 'addFavorite', url: 'https://news.cn' })
    check('第二次 add 回 added=already（模型能对用户说清「本来就有」）', () => {
      assert.equal(again.added, 'already')
    })
    const list = await run({ method: 'listFavorites' })
    check('listFavorites 返回收藏列表', () => {
      assert.ok(Array.isArray(list))
      assert.ok(list.some((f) => f.url === 'https://news.cn'))
    })
    const removed = await run({ method: 'removeFavorite', url: 'https://news.cn' })
    check('removeFavorite 走协议层', () => {
      assert.equal(removed.removed, true)
    })
  }

  console.log('PASS: ' + checks + ' checks — 收藏存储 + 协议层在真实 SQLite 上成立')
}
main().then(() => process.exit(0)).catch((error) => { console.error(error); process.exit(1) })
`
try {
  const bundle = join(work, 'probe.cjs')
  await build({
    stdin: { contents: source, resolveDir: root, loader: 'ts' },
    outfile: bundle, bundle: true, platform: 'node', format: 'cjs', packages: 'external',
    plugins: [{ name: 'electron-stub', setup(b) {
      b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'stub' }))
      b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
        contents: `module.exports={app:{isPackaged:false,getAppPath:()=>${JSON.stringify(root)}}}`, loader: 'js',
      }))
    } }],
  })
  const run = spawnSync(require('electron'), [bundle], {
    cwd: root, stdio: 'inherit',
    env: { ...process.env, HOME: home, ELECTRON_RUN_AS_NODE: '1', NODE_PATH: join(root, 'node_modules') },
  })
  if (run.error) throw run.error
  process.exitCode = run.status === 0 ? 0 : 1
} finally {
  rmSync(work, { recursive: true, force: true })
}
