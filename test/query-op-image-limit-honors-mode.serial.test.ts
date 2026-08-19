/**
 * #4356 — the `query` op's image-similarity branch (`image` param) bypasses
 * hybridSearch entirely (it calls `engine.searchVector` directly), so it
 * never saw the resolved search mode's `searchLimit` and always hard-
 * defaulted `limit` to 20 regardless of mode. This pins that the branch now
 * resolves the same mode + per-key overrides hybridSearch uses
 * (mode.ts:resolveSearchMode) and forwards that mode's `searchLimit` to
 * `searchVector` when the caller omits `limit` — mirroring the
 * `opts?.limit || resolvedMode.searchLimit` convention already used
 * elsewhere, instead of the flat `|| 20`.
 *
 * Drives the REAL dispatch path (dispatchToolCall → query op handler) with
 * `embedMultimodal` (ai/gateway.ts) and `engine.searchVector` stubbed, same
 * pattern as test/query-op-relational-meta-and-limit.serial.test.ts.
 *
 * Serial: mock.module (isolation guard R2).
 */

import { describe, expect, mock, test } from 'bun:test';
import * as realGateway from '../src/core/ai/gateway.ts';
import type { BrainEngine } from '../src/core/engine.ts';

let capturedSearchVectorOpts: { limit?: number } | null = null;

// Mock BEFORE importing dispatch (operations.ts binds embedMultimodal at
// call time via dynamic import, but mock.module still needs to be
// registered before the module graph resolves it).
mock.module('../src/core/ai/gateway.ts', () => ({
  ...realGateway,
  embedMultimodal: async () => [new Float32Array(8).fill(0.1)],
}));

const { dispatchToolCall } = await import('../src/mcp/dispatch.ts');

function makeEngineStub(configOverrides: Record<string, string> = {}): BrainEngine {
  return {
    getConfig: async (key: string) => configOverrides[key] ?? null,
    executeRaw: async () => [],
    searchVector: async (_vec: Float32Array, opts: { limit?: number }) => {
      capturedSearchVectorOpts = opts;
      return [];
    },
  } as unknown as BrainEngine;
}

function callImageQuery(params: Record<string, unknown>, ctxOverrides: Record<string, unknown> = {}) {
  return dispatchToolCall(
    makeEngineStub(),
    'query',
    { image: Buffer.from('fake-image-bytes').toString('base64'), image_mime: 'image/png', ...params },
    { remote: false, transport: 'stdio', sourceId: 'default', ...ctxOverrides },
  );
}

describe('query op — image-similarity limit honors the resolved mode (#4356)', () => {
  test('limit omitted, default mode (balanced) → searchVector receives searchLimit 25, not the old flat 20', async () => {
    capturedSearchVectorOpts = null;
    const out = await callImageQuery({});
    expect(out.isError ?? false).toBe(false);
    expect(capturedSearchVectorOpts).not.toBeNull();
    expect(capturedSearchVectorOpts!.limit).toBe(25);
  });

  test('limit omitted, mode: conservative (local caller) → searchVector receives searchLimit 10', async () => {
    capturedSearchVectorOpts = null;
    const out = await callImageQuery({ mode: 'conservative' });
    expect(out.isError ?? false).toBe(false);
    expect(capturedSearchVectorOpts!.limit).toBe(10);
  });

  test('explicit numeric limit still wins over the mode default', async () => {
    capturedSearchVectorOpts = null;
    const out = await callImageQuery({ limit: 3, mode: 'tokenmax' });
    expect(out.isError ?? false).toBe(false);
    expect(capturedSearchVectorOpts!.limit).toBe(3);
  });

  test('remote caller: per-call mode is ignored (D5), falls through to server-configured mode default (balanced)', async () => {
    capturedSearchVectorOpts = null;
    const out = await callImageQuery({ mode: 'conservative' }, { remote: true });
    expect(out.isError ?? false).toBe(false);
    // Remote callers can't select a per-call mode — server config (unset
    // here) falls through to DEFAULT_SEARCH_MODE (balanced, searchLimit 25),
    // not the requested conservative (10).
    expect(capturedSearchVectorOpts!.limit).toBe(25);
  });
});
