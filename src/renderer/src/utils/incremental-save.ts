/**
 * Planning for incremental conversation persistence.
 *
 * `planIncrementalSave` is the LEGACY ID-only planner, retained because its
 * tests and callers pin the `hasNew`/tail-resave semantics; the desktop hook
 * now plans by CONTENT through `ConversationSaveQueue` below.
 *
 * The queue's model:
 * - Every save captures a deep snapshot at dispatch and fingerprints each
 *   message by ID + full JSON signature, so a same-ID in-place edit (a late
 *   tool_result, an exitCode landing after the fact) is dirty like a new
 *   message — no tail heuristic, no `hasNew` gate, works for any index.
 * - A save acknowledges ONLY the bytes it wrote: on success the captured
 *   baseline is stored, never a later live array. Changes that arrived while
 *   the write was in flight stay dirty and drain from FRESH live data on the
 *   next loop pass.
 * - Writes serialize through one lane per conversation; a full request while
 *   dirty content is queued is discharged by the drain as soon as every dirty
 *   message is covered. `saveSync` bumps an epoch so queued async work and
 *   stale acks cannot outlive a beforeunload sendSync (the main-side IPC
 *   handlers for both channels are synchronous SQLite transactions, so the
 *   sync write issued after a dispatched invoke is the final write).
 */
export const INCREMENTAL_TAIL_RESAVE = 8

export type IncrementalSavePlan =
  | { mode: 'append'; fromIdx: number; hasNew: boolean }
  | { mode: 'full' }

export function planIncrementalSave(
  msgs: ReadonlyArray<{ id: string }>,
  savedIds: ReadonlySet<string> | undefined,
  tailResave: number = INCREMENTAL_TAIL_RESAVE,
): IncrementalSavePlan {
  if (!savedIds) return { mode: 'append', fromIdx: 0, hasNew: true }
  if (msgs.length < savedIds.size) return { mode: 'full' }

  let firstNewIdx = -1
  for (let i = 0; i < msgs.length; i++) {
    if (!savedIds.has(msgs[i].id)) { firstNewIdx = i; break }
  }
  const fromIdx = firstNewIdx === -1
    ? Math.max(0, msgs.length - tailResave)
    : Math.max(0, firstNewIdx - tailResave)
  return { mode: 'append', fromIdx, hasNew: firstNewIdx !== -1 }
}

export interface PersistableSnapshot {
  messages: Array<{ id: string }>
  historySummary?: string
  historySummaryFrontier?: string
}

export type ContentSavePlan =
  | { mode: 'none' }
  | { mode: 'full' }
  | { mode: 'append'; indices: number[] }

type Baseline = { signatures: Map<string, string>; summary: string }

function fingerprint(snapshot: PersistableSnapshot): Baseline {
  return {
    signatures: new Map(snapshot.messages.map(m => [m.id, JSON.stringify(m)])),
    summary: JSON.stringify([snapshot.historySummary, snapshot.historySummaryFrontier]),
  }
}

function contentPlan(current: Baseline, saved?: Baseline): ContentSavePlan {
  // Removed/replaced IDs require the full path, even when length is unchanged.
  if (saved && ([...saved.signatures.keys()].some(id => !current.signatures.has(id)) ||
      saved.summary !== current.summary)) return { mode: 'full' }
  const indices: number[] = []
  let i = 0
  for (const [id, signature] of current.signatures) {
    if (saved?.signatures.get(id) !== signature) indices.push(i)
    i++
  }
  return indices.length ? { mode: 'append', indices } : { mode: 'none' }
}

/** Content acknowledgements and a single write lane per conversation.
 *
 * Capture at dispatch, not when queued; clone the payload before awaiting IPC.
 * An acknowledgement describes ONLY those captured bytes, never a live array.
 * After a successful write, recheck live data: late results (even in an inactive
 * conversation) remain dirty and drain without needing another React render.
 * Failures keep the baseline unchanged and release the lane for the next retry.
 */
export class ConversationSaveQueue<S extends PersistableSnapshot> {
  private baselines = new Map<string, Baseline>()
  private lanes = new Map<string, Promise<void>>()
  private epochs = new Map<string, number>()

  seed(id: string, snapshot: S): void {
    this.baselines.set(id, fingerprint(snapshot))
  }

  private capture(snapshot: S): { snapshot: S; baseline: Baseline } {
    const copy = JSON.parse(JSON.stringify(snapshot)) as S
    return { snapshot: copy, baseline: fingerprint(copy) }
  }

