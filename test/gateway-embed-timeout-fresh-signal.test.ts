/**
 * #3374 — regression guard for the architectural property the fix depends
 * on: each `embed()` call builds its OWN abort signal via
 * `withDefaultTimeout()` inside `embedSubBatch` (src/core/ai/gateway.ts),
 * not a shared/memoized one.
 *
 * gateway.ts itself is UNCHANGED by this fix — this file doesn't test new
 * behavior, it pins the pre-existing behavior that makes the fix safe. The
 * issue's "There is no per-attempt vs. overall-deadline tradeoff here"
 * section argues that a fresh per-attempt signal already exists for
 * `gbrain embed` / `embed --stale` (which route through
 * `embedBatchWithBackoff`); nothing in the test suite pinned that claim
 * before this fix, so a future gateway change could silently make attempt
 * 2's signal reuse or inherit attempt 1's — which would quietly turn
 * `embedBatchWithBackoff`'s retries back into the shared-budget bug this
 * issue reports, without any test catching it.
 *
 * Uses the existing `__setEmbedTransportForTests` seam (same pattern as
 * test/gateway-embed-model-override.test.ts) rather than mock.module, so
 * this file does NOT need the *.serial.test.ts quarantine.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  configureGateway,
  embed,
  resetGateway,
  __setEmbedTransportForTests,
} from '../src/core/ai/gateway.ts';

const seenSignals: (AbortSignal | undefined)[] = [];

beforeEach(() => {
  seenSignals.length = 0;
  resetGateway();
  configureGateway({
    embedding_model: 'openai:text-embedding-3-small',
    embedding_dimensions: 1536,
    env: { OPENAI_API_KEY: 'sk-test' },
  });
  __setEmbedTransportForTests(async ({ values, abortSignal }: any) => {
    seenSignals.push(abortSignal);
    return {
      embeddings: values.map(() => new Array(1536).fill(0)),
      usage: { tokens: 0 },
    } as any;
  });
});

afterEach(() => {
  __setEmbedTransportForTests(null);
  resetGateway();
});

describe('gateway embed() — per-attempt timeout signal freshness (#3374)', () => {
  test('two sequential embed() calls each receive a DISTINCT AbortSignal instance', async () => {
    // This is what embedBatchWithBackoff's retry loop actually does: each
    // retry attempt is a separate embedBatch(...) call, which re-enters
    // embed() -> embedSubBatch() -> a fresh withDefaultTimeout() here.
    await embed(['first attempt text']);
    await embed(['second attempt text']);

    expect(seenSignals).toHaveLength(2);
    expect(seenSignals[0]).toBeInstanceOf(AbortSignal);
    expect(seenSignals[1]).toBeInstanceOf(AbortSignal);
    // A shared/reused signal object here would BE the shared-budget bug
    // #3374 reports (all attempts bounded by one outer deadline).
    expect(seenSignals[0]).not.toBe(seenSignals[1]);
  });

  test('neither call\'s signal starts pre-aborted — each attempt gets a live budget', async () => {
    await embed(['a']);
    await embed(['b']);

    for (const s of seenSignals) {
      expect(s?.aborted).toBe(false);
    }
  });

  test('attempt 2 is unaffected by attempt 1 having already failed/aborted', async () => {
    // Simulate the retry-driven shape: attempt 1's transport call fails
    // (its signal is irrelevant to what attempt 2 gets, since attempt 2
    // is a wholly separate embed() call — this is precisely what makes
    // embedBatchWithBackoff's retries "fresh budget" rather than
    // "shared budget").
    let call = 0;
    __setEmbedTransportForTests(async ({ values, abortSignal }: any) => {
      call++;
      seenSignals.push(abortSignal);
      if (call === 1) {
        throw Object.assign(new Error('The operation timed out.'), { name: 'TimeoutError' });
      }
      return { embeddings: values.map(() => new Array(1536).fill(0)), usage: { tokens: 0 } } as any;
    });

    await expect(embed(['x'])).rejects.toThrow(/timed out/i);
    const v = await embed(['x']);

    expect(v).toHaveLength(1);
    expect(seenSignals).toHaveLength(2);
    expect(seenSignals[0]).not.toBe(seenSignals[1]);
    expect(seenSignals[1]?.aborted).toBe(false);
  });
});
