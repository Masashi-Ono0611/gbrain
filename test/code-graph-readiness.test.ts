/**
 * #1780 Gap 1 — code-graph readiness signal.
 *
 * Verifies the typed readiness contract that lets code-* callers tell
 * "graph not built / still indexing" apart from "genuinely no match" when
 * count === 0:
 *   - empty brain → not_built (both grains)
 *   - code synced, edges not resolved → symbol grain ready, edge grain indexing
 *   - edges resolved → edge grain ready
 *   - count > 0 → ready short-circuit (no query)
 *   - source scoping (scoped miss → not_built; allSources → brain-wide)
 *   - DB error → unknown, fail-open (CRITICAL regression)
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { importCodeFile } from '../src/core/import-file.ts';
import { resolveCodeReadiness, readinessHint } from '../src/core/code-graph-readiness.ts';

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
  // Clean slate per test: remove all chunks + pages so empty-brain cases hold.
  await engine.executeRaw('DELETE FROM content_chunks');
  await engine.executeRaw('DELETE FROM pages');
});

const SAMPLE = `export function alpha(x: number): number {
  return beta(x) + 1;
}

export function beta(y: number): number {
  return y * 2;
}
`;

describe('resolveCodeReadiness — empty brain', () => {
  test('symbol grain → not_built when no code exists', async () => {
    const r = await resolveCodeReadiness(engine, { kind: 'symbol', count: 0 });
    expect(r.status).toBe('not_built');
    expect(r.ready).toBe(false);
    expect(r.has_code).toBe(false);
    // #3707: unscoped caller has no narrower scope to be "out of" — the
    // brain-wide probe must not even run, let alone flip this on.
    expect(r.out_of_scope).toBeUndefined();
  });

  test('edge grain → not_built when no code exists', async () => {
    const r = await resolveCodeReadiness(engine, { kind: 'edge', count: 0 });
    expect(r.status).toBe('not_built');
    expect(r.ready).toBe(false);
  });
});

describe('resolveCodeReadiness — code synced, edges unresolved', () => {
  beforeEach(async () => {
    // importCodeFile writes code chunks with edges_backfilled_at = NULL
    // (resolve phase hasn't run), exactly the "graph still building" state.
    await importCodeFile(engine, 'src/sample.ts', SAMPLE, { noEmbed: true });
  });

  test('symbol grain → ready (symbol metadata is at chunk time)', async () => {
    const r = await resolveCodeReadiness(engine, { kind: 'symbol', count: 0 });
    expect(r.status).toBe('ready');
    expect(r.ready).toBe(true);
    expect(r.has_code).toBe(true);
  });

  test('edge grain → indexing (edges pending resolution)', async () => {
    const r = await resolveCodeReadiness(engine, { kind: 'edge', count: 0 });
    expect(r.status).toBe('indexing');
    expect(r.ready).toBe(false);
    expect(r.pending_edges).toBe(true);
  });

  test('edge grain → ready once edges_backfilled_at is stamped fresh', async () => {
    // Mirror what the resolve_symbol_edges phase does: stamp every code chunk.
    await engine.executeRaw('UPDATE content_chunks SET edges_backfilled_at = NOW()');
    const r = await resolveCodeReadiness(engine, { kind: 'edge', count: 0 });
    expect(r.status).toBe('ready');
    expect(r.ready).toBe(true);
    expect(r.pending_edges).toBe(false);
  });

  test('count > 0 short-circuits to ready with no probe', async () => {
    // Even with pending edges, a non-empty result is trivially ready.
    const r = await resolveCodeReadiness(engine, { kind: 'edge', count: 3 });
    expect(r.status).toBe('ready');
    expect(r.ready).toBe(true);
  });
});

describe('resolveCodeReadiness — source scoping', () => {
  beforeEach(async () => {
    await importCodeFile(engine, 'src/sample.ts', SAMPLE, { noEmbed: true });
  });

  test('scoped to a source with no code → not_built, and out_of_scope since code exists brain-wide (#3707)', async () => {
    const r = await resolveCodeReadiness(engine, { kind: 'symbol', count: 0, sourceId: 'no-such-source' });
    expect(r.status).toBe('not_built');
    expect(r.out_of_scope).toBe(true);
  });

  test('scoped to the default source (where code lives) → ready (symbol)', async () => {
    const r = await resolveCodeReadiness(engine, { kind: 'symbol', count: 0, sourceId: 'default' });
    expect(r.status).toBe('ready');
  });

  test('allSources ignores a non-matching sourceId and goes brain-wide', async () => {
    const r = await resolveCodeReadiness(engine, {
      kind: 'symbol', count: 0, sourceId: 'no-such-source', allSources: true,
    });
    expect(r.status).toBe('ready');
  });
});

describe('resolveCodeReadiness — out_of_scope (#3707)', () => {
  test('scoped miss with NO code anywhere in the brain → not_built, out_of_scope stays unset', async () => {
    // No importCodeFile call here — the brain is genuinely empty, not just
    // out of this scope's reach. The brain-wide probe must correctly report
    // "no" and out_of_scope must NOT be true.
    const r = await resolveCodeReadiness(engine, { kind: 'symbol', count: 0, sourceId: 'no-such-source' });
    expect(r.status).toBe('not_built');
    expect(r.out_of_scope).toBeUndefined();
  });

  test('edge grain scoped miss is also flagged out_of_scope when code exists elsewhere', async () => {
    await importCodeFile(engine, 'src/sample.ts', SAMPLE, { noEmbed: true });
    const r = await resolveCodeReadiness(engine, { kind: 'edge', count: 0, sourceId: 'no-such-source' });
    expect(r.status).toBe('not_built');
    expect(r.out_of_scope).toBe(true);
  });

  test('allSources bypasses the narrowing entirely — no out_of_scope even with a non-matching sourceId', async () => {
    await importCodeFile(engine, 'src/sample.ts', SAMPLE, { noEmbed: true });
    const r = await resolveCodeReadiness(engine, {
      kind: 'symbol', count: 0, sourceId: 'no-such-source', allSources: true,
    });
    // allSources resolves to brain-wide, which DOES have code → ready, not not_built.
    expect(r.status).toBe('ready');
    expect(r.out_of_scope).toBeUndefined();
  });

  test('unscoped call makes exactly ONE probe query — the brain-wide out_of_scope probe never fires without a narrower scope', async () => {
    // No code seeded at all: an unscoped miss has no narrower scope to be
    // "out of", so the second probe must not even run (documented cost
    // policy: probes run ONLY on the already-empty path, and this second
    // one only when there WAS a scope to compare against).
    let calls = 0;
    const counting = {
      ...engine,
      executeRaw: (...args: Parameters<typeof engine.executeRaw>) => {
        calls++;
        return engine.executeRaw(...args);
      },
    } as unknown as BrainEngine;
    const r = await resolveCodeReadiness(counting, { kind: 'symbol', count: 0 });
    expect(r.status).toBe('not_built');
    expect(calls).toBe(1);
  });

  test('scoped probe succeeds (finds nothing) but the brain-wide probe throws → still fails open to unknown, never throws', async () => {
    await importCodeFile(engine, 'src/sample.ts', SAMPLE, { noEmbed: true });
    let calls = 0;
    const flaky = {
      ...engine,
      executeRaw: (...args: Parameters<typeof engine.executeRaw>) => {
        calls++;
        // 1st call = the scoped probe (real, finds nothing for the
        // non-matching sourceId). 2nd call = the new brain-wide probe —
        // synthetically fails to prove the whole out_of_scope check stays
        // inside the module's existing fail-open try/catch.
        if (calls === 2) throw new Error('synthetic brain-wide probe outage');
        return engine.executeRaw(...args);
      },
    } as unknown as BrainEngine;
    const r = await resolveCodeReadiness(flaky, { kind: 'symbol', count: 0, sourceId: 'no-such-source' });
    expect(calls).toBe(2);
    expect(r.status).toBe('unknown');
    expect(r.ready).toBe(false);
  });
});

describe('resolveCodeReadiness — fail-open (CRITICAL regression)', () => {
  test('DB error → status unknown, ready false, never throws', async () => {
    const broken = {
      kind: 'pglite',
      executeRaw: async () => { throw new Error('boom'); },
    } as unknown as BrainEngine;
    const r = await resolveCodeReadiness(broken, { kind: 'edge', count: 0 });
    expect(r.status).toBe('unknown');
    expect(r.ready).toBe(false);
  });
});

describe('readinessHint', () => {
  test('not_built / indexing / unknown produce a hint; ready does not', () => {
    expect(readinessHint({ status: 'not_built', ready: false, has_code: false, pending_edges: false })).toContain('not built');
    expect(readinessHint({ status: 'indexing', ready: false, has_code: true, pending_edges: true })).toContain('still building');
    expect(readinessHint({ status: 'unknown', ready: false, has_code: false, pending_edges: false })).toContain('unavailable');
    expect(readinessHint({ status: 'ready', ready: true, has_code: true, pending_edges: false })).toBeNull();
  });

  test('#3707: not_built + out_of_scope produces a grant-widening hint, not the sync hint', () => {
    const hint = readinessHint({
      status: 'not_built', ready: false, has_code: false, pending_edges: false, out_of_scope: true,
    });
    expect(hint).not.toBeNull();
    expect(hint).not.toContain('gbrain sync');
    expect(hint).toContain('grant');
  });
});
