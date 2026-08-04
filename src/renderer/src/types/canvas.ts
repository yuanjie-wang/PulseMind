export interface Point {
  x: number
  y: number
}

export interface BoundingBox {
  x: number
  y: number
  width: number
  height: number
}

export type AnnotationType = 'pen' | 'rect' | 'arrow' | 'text' | 'highlight' | 'rectangle' | 'ellipse'

export interface Annotation {
  id: string
  type: AnnotationType
  points: Point[]
  boundingBox?: BoundingBox
  color: string
  text?: string
  generatedCode?: string
  createdAt: number
  parentId?: string
  promptWidth?: string
  promptHeight?: string
}

export type ToolType = 'cursor' | 'pan' | 'rect' | 'arrow' | 'text' | 'highlight' | 'rectangle' | 'ellipse'

export interface SnapLine {
  orientation: 'v' | 'h'
  pos: number
}

export function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 9)
}
