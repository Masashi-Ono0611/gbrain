/**
 * get_usage op — actual-spend report computed from `chat_usage_log` token
 * counters against the canonical pricing table (`model-pricing.ts`).
 *
 * Addresses gbrain#3392: ModelPricing had no cache rates and there was no
 * actual-spend report, forcing downstream cost tooling to duplicate (and
 * drift from) the canonical table. The report originally read
 * `subagent_messages`, written from exactly ONE call site in the codebase
 * (the 'subagent' minion-job handler) — invisible to nearly every other
 * gateway.chat() caller. `chat_usage_log` (migration v126) is written
 * directly from gateway.chat() itself, covering essentially all LLM chat
 * traffic; see `test/ai/gateway-chat-usage.test.ts` for coverage of that
 * write path itself. This file covers the get_usage aggregation/pricing
 * logic against the new table's rows.
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

/** Insert a `chat_usage_log` row directly (bypasses gateway.chat() — this file tests get_usage's aggregation/pricing, not the write path). */
async function insertUsage(opts: {
  model: string;
  occurredAt: Date;
  tokensIn?: number;
  tokensOut?: number;
  tokensCacheRead?: number;
  tokensCacheCreate?: number;
  phase?: string | null;
  succeeded?: boolean;
}): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO chat_usage_log
       (job_id, phase, model, tokens_in, tokens_out, tokens_cache_read, tokens_cache_create, succeeded, occurred_at)
     VALUES (NULL, $1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      opts.phase ?? null,
      opts.model,
      opts.tokensIn ?? 0,
      opts.tokensOut ?? 0,
      opts.tokensCacheRead ?? 0,
      opts.tokensCacheCreate ?? 0,
      opts.succeeded ?? true,
      opts.occurredAt,
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
    // Two rows for the same priced model — sums must combine across rows.
    await insertUsage({
      model: 'anthropic:claude-sonnet-4-6', occurredAt: IN_WINDOW,
      tokensIn: 500_000, tokensOut: 100_000, tokensCacheRead: 250_000, tokensCacheCreate: 50_000,
    });
    await insertUsage({
      model: 'anthropic:claude-sonnet-4-6', occurredAt: IN_WINDOW,
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
    await insertUsage({
      model: 'anthropic:claude-sonnet-4-6', occurredAt: IN_WINDOW,
      tokensIn: 1_000_000, tokensOut: 0, tokensCacheRead: 0, tokensCacheCreate: 0,
    });
    await insertUsage({
      model: 'some-unreleased-model-not-in-canonical', occurredAt: IN_WINDOW,
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

  test('excludes succeeded=false rows from by_model and total_cost_usd (pessimistic estimate, not measured spend)', async () => {
    await insertUsage({
      model: 'anthropic:claude-sonnet-4-6', occurredAt: IN_WINDOW,
      tokensIn: 1_000_000, tokensOut: 0, succeeded: true,
    });
    // A failed call's tokens are a pessimistic-ceiling ESTIMATE, not
    // measured usage — large enough that if it leaked into the total, the
    // assertion below would catch it.
    await insertUsage({
      model: 'anthropic:claude-sonnet-4-6', occurredAt: IN_WINDOW,
      tokensIn: 999_999_999, tokensOut: 999_999_999, succeeded: false,
    });

    const op = operationsByName.get_usage;
    const result = (await op.handler(buildCtx(), {
      since: WINDOW_SINCE.toISOString(),
      until: WINDOW_UNTIL.toISOString(),
    })) as {
      by_model: Array<{ model: string; tokens_input: number; cost_usd: number }>;
      total_cost_usd: number;
    };

    expect(result.by_model).toHaveLength(1);
    // Only the succeeded row's 1_000_000 input tokens, not the failed row's
    // near-billion — proves the failed row was excluded, not just under-weighted.
    expect(result.by_model[0]!.tokens_input).toBe(1_000_000);
    expect(result.total_cost_usd).toBeCloseTo(3.0, 6); // 1.0 * $3.00 input rate only
  });

  test('excludes rows outside the [since, until) window', async () => {
    await insertUsage({
      model: 'anthropic:claude-sonnet-4-6', occurredAt: BEFORE_WINDOW,
      tokensIn: 999_999, tokensOut: 0,
    });
    await insertUsage({
      model: 'anthropic:claude-sonnet-4-6', occurredAt: AFTER_WINDOW,
      tokensIn: 999_999, tokensOut: 0,
    });
    await insertUsage({
      model: 'anthropic:claude-sonnet-4-6', occurredAt: IN_WINDOW,
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
    await insertUsage({
      model: 'anthropic:claude-sonnet-4-6', occurredAt: WINDOW_SINCE,
      tokensIn: 1, tokensOut: 0,
    });
    await insertUsage({
      model: 'anthropic:claude-sonnet-4-6', occurredAt: WINDOW_UNTIL,
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

  test('by_model is sorted by cost_usd descending', async () => {
    // anthropic:claude-haiku-4-5 ($1/$5) — cheap
    await insertUsage({
      model: 'anthropic:claude-haiku-4-5', occurredAt: IN_WINDOW,
      tokensIn: 1_000_000, tokensOut: 0,
    });
    // anthropic:claude-opus-4-8 ($5/$25) — expensive
    await insertUsage({
      model: 'anthropic:claude-opus-4-8', occurredAt: IN_WINDOW,
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
    // 1s in the past, not `new Date()` exactly: the handler computes its own
    // `until = new Date()` moments later, and the window's upper bound is
    // exclusive (`occurred_at < until`). A single fast in-process INSERT (no
    // network latency) can land in the SAME millisecond as the handler's
    // `new Date()` — a genuine tie, excluded by `<` — causing this to fail
    // intermittently under low load specifically (flakiness observed and
    // root-caused during gbrain#3392; reproduced deterministically once,
    // see PR discussion). A safe margin removes the race without weakening
    // what the test actually verifies (the row falls inside the window).
    await insertUsage({
      model: 'anthropic:claude-sonnet-4-6', occurredAt: new Date(Date.now() - 1000),
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
    // The just-inserted row falls inside the default window.
    expect(result.by_model.map(r => r.model)).toEqual(['anthropic:claude-sonnet-4-6']);
  });
});
