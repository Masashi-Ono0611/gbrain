/**
 * gateway.chat() → chat_usage_log boundary wiring (gbrain#3392).
 *
 * These are the structural tests that keep the gateway boundary honest: if
 * someone removes or bypasses the beginChatUsageAttempt call inside
 * gateway.chat's dispatch, they fail. The provider is faked at the
 * generateText transport seam, so the rows asserted here come from the REAL
 * dispatch path (provider resolution, cache-control derivation, error
 * normalization) — not from calling the recorder directly.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';
import {
  configureGateway,
  resetGateway,
  chat,
  __setGenerateTextTransportForTests,
} from '../../src/core/ai/gateway.ts';
import {
  setChatUsageEngine,
  flushChatUsage,
  withChatPhase,
  __resetChatUsageForTests,
} from '../../src/core/chat-usage.ts';
import { CANONICAL_PRICING } from '../../src/core/model-pricing.ts';

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
  configureGateway({
    chat_model: 'anthropic:claude-sonnet-4-6',
    env: { ANTHROPIC_API_KEY: 'fake' },
  });
});

afterEach(() => {
  __setGenerateTextTransportForTests(null);
  resetGateway();
});

async function rows(): Promise<any[]> {
  await flushChatUsage();
  return engine.executeRaw('SELECT * FROM chat_usage_log ORDER BY id');
}

function fakeSuccess(usage: Record<string, number>, providerMetadata?: Record<string, any>): void {
  __setGenerateTextTransportForTests(async () => ({
    content: [{ type: 'text', text: 'ok' }],
    finishReason: 'stop',
    usage,
    ...(providerMetadata ? { providerMetadata } : {}),
  }) as any);
}

describe('gateway.chat boundary', () => {
  test('success writes one final row with model, provider, tokens and cost', async () => {
    fakeSuccess(
      { inputTokens: 1000, outputTokens: 200 },
      { anthropic: { cacheReadInputTokens: 300, cacheCreationInputTokens: 50 } },
    );
    await withChatPhase('think', () =>
      chat({ model: 'anthropic:claude-sonnet-4-6', messages: [{ role: 'user', content: 'hi' }] }),
    );
    const all = await rows();
    expect(all.length).toBe(1);
    const r = all[0];
    expect(r.boundary).toBe('gateway.chat');
    expect(r.model).toBe('anthropic:claude-sonnet-4-6');
    expect(r.provider_id).toBe('anthropic');
    expect(r.phase).toBe('think');
    expect(r.request_status).toBe('succeeded');
    expect(r.usage_status).toBe('final');
    expect(Number(r.input_tokens)).toBe(1000);
    expect(Number(r.output_tokens)).toBe(200);
    expect(Number(r.cache_read_tokens)).toBe(300);
    expect(Number(r.cache_creation_tokens)).toBe(50);
    const base = CANONICAL_PRICING['anthropic:claude-sonnet-4-6']!;
    const M = 1_000_000;
    // No cacheSystem opt-in → request carried no cache breakpoints → TTL
    // null → cache-write tokens unpriceable → whole row fails closed.
    expect(r.cache_write_ttl).toBeNull();
    expect(r.cost_usd).toBeNull();
    // Sanity that the pricing WOULD have applied to the non-cache part.
    expect((1000 / M) * base.input).toBeGreaterThan(0);
  });

  test('cacheSystem request records the 5m TTL and prices cache writes', async () => {
    fakeSuccess(
      { inputTokens: 10, outputTokens: 10 },
      { anthropic: { cacheReadInputTokens: 0, cacheCreationInputTokens: 1_000_000 } },
    );
    await chat({
      model: 'anthropic:claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'hi' }],
      system: 'sys',
      cacheSystem: true,
    });
    const [r] = await rows();
    expect(r.cache_write_ttl).toBe('5m');
    const base = CANONICAL_PRICING['anthropic:claude-sonnet-4-6']!;
    const M = 1_000_000;
    expect(Number(r.cost_usd)).toBeCloseTo(
      (10 / M) * base.input + (10 / M) * base.output + (1_000_000 / M) * base.input * 1.25,
      10,
    );
  });

  test('transport failure: row failed/unknown with NULL tokens, error class kept', async () => {
    __setGenerateTextTransportForTests(async () => {
      throw new Error('boom');
    });
    await expect(
      chat({ model: 'anthropic:claude-sonnet-4-6', messages: [{ role: 'user', content: 'hi' }] }),
    ).rejects.toThrow();
    const [r] = await rows();
    expect(r.request_status).toBe('failed');
    expect(r.usage_status).toBe('unknown');
    expect(r.input_tokens).toBeNull();
    expect(r.output_tokens).toBeNull();
    expect(r.cost_usd).toBeNull();
    expect(r.error_class).toBe('Error');
  });

  test('error carrying provider usage: partial lower bound, not ceilings', async () => {
    __setGenerateTextTransportForTests(async () => {
      const err = new Error('mid-flight');
      (err as any).usage = { input_tokens: 777, output_tokens: 3 };
      throw err;
    });
    await expect(
      chat({ model: 'anthropic:claude-sonnet-4-6', messages: [{ role: 'user', content: 'hi' }] }),
    ).rejects.toThrow();
    const [r] = await rows();
    expect(r.usage_status).toBe('partial');
    expect(Number(r.input_tokens)).toBe(777);
    expect(Number(r.output_tokens)).toBe(3);
  });

  test('abort: request_status aborted', async () => {
    __setGenerateTextTransportForTests(async () => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    });
    await expect(
      chat({ model: 'anthropic:claude-sonnet-4-6', messages: [{ role: 'user', content: 'hi' }] }),
    ).rejects.toThrow();
    const [r] = await rows();
    expect(r.request_status).toBe('aborted');
    expect(r.usage_status).toBe('unknown');
  });
});
