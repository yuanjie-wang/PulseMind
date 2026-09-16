// ── Deterministic string → color ──
// One hash implementation shared by every "identity color" caller (file-ref
// chips, project picker cards): the same input always lands on the same hue,
// so a name keeps its color across sessions without storing anything.

/** Hash a string → hue in [0, 360). shift-5-minus-self accumulation over char
 *  codes — stable, cheap, and well distributed across short names. */
export function stringToHue(str: string): number {
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i)
    hash |= 0
  }
  return Math.abs(hash) % 360
}

/** HSV → CSS color. CSS has no hsv() notation, so convert to rgb here.
 *  h in [0, 360), s/v in [0, 1]; alpha < 1 emits rgba(), otherwise rgb(). */
export function hsvToCss(h: number, s: number, v: number, alpha = 1): string {
  const c = v * s
  const hp = h / 60
  const x = c * (1 - Math.abs((hp % 2) - 1))
  let r = 0
  let g = 0
  let b = 0
  if (hp < 1) {
    r = c
    g = x
  } else if (hp < 2) {
    r = x
    g = c
  } else if (hp < 3) {
    g = c
    b = x
  } else if (hp < 4) {
    g = x
    b = c
  } else if (hp < 5) {
    r = x
    b = c
  } else {
    r = c
    b = x
  }
  const m = v - c
  const ch = (n: number) => Math.round((n + m) * 255)
  return alpha < 1 ? `rgba(${ch(r)}, ${ch(g)}, ${ch(b)}, ${alpha})` : `rgb(${ch(r)}, ${ch(g)}, ${ch(b)})`
}
