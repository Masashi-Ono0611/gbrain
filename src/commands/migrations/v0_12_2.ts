/**
 * v0.12.2 migration orchestrator — JSONB double-encode repair.
 *
 * v0.12.0-and-earlier wrote JSONB columns via the buggy
 * `JSON.stringify(value)`-then-cast-to-jsonb interpolation pattern, which
 * postgres.js v3 stringified again on the wire. Result: every
 * `frontmatter->>'key'` query returned NULL on Postgres-backed brains and
 * GIN indexes on JSONB columns were inert. PGLite was unaffected (its
 * driver path uses parameterized binding, never interpolation).
 *
 * v0.12.2 fixes the writes (sql.json) AND repairs existing rows in place.
 * This is the migration. It's idempotent (only touches `jsonb_typeof = 'string'`
 * rows) and safe to re-run. PGLite engines no-op cleanly.
 *
 * Phases (all idempotent):
 *   A. Schema   — gbrain init --migrate-only (no schema changes in v0.12.2
 *                 but we still apply for consistency with v0.12.0).
 *   B. Repair   — gbrain repair-jsonb (the actual JSONB fix).
 *   C. Verify   — gbrain repair-jsonb --dry-run --json; assert 0 remaining.
 *   D. Record   — append completed.jsonl.
 */

import type { Migration, OrchestratorOpts, OrchestratorResult, OrchestratorPhaseResult } from './types.ts';
import { repairJsonb, type RepairOpts, type RepairResult } from '../repair-jsonb.ts';
import * as db from '../../core/db.ts';
// Bug 3 — ledger writes moved to the runner (apply-migrations.ts).

// ── Phase A — Schema ────────────────────────────────────────

async function phaseASchema(opts: OrchestratorOpts): Promise<OrchestratorPhaseResult> {
  if (opts.dryRun) return { name: 'schema', status: 'skipped', detail: 'dry-run' };
  try {
    // Propagate global progress flags so the child shows the same mode the
    // parent orchestrator is running in.
    const { runMigrateOnlyCore } = await import('./in-process.ts');
    await runMigrateOnlyCore();
    return { name: 'schema', status: 'complete' };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { name: 'schema', status: 'failed', detail: msg };
  }
}

// ── Phase B — JSONB repair ──────────────────────────────────

async function phaseBRepair(opts: OrchestratorOpts, repair: (opts: RepairOpts) => Promise<RepairResult> = repairJsonb, onConnectionCreated?: (ownsConnection: boolean) => void): Promise<OrchestratorPhaseResult> {
  if (opts.dryRun) return { name: 'jsonb_repair', status: 'skipped', detail: 'dry-run' };
  try {
    await repair({ dryRun: false, onConnectionCreated });
    return { name: 'jsonb_repair', status: 'complete' };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { name: 'jsonb_repair', status: 'failed', detail: msg };
  }
}

// ── Phase C — Verify ────────────────────────────────────────

async function phaseCVerify(opts: OrchestratorOpts, repair: (opts: RepairOpts) => Promise<RepairResult> = repairJsonb, onConnectionCreated?: (ownsConnection: boolean) => void): Promise<OrchestratorPhaseResult> {
  if (opts.dryRun) return { name: 'verify', status: 'skipped', detail: 'dry-run' };
  try {
    const result = await repair({ dryRun: true, onConnectionCreated });
    const remaining = result.total_repaired;
    if (remaining > 0) {
      return {
        name: 'verify',
        status: 'failed',
        detail: `${remaining} string-typed JSONB rows remain after repair`,
      };
    }
    return { name: 'verify', status: 'complete', detail: result.engine ? `engine=${result.engine}` : undefined };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { name: 'verify', status: 'failed', detail: msg };
  }
}

// ── Orchestrator ────────────────────────────────────────────

async function orchestrator(opts: OrchestratorOpts): Promise<OrchestratorResult> {
  console.log('');
  console.log('=== v0.12.2 — JSONB double-encode repair ===');
  if (opts.dryRun) console.log('  (dry-run; no side effects)');
  console.log('');

  const phases: OrchestratorPhaseResult[] = [];
  let ownsRepairConnection = false;
  const onConnectionCreated = (ownsConnection: boolean) => {
    ownsRepairConnection ||= ownsConnection;
  };

  try {
    const a = await phaseASchema(opts);
    phases.push(a);
    if (a.status === 'failed') return finalizeResult(phases, 'failed');

    const b = await phaseBRepair(opts, repairJsonb, onConnectionCreated);
    phases.push(b);
    if (b.status === 'failed') return finalizeResult(phases, 'failed');

    const c = await phaseCVerify(opts, repairJsonb, onConnectionCreated);
    phases.push(c);

    // a.status and b.status were narrowed to 'skipped' | 'complete' by early returns above.
    const overallStatus: 'complete' | 'partial' | 'failed' =
      c.status === 'failed' ? 'partial' : 'complete';

    return finalizeResult(phases, overallStatus);
  } finally {
    if (ownsRepairConnection) await db.disconnect();
  }
}

function finalizeResult(phases: OrchestratorPhaseResult[], status: 'complete' | 'partial' | 'failed'): OrchestratorResult {
  // Ledger write lives in the runner now (Bug 3).
  return {
    version: '0.12.2',
    status,
    phases,
  };
}

export const v0_12_2: Migration = {
  version: '0.12.2',
  featurePitch: {
    headline: 'Postgres frontmatter queries now work — JSONB double-encode bug fixed and existing rows auto-repaired',
    description:
      'gbrain v0.12.0-and-earlier silently stored JSONB columns as quoted string literals on ' +
      'Postgres/Supabase (PGLite was unaffected). Every `frontmatter->>\'key\'` returned NULL ' +
      'and GIN indexes were inert. v0.12.2 fixes the writes AND auto-repairs every existing ' +
      'string-typed row in pages.frontmatter, raw_data.data, ingest_log.pages_updated, ' +
      'files.metadata, and page_versions.frontmatter. The migration is idempotent. Pages ' +
      'truncated by the splitBody horizontal-rule bug can be recovered with `gbrain sync --full`.',
  },
  orchestrator,
};

/** Exported for unit tests. */
export const __testing = {
  phaseASchema,
  phaseBRepair,
  phaseCVerify,
};
