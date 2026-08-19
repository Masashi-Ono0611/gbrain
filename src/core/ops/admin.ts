/**
 * Admin operation cluster — pure move from operations.ts (v0.46.x tranche 2).
 * Op consts stay module-private; `adminOperations` below lists them in
 * EXACTLY the order they appear in the canonical `operations` array in
 * ../operations.ts (run_doctor / get_versions / revert_version were defined
 * under the skill-catalog divider in the original file but have always
 * occupied the Admin slots of the array — the array order is the contract).
 * Never import from '../operations.ts' here (cycle).
 */

import type { Operation } from './contract.ts';
import { enforceClientSlugFence, sourceScopeOpts } from './context.ts';
import { stripTakesFence } from '../takes-fence.ts';
import { VERSION } from '../../version.ts';
import { chatUsageRecorderFailures } from '../chat-usage.ts';
import { unmeteredSpendPaths } from '../ai/provider-call-registry.ts';

// --- Admin ---

const get_stats: Operation = {
  name: 'get_stats',
  description: 'Brain statistics (page count, chunk count, etc.)',
  params: {},
  handler: async (ctx) => {
    return ctx.engine.getStats();
  },
  scope: 'admin',
  cliHints: { name: 'stats' },
};

const get_health: Operation = {
  name: 'get_health',
  description: 'Brain health dashboard (embed coverage, stale pages, orphans). Includes a `migrations {pending, partial, wedged, skipped_future}` block from the host migration ledger so remote agents can detect wedged/outstanding host migrations without shelling into the brain host.',
  params: {},
  handler: async (ctx) => {
    const health = await ctx.engine.getHealth();
    // TODOS:4063 — composed at the OP layer (not BrainEngine.getHealth):
    // the ledger is a filesystem JSONL, engine-agnostic; growing the engine
    // interface would force both engines to duplicate a file read.
    // Best-effort like the doctor's ledger read: a corrupt/unreadable ledger
    // degrades the field, never the health call.
    let migrations: unknown;
    try {
      const { migrationLedgerSummary } = await import('../migration-ledger.ts');
      const { VERSION } = await import('../../version.ts');
      migrations = migrationLedgerSummary(VERSION);
    } catch {
      migrations = { error: 'ledger_unreadable' };
    }
    return { ...health, migrations };
  },
  scope: 'admin',
  cliHints: { name: 'health' },
};

/**
 * Attempts still 'started' after this long are counted as orphaned (the
 * process died between opening the row and finalizing it). Chat calls carry
 * timeouts far shorter than this, so a healthy in-flight call can't be
 * misclassified; see chat-usage.ts for the lifecycle contract.
 */
const USAGE_ORPHAN_THRESHOLD_MS = 60 * 60_000;

