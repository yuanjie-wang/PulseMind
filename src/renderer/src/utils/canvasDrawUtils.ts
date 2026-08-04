import type { Annotation } from '../types/canvas'

export function drawAnnotation(
  ctx: CanvasRenderingContext2D,
  ann: Annotation,
  index?: number,
  zoom: number = 1,
) {
  ctx.save()
  ctx.strokeStyle = ann.color
  ctx.fillStyle = ann.color
  ctx.lineWidth = 2
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'

  let badgeY = 0
  switch (ann.type) {
    case 'pen':
      if (ann.points.length < 2) break
      ctx.beginPath()
      ctx.moveTo(ann.points[0].x, ann.points[0].y)
      for (let i = 1; i < ann.points.length; i++) ctx.lineTo(ann.points[i].x, ann.points[i].y)
      ctx.stroke()
      if (ann.points.length > 0) {
        const last = ann.points[ann.points.length - 1]
        badgeY = last.y
      }
      break
    case 'highlight':
      if (ann.points.length < 2) break
      ctx.globalAlpha = 0.3
      ctx.lineWidth = 16
      ctx.beginPath()
      ctx.moveTo(ann.points[0].x, ann.points[0].y)
      for (let i = 1; i < ann.points.length; i++) ctx.lineTo(ann.points[i].x, ann.points[i].y)
      ctx.stroke()
      if (ann.points.length > 0) {
        const last = ann.points[ann.points.length - 1]
        badgeY = last.y
      }
      break
    case 'arrow': {
      if (ann.points.length < 2) break
      const [s, e] = [ann.points[0], ann.points[1]]
      ctx.beginPath()
      ctx.moveTo(s.x, s.y)
      ctx.lineTo(e.x, e.y)
      ctx.stroke()
      const angle = Math.atan2(e.y - s.y, e.x - s.x)
      const headLen = 12
      const spread = 0.4
      ctx.beginPath()
      ctx.moveTo(e.x, e.y)
      ctx.lineTo(
        e.x - headLen * Math.cos(angle - spread),
        e.y - headLen * Math.sin(angle - spread),
      )
      ctx.moveTo(e.x, e.y)
      ctx.lineTo(
        e.x - headLen * Math.cos(angle + spread),
        e.y - headLen * Math.sin(angle + spread),
      )
      ctx.stroke()
      badgeY = e.y
      break
    }
    case 'rectangle':
      if (!ann.boundingBox) break
      ctx.strokeRect(ann.boundingBox.x, ann.boundingBox.y, ann.boundingBox.width, ann.boundingBox.height)
      badgeY = ann.boundingBox.y + ann.boundingBox.height
      break
    case 'ellipse':
      if (!ann.boundingBox) break
      ctx.beginPath()
      ctx.ellipse(
        ann.boundingBox.x + ann.boundingBox.width / 2,
        ann.boundingBox.y + ann.boundingBox.height / 2,
        ann.boundingBox.width / 2,
        ann.boundingBox.height / 2,
        0, 0, Math.PI * 2,
      )
      ctx.stroke()
      badgeY = ann.boundingBox.y + ann.boundingBox.height
      break
    case 'text':
      if (ann.points.length < 1) break
      ctx.font = '14px sans-serif'
      ctx.fillStyle = ann.color
      ctx.textAlign = 'left'
      ctx.textBaseline = 'top'
      ctx.fillText(ann.text || '', ann.points[0].x, ann.points[0].y)
      break
  }

  // Note badge — draw a frosted-glass pill near the annotation showing the text
  if (ann.text && ann.type !== 'text' && ann.type !== 'rect') {
    const z = zoom
    const badgeText = ann.text.length > 30 ? ann.text.slice(0, 30) + '...' : ann.text
    ctx.font = `${11 / z}px -apple-system, BlinkMacSystemFont, sans-serif`
    const metrics = ctx.measureText(badgeText)
    const pw = 16 / z // horizontal padding
    const bw = metrics.width + pw * 2
    const bh = 20 / z
    // Position badge below the annotation, centered horizontally
    let bx: number
    if (ann.boundingBox) {
      bx = ann.boundingBox.x + ann.boundingBox.width / 2 - bw / 2
    } else {
      bx = ann.points[0].x
    }
    const by = badgeY + 6 / z

    // Background pill
    ctx.save()
    ctx.globalAlpha = 0.85
    ctx.fillStyle = '#fff'
    ctx.shadowColor = 'rgba(0,0,0,0.08)'
    ctx.shadowBlur = 4 / z
    ctx.beginPath()
    ctx.roundRect(bx, by, bw, bh, 6 / z)
    ctx.fill()
    ctx.restore()

    // Border
    ctx.save()
    ctx.strokeStyle = 'rgba(0,0,0,0.08)'
    ctx.lineWidth = 0.5 / z
    ctx.beginPath()
    ctx.roundRect(bx, by, bw, bh, 6 / z)
    ctx.stroke()
    ctx.restore()

    // Text
    ctx.save()
    ctx.fillStyle = '#333'
    ctx.font = `${11 / z}px -apple-system, BlinkMacSystemFont, sans-serif`
    ctx.textAlign = 'left'
    ctx.textBaseline = 'middle'
    ctx.fillText(badgeText, bx + pw, by + bh / 2)
    ctx.restore()
  }

  // Number badge for child annotations (inverse-scale so it stays fixed on screen)
  if (index !== undefined && ann.points.length > 0) {
    const p = ann.points[0]
    ctx.save()
    const r = 7 / zoom
    ctx.fillStyle = ann.color
    ctx.beginPath()
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillStyle = '#fff'
    ctx.font = `bold ${9 / zoom}px sans-serif`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(String(index + 1), p.x, p.y + 0.5 / zoom)
    ctx.restore()
  }

  ctx.restore()
}
