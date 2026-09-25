interface Bounds {
  x: number; y: number; width: number; height: number
}

interface SnapLine {
  orientation: 'v' | 'h'
  pos: number
}

const THRESHOLD = 6

function findBest(
  candidates: { pos: number; offset: number }[],
  threshold: number,
): { pos: number; offset: number } | null {
  let best: { pos: number; offset: number } | null = null
  for (const c of candidates) {
    const d = Math.abs(c.offset)
    if (d < threshold && (!best || d < Math.abs(best.offset))) {
      best = c
    }
  }
  return best
}

export function snapMove(
  bounds: Bounds,
  others: Bounds[],
  threshold = THRESHOLD,
): { bounds: Bounds; lines: SnapLine[] } {
  const { width, height } = bounds
  let { x, y } = bounds
  const lines: SnapLine[] = []

  const xCandidates: { pos: number; offset: number }[] = []
  const yCandidates: { pos: number; offset: number }[] = []

  for (const o of others) {
    const oR = o.x + o.width
    const oB = o.y + o.height

    xCandidates.push({ pos: o.x, offset: o.x - x })
    xCandidates.push({ pos: oR, offset: oR - x })
    xCandidates.push({ pos: o.x, offset: o.x - (x + width) })
    xCandidates.push({ pos: oR, offset: oR - (x + width) })
    xCandidates.push({ pos: o.x + o.width / 2, offset: (o.x + o.width / 2) - (x + width / 2) })

    yCandidates.push({ pos: o.y, offset: o.y - y })
    yCandidates.push({ pos: oB, offset: oB - y })
    yCandidates.push({ pos: o.y, offset: o.y - (y + height) })
    yCandidates.push({ pos: oB, offset: oB - (y + height) })
    yCandidates.push({ pos: o.y + o.height / 2, offset: (o.y + o.height / 2) - (y + height / 2) })
  }

  const bestX = findBest(xCandidates, threshold)
  if (bestX) {
    x += bestX.offset
    lines.push({ orientation: 'v', pos: bestX.pos })
  }

  const bestY = findBest(yCandidates, threshold)
  if (bestY) {
    y += bestY.offset
    lines.push({ orientation: 'h', pos: bestY.pos })
  }

  return { bounds: { x, y, width, height }, lines }
}

export function snapResize(
  bounds: Bounds,
  edges: ('left' | 'right' | 'top' | 'bottom')[],
  others: Bounds[],
  threshold = THRESHOLD,
): { bounds: Bounds; lines: SnapLine[] } {
  let { x, y, width, height } = bounds
  const lines: SnapLine[] = []

  const xTargets: number[] = []
  const yTargets: number[] = []
  for (const o of others) {
    xTargets.push(o.x, o.x + o.width)
    yTargets.push(o.y, o.y + o.height)
  }

  for (const edge of edges) {
    if (edge === 'left') {
      const best = findBest(xTargets.map(t => ({ pos: t, offset: t - x })), threshold)
      if (best) { x += best.offset; width -= best.offset; lines.push({ orientation: 'v', pos: best.pos }) }
    } else if (edge === 'right') {
      const best = findBest(xTargets.map(t => ({ pos: t, offset: t - (x + width) })), threshold)
      if (best) { width += best.offset; lines.push({ orientation: 'v', pos: best.pos }) }
    } else if (edge === 'top') {
      const best = findBest(yTargets.map(t => ({ pos: t, offset: t - y })), threshold)
      if (best) { y += best.offset; height -= best.offset; lines.push({ orientation: 'h', pos: best.pos }) }
    } else if (edge === 'bottom') {
      const best = findBest(yTargets.map(t => ({ pos: t, offset: t - (y + height) })), threshold)
      if (best) { height += best.offset; lines.push({ orientation: 'h', pos: best.pos }) }
    }
  }

  // Dimension snap
  if (edges.includes('right') && !edges.includes('left')) {
    const matches: { offset: number; rect: Bounds }[] = []
    for (const o of others) {
      const offset = o.width - width
      if (Math.abs(offset) < threshold) matches.push({ offset, rect: o })
    }
    if (matches.length > 0) {
      const best = matches.reduce((a, b) => Math.abs(a.offset) < Math.abs(b.offset) ? a : b)
      width += best.offset
      lines.push({ orientation: 'v', pos: x })
      lines.push({ orientation: 'v', pos: x + width })
    }
  } else if (edges.includes('left') && !edges.includes('right')) {
    const matches: { offset: number; rect: Bounds }[] = []
    for (const o of others) {
      const offset = o.width - width
      if (Math.abs(offset) < threshold) matches.push({ offset, rect: o })
    }
    if (matches.length > 0) {
      const best = matches.reduce((a, b) => Math.abs(a.offset) < Math.abs(b.offset) ? a : b)
      x -= best.offset
      width = best.rect.width
      lines.push({ orientation: 'v', pos: x })
      lines.push({ orientation: 'v', pos: x + width })
    }
  }

  if (edges.includes('bottom') && !edges.includes('top')) {
    const matches: { offset: number; rect: Bounds }[] = []
    for (const o of others) {
      const offset = o.height - height
      if (Math.abs(offset) < threshold) matches.push({ offset, rect: o })
    }
    if (matches.length > 0) {
      const best = matches.reduce((a, b) => Math.abs(a.offset) < Math.abs(b.offset) ? a : b)
      height += best.offset
      lines.push({ orientation: 'h', pos: y })
      lines.push({ orientation: 'h', pos: y + height })
    }
  } else if (edges.includes('top') && !edges.includes('bottom')) {
    const matches: { offset: number; rect: Bounds }[] = []
    for (const o of others) {
      const offset = o.height - height
      if (Math.abs(offset) < threshold) matches.push({ offset, rect: o })
    }
    if (matches.length > 0) {
      const best = matches.reduce((a, b) => Math.abs(a.offset) < Math.abs(b.offset) ? a : b)
      y -= best.offset
      height = best.rect.height
      lines.push({ orientation: 'h', pos: y })
      lines.push({ orientation: 'h', pos: y + height })
    }
  }

  return { bounds: { x, y, width, height }, lines }
}
