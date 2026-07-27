/**
 * gbrain#3392 follow-up — proves expand() (query expansion) writes to
 * chat_usage_log, closing the gap left by the #3399 instrumentation pass:
 * expand() calls generateObject() directly and never went through chat(),
 * so its spend was invisible to `gbrain usage` even after #3399 landed
 * (found via real-invoice reconciliation, 2026-07-27).
 *
 * Mirrors test/ai/gateway-chat-usage.test.ts's structure and test-transport
 * seam pattern (__setGenerateObjectTransportForTests keeps provider
 * resolution live, replaces only the final SDK call).
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';
import {
  expand,
  configureGateway,
  resetGateway,
  __setChatEngineForTests,
  __setGenerateObjectTransportForTests,
  __flushChatUsageForTests,
} from '../../src/core/ai/gateway.ts';

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
  __setGenerateObjectTransportForTests(null);
  __setChatEngineForTests(null);
  resetGateway();
});

async function latestUsageRows(): Promise<Array<{
  model: string;
  tokens_in: number;
  tokens_out: number;
  tokens_cache_read: number;
  tokens_cache_create: number;
  succeeded: boolean;
}>> {
  return engine.executeRaw(
    `SELECT model, tokens_in, tokens_out, tokens_cache_read,
            tokens_cache_create, succeeded
       FROM chat_usage_log ORDER BY id ASC`,
  );
}

describe('expand() writes chat_usage_log (gbrain#3392 follow-up)', () => {
  test('a successful expansion records exactly one succeeded=true row with matching values', async () => {
    configureGateway({
      expansion_model: 'anthropic:claude-haiku-4-5',
      env: { ANTHROPIC_API_KEY: 'fake' },
    });
    __setGenerateObjectTransportForTests(async (): Promise<any> => ({
      object: { queries: ['alt query one', 'alt query two'] },
      usage: { inputTokens: 90, outputTokens: 30 },
      providerMetadata: {
        anthropic: { cacheReadInputTokens: 10, cacheCreationInputTokens: 0 },
      },
    }));

    const result = await expand('original query');
    expect(result).toContain('original query');
    expect(result).toContain('alt query one');
    await __flushChatUsageForTests();

    const rows = await latestUsageRows();
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.model).toBe('anthropic:claude-haiku-4-5-20251001');
    expect(row.tokens_in).toBe(90);
    expect(row.tokens_out).toBe(30);
    expect(row.tokens_cache_read).toBe(10);
    expect(row.succeeded).toBe(true);
  });

  test('a throwing expansion (after provider resolution succeeded) records a succeeded=false row under the RESOLVED model id and falls back to the original query', async () => {
    configureGateway({
      expansion_model: 'anthropic:claude-haiku-4-5',
      env: { ANTHROPIC_API_KEY: 'fake' },
    });
    __setGenerateObjectTransportForTests(async (): Promise<any> => {
      throw new Error('simulated expansion failure');
    });

    const result = await expand('original query');
    // Best-effort: falls back to the original query alone, does not throw.
    expect(result).toEqual(['original query']);
    await __flushChatUsageForTests();

    const rows = await latestUsageRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.succeeded).toBe(false);
    // Codex review finding: resolveExpansionProvider() already succeeded
    // before the generateObject() call threw, so the failure row must be
    // logged under the RESOLVED recipe:modelId (matches the pricing table),
    // not the raw/possibly-aliased config string.
    expect(rows[0]!.model).toBe('anthropic:claude-haiku-4-5-20251001');
    // No real usage on the error path — falls back to the pre-call estimate,
    // which must be > 0 (never silently logs a zero-cost failed call).
    expect(rows[0]!.tokens_in).toBeGreaterThan(0);
  });

  test('no engine on hand — expand() still succeeds, just records nothing', async () => {
    __setChatEngineForTests(null);
    configureGateway({
      expansion_model: 'anthropic:claude-haiku-4-5',
      env: { ANTHROPIC_API_KEY: 'fake' },
    });
    __setGenerateObjectTransportForTests(async (): Promise<any> => ({
      object: { queries: ['alt'] },
      usage: { inputTokens: 5, outputTokens: 2 },
    }));

    const result = await expand('q');
    expect(result).toContain('q');
    await __flushChatUsageForTests();

    expect(await latestUsageRows()).toHaveLength(0);
  });

  test('nonzero cache-create is recorded alongside cache-read (Codex review coverage gap)', async () => {
    configureGateway({
      expansion_model: 'anthropic:claude-haiku-4-5',
      env: { ANTHROPIC_API_KEY: 'fake' },
    });
    __setGenerateObjectTransportForTests(async (): Promise<any> => ({
      object: { queries: ['alt query'] },
      usage: { inputTokens: 90, outputTokens: 30 },
      providerMetadata: {
        anthropic: { cacheReadInputTokens: 5, cacheCreationInputTokens: 40 },
      },
    }));

    await expand('original query');
    await __flushChatUsageForTests();

    const rows = await engine.executeRaw(
      `SELECT tokens_cache_read, tokens_cache_create FROM chat_usage_log ORDER BY id ASC`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tokens_cache_read).toBe(5);
    expect(rows[0]!.tokens_cache_create).toBe(40);
  });

  test('a result-processing failure after a successful provider call does NOT double-record (Codex review finding)', async () => {
    configureGateway({
      expansion_model: 'anthropic:claude-haiku-4-5',
      env: { ANTHROPIC_API_KEY: 'fake' },
    });
    // `queries` containing a non-string forces the post-generation dedup/
    // filter loop (`q.toLowerCase()`) to throw — simulates "provider call
    // succeeded, but something after it blew up" without needing to break
    // Zod validation itself. Before the fix (recording success BEFORE
    // running this loop), this scenario produced TWO rows for one provider
    // call: a phantom succeeded=true row from the pre-loop record, plus a
    // succeeded=false row from the outer catch.
    __setGenerateObjectTransportForTests(async (): Promise<any> => ({
      object: { queries: [null] },
      usage: { inputTokens: 90, outputTokens: 30 },
    }));

    const result = await expand('original query');
    // Best-effort: falls back to the original query alone on any failure,
    // including a post-generation processing failure.
    expect(result).toEqual(['original query']);
    await __flushChatUsageForTests();

    const rows = await latestUsageRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.succeeded).toBe(false);
  });
});
