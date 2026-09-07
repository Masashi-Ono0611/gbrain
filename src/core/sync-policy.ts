/**
 * The single predicate for `config.syncEnabled === false` (#4399).
 *
 * The flag means "excluded from AUTOMATIC/bulk sync": the `sync --all` fan-out
 * filter (sync.ts), autopilot's freshness dispatcher (autopilot.ts), the
 * full-cycle fan-out (autopilot-fanout.ts) and the `sync_enabled` column of
 * the sources status report (sync-status-report.ts, fed RAW `SELECT config`
 * rows) all read it here so they cannot drift apart.
 *
 * Local patch 117 additionally enforces this predicate at performSync(),
 * including explicit single-source sync and jobs queued before disabling a
 * source. The cost gate shares the predicate. Disabled jobs and cycle sync
 * phases report a deliberate skip; there is no bypass flag.
 */

import type { BrainEngine } from './engine.ts';
import { fetchSource, parseSourceConfig } from './sources-load.ts';

/**
 * True iff `config` explicitly sets `syncEnabled: false`. parseSourceConfig
 * unwraps PGLite's JSON-string scalar shape (same pattern as
 * sourceConfigHasRemoteUrl); absent/undefined is NOT disabled.
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
