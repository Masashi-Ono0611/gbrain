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
 *      it — it passes `undefined` through so the resolved search mode's
 *      `searchLimit` (e.g. 25 for balanced) applies. An explicit numeric
 *      `limit` (including `0`) still wins.
 *
 * Serial: mock.module (isolation guard R2).
 */

import { describe, expect, mock, test } from 'bun:test';
import * as realHybrid from '../src/core/search/hybrid.ts';
import type { BrainEngine } from '../src/core/engine.ts';

let nextResults: unknown[] = [];
let nextRelationalMeta: unknown = null;
let capturedOpts: { limit?: number } | null = null;

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
    opts.onMeta?.({ vector_enabled: true, expansion_applied: false, detail_resolved: null });
    if (nextRelationalMeta) opts.onRelationalMeta?.(nextRelationalMeta);
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
    nextResults = [{ page_id: 1, slug: 'companies/acme-example', chunk_text: 'x' }];
    nextRelationalMeta = RELATIONAL_META;
    const out = await callQuery({});
    expect(out.isError ?? false).toBe(false);
    const retrieval = (out._meta as Record<string, any>).retrieval;
    expect(retrieval.relational).toEqual(RELATIONAL_META);
  });

  test('relational arm never reports in → _meta.retrieval.relational absent', async () => {
    nextResults = [{ page_id: 1, slug: 'companies/acme-example', chunk_text: 'x' }];
    nextRelationalMeta = null;
    const out = await callQuery({});
    const retrieval = (out._meta as Record<string, any>).retrieval;
    expect(retrieval.relational).toBeUndefined();
  });

  test('relational arm ran but did not fire → still surfaced (fired: false is not the same as absent)', async () => {
    nextResults = [];
    nextRelationalMeta = { ...RELATIONAL_META, fired: false, candidates: 0 };
    const out = await callQuery({});
    const retrieval = (out._meta as Record<string, any>).retrieval;
    expect(retrieval.relational).toEqual({ ...RELATIONAL_META, fired: false, candidates: 0 });
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

  test('caller passes `limit: 0` → 0 is respected, not coerced back to a default', async () => {
    nextResults = [];
    nextRelationalMeta = null;
    capturedOpts = null;
    await callQuery({ limit: 0 });
    expect(capturedOpts!.limit).toBe(0);
  });
});
