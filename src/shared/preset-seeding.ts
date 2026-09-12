// ── Preset tool seeding plan (PLAN-0.4.0 M5R, B1) ──
// Pure decision logic for turning bundle-distributed preset tools into real
// per-user tools (~/.pulsemind/tools/preset_<id>/). No IO, so the vitest suite
// can cover it (same convention as shared/workspace-naming.ts).

/** Ids to seed this run: skip what already exists on disk, never resurrect
 *  what the user deliberately deleted (D-R2). */
export function planPresetSeeds(bundleIds: string[], existingIds: string[], deletedIds: string[]): string[] {
  const existing = new Set(existingIds)
  const deleted = new Set(deletedIds)
  return bundleIds.filter((id) => !existing.has(id) && !deleted.has(id))
}
