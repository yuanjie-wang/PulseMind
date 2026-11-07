import { describe, expect, it } from 'vitest'
import {
  computeSegments,
  cropRgb,
  ctcDecode,
  dbPostProcess,
  dedupeJoin,
  filterNoiseLines,
  resizeBilinear,
  toTensorData
} from '../src/main/services/ocr-core'

/** 造一张纯色 3 通道图 */
const solid = (w: number, h: number, rgb: [number, number, number]): Uint8Array => {
  const out = new Uint8Array(w * h * 3)
  for (let i = 0; i < w * h; i++) {
    out[i * 3] = rgb[0]
    out[i * 3 + 1] = rgb[1]
    out[i * 3 + 2] = rgb[2]
  }
  return out
}

const blankProb = (w: number, h: number): Float32Array => new Float32Array(w * h)

/** 在概率图上刷一个矩形区域 */
const paint = (
  prob: Float32Array,
  w: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  v: number
): void => {
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) prob[y * w + x] = v
  }
}

describe('toTensorData', () => {
  it('det 模式按 ImageNet 均值方差归一化，且按 CHW 排列', () => {
    const out = toTensorData(solid(1, 1, [255, 0, 0]), 1, 1, 'det')
    expect(out.length).toBe(3)
    // R: (1 - 0.485) / 0.229
    expect(out[0]).toBeCloseTo((1 - 0.485) / 0.229, 5)
    // G: (0 - 0.456) / 0.224
    expect(out[1]).toBeCloseTo(-0.456 / 0.224, 5)
    expect(out[2]).toBeCloseTo(-0.406 / 0.225, 5)
  })

  it('rec 模式按 (x/255-0.5)/0.5 归一化，黑白映射到 -1/+1', () => {
    const black = toTensorData(solid(1, 1, [0, 0, 0]), 1, 1, 'rec')
    const white = toTensorData(solid(1, 1, [255, 255, 255]), 1, 1, 'rec')
    expect(black[0]).toBe(-1)
    expect(white[0]).toBe(1)
  })

  it('同一张图两种口径结果必须不同（防混用）', () => {
    const img = solid(1, 1, [128, 128, 128])
    expect(toTensorData(img, 1, 1, 'det')[0]).not.toBeCloseTo(
      toTensorData(img, 1, 1, 'rec')[0],
      3
    )
  })
})

describe('resizeBilinear', () => {
  it('同尺寸缩放保持像素不变', () => {
    const src = solid(2, 2, [10, 20, 30])
    expect(Array.from(resizeBilinear(src, 2, 2, 2, 2))).toEqual(Array.from(src))
  })

  it('纯色图任意缩放后仍是纯色', () => {
    const out = resizeBilinear(solid(1, 1, [7, 8, 9]), 1, 1, 4, 3)
    expect(out.length).toBe(4 * 3 * 3)
    for (let i = 0; i < 4 * 3; i++) {
      expect(out[i * 3]).toBe(7)
      expect(out[i * 3 + 1]).toBe(8)
      expect(out[i * 3 + 2]).toBe(9)
    }
  })

  it('放大后左右两半颜色正确（验证双线性采样位置）', () => {
    // 2x1：左黑右白 → 放大到 4x1，采样点落在中间应取到插值
    const src = new Uint8Array([0, 0, 0, 255, 255, 255])
    const out = resizeBilinear(src, 2, 1, 4, 1)
    expect(out[0]).toBeLessThan(64)
    expect(out[9]).toBeGreaterThan(192)
  })
})

describe('cropRgb', () => {
  it('按坐标裁出正确区域', () => {
    const src = solid(4, 4, [0, 0, 0])
    // 右下角刷成白色
    for (let y = 2; y < 4; y++) {
      for (let x = 2; x < 4; x++) {
        const i = (y * 4 + x) * 3
        src[i] = 255
        src[i + 1] = 255
        src[i + 2] = 255
      }
    }
    const out = cropRgb(src, 4, 4, 2, 2, 4, 4)
    expect(out.length).toBe(2 * 2 * 3)
    expect(out[0]).toBe(255)
  })

  it('越界坐标被 clamp 到边缘，不越界读取', () => {
    const src = solid(2, 2, [5, 5, 5])
    const out = cropRgb(src, 2, 2, -3, -3, 5, 5)
    expect(out.length).toBe(8 * 8 * 3)
    expect(out[0]).toBe(5)
  })

  it('零面积裁切仍返回 1 像素，避免调用方拿到空 buffer', () => {
    const out = cropRgb(solid(2, 2, [1, 2, 3]), 2, 2, 1, 1, 1, 1)
    expect(out.length).toBe(3)
  })
})

