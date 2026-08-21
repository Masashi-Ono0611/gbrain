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
import { findCodeDef } from '../src/commands/code-def.ts';

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

const SAMPLE = `export const alpha = 1;

export function beta(): number {
  return alpha + 1;
}

export class Gamma {
  value = beta();
}
`;

// Every declaration is below the chunker's small-sibling threshold. The
// resulting merged chunks deliberately have symbol_name = NULL.
const SYMBOLLESS_SAMPLE = `export const A = 1;
export const B = 2;
export const C = 3;
export const D = 4;
export const E = 5;
export const F = 6;
export const G = 7;
export const H = 8;
export const I = 9;
export const J = 10;
`;

describe('issue #3640 — code-def empty-result states stay distinguishable', () => {
  test('never indexed: count 0, not_built, actionable message', async () => {
    const results = await findCodeDef(engine, 'MissingWidget');
    const readiness = await resolveCodeReadiness(engine, { kind: 'symbol', count: results.length });

    expect(results).toHaveLength(0);
    expect(readiness.status).toBe('not_built');
    expect(readiness.ready).toBe(false);
    expect(readinessHint(readiness)).toContain('sync');
  });

  test('code indexed but chunker produced zero symbols: count 0, no_symbols, explanatory message', async () => {
    await importCodeFile(engine, 'src/tiny.ts', SYMBOLLESS_SAMPLE, { noEmbed: true });
    const named = await engine.executeRaw<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM content_chunks WHERE symbol_name IS NOT NULL`,
    );
    const results = await findCodeDef(engine, 'MissingWidget');
    const readiness = await resolveCodeReadiness(engine, { kind: 'symbol', count: results.length });
    const edgeReadiness = await resolveCodeReadiness(engine, { kind: 'edge', count: 0 });

    expect(named[0]?.count).toBe(0);
    expect(results).toHaveLength(0);
    expect(readiness.status).toBe('no_symbols');
    expect(readiness.ready).toBe(false);
    expect(edgeReadiness.status).toBe('no_symbols');
    expect(edgeReadiness.ready).toBe(false);
    expect(readinessHint(readiness)).toContain('no named symbols');
  });

  test('symbol index populated but name is absent: count 0, ready, no warning message', async () => {
    await importCodeFile(engine, 'src/sample.ts', SAMPLE, { noEmbed: true });
    const named = await engine.executeRaw<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM content_chunks WHERE symbol_name IS NOT NULL`,
    );
    const results = await findCodeDef(engine, 'MissingWidget');
    const readiness = await resolveCodeReadiness(engine, { kind: 'symbol', count: results.length });

    expect(named[0]?.count).toBeGreaterThan(0);
    expect(results).toHaveLength(0);
    expect(readiness.status).toBe('ready');
    expect(readiness.ready).toBe(true);
    expect(readinessHint(readiness)).toBeNull();
  });
});

describe('resolveCodeReadiness — empty brain', () => {
  test('symbol grain → not_built when no code exists', async () => {
    const r = await resolveCodeReadiness(engine, { kind: 'symbol', count: 0 });
    expect(r.status).toBe('not_built');
    expect(r.ready).toBe(false);
    expect(r.has_code).toBe(false);
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

  test('scoped to a source with no code → not_built', async () => {
    const r = await resolveCodeReadiness(engine, { kind: 'symbol', count: 0, sourceId: 'no-such-source' });
    expect(r.status).toBe('not_built');
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
  test('not_built / no_symbols / indexing / unknown produce a hint; ready does not', () => {
    expect(readinessHint({ status: 'not_built', ready: false, has_code: false, pending_edges: false })).toContain('not built');
    expect(readinessHint({ status: 'no_symbols', ready: false, has_code: true, pending_edges: false })).toContain('no named symbols');
    expect(readinessHint({ status: 'indexing', ready: false, has_code: true, pending_edges: true })).toContain('still building');
    expect(readinessHint({ status: 'unknown', ready: false, has_code: false, pending_edges: false })).toContain('unavailable');
    expect(readinessHint({ status: 'ready', ready: true, has_code: true, pending_edges: false })).toBeNull();
  });
});
