/**
 * chat-usage.ts — lifecycle ledger unit tests (gbrain#3392).
 *
 * Covers the two layers separately:
 *  - pure pricing (buildRateSnapshot / computeCostUsd): exact dollar math at
 *    published list rates, and every fail-closed branch (unknown model,
 *    unverified cache semantics) returning null instead of a guess.
 *  - lifecycle writes against a real PGLite engine: started→final,
 *    started→failed-with-NULL-tokens (never 0), double-finish idempotence,
 *    crash orphan (started row left pending), and the no-engine path
 *    counting a recorder failure instead of throwing.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import {
  beginChatUsageAttempt,
  buildRateSnapshot,
  computeCostUsd,
  chatUsageRecorderFailures,
  flushChatUsage,
  setChatUsageEngine,
  withChatPhase,
  currentChatPhase,
  __resetChatUsageForTests,
} from '../src/core/chat-usage.ts';
import { CANONICAL_PRICING } from '../src/core/model-pricing.ts';

// ---------------------------------------------------------------------------
// Pure pricing
// ---------------------------------------------------------------------------

describe('buildRateSnapshot', () => {
  test('anthropic model, 5m TTL: cache rates derived from input rate', () => {
    const base = CANONICAL_PRICING['anthropic:claude-sonnet-5'];
    expect(base).toBeDefined();
    const snap = buildRateSnapshot('anthropic:claude-sonnet-5', '5m');
    expect(snap).not.toBeNull();
    expect(snap!.input_per_mtok).toBe(base!.input);
    expect(snap!.output_per_mtok).toBe(base!.output);
    expect(snap!.cache_read_per_mtok).toBeCloseTo(base!.input * 0.1, 10);
    expect(snap!.cache_write_per_mtok).toBeCloseTo(base!.input * 1.25, 10);
    expect(snap!.cache_write_ttl).toBe('5m');
  });

  test('anthropic model, 1h TTL: write rate is 2x input, not 1.25x', () => {
    const base = CANONICAL_PRICING['anthropic:claude-sonnet-5']!;
    const snap = buildRateSnapshot('anthropic:claude-sonnet-5', '1h');
    expect(snap!.cache_write_per_mtok).toBeCloseTo(base.input * 2.0, 10);
    expect(snap!.cache_write_ttl).toBe('1h');
  });

  test('anthropic model, TTL unknown: write rate is null (fail closed), read rate still known', () => {
    const snap = buildRateSnapshot('anthropic:claude-sonnet-5', null);
    expect(snap!.cache_write_per_mtok).toBeNull();
    expect(snap!.cache_read_per_mtok).not.toBeNull();
  });

  test('non-anthropic model: cache rates null (semantics unverified)', () => {
    const nonAnthropic = Object.keys(CANONICAL_PRICING).find(k => !k.startsWith('anthropic:'));
    expect(nonAnthropic).toBeDefined();
    const snap = buildRateSnapshot(nonAnthropic!, '5m');
    expect(snap).not.toBeNull();
    expect(snap!.cache_read_per_mtok).toBeNull();
    expect(snap!.cache_write_per_mtok).toBeNull();
  });

  test('unknown model / null model: null snapshot', () => {
    expect(buildRateSnapshot('claude-cli:opus', '5m')).toBeNull();
    expect(buildRateSnapshot(null, '5m')).toBeNull();
  });
});

describe('computeCostUsd', () => {
  const sonnet = buildRateSnapshot('anthropic:claude-sonnet-5', '5m')!;
  const base = CANONICAL_PRICING['anthropic:claude-sonnet-5']!;

  test('all four token classes priced (1M each, exact dollars)', () => {
    const cost = computeCostUsd(
      { input_tokens: 1_000_000, output_tokens: 1_000_000, cache_read_tokens: 1_000_000, cache_creation_tokens: 1_000_000 },
      sonnet,
    );
    expect(cost).toBeCloseTo(base.input + base.output + base.input * 0.1 + base.input * 1.25, 8);
  });

  test('no rate: null', () => {
    expect(computeCostUsd({ input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 }, null)).toBeNull();
  });

  test('cache tokens present but cache rate unverified: null, not a partial sum', () => {
    const noCache = { ...sonnet, cache_read_per_mtok: null, cache_write_per_mtok: null };
    expect(computeCostUsd({ input_tokens: 100, output_tokens: 100, cache_read_tokens: 5, cache_creation_tokens: 0 }, noCache)).toBeNull();
    expect(computeCostUsd({ input_tokens: 100, output_tokens: 100, cache_read_tokens: 0, cache_creation_tokens: 5 }, noCache)).toBeNull();
    // zero cache tokens: the unverified cache rate is irrelevant — priced.
    expect(computeCostUsd({ input_tokens: 100, output_tokens: 100, cache_read_tokens: 0, cache_creation_tokens: 0 }, noCache)).not.toBeNull();
  });
});

describe('withChatPhase', () => {
  test('ambient phase visible inside, absent outside', async () => {
    expect(currentChatPhase()).toBeUndefined();
    const seen = await withChatPhase('think', async () => currentChatPhase());
    expect(seen).toBe('think');
    expect(currentChatPhase()).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Lifecycle against a real engine
// ---------------------------------------------------------------------------

describe('lifecycle ledger', () => {
  let engine: PGLiteEngine;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  });

  afterAll(async () => {
    setChatUsageEngine(null);
    await engine.disconnect();
  });

  beforeEach(async () => {
    await resetPgliteState(engine);
    __resetChatUsageForTests();
    setChatUsageEngine(engine);
    await engine.executeRaw('DELETE FROM chat_usage_log');
  });

  async function rows(): Promise<any[]> {
    await flushChatUsage();
    return engine.executeRaw('SELECT * FROM chat_usage_log ORDER BY id');
  }

  test('success: started row finalized with usage, rate snapshot and cost', async () => {
    const attempt = beginChatUsageAttempt({
      boundary: 'gateway.chat',
      modelRaw: 'anthropic:claude-sonnet-5',
      model: 'anthropic:claude-sonnet-5',
      providerId: 'anthropic',
      cacheWriteTtl: '5m',
    });
    await attempt.finish({
      requestStatus: 'succeeded',
      usageStatus: 'final',
      usage: { input_tokens: 1000, output_tokens: 500, cache_read_tokens: 200, cache_creation_tokens: 100 },
    });
    const [r] = await rows();
    expect(r.request_status).toBe('succeeded');
    expect(r.usage_status).toBe('final');
    expect(Number(r.input_tokens)).toBe(1000);
    expect(Number(r.output_tokens)).toBe(500);
    expect(Number(r.cache_read_tokens)).toBe(200);
    expect(Number(r.cache_creation_tokens)).toBe(100);
    expect(r.cache_write_ttl).toBe('5m');
    expect(r.rate_source).toBe('model-pricing.ts:CANONICAL_PRICING');
    expect(r.rate_snapshot).toBeTruthy();
    const base = CANONICAL_PRICING['anthropic:claude-sonnet-5']!;
    const M = 1_000_000;
    expect(Number(r.cost_usd)).toBeCloseTo(
      (1000 / M) * base.input + (500 / M) * base.output + (200 / M) * base.input * 0.1 + (100 / M) * base.input * 1.25,
      10,
    );
    expect(r.completed_at).toBeTruthy();
  });

  test('failure without provider usage: tokens NULL, never 0', async () => {
    const attempt = beginChatUsageAttempt({
      boundary: 'gateway.chat',
      modelRaw: 'anthropic:claude-sonnet-5',
      model: 'anthropic:claude-sonnet-5',
    });
    await attempt.finish({
      requestStatus: 'failed',
      usageStatus: 'unknown',
      errorClass: 'APIConnectionTimeoutError',
    });
    const [r] = await rows();
    expect(r.request_status).toBe('failed');
    expect(r.usage_status).toBe('unknown');
    expect(r.input_tokens).toBeNull();
    expect(r.output_tokens).toBeNull();
    expect(r.cost_usd).toBeNull();
    expect(r.error_class).toBe('APIConnectionTimeoutError');
  });

  test('unpriced model: tokens recorded, cost NULL (fail closed)', async () => {
    const attempt = beginChatUsageAttempt({
      boundary: 'gateway.chat',
      modelRaw: 'claude-cli:opus',
      model: 'claude-cli:opus',
      cacheWriteTtl: '5m',
    });
    await attempt.finish({
      requestStatus: 'succeeded',
      usageStatus: 'final',
      usage: { input_tokens: 10, output_tokens: 10, cache_read_tokens: 0, cache_creation_tokens: 0 },
    });
    const [r] = await rows();
    expect(Number(r.input_tokens)).toBe(10);
    expect(r.cost_usd).toBeNull();
    expect(r.rate_snapshot).toBeNull();
  });

  test('abandoned attempt: row stays started/pending (query-time orphan)', async () => {
    beginChatUsageAttempt({ boundary: 'subagent.legacy_anthropic', modelRaw: 'anthropic:claude-haiku-4-5', jobId: 42 });
    const [r] = await rows();
    expect(r.request_status).toBe('started');
    expect(r.usage_status).toBe('pending');
    expect(Number(r.job_id)).toBe(42);
    expect(r.completed_at).toBeNull();
  });

  test('double finish: second call is a no-op (one terminal write)', async () => {
    const attempt = beginChatUsageAttempt({ boundary: 'gateway.chat', modelRaw: 'anthropic:claude-haiku-4-5', model: 'anthropic:claude-haiku-4-5' });
    await attempt.finish({ requestStatus: 'succeeded', usageStatus: 'final', usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 } });
    await attempt.finish({ requestStatus: 'failed', usageStatus: 'unknown' });
    const all = await rows();
    expect(all.length).toBe(1);
    expect(all[0].request_status).toBe('succeeded');
  });

  test('phase: ambient AsyncLocalStorage label lands on the row', async () => {
    await withChatPhase('dream.synthesize', async () => {
      const attempt = beginChatUsageAttempt({ boundary: 'gateway.chat', modelRaw: 'anthropic:claude-haiku-4-5' });
      await attempt.finish({ requestStatus: 'succeeded', usageStatus: 'final', usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 } });
    });
    const [r] = await rows();
    expect(r.phase).toBe('dream.synthesize');
  });

  test('no engine: no throw, recorder failure counted, nothing written', async () => {
    setChatUsageEngine(null);
    const before = chatUsageRecorderFailures();
    const attempt = beginChatUsageAttempt({ boundary: 'gateway.chat', modelRaw: 'x' });
    await attempt.finish({ requestStatus: 'succeeded', usageStatus: 'final', usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 } });
    expect(chatUsageRecorderFailures()).toBe(before + 1);
    setChatUsageEngine(engine);
    expect((await rows()).length).toBe(0);
  });
});