describe('dbPostProcess', () => {
  it('识别单个区域并做 unclip 外扩', () => {
    const W = 10
    const H = 10
    const prob = blankProb(W, H)
    paint(prob, W, 3, 3, 6, 6, 0.9)
    const boxes = dbPostProcess(prob, W, H)
    expect(boxes.length).toBe(1)
    expect(boxes[0].score).toBeCloseTo(0.9, 5)
    // unclip：dist = 16*1.6/(2*8) = 1.6 → 3-1.6≈1, 6+1.6≈8
    expect(boxes[0].x0).toBe(1)
    expect(boxes[0].y0).toBe(1)
    expect(boxes[0].x1).toBe(8)
    expect(boxes[0].y1).toBe(8)
  })

  it('两个不相连区域产出两个框', () => {
    const W = 20
    const H = 10
    const prob = blankProb(W, H)
    paint(prob, W, 1, 2, 5, 7, 0.9)
    paint(prob, W, 12, 2, 17, 7, 0.9)
    expect(dbPostProcess(prob, W, H).length).toBe(2)
  })

  it('小于 minSize 的噪点被丢弃', () => {
    const W = 10
    const H = 10
    const prob = blankProb(W, H)
    paint(prob, W, 4, 4, 5, 5, 0.9) // 2x2 < 默认 minSize 4
    expect(dbPostProcess(prob, W, H)).toEqual([])
  })

  it('置信度不足的区域被 boxThresh 丢弃', () => {
    const W = 10
    const H = 10
    const prob = blankProb(W, H)
    paint(prob, W, 2, 2, 7, 7, 0.5) // 0.5 < 默认 0.6
    expect(dbPostProcess(prob, W, H)).toEqual([])
  })

  it('满图区域外扩后仍被 clamp 在图内', () => {
    const W = 8
    const H = 8
    const prob = blankProb(W, H)
    paint(prob, W, 0, 0, 7, 7, 0.99)
    const [box] = dbPostProcess(prob, W, H)
    expect(box.x0).toBe(0)
    expect(box.y0).toBe(0)
    expect(box.x1).toBe(W - 1)
    expect(box.y1).toBe(H - 1)
  })

  it('空概率图返回空数组', () => {
    expect(dbPostProcess(blankProb(16, 16), 16, 16)).toEqual([])
  })
})

describe('ctcDecode', () => {
  const chars = ['a', 'b', 'c'] // 类：0=blank, 1=a, 2=b, 3=c, 4=space

  const frameMax = (C: number, idx: number, p: number): number[] => {
    const f = new Array(C).fill(0.01)
    f[idx] = p
    return f
  }

  it('相邻重复帧只取一次，blank 被跳过', () => {
    const rows = [
      frameMax(5, 1, 0.9), // a
      frameMax(5, 1, 0.8), // a（重复）
      frameMax(5, 0, 0.95), // blank
      frameMax(5, 2, 0.7) // b
    ]
    const pred = new Float32Array(rows.flat())
    const r = ctcDecode(pred, rows.length, 5, chars)
    expect(r.text).toBe('ab')
    // 只有被选中的帧计入分数：(0.9 + 0.7) / 2
    expect(r.score).toBeCloseTo(0.8, 5)
  })

  it('blank 分隔后的相同字符可以重复出现', () => {
    const rows = [frameMax(5, 1, 0.9), frameMax(5, 0, 0.9), frameMax(5, 1, 0.9)]
    const r = ctcDecode(new Float32Array(rows.flat()), rows.length, 5, chars)
    expect(r.text).toBe('aa')
  })

  it('最大类号解码为空格', () => {
    const rows = [frameMax(5, 4, 0.9)]
    const r = ctcDecode(new Float32Array(rows.flat()), rows.length, 5, chars)
    expect(r.text).toBe(' ')
  })

  it('全 blank 返回空文本且分数为 0，不产生 NaN', () => {
    const rows = [frameMax(5, 0, 0.9), frameMax(5, 0, 0.9)]
    const r = ctcDecode(new Float32Array(rows.flat()), rows.length, 5, chars)
    expect(r.text).toBe('')
    expect(r.score).toBe(0)
  })
})

describe('computeSegments', () => {
  it('宽度未超限时单段覆盖整行', () => {
    expect(computeSegments(100, 48, 48, 320)).toEqual([{ sx: 0, ex: 100 }])
  })

  it('长行按 maxWidth 切成多段且相邻段有重叠', () => {
    const segs = computeSegments(2240, 40, 48, 320)
    expect(segs.length).toBe(9)
    // 首段从 0 开始，末段到行尾
    expect(segs[0].sx).toBe(0)
    expect(segs[segs.length - 1].ex).toBe(2240)
    // 段间存在重叠，否则接缝会切在字中间
    for (let i = 1; i < segs.length; i++) {
      expect(segs[i].sx).toBeLessThan(segs[i - 1].ex)
    }
  })

  it('需求宽度恰好等于 maxWidth 时不切段', () => {
    // wantW = 48 * w / h = 320 → w=640, h=96
    expect(computeSegments(640, 96, 48, 320).length).toBe(1)
  })

  it('零或负尺寸返回空数组', () => {
    expect(computeSegments(0, 40, 48, 320)).toEqual([])
    expect(computeSegments(100, 0, 48, 320)).toEqual([])
    expect(computeSegments(-5, 40, 48, 320)).toEqual([])
  })
})

