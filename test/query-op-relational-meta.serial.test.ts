/**
 * #3995 (local-only patch, not submitted upstream — see patch 84 rationale
 * in the patch-stack commit message) — `onRelationalMeta` is wired through
 * to `_meta.retrieval.relational` when the relational recall arm reports in
 * (and absent when it doesn't) — previously the callback existed on
 * HybridSearchOpts but the `query` op never passed one, so callers had no
 * caller-visible signal that the arm fired.
 *
 * Also covers: the semantic-cache-hit contract from hybrid.ts (the cache-hit
 * branch calls `onMeta` but never `onRelationalMeta`) — `_meta.retrieval`
 * must reflect that even when the cached row set was originally produced by
 * a relational-recall miss.
 *
 * Serial: mock.module (isolation guard R2).
 */

import { describe, expect, mock, test } from 'bun:test';
import * as realHybrid from '../src/core/search/hybrid.ts';
import type { BrainEngine } from '../src/core/engine.ts';

let nextResults: unknown[] = [];
let nextRelationalMeta: unknown = null;
// #3995 — mirrors hybrid.ts's real cache-hit branch: it calls `onMeta` (with
// `cache: 'hit'`) but returns WITHOUT ever calling `onRelationalMeta`, even
// if the cached rows were originally produced by a relational-recall arm
// that fired. Set true to simulate that contract regardless of
// `nextRelationalMeta`.
let simulateCacheHit = false;

// Mock BEFORE importing dispatch (operations.ts binds hybridSearchCached at
// import time; the spread keeps every other export live).
mock.module('../src/core/search/hybrid.ts', () => ({
  ...realHybrid,
  hybridSearchCached: async (
    _engine: unknown,
    _query: string,
    opts: { limit?: number; onMeta?: (m: unknown) => void; onRelationalMeta?: (m: unknown) => void },
  ) => {
    opts.onMeta?.({
      vector_enabled: true,
      expansion_applied: false,
      detail_resolved: null,
      ...(simulateCacheHit ? { cache: { status: 'hit' as const } } : {}),
    });
    // Real hybrid.ts cache-hit branch (hybrid.ts:2206) never calls
    // onRelationalMeta — it returns before reaching the relational-arm
    // build. `nextRelationalMeta` is ignored on a simulated hit so this
    // mock can't accidentally paper over that gap.
    if (nextRelationalMeta && !simulateCacheHit) opts.onRelationalMeta?.(nextRelationalMeta);
    return nextResults;
  },
}));

const { dispatchToolCall } = await import('../src/mcp/dispatch.ts');

const engineStub = {
  getConfig: async () => null,
  executeRaw: async () => [],
} as unknown as BrainEngine;

function callQuery(params: Record<string, unknown>) {
  return dispatchToolCall(engineStub, 'query', { query: 'who founded acme-example', ...params }, {
    remote: true,
    transport: 'http',
    sourceId: 'default',
  });
}

const RELATIONAL_META = {
  fired: true,
  kind: 'who' as const,
  seeds_resolved: 1,
  candidates: 1,
  errored: false,
  duration_ms: 4,
};

describe('query op — relational meta wiring (#3995, local-only)', () => {
  test('relational arm fired → _meta.retrieval.relational carries the arm meta verbatim', async () => {
    simulateCacheHit = false;
    nextResults = [{ page_id: 1, slug: 'companies/acme-example', chunk_text: 'x' }];
    nextRelationalMeta = RELATIONAL_META;
    const out = await callQuery({});
    expect(out.isError ?? false).toBe(false);
    const retrieval = (out._meta as Record<string, any>).retrieval;
    expect(retrieval.relational).toEqual(RELATIONAL_META);
  });

  test('relational arm never reports in → _meta.retrieval.relational absent', async () => {
    simulateCacheHit = false;
    nextResults = [{ page_id: 1, slug: 'companies/acme-example', chunk_text: 'x' }];
    nextRelationalMeta = null;
    const out = await callQuery({});
    const retrieval = (out._meta as Record<string, any>).retrieval;
    expect(retrieval.relational).toBeUndefined();
  });

  test('relational arm ran but did not fire → still surfaced (fired: false is not the same as absent)', async () => {
    simulateCacheHit = false;
    nextResults = [];
    nextRelationalMeta = { ...RELATIONAL_META, fired: false, candidates: 0 };
    const out = await callQuery({});
    const retrieval = (out._meta as Record<string, any>).retrieval;
    expect(retrieval.relational).toEqual({ ...RELATIONAL_META, fired: false, candidates: 0 });
  });

  test('semantic-cache hit → _meta.retrieval.relational absent even if the cached set had relational recall', async () => {
    simulateCacheHit = true;
    nextResults = [{ page_id: 1, slug: 'companies/acme-example', chunk_text: 'x' }];
    nextRelationalMeta = RELATIONAL_META; // ignored by the mock while simulateCacheHit is true
    const out = await callQuery({});
    const retrieval = (out._meta as Record<string, any>).retrieval;
    expect(retrieval.cache).toBe('hit');
    expect(retrieval.relational).toBeUndefined();
    simulateCacheHit = false;
  });
});