const get_usage: Operation = {
  name: 'get_usage',
  description:
    'Chat LLM spend over a date range, from the provider-boundary lifecycle '
    + 'ledger (chat_usage_log). Reports token ground truth, a cost lower '
    + 'bound at published list rates, and an explicit coverage contract — '
    + 'costs are labeled estimates, not invoice reconciliation (gbrain#3392).',
  params: {
    since: { type: 'string', description: 'ISO 8601 start (inclusive). Defaults to 7 days ago.' },
    until: { type: 'string', description: 'ISO 8601 end (exclusive). Defaults to now.' },
  },
  handler: async (ctx, p) => {
    const now = new Date();
    const since = typeof p.since === 'string' && p.since
      ? new Date(p.since)
      : new Date(now.getTime() - 7 * 86_400_000);
    const until = typeof p.until === 'string' && p.until ? new Date(p.until) : now;
    if (Number.isNaN(since.getTime())) {
      throw new Error(`get_usage: invalid 'since' date: ${String(p.since)}`);
    }
    if (Number.isNaN(until.getTime())) {
      throw new Error(`get_usage: invalid 'until' date: ${String(p.until)}`);
    }
    if (since.getTime() > until.getTime()) {
      throw new Error(`get_usage: 'since' (${since.toISOString()}) is after 'until' (${until.toISOString()})`);
    }
    const orphanCutoff = new Date(now.getTime() - USAGE_ORPHAN_THRESHOLD_MS);

    // Observed rows (final = authoritative provider usage; partial = billed
    // lower bound recovered from an error). Grouped by model and by phase.
    const byModel = await ctx.engine.executeRaw<{
      model: string | null;
      usage_status: string;
      calls: string;
      input_tokens: string;
      output_tokens: string;
      cache_read_tokens: string;
      cache_creation_tokens: string;
      priced_cost_usd: string | null;
      unpriced_calls: string;
    }>(
      `SELECT
         model,
         usage_status,
         COUNT(*)::text AS calls,
         COALESCE(SUM(input_tokens), 0)::text AS input_tokens,
         COALESCE(SUM(output_tokens), 0)::text AS output_tokens,
         COALESCE(SUM(cache_read_tokens), 0)::text AS cache_read_tokens,
         COALESCE(SUM(cache_creation_tokens), 0)::text AS cache_creation_tokens,
         SUM(cost_usd)::text AS priced_cost_usd,
         COUNT(*) FILTER (WHERE cost_usd IS NULL)::text AS unpriced_calls
       FROM chat_usage_log
       WHERE started_at >= $1 AND started_at < $2
         AND usage_status IN ('final', 'partial')
       GROUP BY model, usage_status
       ORDER BY model NULLS LAST`,
      [since.toISOString(), until.toISOString()],
    );

    const byPhase = await ctx.engine.executeRaw<{
      phase: string;
      calls: string;
      input_tokens: string;
      output_tokens: string;
      cache_read_tokens: string;
      cache_creation_tokens: string;
      priced_cost_usd: string | null;
    }>(
      `SELECT
         COALESCE(cul.phase, 'job:' || mj.name, cul.boundary) AS phase,
         COUNT(*)::text AS calls,
         COALESCE(SUM(cul.input_tokens), 0)::text AS input_tokens,
         COALESCE(SUM(cul.output_tokens), 0)::text AS output_tokens,
         COALESCE(SUM(cul.cache_read_tokens), 0)::text AS cache_read_tokens,
         COALESCE(SUM(cul.cache_creation_tokens), 0)::text AS cache_creation_tokens,
         SUM(cul.cost_usd)::text AS priced_cost_usd
       FROM chat_usage_log cul
       LEFT JOIN minion_jobs mj ON cul.job_id = mj.id
       WHERE cul.started_at >= $1 AND cul.started_at < $2
         AND cul.usage_status IN ('final', 'partial')
       GROUP BY 1
       ORDER BY 1`,
      [since.toISOString(), until.toISOString()],
    );

    // Gap census over the same window — the rows that keep this report from
    // claiming completeness. Orphans: still 'started' past the threshold.
    const gapRows = await ctx.engine.executeRaw<{ kind: string; calls: string }>(
      `SELECT kind, COUNT(*)::text AS calls FROM (
         SELECT CASE
           WHEN usage_status = 'unknown' THEN 'usage_unknown'
           WHEN usage_status = 'partial' THEN 'usage_partial'
           WHEN request_status = 'started' AND started_at < $3 THEN 'orphaned_attempt'
           WHEN request_status = 'started' THEN 'in_flight'
           ELSE NULL
         END AS kind
         FROM chat_usage_log
         WHERE started_at >= $1 AND started_at < $2
       ) t WHERE kind IS NOT NULL
       GROUP BY kind`,
      [since.toISOString(), until.toISOString(), orphanCutoff.toISOString()],
    );

    const num = (v: string | null | undefined): number => {
      const n = parseFloat(String(v ?? '0'));
      return Number.isFinite(n) ? n : 0;
    };

    const gapCount = (kind: string): number =>
      num(gapRows.find(r => r.kind === kind)?.calls);

    const models = new Map<string, {
      model: string;
      final_calls: number;
      partial_calls: number;
      input_tokens: number;
      output_tokens: number;
      cache_read_tokens: number;
      cache_creation_tokens: number;
      known_cost_lower_bound_usd: number;
      unpriced_calls: number;
    }>();
    for (const r of byModel) {
      const key = r.model ?? '(unresolved)';
      const m = models.get(key) ?? {
        model: key,
        final_calls: 0,
        partial_calls: 0,
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
        known_cost_lower_bound_usd: 0,
        unpriced_calls: 0,
      };
      if (r.usage_status === 'final') m.final_calls += num(r.calls);
      else m.partial_calls += num(r.calls);
      m.input_tokens += num(r.input_tokens);
      m.output_tokens += num(r.output_tokens);
      m.cache_read_tokens += num(r.cache_read_tokens);
      m.cache_creation_tokens += num(r.cache_creation_tokens);
      m.known_cost_lower_bound_usd += num(r.priced_cost_usd);
      m.unpriced_calls += num(r.unpriced_calls);
      models.set(key, m);
    }

    const totals = {
      final_calls: 0, partial_calls: 0,
      input_tokens: 0, output_tokens: 0,
      cache_read_tokens: 0, cache_creation_tokens: 0,
      known_cost_lower_bound_usd: 0, unpriced_calls: 0,
    };
    for (const m of models.values()) {
      totals.final_calls += m.final_calls;
      totals.partial_calls += m.partial_calls;
      totals.input_tokens += m.input_tokens;
      totals.output_tokens += m.output_tokens;
      totals.cache_read_tokens += m.cache_read_tokens;
      totals.cache_creation_tokens += m.cache_creation_tokens;
      totals.known_cost_lower_bound_usd += m.known_cost_lower_bound_usd;
      totals.unpriced_calls += m.unpriced_calls;
    }

    const gaps: Array<{ type: string; calls?: number; count?: number; note?: string }> = [];
    const unknownCalls = gapCount('usage_unknown');
    const partialCalls = gapCount('usage_partial');
    const orphanedCalls = gapCount('orphaned_attempt');
    const recorderFailures = chatUsageRecorderFailures();
    if (unknownCalls > 0) gaps.push({ type: 'usage_unknown', calls: unknownCalls, note: 'terminated without provider-reported usage; may or may not have been billed' });
    if (partialCalls > 0) gaps.push({ type: 'usage_partial', calls: partialCalls, note: 'error carried usage; counted as a billed lower bound' });
    if (orphanedCalls > 0) gaps.push({ type: 'orphaned_attempt', calls: orphanedCalls, note: 'attempt opened but never finalized (process crash?)' });
    const inFlightCalls = gapCount('in_flight');
    if (inFlightCalls > 0) gaps.push({ type: 'in_flight', calls: inFlightCalls, note: 'attempt still running; its spend is not in the sums yet' });
    if (totals.unpriced_calls > 0) gaps.push({ type: 'pricing_missing', calls: totals.unpriced_calls, note: 'tokens recorded but no verified rate; excluded from cost sums' });
    if (recorderFailures > 0) gaps.push({ type: 'recorder_failures_this_process', count: recorderFailures, note: 'ledger writes that failed in THIS process; cross-process write failures are not observable' });

    // 'complete_observed', not 'complete': completeness is judged over the
    // rows this ledger observed. A process that failed BOTH ledger writes for
    // an attempt leaves nothing behind for any later reader to count — an
    // unobservable gap by construction, so the status name must not claim
    // more than the ledger can know.
    const complete = gaps.length === 0;
    const totalObserved = totals.final_calls + totals.partial_calls;

    return {
      window: { since: since.toISOString(), until: until.toISOString() },
      totals,
      by_model: [...models.values()],
      by_phase: byPhase.map(r => ({
        phase: r.phase,
        calls: num(r.calls),
        input_tokens: num(r.input_tokens),
        output_tokens: num(r.output_tokens),
        cache_read_tokens: num(r.cache_read_tokens),
        cache_creation_tokens: num(r.cache_creation_tokens),
        known_cost_lower_bound_usd: num(r.priced_cost_usd),
      })),
      known_cost_lower_bound_usd: totals.known_cost_lower_bound_usd,
      complete_calculated_cost_usd: complete ? totals.known_cost_lower_bound_usd : null,
      in_flight_calls: inFlightCalls,
      coverage: {
        status: complete ? 'complete_observed' : 'partial',
        scope: {
          operation: 'chat',
          boundaries: ['gateway.chat', 'subagent.legacy_anthropic'],
        },
        basis: 'published_rate_snapshot',
        gaps,
        out_of_scope: unmeteredSpendPaths(),
        notes: [
          'Costs use per-row rate snapshots taken at write time from '
          + 'model-pricing.ts published list rates. Promotional, negotiated '
          + 'and invoice-level pricing (credits, tax, tiers) are NOT modeled: '
          + 'token counts are the ground truth, costs are labeled estimates.',
          'complete_observed means gap-free over OBSERVED rows: an attempt '
          + 'whose ledger writes all failed in a crashed process leaves no '
          + 'row and cannot be counted by any reader.',
          'SDK-internal retries are not separately metered: the boundaries '
          + 'wrap the SDK call, so a transient failure that was billed and '
          + 'then retried appears as one attempt carrying only the final '
          + 'try\'s usage. Sums remain valid lower bounds.',
          ...(totalObserved === 0
            ? ['window contains no recorded attempts — an empty window is '
               + 'trivially gap-free, not evidence of zero spend outside the '
               + 'ledger\'s scope.']
            : []),
        ],
      },
    };
  },
  scope: 'admin',
  cliHints: { name: 'usage' },
};

