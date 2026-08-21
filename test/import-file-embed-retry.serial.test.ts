/**
 * #3374 — import embed path: SDK-internal retries share one
 * AI_EMBED_TIMEOUT_MS budget, so transient timeouts on large pages were
 * never actually retried.
 *
 * Two gaps the issue identified:
 *   1. `import-file.ts`'s two embed call sites used the raw `embedBatch`
 *      (gatewayEmbed passthrough), so retries were SDK-internal — all
 *      attempts run inside ONE `_embedTransport` call, bounded by ONE
 *      `withDefaultTimeout(..., AI_EMBED_TIMEOUT_MS)` signal. Fix: route
 *      both call sites through `embedBatchWithBackoff` (src/commands/embed.ts),
 *      same as `src/core/embed-stale.ts` already does for `embed --stale`.
 *      Each wrapper-driven retry is a SEPARATE `embedBatch(..., {maxRetries:
 *      0})` call, and the gateway's `embedSubBatch` builds a FRESH
 *      `withDefaultTimeout()` / `AbortSignal.timeout()` on every call (see
 *      src/core/ai/gateway.ts) — so each retry gets its own timeout window.
 *   2. `embedBatchWithBackoff`'s retry predicate was 429/5xx-only — a
 *      timeout-classified failure fell through to `throw e` on attempt 1,
 *      so even a wrapper-routed caller wouldn't have retried it. Fix:
 *      `classifyEmbedRetryError` now also recognizes the gateway's
 *      `TimeoutError` (structural cause-chain walk + message fallback,
 *      mirroring the existing 429/gateway detectors) and retries it with a
 *      short jittered backoff (`timeoutRetryDelayMs`) instead of
 *      `parseRetryDelayMs`'s 60s rate-limit fallback.
 *
 * This file mocks `../src/core/embedding.ts` (mock.module — hence
 * `*.serial.test.ts`, same pattern as test/embed.serial.test.ts) so it can
 * simulate a first-attempt timeout and observe how many times the mocked
 * `embedBatch` primitive gets called, with what options, and how long the
 * retry takes to resolve.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';

// ────────────────────────────────────────────────────────────────
// Mock core/embedding.ts BEFORE importing import-file.ts / embed.ts, so
// both pick up the mocked embedBatch. embedBatchWithBackoff (commands/
// embed.ts) calls this same `embedBatch` internally, so mocking it here
// intercepts both the direct test calls AND import-file.ts's calls that
// route through the wrapper.
// ────────────────────────────────────────────────────────────────
let totalEmbedCalls = 0;
let lastEmbedBatchOpts: unknown = undefined;
let embedBatchBehavior: ((texts: string[], opts?: unknown) => Promise<Float32Array[]>) | null = null;

mock.module('../src/core/embedding.ts', () => ({
  embedBatch: async (texts: string[], opts?: unknown) => {
    totalEmbedCalls++;
    lastEmbedBatchOpts = opts;
    if (embedBatchBehavior) return embedBatchBehavior(texts, opts);
    return texts.map(() => new Float32Array(1536));
  },
  embedMultimodal: async () => {
    throw new Error('embedMultimodal should not be invoked by these text-only fixtures');
  },
  currentEmbeddingSignature: () => 'test:model:1536',
}));

// Import AFTER mocking.
const { importFromContent, importCodeFile } = await import('../src/core/import-file.ts');
const {
  embedBatchWithBackoff,
  classifyEmbedRetryError,
  detectTimeoutFromCause,
  MAX_RATE_LIMIT_RETRIES,
} = await import('../src/commands/embed.ts');

/** A TimeoutError-shaped error matching what the gateway actually throws
 * (normalizeAIError wraps the raw DOMException in AITransientError, with
 * the original — carrying `name: 'TimeoutError'` — preserved on `.cause`).
 * Message matches the production evidence quoted in #3374:
 * "[embed(openai:text-embedding-3-small)] The operation timed out." */
function makeTimeoutError(): Error {
  const raw = Object.assign(new Error('The operation timed out.'), { name: 'TimeoutError' });
  const wrapped = new Error('[embed(openai:text-embedding-3-small)] The operation timed out.');
  (wrapped as { cause?: unknown }).cause = raw;
  wrapped.name = 'AITransientError';
  return wrapped;
}