describe('dedupeJoin', () => {
  it('重叠前缀被去掉', () => {
    expect(dedupeJoin('abcd', 'cdex')).toBe('ex')
  })

  it('无重叠时原样追加', () => {
    expect(dedupeJoin('abcd', 'xyz')).toBe('xyz')
  })

  it('maxOverlap 是搜索上界：超过上界的重叠不被识别', () => {
    // 完全重叠 4 字：上界 4 时整段去掉，上界 2 时找不到 ≥2 的公共尾部 → 原样追加
    expect(dedupeJoin('abcd', 'abcd', 4)).toBe('')
    expect(dedupeJoin('abcd', 'abcd', 2)).toBe('abcd')
  })

  it('单字符重叠仍会被去掉（接缝重复字的常态，不是 bug）', () => {
    expect(dedupeJoin('abcd', 'dx', 1)).toBe('x')
    expect(dedupeJoin('abcd', 'dx', 4)).toBe('x')
  })

  it('空累积串直接返回追加内容', () => {
    expect(dedupeJoin('', 'abc')).toBe('abc')
  })

  it('完全相同视为整段重叠', () => {
    expect(dedupeJoin('合同', '合同')).toBe('')
  })
})

describe('filterNoiseLines', () => {
  const line = (text: string, score: number): { text: string; score: number } => ({ text, score })

  it('默认丢掉「低分 + 短」的界面碎片', () => {
    // 实测值：手机截图里的「小」「它」「21」
    const { kept, dropped } = filterNoiseLines([line('小', 0.102), line('它', 0.297), line('21', 0.323)])
    expect(kept).toHaveLength(0)
    expect(dropped.map(l => l.text)).toEqual(['小', '它', '21'])
  })

  it('短但高分的真内容不误杀（阴性 / 70.0）', () => {
    const { kept, dropped } = filterNoiseLines([line('阴性', 0.97), line('70.0', 0.998)])
    expect(dropped).toHaveLength(0)
    expect(kept.map(l => l.text)).toEqual(['阴性', '70.0'])
  })

  it('长但低分不误杀：拍照件正文整体分数会左移', () => {
    const { kept, dropped } = filterNoiseLines([line('参考值:5--349pg/mL', 0.62)])
    expect(dropped).toHaveLength(0)
    expect(kept).toHaveLength(1)
  })

  it('分数恰好等于阈值时保留（严格小于才丢）', () => {
    const { kept, dropped } = filterNoiseLines([line('X', 0.9)])
    expect(dropped).toHaveLength(0)
    expect(kept).toHaveLength(1)
  })

  it('长度按去空白后计算：一个字符 + 低分 → 丢', () => {
    const { dropped } = filterNoiseLines([line(' 它 ', 0.2)])
    expect(dropped.map(l => l.text)).toEqual([' 它 '])
  })

  it('长度边界：2 字丢、3 字留（同为低分）', () => {
    // 实测里 X=0.922、<返回=0.896 都高于长度/分数门槛，会被保留
    const { kept, dropped } = filterNoiseLines([line('返回', 0.2), line('<返回', 0.2)])
    expect(dropped.map(l => l.text)).toEqual(['返回'])
    expect(kept.map(l => l.text)).toEqual(['<返回'])
  })

  it('可调阈值：放宽分数会多丢，放宽长度会多丢', () => {
    expect(filterNoiseLines([line('X', 0.922)], { scoreFloor: 0.95 }).dropped).toHaveLength(1)
    expect(filterNoiseLines([line('X', 0.922)], { scoreFloor: 0.9 }).dropped).toHaveLength(0)
    expect(filterNoiseLines([line('返回', 0.5)], { maxShortLen: 3 }).dropped).toHaveLength(1)
  })

  it('空输入返回两个空数组', () => {
    expect(filterNoiseLines([])).toEqual({ kept: [], dropped: [] })
  })

  it('保留原对象引用与顺序，不做拷贝（dropped 要能直接回溯来源）', () => {
    const body = line('合同编号', 0.5)
    const noise = line('小', 0.1)
    const { kept, dropped } = filterNoiseLines([body, noise])
    expect(kept[0]).toBe(body)
    expect(dropped[0]).toBe(noise)
  })
})
