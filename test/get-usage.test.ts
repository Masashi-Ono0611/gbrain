/**
 * get_usage op — aggregation + coverage-contract tests (gbrain#3392).
 *
 * The contract under test is honesty, not just arithmetic:
 *  - complete_calculated_cost_usd is non-null ONLY when the window has no
 *    gaps (every attempt final, priced, none in flight or orphaned).
 *  - every gap class (usage_unknown / usage_partial / orphaned_attempt /
 *    in_flight / pricing_missing) flips coverage.status to 'partial' and is
 *    itemized in coverage.gaps.
 *  - unmetered spend paths from the provider-call registry are surfaced as
 *    out_of_scope — chat coverage never silently claims to be "all spend".
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { operationsByName, type OperationContext } from '../src/core/operations.ts';
import { buildRateSnapshot, computeCostUsd } from '../src/core/chat-usage.ts';
import { CANONICAL_PRICING } from '../src/core/model-pricing.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  await engine.executeRaw('DELETE FROM chat_usage_log');
});

function buildCtx(): OperationContext {
  return {
    engine,
    config: {} as any,
    logger: { info() {}, warn() {}, error() {}, debug() {} } as any,
    dryRun: false,
    remote: false,
    sourceId: 'default',
  } as OperationContext;
}

let seq = 0;

/** Insert a chat_usage_log row directly — this file tests aggregation, not the write path. */
async function insertRow(opts: {
  boundary?: string;
  phase?: string | null;
  jobId?: number | null;
  model?: string | null;
  requestStatus?: string;
  usageStatus?: string;
  cacheWriteTtl?: string | null;
  inTok?: number | null;
  outTok?: number | null;
  cacheRead?: number | null;
  cacheCreate?: number | null;
  costUsd?: number | null;
  startedAt?: Date;
  completedAt?: Date | null;
}): Promise<void> {
  // 1s in the past by default: the op's `until` defaults to its own `new
  // Date()` (exclusive), and bun can run insert→op within the same
  // millisecond — a row started exactly AT `until` would flake out of the
  // window (observed: intermittent last-row misses on the first runs).
  const startedAt = opts.startedAt ?? new Date(Date.now() - 1000);
  await engine.executeRaw(
    `INSERT INTO chat_usage_log (
       attempt_id, boundary, phase, job_id, model_raw, model,
       request_status, usage_status, cache_write_ttl,
       input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
       cost_usd, started_at, completed_at
     ) VALUES ($1,$2,$3,$4,$5,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
    [
      `t-${++seq}`,
      opts.boundary ?? 'gateway.chat',
      opts.phase ?? null,
      opts.jobId ?? null,
      opts.model ?? 'anthropic:claude-sonnet-5',
      opts.requestStatus ?? 'succeeded',
      opts.usageStatus ?? 'final',
      opts.cacheWriteTtl ?? '5m',
      opts.inTok ?? null,
      opts.outTok ?? null,
      opts.cacheRead ?? null,
      opts.cacheCreate ?? null,
      opts.costUsd ?? null,
      startedAt.toISOString(),
      (opts.completedAt === undefined ? new Date() : opts.completedAt)?.toISOString() ?? null,
    ],
  );
}

/** Priced final row helper — cost computed exactly like the recorder does. */
async function insertFinal(model: string, tok: { in: number; out: number; cr?: number; cc?: number }, extra: Parameters<typeof insertRow>[0] = {}): Promise<number> {
  const usage = {
    input_tokens: tok.in,
    output_tokens: tok.out,
    cache_read_tokens: tok.cr ?? 0,
    cache_creation_tokens: tok.cc ?? 0,
  };
  const cost = computeCostUsd(usage, buildRateSnapshot(model, (extra.cacheWriteTtl as any) ?? '5m'));
  await insertRow({
    ...extra,
    model,
    inTok: usage.input_tokens,
    outTok: usage.output_tokens,
    cacheRead: usage.cache_read_tokens,
    cacheCreate: usage.cache_creation_tokens,
    costUsd: cost,
  });
  return cost ?? 0;
}

async function runOp(params: Record<string, unknown> = {}): Promise<any> {
  return operationsByName.get_usage!.handler(buildCtx(), params);
}

describe('get_usage', () => {
  test('all-final priced window: complete, exact totals', async () => {
    const c1 = await insertFinal('anthropic:claude-sonnet-5', { in: 1_000_000, out: 500_000, cr: 200_000, cc: 100_000 });
    const c2 = await insertFinal('anthropic:claude-haiku-4-5', { in: 50_000, out: 10_000 });
    const res = await runOp();
    expect(res.coverage.status).toBe('complete');
    expect(res.coverage.gaps).toEqual([]);
    expect(res.known_cost_lower_bound_usd).toBeCloseTo(c1 + c2, 10);
    expect(res.complete_calculated_cost_usd).toBeCloseTo(c1 + c2, 10);
    expect(res.totals.final_calls).toBe(2);
    expect(res.totals.input_tokens).toBe(1_050_000);
    expect(res.by_model.length).toBe(2);
    const sonnet = res.by_model.find((m: any) => m.model === 'anthropic:claude-sonnet-5');
    expect(sonnet.known_cost_lower_bound_usd).toBeCloseTo(c1, 10);
  });

  test('cache TTL matters: a 1h-TTL row costs more than the same 5m row', async () => {
    const c5m = await insertFinal('anthropic:claude-sonnet-5', { in: 0, out: 0, cc: 1_000_000 }, { cacheWriteTtl: '5m' });
    await engine.executeRaw('DELETE FROM chat_usage_log');
    const c1h = await insertFinal('anthropic:claude-sonnet-5', { in: 0, out: 0, cc: 1_000_000 }, { cacheWriteTtl: '1h' });
    const base = CANONICAL_PRICING['anthropic:claude-sonnet-5']!;
    expect(c5m).toBeCloseTo(base.input * 1.25, 10);
    expect(c1h).toBeCloseTo(base.input * 2.0, 10);
  });

  test('unknown-usage row: partial, complete cost null, lower bound unaffected', async () => {
    const c1 = await insertFinal('anthropic:claude-sonnet-5', { in: 1000, out: 100 });
    await insertRow({ requestStatus: 'failed', usageStatus: 'unknown' });
    const res = await runOp();
    expect(res.coverage.status).toBe('partial');
    expect(res.complete_calculated_cost_usd).toBeNull();
    expect(res.known_cost_lower_bound_usd).toBeCloseTo(c1, 10);
    expect(res.coverage.gaps.map((g: any) => g.type)).toContain('usage_unknown');
  });

  test('partial-usage row: counted into lower bound AND flagged as a gap', async () => {
    const cost = computeCostUsd(
      { input_tokens: 500, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 },
      buildRateSnapshot('anthropic:claude-sonnet-5', '5m'),
    )!;
    await insertRow({ requestStatus: 'failed', usageStatus: 'partial', inTok: 500, outTok: 0, cacheRead: 0, cacheCreate: 0, costUsd: cost });
    const res = await runOp();
    expect(res.totals.partial_calls).toBe(1);
    expect(res.known_cost_lower_bound_usd).toBeCloseTo(cost, 10);
    expect(res.complete_calculated_cost_usd).toBeNull();
    expect(res.coverage.gaps.map((g: any) => g.type)).toContain('usage_partial');
  });

  test('unpriced final row: pricing_missing gap, excluded from cost sums, tokens still counted', async () => {
    await insertRow({ model: 'claude-cli:opus', usageStatus: 'final', inTok: 999, outTok: 1, cacheRead: 0, cacheCreate: 0, costUsd: null });
    const res = await runOp();
    expect(res.coverage.status).toBe('partial');
    expect(res.coverage.gaps.map((g: any) => g.type)).toContain('pricing_missing');
    expect(res.known_cost_lower_bound_usd).toBe(0);
    expect(res.totals.input_tokens).toBe(999);
  });

  test('orphaned vs in-flight started rows are distinguished by age, both are gaps', async () => {
    await insertRow({ requestStatus: 'started', usageStatus: 'pending', startedAt: new Date(Date.now() - 2 * 3600_000), completedAt: null });
    await insertRow({ requestStatus: 'started', usageStatus: 'pending', startedAt: new Date(Date.now() - 60_000), completedAt: null });
    const res = await runOp();
    const types = res.coverage.gaps.map((g: any) => g.type);
    expect(types).toContain('orphaned_attempt');
    expect(types).toContain('in_flight');
    expect(res.in_flight_calls).toBe(1);
    expect(res.complete_calculated_cost_usd).toBeNull();
  });

  test('by_phase: ambient phase, job-name fallback, boundary fallback', async () => {
    await insertFinal('anthropic:claude-sonnet-5', { in: 10, out: 10 }, { phase: 'think' });
    // Subagent row with a job: phase falls back to 'job:<name>'.
    const [job] = await engine.executeRaw<{ id: number }>(
      `INSERT INTO minion_jobs (name, queue, status, data) VALUES ('subagent', 'default', 'completed', '{}') RETURNING id`,
    );
    await insertFinal('anthropic:claude-sonnet-5', { in: 20, out: 20 }, { boundary: 'subagent.legacy_anthropic', jobId: Number(job.id) });
    // No phase, no job: falls back to the boundary label.
    await insertFinal('anthropic:claude-sonnet-5', { in: 30, out: 30 });
    const res = await runOp();
    const phases = Object.fromEntries(res.by_phase.map((p: any) => [p.phase, p.input_tokens]));
    expect(phases['think']).toBe(10);
    expect(phases['job:subagent']).toBe(20);
    expect(phases['gateway.chat']).toBe(30);
  });

  test('window bounds respected; validation errors on bad input', async () => {
    await insertFinal('anthropic:claude-sonnet-5', { in: 10, out: 10 }, { startedAt: new Date('2026-01-01T00:00:00Z') });
    const res = await runOp({ since: '2026-02-01T00:00:00Z' });
    expect(res.totals.final_calls).toBe(0);
    await expect(runOp({ since: 'not-a-date' })).rejects.toThrow(/invalid 'since'/);
    await expect(runOp({ since: '2026-03-01', until: '2026-02-01' })).rejects.toThrow(/is after/);
  });

  test('coverage always names its scope and the unmetered out-of-scope paths', async () => {
    const res = await runOp();
    expect(res.coverage.scope.operation).toBe('chat');
    expect(res.coverage.scope.boundaries).toEqual(['gateway.chat', 'subagent.legacy_anthropic']);
    expect(res.coverage.basis).toBe('published_rate_snapshot');
    const ops = res.coverage.out_of_scope.map((o: any) => o.operation);
    expect(ops).toContain('embedding');
    expect(ops).toContain('transcription');
    for (const o of res.coverage.out_of_scope) expect(o.reason).toBeTruthy();
  });
});
