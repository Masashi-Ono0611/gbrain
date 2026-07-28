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
  sanitizeTokenCount,
  isAbortError,
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

  test('invalid TTL string: fail closed to null, never a silent 5m rate', () => {
    const snap = buildRateSnapshot('anthropic:claude-sonnet-5', '30m');
    expect(snap!.cache_write_per_mtok).toBeNull();
    expect(snap!.cache_write_ttl).toBeNull();
  });

  test('bare model id prices via canonicalLookup (anthropic default)', () => {
    const snap = buildRateSnapshot('claude-sonnet-5', '5m');
    expect(snap).not.toBeNull();
    expect(snap!.input_per_mtok).toBe(CANONICAL_PRICING['anthropic:claude-sonnet-5']!.input);
    expect(snap!.cache_write_per_mtok).not.toBeNull();
  });

  test('slash-spelled non-anthropic id: priced, but NEVER given anthropic cache rates', () => {
    // canonicalLookup resolves 'openai/gpt-4o' → openai:gpt-4o; classifying
    // it as anthropic (the old punctuation heuristic) would price unverified
    // cache semantics — the wrong fail-open direction.
    const snap = buildRateSnapshot('openai/gpt-4o', '5m');
    expect(snap).not.toBeNull();
    expect(snap!.input_per_mtok).toBe(CANONICAL_PRICING['openai:gpt-4o']!.input);
    expect(snap!.cache_read_per_mtok).toBeNull();
    expect(snap!.cache_write_per_mtok).toBeNull();
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

  test('null fields contribute nothing (lower bound), not zero-as-fact', () => {
    const base = CANONICAL_PRICING['anthropic:claude-sonnet-5']!;
    const cost = computeCostUsd(
      { input_tokens: 1_000_000, output_tokens: null, cache_read_tokens: null, cache_creation_tokens: null },
      sonnet,
    );
    expect(cost).toBeCloseTo(base.input, 10);
  });
});

describe('sanitizeTokenCount', () => {
  test('finite non-negative passes; NaN/Infinity/negative/non-number become null', () => {
    expect(sanitizeTokenCount(0)).toBe(0);
    expect(sanitizeTokenCount(42)).toBe(42);
    expect(sanitizeTokenCount(NaN)).toBeNull();
    expect(sanitizeTokenCount(Infinity)).toBeNull();
    expect(sanitizeTokenCount(-1)).toBeNull();
    expect(sanitizeTokenCount('10')).toBeNull();
    expect(sanitizeTokenCount(undefined)).toBeNull();
  });
});

