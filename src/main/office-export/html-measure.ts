// ── HTML design route: measurement (PLAN-pptx-html-route) ── the glue between
//  deck.html on disk and the layout facts the emitter consumes. Two halves:
//
//  Pure validators (vitest-covered, run BEFORE Chromium for a fast refusal):
//    scanHtmlProfile   — source-text refusals (<script>, @font-face, gradients,
//                        network urls, font-family outside tokens …)
//    parseTokensCss    — tokens.css is a fixed 7-key schema, not a stylesheet
//    collectLinkedCss / collectImageSrcs / extractHtmlTitle
//    resolveTokenTheme — tokens + defaults → the theme the emitter gets
//
//  The measurement itself: a fresh headless Chromium per export (按次付费 —
//  never the browser tool's BrowserService instance), the html loaded from
//  file:// so the tokens <link> resolves exactly like the preview pane's does,
//  and collectDeckLayout serialized INTO the page. Default tokens are injected
//  as a <style> at head start — document-order cascade means a real
//  tokens.css link (and any inline <style>) wins over them.

import { pathToFileURL } from 'node:url'
import type { Browser } from 'playwright-core'
import { collectDeckLayout } from './html-measure-script'
import {
  DEFAULT_TOKENS, FONT_WHITELIST, FS_KEYS, FS_MAX_PX, FS_MIN_PX, TOKEN_KEYS,
  type CollectResult, type TokenKey,
} from './html-route-types'

const COLOR_KEYS: readonly string[] = ['--pm-accent', '--pm-accent-soft', '--pm-ink', '--pm-muted', '--pm-panel', '--pm-bg', '--pm-line']

// ── source-text profile scan: the fast belt before Chromium ──
// The page-level collector re-checks the layout facts anyway (transform,
// fixed, background-image via computed style); this scan catches what a
// string can see and costs nothing.