/**
 * v0.31.1 (Issue #734): lightweight identity packet for the thin-client
 * banner. Read-scope so any authenticated client can surface "thin-client →
 * <host> · brain: 102k pages, 265k chunks · v0.31.1" without needing admin.
 *
 * Reuses engine.getStats() for counters (banner cache TTL bounds frequency
 * to ≤1/60s per CLI process; well below the Fly.io health-check cadence
 * that motivated the `getStats` cost warning in CLAUDE.md).
 *
 * No CLI surface (no cliHints) — this op exists only for thin-client banner
 * data. `last_sync_iso` deferred (no canonical source field today; would
 * need autopilot cycle to write a config key — TODO in v0.31.x).
 */
const get_brain_identity: Operation = {
  name: 'get_brain_identity',
  description: 'Brain identity + counters for thin-client banner. Returns version, engine kind, and page/chunk counts. Read-scope.',
  params: {},
  handler: async (ctx) => {
    const stats = await ctx.engine.getStats();
    // v0.42 self-upgrade: surface a pending update on the thin-client banner
    // (bonus channel; the CLI stderr marker + `gbrain self-upgrade` are the
    // load-bearing surface). Cache-read-only, no network, fail-open.
    let update_available = false;
    let latest_version: string | null = null;
    try {
      const su = await import('../self-upgrade.ts');
      // Shared stale/foreign-cache guard (pendingUpgradeVersion): only an
      // upgrade strictly newer than the RUNNING version counts.
      const latest = su.pendingUpgradeVersion(VERSION, Date.now());
      if (latest) {
        update_available = true;
        latest_version = latest;
      }
    } catch {
      /* never let the banner break the op */
    }
    return {
      version: VERSION,
      engine: ctx.engine.kind,
      page_count: stats.page_count,
      chunk_count: stats.chunk_count,
      last_sync_iso: null as string | null,
      update_available,
      latest_version,
    };
  },
  scope: 'read',
  // intentionally no cliHints — banner-only op
};

