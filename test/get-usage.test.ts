/**
 * get_usage op — actual-spend report computed from `subagent_messages` token
 * counters against the canonical pricing table (`model-pricing.ts`).
 *
 * Addresses gbrain#3392: ModelPricing had no cache rates and there was no
 * actual-spend report, forcing downstream cost tooling to duplicate (and
 * drift from) the canonical table.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { operationsByName } from '../src/core/operations.ts';
import type { OperationContext } from '../src/core/operations.ts';

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
});

function buildCtx(): OperationContext {
  return {
    engine,
    config: {} as any,
    logger: { info() {}, warn() {}, error() {}, debug() {} } as any,
    dryRun: false,
    remote: false,
    sourceId: 'default',
  };
}

/** Insert a minimal minion_jobs row and return its id (FK target for subagent_messages). */
async function insertJob(): Promise<number> {
  const rows = await engine.executeRaw<{ id: number }>(
    `INSERT INTO minion_jobs (name, status, data, queue, priority, created_at)
     VALUES ('subagent', 'completed', '{}'::jsonb, 'default', 0, now())
     RETURNING id`,
  );
  return rows[0]!.id;
}

async function insertMessage(opts: {
  jobId: number;
  messageIdx: number;
  model: string | null;
  tokensIn?: number;
  tokensOut?: number;
  tokensCacheRead?: number;
  tokensCacheCreate?: number;
  endedAt: Date;
}): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO subagent_messages
       (job_id, message_idx, role, content_blocks, tokens_in, tokens_out,
        tokens_cache_read, tokens_cache_create, model, ended_at)
     VALUES ($1, $2, 'assistant', '[]'::jsonb, $3, $4, $5, $6, $7, $8)`,
    [
      opts.jobId,
      opts.messageIdx,
      opts.tokensIn ?? null,
      opts.tokensOut ?? null,
      opts.tokensCacheRead ?? null,
      opts.tokensCacheCreate ?? null,
      opts.model,
      opts.endedAt,
    ],
  );
}

const WINDOW_SINCE = new Date('2026-01-01T00:00:00.000Z');
const WINDOW_UNTIL = new Date('2026-01-02T00:00:00.000Z');
const IN_WINDOW = new Date('2026-01-01T12:00:00.000Z');
const BEFORE_WINDOW = new Date('2025-12-31T00:00:00.000Z');
const AFTER_WINDOW = new Date('2026-01-03T00:00:00.000Z');

describe('get_usage op', () => {
  test('is registered in operationsByName with admin scope + usage CLI name', () => {
    const op = operationsByName.get_usage;
    expect(op).toBeDefined();
    expect(op.scope).toBe('admin');
    expect(op.cliHints?.name).toBe('usage');
  });

  test('declares optional since/until string params', () => {
    const op = operationsByName.get_usage;
    expect(op.params.since.type).toBe('string');
    expect(op.params.since.required).toBeFalsy();
    expect(op.params.until.type).toBe('string');
    expect(op.params.until.required).toBeFalsy();
  });

  test('empty brain returns zeroed report for the requested window', async () => {
    const op = operationsByName.get_usage;
    const result = (await op.handler(buildCtx(), {
      since: WINDOW_SINCE.toISOString(),
      until: WINDOW_UNTIL.toISOString(),
    })) as {
      schema_version: number;
      since: string;
      until: string;
      by_model: unknown[];
      total_cost_usd: number;
      unpriced_models: string[];
    };

    expect(result.schema_version).toBe(1);
    expect(result.since).toBe(WINDOW_SINCE.toISOString());
    expect(result.until).toBe(WINDOW_UNTIL.toISOString());
    expect(result.by_model).toEqual([]);
    expect(result.total_cost_usd).toBe(0);
    expect(result.unpriced_models).toEqual([]);
  });

  test('sums tokens per priced model and computes cost against canonical pricing', async () => {
    const jobId = await insertJob();
    // Two messages for the same priced model — sums must combine across rows.
    await insertMessage({
      jobId, messageIdx: 0, model: 'anthropic:claude-sonnet-4-6', endedAt: IN_WINDOW,
      tokensIn: 500_000, tokensOut: 100_000, tokensCacheRead: 250_000, tokensCacheCreate: 50_000,
    });
    await insertMessage({
      jobId, messageIdx: 1, model: 'anthropic:claude-sonnet-4-6', endedAt: IN_WINDOW,
      tokensIn: 500_000, tokensOut: 100_000, tokensCacheRead: 250_000, tokensCacheCreate: 50_000,
    });

    const op = operationsByName.get_usage;
    const result = (await op.handler(buildCtx(), {
      since: WINDOW_SINCE.toISOString(),
      until: WINDOW_UNTIL.toISOString(),
    })) as {
      by_model: Array<{
        model: string;
        tokens_input: number;
        tokens_output: number;
        tokens_cache_read: number;
        tokens_cache_create: number;
        cost_usd: number;
      }>;
      total_cost_usd: number;
      unpriced_models: string[];
    };

    expect(result.by_model).toHaveLength(1);
    const row = result.by_model[0]!;
    expect(row.model).toBe('anthropic:claude-sonnet-4-6');
    expect(row.tokens_input).toBe(1_000_000);
    expect(row.tokens_output).toBe(200_000);
    expect(row.tokens_cache_read).toBe(500_000);
    expect(row.tokens_cache_create).toBe(100_000);
    // anthropic:claude-sonnet-4-6 = input $3.00, output $15.00, cacheRead $0.30, cacheWrite5m $3.75
    // (1.0 * 3.00) + (0.2 * 15.00) + (0.5 * 0.30) + (0.1 * 3.75) = 3.00 + 3.00 + 0.15 + 0.375 = 6.525
    expect(row.cost_usd).toBeCloseTo(6.525, 6);
    expect(result.total_cost_usd).toBeCloseTo(6.525, 6);
    expect(result.unpriced_models).toEqual([]);
  });

  test('unpriced models are reported separately and excluded from total_cost_usd', async () => {
    const jobId = await insertJob();
    await insertMessage({
      jobId, messageIdx: 0, model: 'anthropic:claude-sonnet-4-6', endedAt: IN_WINDOW,
      tokensIn: 1_000_000, tokensOut: 0, tokensCacheRead: 0, tokensCacheCreate: 0,
    });
    await insertMessage({
      jobId, messageIdx: 1, model: 'some-unreleased-model-not-in-canonical', endedAt: IN_WINDOW,
      tokensIn: 1_000, tokensOut: 500, tokensCacheRead: 0, tokensCacheCreate: 0,
    });

    const op = operationsByName.get_usage;
    const result = (await op.handler(buildCtx(), {
      since: WINDOW_SINCE.toISOString(),
      until: WINDOW_UNTIL.toISOString(),
    })) as {
      by_model: Array<{ model: string; cost_usd: number }>;
      total_cost_usd: number;
      unpriced_models: string[];
    };

    expect(result.unpriced_models).toEqual(['some-unreleased-model-not-in-canonical']);
    // Only the priced model shows up in by_model.
    expect(result.by_model.map(r => r.model)).toEqual(['anthropic:claude-sonnet-4-6']);
    // Priced model: 1.0 * 3.00 = 3.00. The unpriced model's tokens contribute nothing.
    expect(result.total_cost_usd).toBeCloseTo(3.0, 6);
  });

  test('excludes rows outside the [since, until) window', async () => {
    const jobId = await insertJob();
    await insertMessage({
      jobId, messageIdx: 0, model: 'anthropic:claude-sonnet-4-6', endedAt: BEFORE_WINDOW,
      tokensIn: 999_999, tokensOut: 0,
    });
    await insertMessage({
      jobId, messageIdx: 1, model: 'anthropic:claude-sonnet-4-6', endedAt: AFTER_WINDOW,
      tokensIn: 999_999, tokensOut: 0,
    });
    await insertMessage({
      jobId, messageIdx: 2, model: 'anthropic:claude-sonnet-4-6', endedAt: IN_WINDOW,
      tokensIn: 1_000_000, tokensOut: 0,
    });

    const op = operationsByName.get_usage;
    const result = (await op.handler(buildCtx(), {
      since: WINDOW_SINCE.toISOString(),
      until: WINDOW_UNTIL.toISOString(),
    })) as { by_model: Array<{ tokens_input: number }> };

    expect(result.by_model).toHaveLength(1);
    expect(result.by_model[0]!.tokens_input).toBe(1_000_000);
  });

  test('boundary: a row exactly at since is included, a row exactly at until is excluded', async () => {
    const jobId = await insertJob();
    await insertMessage({
      jobId, messageIdx: 0, model: 'anthropic:claude-sonnet-4-6', endedAt: WINDOW_SINCE,
      tokensIn: 1, tokensOut: 0,
    });
    await insertMessage({
      jobId, messageIdx: 1, model: 'anthropic:claude-sonnet-4-6', endedAt: WINDOW_UNTIL,
      tokensIn: 999_999, tokensOut: 0,
    });

    const op = operationsByName.get_usage;
    const result = (await op.handler(buildCtx(), {
      since: WINDOW_SINCE.toISOString(),
      until: WINDOW_UNTIL.toISOString(),
    })) as { by_model: Array<{ tokens_input: number }> };

    expect(result.by_model).toHaveLength(1);
    expect(result.by_model[0]!.tokens_input).toBe(1);
  });

  test('rejects since after until', async () => {
    const op = operationsByName.get_usage;
    await expect(op.handler(buildCtx(), {
      since: WINDOW_UNTIL.toISOString(),
      until: WINDOW_SINCE.toISOString(),
    })).rejects.toThrow(/since.*after.*until/i);
  });

  test('rows with model IS NULL are excluded', async () => {
    const jobId = await insertJob();
    await insertMessage({ jobId, messageIdx: 0, model: null, endedAt: IN_WINDOW, tokensIn: 1000 });
    await insertMessage({
      jobId, messageIdx: 1, model: 'anthropic:claude-sonnet-4-6', endedAt: IN_WINDOW, tokensIn: 500_000,
    });

    const op = operationsByName.get_usage;
    const result = (await op.handler(buildCtx(), {
      since: WINDOW_SINCE.toISOString(),
      until: WINDOW_UNTIL.toISOString(),
    })) as { by_model: Array<{ model: string }> };

    expect(result.by_model.map(r => r.model)).toEqual(['anthropic:claude-sonnet-4-6']);
  });

  test('by_model is sorted by cost_usd descending', async () => {
    const jobId = await insertJob();
    // anthropic:claude-haiku-4-5 ($1/$5) — cheap
    await insertMessage({
      jobId, messageIdx: 0, model: 'anthropic:claude-haiku-4-5', endedAt: IN_WINDOW,
      tokensIn: 1_000_000, tokensOut: 0,
    });
    // anthropic:claude-opus-4-8 ($5/$25) — expensive
    await insertMessage({
      jobId, messageIdx: 1, model: 'anthropic:claude-opus-4-8', endedAt: IN_WINDOW,
      tokensIn: 1_000_000, tokensOut: 0,
    });

    const op = operationsByName.get_usage;
    const result = (await op.handler(buildCtx(), {
      since: WINDOW_SINCE.toISOString(),
      until: WINDOW_UNTIL.toISOString(),
    })) as { by_model: Array<{ model: string; cost_usd: number }> };

    expect(result.by_model.map(r => r.model)).toEqual([
      'anthropic:claude-opus-4-8',
      'anthropic:claude-haiku-4-5',
    ]);
  });

  test('defaults since to 7 days ago and until to now when omitted', async () => {
    const jobId = await insertJob();
    await insertMessage({
      jobId, messageIdx: 0, model: 'anthropic:claude-sonnet-4-6', endedAt: new Date(),
      tokensIn: 1_000_000, tokensOut: 0,
    });

    const op = operationsByName.get_usage;
    const before = Date.now();
    const result = (await op.handler(buildCtx(), {})) as {
      since: string;
      until: string;
      by_model: Array<{ model: string }>;
    };
    const after = Date.now();

    const sinceMs = new Date(result.since).getTime();
    const untilMs = new Date(result.until).getTime();
    // until ~ now (handler-call window)
    expect(untilMs).toBeGreaterThanOrEqual(before);
    expect(untilMs).toBeLessThanOrEqual(after);
    // since ~ 7 days before until
    expect(untilMs - sinceMs).toBeCloseTo(7 * 86_400_000, -3);
    // The just-inserted message (ended_at = now) falls inside the default window.
    expect(result.by_model.map(r => r.model)).toEqual(['anthropic:claude-sonnet-4-6']);
  });
});
