/**
 * gbrain#3392 — proves `chat()` itself writes to `chat_usage_log` on both
 * the success and error paths, not just that get_usage's aggregation math
 * is correct against pre-seeded rows (see test/get-usage.test.ts for that).
 *
 * Uses the existing `_chatTransport` test-transport seam
 * (`__setChatTransportForTests`) to drive `chat()` deterministically with
 * $0 cost — no real network calls, no real API keys. `__setChatEngineForTests`
 * stands in for `reconfigureGatewayWithEngine()` (which every real gbrain
 * process calls once at bootstrap — see the `_currentEngine` comment in
 * gateway.ts) without that call's other side effects (re-resolving
 * expansion/chat/tier models against the engine's DB-backed config).
 * `__flushChatUsageForTests` awaits the fire-and-forget write so assertions
 * don't race it.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';
import {
  chat,
  withChatPhase,
  configureGateway,
  resetGateway,
  __setChatTransportForTests,
  __setChatEngineForTests,
  __setGenerateTextTransportForTests,
  __flushChatUsageForTests,
  type ChatResult,
} from '../../src/core/ai/gateway.ts';
import type { BrainEngine, ChatUsageLogRow } from '../../src/core/engine.ts';

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
  __setChatEngineForTests(engine);
});

afterEach(() => {
  __setChatTransportForTests(null);
  __setGenerateTextTransportForTests(null);
  __setChatEngineForTests(null);
  resetGateway();
  // resetGateway() clears _currentEngine too — re-stamp isn't needed here
  // since each test's beforeEach re-runs before the next test.
});

async function latestUsageRows(): Promise<Array<{
  job_id: number | null;
  phase: string | null;
  model: string;
  tokens_in: number;
  tokens_out: number;
  tokens_cache_read: number;
  tokens_cache_create: number;
  succeeded: boolean;
}>> {
  return engine.executeRaw(
    `SELECT job_id, phase, model, tokens_in, tokens_out, tokens_cache_read,
            tokens_cache_create, succeeded
       FROM chat_usage_log ORDER BY id ASC`,
  );
}

describe('chat() writes chat_usage_log (gbrain#3392)', () => {
  test('a successful call records exactly one succeeded=true row with matching values', async () => {
    __setChatTransportForTests(async (): Promise<ChatResult> => ({
      text: 'hello',
      blocks: [{ type: 'text', text: 'hello' }],
      stopReason: 'end',
      usage: { input_tokens: 123, output_tokens: 45, cache_read_tokens: 6, cache_creation_tokens: 7 },
      model: 'anthropic:claude-sonnet-4-6',
      providerId: 'anthropic',
    }));

    const result = await chat({
      model: 'anthropic:claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(result.text).toBe('hello');
    await __flushChatUsageForTests();

    const rows = await latestUsageRows();
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.model).toBe('anthropic:claude-sonnet-4-6');
    expect(row.tokens_in).toBe(123);
    expect(row.tokens_out).toBe(45);
    expect(row.tokens_cache_read).toBe(6);
    expect(row.tokens_cache_create).toBe(7);
    expect(row.succeeded).toBe(true);
    expect(row.job_id).toBeNull();
    // No withChatPhase scope active for this call — phase is null, not a
    // precondition for being counted (see the next test for the positive case).
    expect(row.phase).toBeNull();
  });

  test('withChatPhase(...) tags the recorded row with that phase', async () => {
    __setChatTransportForTests(async (): Promise<ChatResult> => ({
      text: 'ok',
      blocks: [],
      stopReason: 'end',
      usage: { input_tokens: 10, output_tokens: 2, cache_read_tokens: 0, cache_creation_tokens: 0 },
      model: 'anthropic:claude-sonnet-4-6',
      providerId: 'anthropic',
    }));

    await withChatPhase('test.phase', () =>
      chat({ model: 'anthropic:claude-sonnet-4-6', messages: [{ role: 'user', content: 'hi' }] }),
    );
    await __flushChatUsageForTests();

    const rows = await latestUsageRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.phase).toBe('test.phase');
  });

  test('a throwing call still records a succeeded=false row', async () => {
    __setChatTransportForTests(async (): Promise<ChatResult> => {
      throw new Error('simulated provider failure');
    });

    await expect(
      chat({ model: 'anthropic:claude-sonnet-4-6', messages: [{ role: 'user', content: 'hi' }] }),
    ).rejects.toThrow('simulated provider failure');
    await __flushChatUsageForTests();

    const rows = await latestUsageRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.succeeded).toBe(false);
    expect(rows[0]!.model).toBe('anthropic:claude-sonnet-4-6');
  });

  test('no engine on hand (e.g. isolated unit tests) — chat() still succeeds, just records nothing', async () => {
    __setChatEngineForTests(null);
    __setChatTransportForTests(async (): Promise<ChatResult> => ({
      text: 'ok',
      blocks: [],
      stopReason: 'end',
      usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
      model: 'anthropic:claude-sonnet-4-6',
      providerId: 'anthropic',
    }));

    const result = await chat({
      model: 'anthropic:claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(result.text).toBe('ok');
    await __flushChatUsageForTests();

    expect(await latestUsageRows()).toHaveLength(0);
  });
});

// `_chatTransport` (above) short-circuits `chat()` before it ever reaches
// provider resolution — the `if (_chatTransport) { ... }` branch returns
// or throws before the TWO production instrumentation points (the
// `_recordBudget`-adjacent calls after `_generateTextTransport`'s success
// and inside its `catch`) are ever reached. This block exercises those
// production call sites directly via `__setGenerateTextTransportForTests`
// (keeps real provider resolution + providerOptions assembly live, only
// replaces the final SDK call), matching the pattern
// `gateway-cache-breakpoint.test.ts` uses to pin real `chat()` behavior.
describe('chat() writes chat_usage_log — production instrumentation points', () => {
  test('success via the real provider-resolution path records a succeeded=true row with cache tokens', async () => {
    configureGateway({
      chat_model: 'anthropic:claude-sonnet-4-6',
      env: { ANTHROPIC_API_KEY: 'fake' },
    });
    __setGenerateTextTransportForTests(async (): Promise<any> => ({
      content: [{ type: 'text', text: 'ok' }],
      finishReason: 'stop',
      usage: { inputTokens: 200, outputTokens: 50 },
      providerMetadata: {
        anthropic: { cacheReadInputTokens: 20, cacheCreationInputTokens: 5 },
      },
    }));

    await chat({
      model: 'anthropic:claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'hi' }],
    });
    await __flushChatUsageForTests();

    const rows = await latestUsageRows();
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.model).toBe('anthropic:claude-sonnet-4-6');
    expect(row.tokens_in).toBe(200);
    expect(row.tokens_out).toBe(50);
    expect(row.tokens_cache_read).toBe(20);
    expect(row.tokens_cache_create).toBe(5);
    expect(row.succeeded).toBe(true);
  });

  test('a throw from the real provider call records a succeeded=false row via the catch-path instrumentation', async () => {
    configureGateway({
      chat_model: 'anthropic:claude-sonnet-4-6',
      env: { ANTHROPIC_API_KEY: 'fake' },
    });
    __setGenerateTextTransportForTests(async (): Promise<any> => {
      throw new Error('simulated SDK failure');
    });

    await expect(
      chat({ model: 'anthropic:claude-sonnet-4-6', messages: [{ role: 'user', content: 'hi' }] }),
    ).rejects.toThrow();
    await __flushChatUsageForTests();

    const rows = await latestUsageRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.model).toBe('anthropic:claude-sonnet-4-6');
    expect(rows[0]!.succeeded).toBe(false);
  });
});

// Direct test of the single most important correctness constraint in this
// feature: a broken audit write must NEVER turn into a broken chat() call.
// Uses hand-rolled BrainEngine stubs (not the real PGLiteEngine) so
// `recordChatUsage` can be made to fail synchronously or via rejection on
// demand — the real engine's implementation can't be coerced into either
// failure mode from a test.
describe('chat() never lets a broken recordChatUsage() affect the caller', () => {
  test('a synchronously-throwing engine.recordChatUsage does not break chat()', async () => {
    const throwingEngine = {
      recordChatUsage(_row: ChatUsageLogRow): Promise<void> {
        throw new Error('synchronous engine bug');
      },
    } as unknown as BrainEngine;
    __setChatEngineForTests(throwingEngine);
    __setChatTransportForTests(async (): Promise<ChatResult> => ({
      text: 'still works',
      blocks: [],
      stopReason: 'end',
      usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
      model: 'anthropic:claude-sonnet-4-6',
      providerId: 'anthropic',
    }));

    const result = await chat({
      model: 'anthropic:claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(result.text).toBe('still works');
    // Nothing to flush (the throwing engine's write was never tracked —
    // it threw before returning a promise) — this just proves flush itself
    // doesn't throw either.
    await __flushChatUsageForTests();
  });

  test('a rejecting engine.recordChatUsage does not break chat() or leak an unhandled rejection', async () => {
    const rejectingEngine = {
      async recordChatUsage(_row: ChatUsageLogRow): Promise<void> {
        throw new Error('async engine bug');
      },
    } as unknown as BrainEngine;
    __setChatEngineForTests(rejectingEngine);
    __setChatTransportForTests(async (): Promise<ChatResult> => ({
      text: 'still works too',
      blocks: [],
      stopReason: 'end',
      usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
      model: 'anthropic:claude-sonnet-4-6',
      providerId: 'anthropic',
    }));

    const result = await chat({
      model: 'anthropic:claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(result.text).toBe('still works too');
    // The rejection is tracked (recordChatUsage DID return a promise this
    // time) — flushing it must resolve cleanly, not propagate the rejection.
    await __flushChatUsageForTests();
  });
});