// Proxy-based mock engine — same shape as test/import-file.test.ts's mockEngine.
function mockEngine(overrides: Partial<Record<string, any>> = {}): BrainEngine {
  const calls: { method: string; args: any[] }[] = [];
  const pageStore = new Map<string, any>();
  const track = (method: string) => (...args: any[]) => {
    calls.push({ method, args });
    if (overrides[method]) return overrides[method](...args);
    return Promise.resolve(null);
  };
  const engine = new Proxy({} as any, {
    get(_, prop: string) {
      if (prop === '_calls') return calls;
      if (prop === 'getTags') return overrides.getTags || (() => Promise.resolve([]));
      if (prop === 'getPage') {
        return async (slug: string, opts?: { sourceId?: string }) => {
          if (overrides.getPage) {
            const overrideResult = await overrides.getPage(slug, opts);
            if (overrideResult) {
              const stored = pageStore.get(slug);
              return stored ? { ...overrideResult, content_hash: stored.content_hash } : overrideResult;
            }
          }
          return pageStore.get(slug) ?? null;
        };
      }
      if (prop === 'putPage') {
        return async (slug: string, page: any, _opts?: { sourceId?: string }) => {
          calls.push({ method: 'putPage', args: [slug, page, _opts] });
          if (overrides.putPage) overrides.putPage(slug, page, _opts);
          pageStore.set(slug, {
            slug,
            content_hash: page.content_hash ?? '',
            title: page.title ?? '',
            type: page.type ?? '',
            frontmatter: page.frontmatter ?? {},
          });
          return Promise.resolve(undefined);
        };
      }
      if (prop === 'transaction') return async (fn: (tx: BrainEngine) => Promise<any>) => fn(engine);
      return track(prop);
    },
  });
  return engine;
}

beforeEach(() => {
  totalEmbedCalls = 0;
  lastEmbedBatchOpts = undefined;
  embedBatchBehavior = null;
});

afterEach(() => {
  embedBatchBehavior = null;
});

// ────────────────────────────────────────────────────────────────
// Gap 1: import-file.ts's two call sites now route through
// embedBatchWithBackoff, so a first-attempt timeout is retried instead of
// propagating immediately.
// ────────────────────────────────────────────────────────────────

describe('importFromContent (markdown path) — embed retry routing', () => {
  test('a first-attempt timeout is retried and the import succeeds', async () => {
    embedBatchBehavior = async (texts) => {
      if (totalEmbedCalls === 1) throw makeTimeoutError();
      return texts.map(() => new Float32Array(1536));
    };
    const engine = mockEngine();
    const content = [
      '---',
      'title: Retry Test',
      '---',
      '',
      'This body is long enough to produce at least one real chunk of text',
      'for the recursive chunker to embed, so the embed call site actually fires.',
    ].join('\n');

    const result = await importFromContent(engine, 'retry-test/markdown', content, {});

    expect(result.status).toBe('imported');
    // Two embedBatch invocations: attempt 1 (timeout) + attempt 2 (success).
    // Proves import-file.ts is no longer calling raw embedBatch once and
    // propagating — it's going through the retrying wrapper.
    expect(totalEmbedCalls).toBe(2);
  });

  test('every retry attempt disables the AI SDK\'s own internal retries (maxRetries: 0)', async () => {
    // Guards against the "double-retrying" failure mode a reviewer would
    // flag: if the wrapper's outer retry loop did NOT pass maxRetries:0,
    // each of ITS attempts would ALSO trigger the SDK's up-to-3-attempt
    // internal stack, multiplying retries (5 wrapper attempts x 3 SDK
    // attempts = 15, per the D4a doc comment in commands/embed.ts).
    embedBatchBehavior = async (texts) => {
      if (totalEmbedCalls === 1) throw makeTimeoutError();
      return texts.map(() => new Float32Array(1536));
    };
    const engine = mockEngine();
    await importFromContent(engine, 'retry-test/maxretries', [
      '---',
      'title: MaxRetries Test',
      '---',
      '',
      'Body text long enough to chunk and embed for this assertion to run.',
    ].join('\n'), {});

    expect(lastEmbedBatchOpts).toBeDefined();
    expect((lastEmbedBatchOpts as { maxRetries?: number }).maxRetries).toBe(0);
  });

  test('a persistently timing-out backend exhausts retries and the error still propagates (Codex C2: no silent drop)', async () => {
    embedBatchBehavior = async () => {
      throw makeTimeoutError();
    };
    const engine = mockEngine();
    const content = [
      '---',
      'title: Exhausted Retries',
      '---',
      '',
      'Body text long enough to chunk and embed for this assertion to run.',
    ].join('\n');

    await expect(importFromContent(engine, 'retry-test/exhausted', content, {})).rejects.toThrow(/timed out/i);
    // MAX_RATE_LIMIT_RETRIES retries + the initial attempt = bounded, not infinite.
    expect(totalEmbedCalls).toBe(MAX_RATE_LIMIT_RETRIES + 1);
  });
});

describe('importCodeFile (code path) — embed retry routing', () => {
  test('a first-attempt timeout is retried and the file imports with embeddings intact', async () => {
    embedBatchBehavior = async (texts) => {
      if (totalEmbedCalls === 1) throw makeTimeoutError();
      return texts.map(() => new Float32Array(1536));
    };
    const engine = mockEngine();
    const src = [
      'export function retryTarget(a: number, b: number): number {',
      '  // A body with enough substance to produce a real chunk.',
      '  let total = 0;',
      '  for (let i = 0; i < a; i++) { total += b; }',
      '  return total;',
      '}',
    ].join('\n');

    const result = await importCodeFile(engine, 'src/retry-target.ts', src, {});

    expect(result.status).toBe('imported');
    expect(totalEmbedCalls).toBe(2);
  });

  test('a persistently timing-out backend exhausts retries; importCodeFile keeps its existing swallow-and-warn contract', async () => {
    // importCodeFile wraps its embed call in a try/catch that warns and
    // continues (unlike importFromContent, which propagates) — that
    // existing design choice is untouched by this fix. We only assert the
    // retry count is bounded, not that the behavior on exhaustion changed.
    embedBatchBehavior = async () => {
      throw makeTimeoutError();
    };
    const engine = mockEngine();
    const src = [
      'export function neverEmbeds(x: number): number {',
      '  return x * 2;',
      '}',
    ].join('\n');

    const result = await importCodeFile(engine, 'src/never-embeds.ts', src, {});

    expect(result.status).toBe('imported'); // swallow-and-warn: import still succeeds
    expect(totalEmbedCalls).toBe(MAX_RATE_LIMIT_RETRIES + 1);
  });
});

