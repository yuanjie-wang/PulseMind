// ── DOCX font aliases ── Word documents name fonts by their Windows names
//  (`w:rFonts w:eastAsia="宋体"`), and docx-preview passes those names straight
//  into `font-family`. On macOS most of them are not installed, so every run
//  falls back to a default face: the glyph shapes change (that is the visible
//  difference from Word) and, worse, the metrics change — line widths and
//  heights shift, which moves the height-based page breaks too.
//
//  The fix is a plain CSS trick, not a font substitution pass: declare an
//  `@font-face` whose family is the *document's* name and whose only source is
//  `local(...)`, so the browser resolves "宋体" to the macOS face that is
//  actually installed under another name. No bytes are fetched, so nothing here
//  depends on the CSP (`font-src 'self' data:` allows it — measured in
//  Chromium) and no font files are bundled.
//
//  Ordering is load-bearing: these declarations are injected BEFORE
//  docx-preview's own <style>, so a document that *embeds* its font still wins
//  — the embedded face is declared later for the same family/descriptors and
//  therefore replaces the alias. So this is a fallback, never an override.
//
//  A family declared here with no matching local face simply fails to load and
//  the browser continues down the document's own font list, so an unknown or
//  unavailable name costs nothing.

const CJK_ALIASES: Record<string, string[]> = {
  // Simplified-Chinese fonts Word documents name most often.
  宋体: ['Songti SC', 'STSongti-SC-Regular', 'STSong'],
  SimSun: ['Songti SC', 'STSongti-SC-Regular', 'STSong'],
  新宋体: ['Songti SC', 'STSong'],
  NSimSun: ['Songti SC', 'STSong'],
  中易宋体: ['Songti SC', 'STSong'],
  黑体: ['Heiti SC', 'STHeitiSC-Light', 'STHeiti'],
  SimHei: ['Heiti SC', 'STHeitiSC-Light', 'STHeiti'],
  中易黑体: ['Heiti SC', 'STHeiti'],
  微软雅黑: ['PingFang SC', 'PingFangSC-Regular', 'Hiragino Sans GB'],
  'Microsoft YaHei': ['PingFang SC', 'PingFangSC-Regular', 'Hiragino Sans GB'],
  '微软雅黑 Light': ['PingFang SC'],
  等线: ['PingFang SC', 'PingFangSC-Regular'],
  '等线 Light': ['PingFang SC'],
  DengXian: ['PingFang SC'],
  楷体: ['Kaiti SC', 'KaitiSC-Regular', 'STKaiti'],
  KaiTi: ['Kaiti SC', 'KaitiSC-Regular', 'STKaiti'],
  楷体_GB2312: ['Kaiti SC', 'STKaiti'],
  仿宋: ['STFangsong', 'Fangsong', 'STFangsongSC-Regular'],
  FangSong: ['STFangsong', 'Fangsong'],
  仿宋_GB2312: ['STFangsong'],
  华文中宋: ['STZhongsong', 'Songti SC'],
  STZhongsong: ['STZhongsong', 'Songti SC'],
  华文宋体: ['STSong', 'Songti SC'],
  华文楷体: ['STKaiti', 'Kaiti SC'],
  华文仿宋: ['STFangsong'],
  华文细黑: ['Heiti SC', 'STHeiti', 'STXihei'],
  华文黑体: ['Heiti SC', 'STHeiti'],
  幼圆: ['Yuanti SC'],
  YouYuan: ['Yuanti SC'],
  隶书: ['STLiti'],
  LiSu: ['STLiti'],
  // 方正 faces ship with the Office/WPS installs rather than the OS; the
  // closest installed styles are mapped so the document keeps its look instead
  // of dropping to a default sans.
  方正小标宋简体: ['STZhongsong', 'Songti SC'],
  方正书宋: ['STSong', 'Songti SC'],
  方正仿宋: ['STFangsong'],
  方正黑体: ['Heiti SC', 'STHeiti'],
  方正楷体: ['STKaiti', 'Kaiti SC'],
}

const LATIN_ALIASES: Record<string, string[]> = {
  // Office's own faces are not on macOS; the metric-compatible substitutes
  // (Carlito / Caladea) are preferred where present, then the macOS default of
  // the same overall shape.
  Calibri: ['Carlito', 'Helvetica Neue'],
  'Calibri Light': ['Carlito', 'Helvetica Neue'],
  Cambria: ['Caladea', 'Georgia'],
  'Cambria Math': ['Caladea', 'Georgia'],
  Consolas: ['Menlo', 'Courier New'],
  'Segoe UI': ['Helvetica Neue'],
  'Segoe UI Light': ['Helvetica Neue'],
}

function fontFaceCss(aliases: Record<string, string[]>): string {
  return Object.entries(aliases)
    .map(([family, locals]) => {
      const src = locals.map((name) => `local("${name}")`).join(', ')
      return `@font-face { font-family: "${family}"; src: ${src}; }`
    })
    .join('\n')
}

/** The document's default when it names no font at all. docx-preview writes a
 *  `font-family` only for a run that names one (or references the theme), so a
 *  document that declares nothing shows the browser's own default — Times —
 *  where Word shows the theme's minor face. `.${className}` is also the element
 *  docx-preview hangs the theme variables on, so a themed document keeps its
 *  own minor font and `Calibri`/`宋体` are only the fallback for a document with
 *  no theme part (the common case for programmatically generated files).
 *  Latin resolves through the alias above; the CJK default is 宋体 because that
 *  is what a Chinese document without an explicit font is expected to look like
 *  (WPS's own default), while 等线/微软雅黑 documents name their font and never
 *  reach this rule. */
function defaultFontCss(className: string): string {
  return (
    `.${className}, .${className}-wrapper { font-family: ` +
    `var(--docx-minorHAnsi-font, Calibri), 宋体, "Helvetica Neue", sans-serif; }`
  )
}

/** Injected before docx-preview's own <style>, so embedded fonts still win. */
export function docxFontCss(className: string): string {
  return `${fontFaceCss(LATIN_ALIASES)}\n${fontFaceCss(CJK_ALIASES)}\n${defaultFontCss(className)}`
}
