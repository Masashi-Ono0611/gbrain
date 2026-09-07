/**
 * The single predicate for `config.syncEnabled === false` (#4399).
 *
 * The flag excludes a source from all syncs: the `sync --all` fan-out
 * filter (sync/run.ts), autopilot's freshness dispatcher (autopilot-dispatch.ts), the
 * full-cycle fan-out (autopilot-fanout.ts) and the `sync_enabled` column of
 * the sources status report (sync-status-report.ts, fed RAW `SELECT config`
 * rows) all read it here so they cannot drift apart. Local patch 117 also
 * enforces this at performSync(), including explicit single-source sync and
 * jobs queued before disabling a source. Disabled jobs and cycle sync phases
 * report a deliberate skip; there is no bypass flag.
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

/** Look up the source at the performSync choke point. Missing rows remain allowed;
 * genuine lookup failures propagate so a disabled source cannot slip through. */
export async function isSyncDisabledForSource(
  engine: BrainEngine,
  sourceId: string | undefined,
): Promise<boolean> {
  if (!sourceId) return false;
  const source = await fetchSource(engine, sourceId);
  return source ? isSyncDisabledConfig(source.config) : false;
}

/** Deliberate hard exclusion, classified as a skip by automatic callers. */
export class SyncDisabledError extends Error {
  readonly sourceId: string;
  constructor(sourceId: string) {
    super(`Sync is disabled for source "${sourceId}" (config.syncEnabled=false)`);
    this.name = 'SyncDisabledError';
    this.sourceId = sourceId;
  }
}

/**
 * #5198: source ids that are claimed (`sources writer claim`) while persistence
 * is not yet activated. performSync refuses these with
 * `writer_coordinator_required` until deliberate activation
 * (resolveSyncPersistenceMode in persistence/sync-authority.ts), so automatic
 * dispatchers skip their sync instead of queueing a job that fails the same
 * way on every tick. The refusal contract itself is unchanged: an explicit
 * `gbrain sync --source <id>` still reaches performSync and still refuses.
 *
 * Mirrors resolveSyncPersistenceMode: a missing persistence_brain row counts as
 * not activated. Fail-open: when the persistence tables are unreadable (older
 * schema, stub engine) nothing is skipped and dispatch behaves as before.
 */
export async function loadActivationPendingSourceIds(
  engine: Pick<BrainEngine, 'executeRaw'>,
): Promise<Set<string>> {
  try {
    const rows = await engine.executeRaw<{ source_id: string }>(
      `SELECT b.source_id FROM persistence_source_bindings b
        WHERE NOT COALESCE((SELECT enabled FROM persistence_brain WHERE singleton=1), false)`,
    );
    return new Set(rows.map((r) => r.source_id));
  } catch {
    return new Set();
  }
}

const reportedActivationPending = new Set<string>();

/**
 * True the first time a process skips sync for `sourceId` because of a pending
 * activation, so a long-running daemon states the reason once instead of on
 * every tick.
 */
export function firstActivationPendingSkip(sourceId: string): boolean {
  if (reportedActivationPending.has(sourceId)) return false;
  reportedActivationPending.add(sourceId);
  return true;
}

/**
 * Dispatcher guard: true when `sourceId` is awaiting activation, in which case
 * the caller skips its sync. Reports the reason once per process — an NDJSON
 * `event` line under --json, plain prose otherwise.
 */
export function skipActivationPendingSync(
  pending: ReadonlySet<string>,
  sourceId: string,
  event: string,
  jsonMode: boolean,
  write: (line: string) => void,
): boolean {
  if (!pending.has(sourceId)) return false;
  if (firstActivationPendingSkip(sourceId)) {
    write(jsonMode
      ? JSON.stringify({ event, source_id: sourceId, reason: 'activation_pending' })
      : activationPendingSkipMessage(sourceId));
  }
  return true;
}

export function activationPendingSkipMessage(sourceId: string): string {
  return `[sync] skipping automatic sync for source=${sourceId}: it is claimed but persistence is not activated, ` +
    'so sync refuses with writer_coordinator_required. Review `gbrain sources writer status`; ' +
    'automatic sync resumes after activation.';
}