// ────────────────────────────────────────────────────────────────
// Gap 2: embedBatchWithBackoff's retry predicate now covers
// timeout-classified errors, with a distinct (short) backoff from the
// rate-limit path's parsed Retry-After / 60s fallback.
// ────────────────────────────────────────────────────────────────

describe('classifyEmbedRetryError / detectTimeoutFromCause (#3374 predicate widening)', () => {
  test('a TimeoutError on the cause chain classifies as "timeout"', () => {
    expect(detectTimeoutFromCause(makeTimeoutError())).toBe(true);
    expect(classifyEmbedRetryError(makeTimeoutError())).toBe('timeout');
  });

  test('a bare (unwrapped) TimeoutError-named error also classifies as "timeout" (no .cause needed)', () => {
    const e = Object.assign(new Error('The operation timed out.'), { name: 'TimeoutError' });
    // No .cause here — detectTimeoutFromCause checks the object itself at
    // depth 0 before walking into .cause, so this needs no nesting.
    expect(detectTimeoutFromCause(e)).toBe(true);
    expect(classifyEmbedRetryError(e)).toBe('timeout');
  });

  test('a wrapper that strips .cause.name still classifies via the message fallback', () => {
    // Mirrors the existing 429/gateway detectors' documented fallback for
    // "providers whose wrappers strip cause.status" — here the wrapper
    // strips cause.name instead, leaving only the message text.
    const e = new Error('[embed(local:custom-model)] The operation timed out.');
    (e as { cause?: unknown }).cause = { message: 'The operation timed out.' }; // no .name
    expect(detectTimeoutFromCause(e)).toBe(false);
    expect(classifyEmbedRetryError(e)).toBe('timeout');
  });

  test('429 / gateway-overload errors keep their prior classification (unaffected by the timeout addition)', () => {
    const rateLimited = new Error('Rate limit reached. Please try again in 10ms.');
    (rateLimited as { cause?: unknown }).cause = { status: 429 };
    expect(classifyEmbedRetryError(rateLimited)).toBe('rate_limit');

    const gateway = new Error('Bad Gateway');
    (gateway as { cause?: unknown }).cause = { status: 502 };
    expect(classifyEmbedRetryError(gateway)).toBe('gateway');
  });

  test('an unrelated permanent error still classifies as null (non-retriable, unchanged)', () => {
    expect(classifyEmbedRetryError(new Error('Invalid request: unsupported model'))).toBeNull();
    expect(detectTimeoutFromCause(new Error('Invalid request: unsupported model'))).toBe(false);
  });

  test('a deep cause-chain wrap still resolves (defensive depth walk, same bound as detect429FromCause)', () => {
    const deep = { cause: { cause: { name: 'TimeoutError' } } };
    expect(detectTimeoutFromCause(deep)).toBe(true);
  });
});

describe('embedBatchWithBackoff — timeout retries use a short bounded backoff, not the 60s rate-limit fallback', () => {
  test('a single timeout retry resolves well under the 60s rate-limit fallback window', async () => {
    let calls = 0;
    embedBatchBehavior = async () => {
      calls++;
      if (calls === 1) throw makeTimeoutError();
      return [new Float32Array(1536)];
    };
    const t0 = Date.now();
    const result = await embedBatchWithBackoff(['x']);
    const elapsed = Date.now() - t0;

    expect(calls).toBe(2);
    expect(result).toHaveLength(1);
    // parseRetryDelayMs's unparseable-message fallback is 60s; timeoutRetryDelayMs
    // is a few hundred ms. A generous 5s ceiling proves we took the short path.
    expect(elapsed).toBeLessThan(5000);
  });

  test('a wall-clock abort during a timeout retry sleep wakes up early (same abort contract as the rate-limit path)', async () => {
    const controller = new AbortController();
    let calls = 0;
    embedBatchBehavior = async (_texts, opts) => {
      calls++;
      expect((opts as { abortSignal?: AbortSignal } | undefined)?.abortSignal).toBe(controller.signal);
      if (calls === 1) throw makeTimeoutError();
      return [new Float32Array(1536)];
    };
    setTimeout(() => controller.abort(), 10);
    await expect(embedBatchWithBackoff(['x'], { abortSignal: controller.signal })).rejects.toThrow();
  });
});
