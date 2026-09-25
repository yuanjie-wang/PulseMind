// ── Realpath resolution for the path jail (review 2026-09-25 P1) ──
// The jail decides with the REAL location of a path, not its spelling: a
// target that does not exist yet used to skip symlink resolution entirely
// (realpath throws ENOENT → "lexical check stands"), so a write through a
// symlinked PARENT directory escaped the workspace while looking legal.
// `resolveRealTarget` anchors on the nearest existing ancestor instead —
// parent links are resolved by realpath of that ancestor — and fails CLOSED
// when the path exists but cannot be resolved (dangling symlink), because a
// write would then follow the link to wherever it points.
//
// Async for the guard (services), sync twin for tool-runtime's dispatch path.
// The tail probe uses the sync lstat on purpose: it stats one freshly walked
// prefix chain per guard call, and one shared loop beats an async twin for a
// handful of stats on a path that is about to be written anyway.

import { lstatSync, realpathSync, type Stats } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

export type RealTargetResult =
  /** Fully trustworthy real path; a trailing segment may not exist yet. */
  | { status: 'resolved'; path: string }
  /** Exists but cannot be resolved (dangling/loop symlink) — deny the op. */
  | { status: 'unresolvable' }

/** ENOENT/ENOTDIR below the anchor mean "not created yet" — the lexical tail
 *  stands. Anything else (EACCES…) cannot be vouched for → unresolvable. */
function isMissingCode(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

/** null = ENOENT/ENOTDIR (caller reads the gap as "not created yet"); any
 *  other error throws and the caller turns it into a deny. */
function lstatOrNull(p: string): Stats | null {
  try {
    return lstatSync(p)
  } catch (err) {
    if (isMissingCode(err)) return null
    throw err
  }
}

/** The tail below `base` may itself contain a symlink (created between the
 *  ancestor probe and now, or simply below a higher anchor): if such a link
 *  cannot be resolved the full realpath would have failed — a write would
 *  follow it out of the judged location, so fail closed. */
function checkTail(base: string, tail: string[]): RealTargetResult {
  let prefix = base
  for (const part of tail) {
    prefix = join(prefix, part)
    let st: Stats | null
    try {
      st = lstatOrNull(prefix)
    } catch {
      return { status: 'unresolvable' } // exists but unreadable — cannot vouch
    }
    if (!st) break // nothing below exists yet — lexical tail stands
    if (st.isSymbolicLink()) return { status: 'unresolvable' }
  }
  return { status: 'resolved', path: tail.length ? join(base, ...tail) : base }
}

export async function resolveRealTarget(target: string): Promise<RealTargetResult> {
  try {
    return { status: 'resolved', path: await realpath(target) }
  } catch {
    // Missing (or unreadable — checkTail decides for the tail below the
    // anchor): walk up to the nearest ancestor realpath can resolve.
  }
  const tail: string[] = []
  let cur = target
  for (;;) {
    const parent = dirname(cur)
    if (parent === cur) return { status: 'unresolvable' } // walked to root, nothing anchors
    tail.unshift(basename(cur))
    cur = parent
    try {
      return checkTail(await realpath(cur), tail)
    } catch {
      continue // ancestor missing/unreadable — keep walking
    }
  }
}

// ── sync twin (tool-runtime dispatches inside a synchronous call chain) ──

export function resolveRealTargetSync(target: string): RealTargetResult {
  try {
    return { status: 'resolved', path: realpathSync(target) }
  } catch {
    const tail: string[] = []
    let cur = target
    for (;;) {
      const parent = dirname(cur)
      if (parent === cur) return { status: 'unresolvable' }
      tail.unshift(basename(cur))
      cur = parent
      try {
        return checkTail(realpathSync(cur), tail)
      } catch {
        continue
      }
    }
  }
}
