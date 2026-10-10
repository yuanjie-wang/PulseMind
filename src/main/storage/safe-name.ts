import { isAbsolute, join, relative } from 'node:path'

/** join 后仍落在 baseDir 之内才返回路径，否则 null（full_20261011 M9-P0-1）。
 *  `join` 不做任何越界检查——`join(DIR, '..')` 就是 DIR 的父目录、
 *  `join(DIR, '')` 就是 DIR 本身——所以任何「按外部传入的名字拼路径后
 *  rm/unlink/writeFile」的入口都必须先过这里。拒绝空串（指向 baseDir
 *  自己）、NUL 与一切逃出 baseDir 的拼写；`skill-store` 的类内同型守卫
 *  （resolveSkillDir）与 `knowledge-store` 的先校验再删是这一纪律的既有
 *  范式，此处只是把它提炼为共享函数。 */
export function safeChildPath(baseDir: string, name: string): string | null {
  if (!name || name.includes('\0')) return null
  const p = join(baseDir, name)
  const rel = relative(baseDir, p)
  return !rel || rel.startsWith('..') || isAbsolute(rel) ? null : p
}