/**
 * Multi-topology v1 (Tier B): structured doctor report for remote callers.
 *
 * First read-only diagnostic op exposed over HTTP MCP. Wraps the focused
 * thin-client check set in `src/commands/doctor.ts:doctorReportRemote()` and
 * returns the structured `DoctorReport` JSON verbatim. The matching client-
 * side renderer lives in `src/commands/remote.ts` (used by `gbrain remote
 * doctor`). Local doctor is unchanged — operators on the host still get the
 * full check set.
 *
 * scope=admin because some checks expose system-state (queue depth, schema
 * version) that read-only consumers don't need. localOnly=false so HTTP
 * callers can invoke it. No mutation; safe to call repeatedly.
 *
 * Precedent: doctor only. Generalizing to lint/integrity/orphans is filed as
 * follow-up work pending demand.
 */
const run_doctor: Operation = {
  name: 'run_doctor',
  description: 'Run brain health checks and return a structured DoctorReport (thin-client doctor surface).',
  params: {},
  handler: async (ctx) => {
    const { doctorReportRemote } = await import('../../commands/doctor.ts');
    // Source isolation (cross-model P1): a source-bound caller's report must
    // not aggregate other sources' activity. Scope-aware checks (currently
    // volunteer_channels) filter on these ids; unscoped ctx = brain-wide.
    const scope = sourceScopeOpts(ctx);
    const sourceIds = scope.sourceIds ?? (scope.sourceId ? [scope.sourceId] : undefined);
    return doctorReportRemote(ctx.engine, { sourceIds });
  },
  scope: 'admin',
  localOnly: false,
};

