/**
 * #3995 mechanical follow-up — two independent behaviors on the `query` op,
 * driven through the REAL dispatch path (dispatchToolCall → query op
 * handler) with hybridSearchCached mocked, same pattern as
 * dispatch-response-meta.serial.test.ts:
 *
 *   1. `onRelationalMeta` is wired through to `_meta.retrieval.relational`
 *      when the relational recall arm reports in (and absent when it
 *      doesn't) — previously the callback existed on HybridSearchOpts but
 *      the `query` op never passed one, so callers had no caller-visible
 *      signal that the arm fired.
 *   2. the op no longer hard-defaults `limit` to 20 when the caller omits
 *      it — it forwards `undefined` to hybridSearchCached instead, so the
 *      resolved search mode's `searchLimit` (e.g. 25 for balanced) applies.
 *      A positive explicit numeric `limit` still wins. NOTE: this file mocks
 *      `hybridSearchCached`, so it only proves the op forwards a numeric
 *      `limit` unmodified — it does not exercise hybridSearch's own
 *      `opts?.limit || resolvedMode.searchLimit` fallback (hybrid.ts), which
 *      is a `||`, not `??`: `limit: 0` forwarded here still falls back to
 *      the mode default downstream in the real (non-mocked) path, same as
 *      omitting `limit`. That inherited behavior is out of scope for this
 *      follow-up (see the "limit: 0" test below for what is and isn't
 *      claimed).
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
let capturedOpts: { limit?: number } | null = null;
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
    capturedOpts = opts;
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

describe('query op — relational meta wiring (#3995)', () => {
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

  // #3995 Codex review (Warning 2): hybrid.ts's cache-hit branch
  // (hybrid.ts:2206) returns without ever calling onRelationalMeta, so a
  // cache hit reports no `relational` field regardless of whether the row
  // set behind it was originally produced with relational recall. This is
  // the current contract (documented in MCP_META_CHANNELS.md), not
  // something this test suite fixes — it pins the gap so a future change to
  // hybrid.ts's caching (making relational meta survive the cache) shows up
  // as an intentional test update rather than a silent behavior change.
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

describe('query op — limit no longer hard-floors to 20 (#3995)', () => {
  test('caller omits `limit` → hybridSearchCached receives limit: undefined (mode bundle decides)', async () => {
    nextResults = [];
    nextRelationalMeta = null;
    capturedOpts = null;
    await callQuery({});
    expect(capturedOpts).not.toBeNull();
    expect(capturedOpts!.limit).toBeUndefined();
  });

  test('caller passes an explicit numeric `limit` → still wins', async () => {
    nextResults = [];
    nextRelationalMeta = null;
    capturedOpts = null;
    await callQuery({ limit: 7 });
    expect(capturedOpts!.limit).toBe(7);
  });

  // NOTE: this only proves the op forwards `0` to hybridSearchCached
  // unmodified — it does NOT prove `0` survives end-to-end. The real (not
  // mocked) hybridSearch does `opts?.limit || resolvedMode.searchLimit`
  // (hybrid.ts), which is falsy-coercing: a forwarded `0` still falls back
  // to the mode default downstream, on both the cache-miss and cache-hit
  // paths. That fallback is inherited from hybridSearch's existing
  // contract; changing it is a separately-scoped `||` → `??` follow-up, not
  // part of this PR.
  test('caller passes `limit: 0` → op forwards 0 unmodified (does not coerce it to undefined)', async () => {
    nextResults = [];
    nextRelationalMeta = null;
    capturedOpts = null;
    await callQuery({ limit: 0 });
    expect(capturedOpts!.limit).toBe(0);
  });
});