  save(
    id: string,
    read: () => S | undefined,
    write: (snapshot: S, plan: Exclude<ContentSavePlan, { mode: 'none' }>) => Promise<void>,
    full = false,
  ): Promise<void> {
    const epoch = this.epochs.get(id) ?? 0
    const run = async () => {
      let forceFull = full
      while ((this.epochs.get(id) ?? 0) === epoch) {
        const live = read()
        if (!live) return
        const { snapshot, baseline } = this.capture(live)
        const plan = contentPlan(baseline, this.baselines.get(id))
        if (plan.mode === 'none') return
        const operation = forceFull ? { mode: 'full' as const } : plan
        forceFull = false
        await write(snapshot, operation)
        if ((this.epochs.get(id) ?? 0) !== epoch) return
        this.baselines.set(id, baseline)
      }
    }
    const previous = this.lanes.get(id)
    // Start the first IPC synchronously. A beforeunload sendSync must be issued
    // AFTER already-dispatched writes, never before an old queued snapshot.
    const pending = previous ? previous.catch(() => {}).then(run) : run()
    this.lanes.set(id, pending)
    const cleanup = () => { if (this.lanes.get(id) === pending) this.lanes.delete(id) }
    void pending.then(cleanup, cleanup)
    return pending
  }

  /** The IPC main handlers are synchronous SQLite transactions. sendSync issued
   * after an async invoke is the final write on that sender's channel. Cancel
   * queued work and invalidate old acks so their promise completions cannot
   * replace this newer baseline or send a stale retry after the sync flush. */
  saveSync(id: string, snapshot: S, write: (snapshot: S) => void): void {
    this.epochs.set(id, (this.epochs.get(id) ?? 0) + 1)
    const captured = this.capture(snapshot)
    // A live value may have reverted to the baseline while a DIFFERENT value
    // is in flight. It still needs the final sync write to supersede that IPC.
    if (!this.lanes.has(id) && contentPlan(captured.baseline, this.baselines.get(id)).mode === 'none') return
    write(captured.snapshot)
    this.baselines.set(id, captured.baseline)
  }

  /** Cancel queued work before deletion. Await the already-dispatched write
   * before deleting its DB row so a late save cannot resurrect it. */
  async forget(id: string): Promise<void> {
    this.epochs.set(id, (this.epochs.get(id) ?? 0) + 1)
    await this.lanes.get(id)?.catch(() => {})
    this.baselines.delete(id)
  }
}

/** Deletion-side lifecycle: sever every future write to a conversation's row,
 * then delete the row. The order IS the contract — `forget` plus the engine
 * map, whose entries the 10s sweep and the beforeunload flush both iterate
 * (an entry left behind re-saves the deleted id on the next tick, and since
 * both write channels are UPSERTs the row comes back):
 *   1. dispose the cached engine and drop it from the map, so no sweep/flush
 *      tick can even read it again;
 *   2. bump the queue epoch and await the in-flight write (`forget`), so a
 *      save already dispatched lands BEFORE the delete, never after it;
 *   3. only then delete the DB row.
 * The caller removes the conversation from the visible list; after this
 * resolves no save path may target the id again (createNewConversation's
 * old-conversation flush filters the ids its cleanup just evicted). */
export async function teardownConversation<S extends PersistableSnapshot>(
  convId: string,
  engines: Map<string, { dispose(): void }>,
  queue: ConversationSaveQueue<S>,
  deleteRow: (id: string) => unknown,
): Promise<void> {
  engines.get(convId)?.dispose()
  engines.delete(convId)
  await queue.forget(convId)
  await deleteRow(convId)
}

// ── Sweep gate (review 2026-09-18 M2) ──
// The 10s crash-recovery sweep used to pay snapshotConversation's full
// assembly plus the queue's whole-session JSON clone for EVERY cached engine
// on EVERY tick, before the dirty check could answer 'none'. The engine
// replaces its messages array on every mutation (immutable updates are the
// mirror's identity contract), so an unchanged array reference plus an
// unchanged summary pair proves the deep plan could only return 'none'.

export interface SweepKey {
  array: unknown
  summary: unknown
  frontier: unknown
}

export function sweepKeyOf(engine: {
  messages: unknown
  getHistorySummary(): { text?: string; firstKeptId?: string } | null | undefined
}): SweepKey {
  const hs = engine.getHistorySummary()
  return { array: engine.messages, summary: hs?.text ?? null, frontier: hs?.firstKeptId ?? null }
}

export function sweepKeysMatch(prev: SweepKey | undefined, key: SweepKey): boolean {
  return prev !== undefined &&
    prev.array === key.array &&
    prev.summary === key.summary &&
    prev.frontier === key.frontier
}