export function scanHtmlProfile(html: string): string[] {
  const errs: string[] = []
  const add = (m: string): void => { if (!errs.includes(m)) errs.push(m) }
  if (/<script[\s>]/i.test(html)) add('<script> 被拒绝——设计路线只转换静态版式，没有可执行内容。')
  if (/<(svg|iframe|video|audio|canvas|form|input|select|textarea|button|object|embed)[\s>]/i.test(html)) {
    add('出现了白名单外的元素——设计路线只收 h1–h6/p/ul/ol/li/table/img/div/span 等（白名单见 references/pptx.md）；图表用 data-chart 标注。')
  }
  if (/@font-face/i.test(html)) add('@font-face 被拒绝——字体只在 tokens.css 里从白名单选，web 字体进不了 pptx。')
  if (/@import/i.test(html)) add('@import 被拒绝——样式只允许 <style> 与一处 tokens.css 的 link。')
  if (/url\s*\(/i.test(html)) add('CSS url() 被拒绝——图片一律用 <img src> 指向工作区文件。')
  if (/srcset/i.test(html)) add('srcset 被拒绝——<img> 只给一个确定的工作区 src。')
  {
    const bare = Array.from(html.matchAll(/font-family\s*:\s*([^;}]+)/gi))
      .map((m) => m[1].trim())
      .filter((v) => !/^var\(--pm-font-(zh|latin|mono)\)$/.test(v))
    if (bare.length > 0) add('font-family 只允许 var(--pm-font-zh / --pm-font-latin / --pm-font-mono) 引用——字体名只在 tokens.css 里声明（收到「' + bare[0] + '」）。')
  }
  if (/position\s*:\s*fixed/i.test(html)) add('position:fixed 被拒绝——画布没有视口概念，用 absolute。')
  if (/(^|[;{\s])transform\s*:/im.test(html)) add('transform 被拒绝——位置、旋转、缩放直接写进布局。')
  if (/(^|[;{\s])(animation|transition)\s*:|@keyframes/i.test(html)) add('CSS 动画/过渡被拒绝——pptx 是静态页面。')
  if (/gradient\s*\(/i.test(html)) add('渐变被拒绝——背景只收纯色；渐变可以拆成几个纯色块近似。')
  if (/(colspan|rowspan)\s*=/i.test(html)) add('表格不支持 colspan/rowspan 合并单元格——拆成普通格子，或用色块拼版式。')
  if (/(src|href)\s*=\s*["']?\s*(https?:|data:)/i.test(html)) add('网络/内联资源被拒绝——图片与样式只允许工作区文件。')
  return errs
}

// ── tokens.css: the route's only theme surface ──

export interface ParsedTokens {
  values: Partial<Record<TokenKey, string>>
  errors: string[]
}

/** tokens.css must be exactly `:root { --pm-*: … }` declarations — a fixed
 *  schema the converter consumes, not a stylesheet. Colors are strict hex
 *  (CSS-invalid values would render differently in the preview than the pptx
 *  — the divergence is the refusal's reason); fonts one whitelisted face; the
 *  four type-scale keys are `NNpx` integers (they are html-side indirection —
 *  sizes are measured off the browser — but a nonsense scale must still be
 *  refused at save time, not discovered in the preview). */
export function parseTokensCss(text: string): ParsedTokens {
  const errors: string[] = []
  const values: Partial<Record<TokenKey, string>> = {}
  const stripped = text.replace(/\/\*[\s\S]*?\*\//g, '')
  const rootBodies: string[] = []
  const outside = stripped.replace(/:root\s*\{([^}]*)\}/g, (_, body: string) => {
    rootBodies.push(body)
    return ''
  })
  if (outside.replace(/[\s;]/g, '') !== '') {
    errors.push('tokens.css 只允许 :root { --pm-*: 值; } 变量声明——它是给转换器的固定 schema，不是样式表（选择器/普通属性/@规则都不要写）。')
    return { values, errors }
  }
  const seen = new Map<string, string>()
  for (const body of rootBodies) {
    for (const m of body.matchAll(/(--[a-zA-Z0-9-]+)\s*:\s*([^;}]*)/g)) {
      const name = m[1]
      if (!(TOKEN_KEYS as readonly string[]).includes(name)) {
        errors.push(`tokens.css 里出现了未知变量 ${name}——只认这七个：${TOKEN_KEYS.join(' ')}。`)
        continue
      }
      seen.set(name, m[2].trim())
    }
  }
  for (const [name, raw] of seen) {
    if (COLOR_KEYS.includes(name)) {
      const m = raw.match(/^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$/)
      if (!m) {
        errors.push(`${name} 的值「${raw}」不是合法 hex 颜色——写 #RRGGBB（或 #RGB）。`)
        continue
      }
      const hex = m[1].length === 3 ? m[1].split('').map((c) => c + c).join('') : m[1]
      values[name as TokenKey] = hex.toUpperCase()
    } else if (FS_KEYS.includes(name)) {
      const m = raw.match(/^(\d+)px$/)
      const n = m ? parseInt(m[1], 10) : NaN
      if (!Number.isFinite(n) || n < FS_MIN_PX || n > FS_MAX_PX) {
        errors.push(`${name} 的值「${raw}」要是 ${FS_MIN_PX}–${FS_MAX_PX} 的整像素数（如 26px）。`)
        continue
      }
      values[name as TokenKey] = `${n}px`
    } else {
      const face = raw.replace(/^["']|["']$/g, '').trim()
      if (!face || face.includes(',')) {
        errors.push(`${name} 一次只能给一个字体名（收到「${raw}」）。`)
        continue
      }
      if (!(FONT_WHITELIST as readonly string[]).includes(face)) {
        errors.push(`${name} 的字体「${face}」不在白名单——可选：${FONT_WHITELIST.join(' / ')}。`)
        continue
      }
      values[name as TokenKey] = face
    }
  }
  return { values, errors }
}

export interface TokenTheme {
  accent: string
  fontZh: string
  fontLatin: string
  /** Numerals/labels face — emitted per-run where the html asked for it. */
  fontMono: string
}

export function resolveTokenTheme(values: Partial<Record<TokenKey, string>>): TokenTheme {
  return {
    accent: (values['--pm-accent'] ?? DEFAULT_TOKENS['--pm-accent']).replace('#', '').toUpperCase(),
    fontZh: values['--pm-font-zh'] ?? DEFAULT_TOKENS['--pm-font-zh'],
    fontLatin: values['--pm-font-latin'] ?? DEFAULT_TOKENS['--pm-font-latin'],
    fontMono: values['--pm-font-mono'] ?? DEFAULT_TOKENS['--pm-font-mono'],
  }
}

/** The injected default-:root <style> — the html can reference var(--pm-*)
 *  unconditionally; a real tokens.css link (later in document order) wins. */
export function defaultTokensStyle(): string {
  const decls = (Object.entries(DEFAULT_TOKENS) as [TokenKey, string][])
    .map(([k, v]) => `${k}: ${v};`)
    .join(' ')
  return `<style>:root { ${decls} }</style>`
}

// ── structure readers ──

/** Every stylesheet <link>'s href, document order. The service enforces: at
 *  most tokens.css (any other link is a refusal — the schema has one theme
 *  surface, and an extra stylesheet would change what the preview shows vs
 *  what the pptx can keep). */
export function collectLinkedCss(html: string): string[] {
  return Array.from(html.matchAll(/<link\b[^>]*>/gi))
    .filter((m) => /rel\s*=\s*["']?stylesheet/i.test(m[0]))
    .map((m) => (m[0].match(/href\s*=\s*["']([^"']+)["']/i) ?? [])[1])
    .filter((v): v is string => !!v)
}

export function collectImageSrcs(html: string): string[] {
  const srcs: string[] = []
  for (const m of html.matchAll(/<img\b[^>]*>/gi)) {
    const tag = m[0]
    const src = (tag.match(/\bsrc\s*=\s*"([^"]*)"/i) ?? tag.match(/\bsrc\s*=\s*'([^']*)'/i) ?? tag.match(/\bsrc\s*=\s*([^\s>]+)/i) ?? [])[1]
    if (src) srcs.push(src)
  }
  return srcs
}

export function extractHtmlTitle(html: string): string | undefined {
  const m = html.match(/<title>([^<]*)<\/title>/i)
  const t = m ? m[1].trim() : ''
  return t || undefined
}

// ── the measurement itself ──

export type LaunchFn = (headless: boolean) => Promise<Browser>

/** Per-export launch: the shared resolver (env → bundled → system Chrome/Edge)
 *  first, then playwright-core's own managed browser (what
 *  `npm run browsers:install` installs) as the dev-machine fallback. */
async function defaultLaunch(headless: boolean): Promise<Browser> {
  const { chromium } = await import('playwright-core')
  let sharedError = ''
  try {
    const { resolveLaunchOptions } = await import('../browser/backends/ManagedBackend')
    const options = await resolveLaunchOptions(headless)
    return await chromium.launch(options)
  } catch (err) {
    sharedError = err instanceof Error ? err.message : String(err)
  }
  try {
    return await chromium.launch({ headless })
  } catch {
    throw new Error(`转换器无法启动 Chromium（${sharedError}）——运行 npm run browsers:install 安装内核，或设置 PULSEMIND_CHROMIUM_PATH 指向一个 Chromium 可执行文件后重试。`)
  }
}

export interface MeasureOptions {
  launch?: LaunchFn
  gotoTimeoutMs?: number
}

/** Load the html in headless Chromium and collect layout facts. Profile
 *  violations found in the page throw a refusal naming every page/element —
 *  the caller never sees partial facts (an export either lands complete or
 *  refuses, same discipline as the image resolution above). */
export async function measureLayout(htmlPath: string, opts: MeasureOptions = {}): Promise<Required<Pick<CollectResult, 'slides' | 'degradations'>>> {
  const launch = opts.launch ?? defaultLaunch
  let browser: Browser | undefined
  try {
    browser = await launch(true)
    const page = await browser.newPage()
    await page.goto(pathToFileURL(htmlPath).href, { waitUntil: 'load', timeout: opts.gotoTimeoutMs ?? 20_000 })
    // default tokens at head START: document-order cascade keeps a real
    // tokens.css link (and any inline <style>) above them
    await page.evaluate((css: string) => {
      const s = document.createElement('style')
      s.textContent = css
      ;(document.head ?? document.documentElement).insertBefore(s, (document.head ?? document.documentElement).firstChild)
    }, defaultTokensStyle())
    const result = (await page.evaluate(collectDeckLayout)) as CollectResult
    if (result.errors.length > 0) {
      throw new Error(result.errors.map((e) => (e.page > 0 ? `第 ${e.page} 页：${e.message}` : e.message)).join('\n'))
    }
    if (result.slides.length === 0) {
      throw new Error('页面里没有任何可转换的内容——确认 .slide 节点存在且未被隐藏。')
    }
    return { slides: result.slides, degradations: result.degradations }
  } finally {
    await browser?.close().catch(() => undefined)
  }
}
