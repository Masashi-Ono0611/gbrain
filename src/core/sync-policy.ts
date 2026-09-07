/**
 * Sync policy: the single predicate for `config.syncEnabled === false`.
 *
 * #4399: `syncEnabled: false` was enforced in exactly two places
 * (sync-cost-gate.ts's inline cost estimate, and the `sync --all` fan-out
 * filter in sync.ts) but NOT inside `performSync()` — the one function
 * every sync execution path (CLI single-source `gbrain sync --source X`,
 * the minion `sync` job worker, autopilot's per-source freshness
 * dispatcher, cycle.ts's sync phase) funnels through. A source the user
 * explicitly disabled to protect it from a known duplicate-page bug got
 * auto-resynced by autopilot anyway, reproducing the bug it was disabled
 * to avoid — because autopilot's dispatch loop never checked the flag,
 * and neither did performSync.
 *
 * This module is the single source of truth for the boolean so every
 * enforcement point reads the same predicate instead of duplicating (and
 * risking drifting) the `syncEnabled === false` check inline.
 */
import type { BrainEngine } from './engine.ts';
import { fetchSource, parseSourceConfig } from './sources-load.ts';

/**
 * True iff `config` explicitly sets `syncEnabled: false`. Uses
 * `parseSourceConfig` so callers don't need to care whether the driver
 * handed back a parsed object (Postgres) or a JSON string (PGLite) —
 * see sources-load.ts's `SourceRow.config` doc comment.
 *
 * Absent/undefined `syncEnabled` (the common case — most sources never set
 * this key) is NOT disabled; only the literal `false` excludes.
 */
export function isSyncDisabledConfig(config: unknown): boolean {
  return parseSourceConfig(config).syncEnabled === false;
}

/**
 * DB-backed lookup for callers that only have a `sourceId`, not an
 * already-loaded source row (performSync's choke-point check).
 *
 * Returns false (not disabled) when `sourceId` is unset or no such source
 * row exists — an absent row carries no `syncEnabled: false`, so there is
 * nothing to exclude on, matching pre-existing behavior for callers that
 * never registered a `sources` row at all (the pre-v0.17 global-config
 * path). A genuine lookup FAILURE (thrown error) is deliberately NOT
 * swallowed here and propagates to the caller: this guards an
 * unconditional exclusion, not a best-effort estimate (contrast
 * sync-cost-gate.ts's staleChars, which fails open because it only feeds a
 * cost preview) — silently proceeding on a DB hiccup would let exactly the
 * disabled source it couldn't verify slip through.
 */
export async function isSyncDisabledForSource(
  engine: BrainEngine,
  sourceId: string | undefined,
): Promise<boolean> {
  if (!sourceId) return false;
  const source = await fetchSource(engine, sourceId);
  if (!source) return false;
  return isSyncDisabledConfig(source.config);
}

/**
 * Thrown by `performSync()` when the target source's `config.syncEnabled`
 * is `false`. Distinguishes a deliberate, hard exclusion from a real
 * failure — the `sync` job worker (src/commands/jobs.ts) catches this the
 * same way it already catches `SyncLockBusyError` and marks the job
 * skipped rather than failed. There is no bypass flag: `syncEnabled: false`
 * is an unconditional exclusion, including for an explicit CLI invocation
 * naming that source.
 */
export class SyncDisabledError extends Error {
  readonly sourceId: string;
  constructor(sourceId: string) {
    super(`Sync is disabled for source "${sourceId}" (config.syncEnabled=false)`);
    this.name = 'SyncDisabledError';
    this.sourceId = sourceId;
  }
}