describe('isAbortError', () => {
  test('AbortError / APIUserAbortError variants classify; plain errors do not', () => {
    const a = new Error('x'); a.name = 'AbortError';
    const b = new Error('x'); b.name = 'APIUserAbortError';
    expect(isAbortError(a)).toBe(true);
    expect(isAbortError(b)).toBe(true);
    expect(isAbortError(new Error('x'))).toBe(false);
    expect(isAbortError(null)).toBe(false);
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

  test('final claim with a missing field is downgraded to partial', async () => {
    const attempt = beginChatUsageAttempt({ boundary: 'gateway.chat', modelRaw: 'anthropic:claude-haiku-4-5', model: 'anthropic:claude-haiku-4-5' });
    await attempt.finish({
      requestStatus: 'succeeded',
      usageStatus: 'final',
      usage: { input_tokens: 100, output_tokens: null, cache_read_tokens: 0, cache_creation_tokens: 0 },
    });
    const [r] = await rows();
    expect(r.usage_status).toBe('partial');
    expect(Number(r.input_tokens)).toBe(100);
    expect(r.output_tokens).toBeNull();
  });

  test('all-null usage collapses to unknown with no usage row data', async () => {
    const attempt = beginChatUsageAttempt({ boundary: 'gateway.chat', modelRaw: 'anthropic:claude-haiku-4-5', model: 'anthropic:claude-haiku-4-5' });
    await attempt.finish({
      requestStatus: 'succeeded',
      usageStatus: 'final',
      usage: { input_tokens: null, output_tokens: null, cache_read_tokens: null, cache_creation_tokens: null },
    });
    const [r] = await rows();
    expect(r.usage_status).toBe('unknown');
    expect(r.input_tokens).toBeNull();
    expect(r.cost_usd).toBeNull();
  });

  test('NaN token counts are sanitized to null, never written', async () => {
    const attempt = beginChatUsageAttempt({ boundary: 'gateway.chat', modelRaw: 'anthropic:claude-haiku-4-5', model: 'anthropic:claude-haiku-4-5' });
    await attempt.finish({
      requestStatus: 'succeeded',
      usageStatus: 'final',
      usage: { input_tokens: NaN, output_tokens: 5, cache_read_tokens: 0, cache_creation_tokens: 0 },
    });
    const [r] = await rows();
    expect(r.input_tokens).toBeNull();
    expect(r.usage_status).toBe('partial');
  });

  test('rate_snapshot round-trips as a jsonb OBJECT, not a double-encoded string', async () => {
    const attempt = beginChatUsageAttempt({
      boundary: 'gateway.chat',
      modelRaw: 'anthropic:claude-sonnet-5',
      model: 'anthropic:claude-sonnet-5',
      cacheWriteTtl: '5m',
    });
    await attempt.finish({
      requestStatus: 'succeeded',
      usageStatus: 'final',
      usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
    });
    await flushChatUsage();
    const [probe] = await engine.executeRaw<{ t: string; in_rate: string | null }>(
      `SELECT jsonb_typeof(rate_snapshot) AS t, rate_snapshot ->> 'input_per_mtok' AS in_rate FROM chat_usage_log`,
    );
    // The #2339 double-encode failure mode stores a jsonb STRING scalar:
    // typeof 'string' and ->> returning NULL. Assert the healthy shape.
    expect(probe.t).toBe('object');
    expect(parseFloat(String(probe.in_rate))).toBe(CANONICAL_PRICING['anthropic:claude-sonnet-5']!.input);
  });

  test('started-INSERT failure: finish lands a single self-contained terminal row', async () => {
    // Engine proxy: fail exactly the FIRST executeRaw (the started INSERT),
    // let everything after through. sqlQueryForEngine funnels every write
    // through engine.executeRaw, so this exercises the recovery INSERT path.
    let failures = 0;
    const flaky = new Proxy(engine, {
      get(target, prop, receiver) {
        if (prop === 'executeRaw') {
          return (...args: unknown[]) => {
            if (failures === 0) {
              failures++;
              return Promise.reject(new Error('transient DB error'));
            }
            return (target as any).executeRaw(...args);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    setChatUsageEngine(flaky as any);
    const attempt = beginChatUsageAttempt({ boundary: 'gateway.chat', modelRaw: 'anthropic:claude-haiku-4-5', model: 'anthropic:claude-haiku-4-5' });
    await attempt.finish({
      requestStatus: 'succeeded',
      usageStatus: 'final',
      usage: { input_tokens: 7, output_tokens: 3, cache_read_tokens: 0, cache_creation_tokens: 0 },
    });
    setChatUsageEngine(engine);
    expect(failures).toBe(1);
    const all = await rows();
    expect(all.length).toBe(1);
    expect(all[0].request_status).toBe('succeeded');
    expect(Number(all[0].input_tokens)).toBe(7);
    expect(all[0].completed_at).toBeTruthy();
    // The failed started-INSERT counted as one recorder failure — the gap is
    // visible even though recovery succeeded.
    expect(chatUsageRecorderFailures()).toBe(1);
  });

  test('terminal-UPDATE failure: bounded retry lands the terminal state', async () => {
    // Call #1 (started INSERT) succeeds, call #2 (terminal UPDATE) fails
    // once, the built-in retry (call #3) succeeds. The row must end terminal
    // — Codex P2: without the retry, a transient UPDATE failure left the row
    // 'started' forever with the finished latch already set.
    let calls = 0;
    const flaky = new Proxy(engine, {
      get(target, prop, receiver) {
        if (prop === 'executeRaw') {
          return (...args: unknown[]) => {
            calls++;
            if (calls === 2) return Promise.reject(new Error('transient UPDATE failure'));
            return (target as any).executeRaw(...args);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    setChatUsageEngine(flaky as any);
    const attempt = beginChatUsageAttempt({ boundary: 'gateway.chat', modelRaw: 'anthropic:claude-haiku-4-5', model: 'anthropic:claude-haiku-4-5' });
    await attempt.finish({
      requestStatus: 'succeeded',
      usageStatus: 'final',
      usage: { input_tokens: 11, output_tokens: 2, cache_read_tokens: 0, cache_creation_tokens: 0 },
    });
    setChatUsageEngine(engine);
    const all = await rows();
    expect(all.length).toBe(1);
    expect(all[0].request_status).toBe('succeeded');
    expect(Number(all[0].input_tokens)).toBe(11);
    expect(all[0].completed_at).toBeTruthy();
  });

  test('backpressure: past the pending-writes cap, attempts are dropped and counted', async () => {
    // Wedge the DB: executeRaw never resolves. Every attempt leaves its
    // started-INSERT pending, so the cap fills; past it, beginChatUsageAttempt
    // returns the no-op handle and counts a recorder failure instead of
    // queueing unbounded promises against a dead database.
    const never = new Proxy(engine, {
      get(target, prop, receiver) {
        if (prop === 'executeRaw') {
          return () => new Promise(() => {});
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    setChatUsageEngine(never as any);
    const before = chatUsageRecorderFailures();
    for (let i = 0; i < 300; i++) {
      beginChatUsageAttempt({ boundary: 'gateway.chat', modelRaw: 'x' });
    }
    expect(chatUsageRecorderFailures()).toBeGreaterThan(before);
    setChatUsageEngine(engine);
    __resetChatUsageForTests();
    setChatUsageEngine(engine);
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