const get_versions: Operation = {
  name: 'get_versions',
  description: 'Page version history',
  params: {
    slug: { type: 'string', required: true, description: 'Slug of the page whose version history to list.' },
  },
  handler: async (ctx, p) => {
    const versions = await ctx.engine.getVersions(p.slug as string, sourceScopeOpts(ctx));
    // Same takes-allow-list privacy boundary as get_page. Snapshots persist
    // historical compiled_truth verbatim, including the takes fence, so
    // a remote token bypassing get_page via /history would re-introduce
    // the same leak across every prior version.
    if (!ctx.takesHoldersAllowList) return versions;
    return versions.map(v => ({ ...v, compiled_truth: stripTakesFence(v.compiled_truth) }));
  },
  scope: 'read',
  cliHints: { name: 'history', positional: ['slug'] },
};

const revert_version: Operation = {
  name: 'revert_version',
  description: 'Revert page to a previous version',
  params: {
    slug: { type: 'string', required: true, description: 'Slug of the page to revert.' },
    version_id: { type: 'number', required: true, description: 'Numeric version id to revert to, as returned by get_versions. Not a version NUMBER offset — pass the id field.' },
  },
  mutating: true,
  scope: 'write',
  handler: async (ctx, p) => {
    enforceClientSlugFence(ctx, p.slug as string, 'revert_version');
    if (ctx.dryRun) return { dry_run: true, action: 'revert_version', slug: p.slug, version_id: p.version_id };
    // v0.31.8 (D7): thread ctx.sourceId so multi-source brains revert the
    // intended page row instead of whichever same-slug row Postgres returns
    // first.
    const sourceOpts = ctx.sourceId ? { sourceId: ctx.sourceId } : {};
    await ctx.engine.createVersion(p.slug as string, sourceOpts);
    await ctx.engine.revertToVersion(p.slug as string, p.version_id as number, sourceOpts);
    return { status: 'reverted' };
  },
  cliHints: { name: 'revert', positional: ['slug', 'version_id'] },
};


/**
 * CLI→MCP gap-closure wave — read-only view of the content-quality gate
 * (issue #1699). User story: an operator/agent reviewing what the gate hid or
 * flagged, remotely or via a thin-client CLI. Admin scope: enumerates
 * deliberately-hidden page slugs (the run_doctor posture). `quarantine scan`
 * (bulk re-import + re-embed) and `quarantine clear` (the trust decision —
 * same class as extraction_review) stay CLI-only.
 */
const quarantine_list: Operation = {
  name: 'quarantine_list',
  description:
    'List quarantined (hidden) and optionally content-flagged pages by scanning page ' +
    'frontmatter, newest-updated first. When truncated is true, count is a LOWER BOUND — ' +
    'raise max_scan/limit or run the quarantine list command on the brain host for the full ' +
    'set. Clearing a marker is a local-only trust decision (CLI).',
  params: {
    include_flagged: { type: 'boolean', required: false, description: 'Also list content_flag pages (searchable-but-warned). Default false.' },
    limit: { type: 'number', required: false, description: 'Max rows returned (default 200, cap 1000).' },
    max_scan: { type: 'number', required: false, description: 'Max pages scanned (default 20000, cap 100000).' },
  },
  scope: 'admin',
  area: 'admin',
  handler: async (ctx, p) => {
    const {
      collectQuarantineRows,
      QUARANTINE_LIST_DEFAULT_LIMIT, QUARANTINE_LIST_MAX_LIMIT,
      QUARANTINE_SCAN_DEFAULT, QUARANTINE_SCAN_MAX,
    } = await import('../../commands/quarantine.ts');
    const rawLimit = typeof p.limit === 'number' && Number.isFinite(p.limit) ? p.limit : QUARANTINE_LIST_DEFAULT_LIMIT;
    const rawScan = typeof p.max_scan === 'number' && Number.isFinite(p.max_scan) ? p.max_scan : QUARANTINE_SCAN_DEFAULT;
    const { rows, scanned, truncated } = await collectQuarantineRows(ctx.engine, {
      includeFlagged: p.include_flagged === true,
      limit: Math.max(1, Math.min(QUARANTINE_LIST_MAX_LIMIT, rawLimit)),
      maxScan: Math.max(1, Math.min(QUARANTINE_SCAN_MAX, rawScan)),
      ...sourceScopeOpts(ctx),
    });
    return { schema_version: 1, count: rows.length, truncated, scanned, rows };
  },
};

// Ops in EXACTLY the canonical `operations` array order.
export const adminOperations: Operation[] = [
  get_stats, get_health, get_usage, run_doctor, get_versions, revert_version,
  get_brain_identity, quarantine_list,
];
