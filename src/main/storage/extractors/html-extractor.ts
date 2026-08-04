import { basename } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { ExtractionResult } from './index'

export async function extractHtml(filePath: string, buffer: Buffer): Promise<ExtractionResult> {
  const [{ JSDOM }, { Readability }, TurndownService] = await Promise.all([
    import('jsdom'),
    import('@mozilla/readability'),
    import('turndown').then(m => m.default)
  ])
  const html = buffer.toString('utf-8')
  const dom = new JSDOM(html, { url: pathToFileURL(filePath).href })
  const document = dom.window.document

  // Strip script and style tags before extraction
  document.querySelectorAll('script, style').forEach(el => el.parentNode?.removeChild(el));

  // Extract text from SVG <text>/<tspan> nodes and inject as regular HTML
  const svgTexts: string[] = []
  document.querySelectorAll('svg text, svg tspan').forEach(el => {
    const t = el.textContent?.trim()
    if (t) svgTexts.push(t)
  })
  if (svgTexts.length > 0) {
    const container = document.createElement('div')
    container.innerHTML = svgTexts.map(t => `<p>${t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</p>`).join('')
    document.body.appendChild(container)
  }

  // Extract title from <title> tag or filename
  let title = document.querySelector('title')?.textContent?.trim() || basename(filePath).replace(/\.[^.]+$/, '')

  // Use Readability to extract main content
  const reader = new Readability(document)
  const article = reader.parse()

  const contentHtml = article?.content || html

  // Convert HTML to Markdown
  const turndownService = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced'
  })
  const markdown = turndownService.turndown(contentHtml)

  const frontmatter = `---
title: "${title.replace(/"/g, '\\"')}"
source: "${filePath.replace(/"/g, '\\"')}"
extracted: "${new Date().toISOString()}"
---\n\n`

  return {
    title,
    content: frontmatter + markdown
  }
}
