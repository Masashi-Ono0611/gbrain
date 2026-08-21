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
 *   - #3640/#3970: code chunks exist but none carry symbol_name (chunker
 *     merged small siblings, or metadata was wiped by a prior bug) → symbol
 *     grain no_symbols, NOT a false ready; edge grain is unaffected (it
 *     never reads symbol_name)
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

// Bodies are deliberately padded so each function's own token count clears
// the chunker's merge-small-siblings threshold (15% of the 300-token
// default chunk target — src/core/chunkers/code.ts:mergeSmallSiblings) and
// each survives as its own independent, symbol-bearing chunk. A terser
// alpha/beta pair (the original form of this fixture) turned out to fall
// BELOW that threshold and got silently folded into one anonymous
// `symbol_type: 'merged', symbol_name: NULL` chunk — the exact #3640/#3970
// shape this file's "no_symbols" describe block covers below — which
// defeated the "ready (symbol metadata exists)" fixtures this SAMPLE feeds.
const SAMPLE = `export function alpha(x: number): number {
  let total = 0;
  for (let i = 0; i < x; i++) {
    total += beta(i);
    total += i * 2;
    total -= 1;
  }
  if (total < 0) {
    total = 0;
  }
  return total + beta(x) + 1;
}

export function beta(y: number): number {
  let acc = y;
  for (let i = 0; i < y; i++) {
    acc += i;
    acc -= 1;
    acc *= 1;
  }
  if (acc < 0) {
    acc = 0;
  }
  return acc * 2;
}
`;

// Several tiny top-level declarations, each well under the chunker's merge
// threshold (15% of the 300-token default chunk target = 45 tokens) and
// together under the 300-token group budget. `mergeSmallSiblings`
// (src/core/chunkers/code.ts) collapses these into ONE chunk with
// `symbol_type: 'merged'` and `symbol_name: NULL` — the exact shape #3640
// and #3970 report as indistinguishable from "no such symbol" once probed
// via `symbol_name = $1`. A single `makeThing` declaration alone would NOT
// reproduce this (one chunk never enters the merge path), which is why the
// fixture needs multiple small siblings.
const TINY_MERGED_SAMPLE = `export const A = 1;
export const B = 2;
export const C = 3;
export function makeThing() { return 1; }
`;

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

  test('sanity: the fixture survives unmerged (each chunk carries symbol_name)', async () => {
    const rows = await engine.executeRaw<{ symbol_name: string | null }>(
      `SELECT cc.symbol_name FROM content_chunks cc
         JOIN pages p ON p.id = cc.page_id WHERE p.page_kind = 'code'`,
      [],
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.symbol_name).not.toBeNull();
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

describe('resolveCodeReadiness — code synced, chunker merged away symbol metadata (#3640/#3970)', () => {
  beforeEach(async () => {
    await importCodeFile(engine, 'src/tiny.ts', TINY_MERGED_SAMPLE, { noEmbed: true });
  });

  test('sanity: the fixture actually merges (symbol_name NULL, symbol_type merged)', async () => {
    const rows = await engine.executeRaw<{ symbol_name: string | null; symbol_type: string | null }>(
      `SELECT cc.symbol_name, cc.symbol_type FROM content_chunks cc
         JOIN pages p ON p.id = cc.page_id WHERE p.page_kind = 'code'`,
      [],
    );
    expect(rows.length).toBe(1);
    expect(rows[0]!.symbol_name).toBeNull();
    expect(rows[0]!.symbol_type).toBe('merged');
  });

  test('symbol grain → no_symbols, NOT ready — a genuinely-defined symbol (makeThing) that got merged away', async () => {
    // findCodeDef/findCodeRefs filter on cc.symbol_name = $1, so a merged
    // chunk never matches even though `makeThing` is right there in the text.
    const r = await resolveCodeReadiness(engine, { kind: 'symbol', count: 0 });
    expect(r.status).toBe('no_symbols');
    expect(r.ready).toBe(false);
    expect(r.has_code).toBe(true);
  });

  test('symbol grain → the SAME no_symbols shape for a symbol that never existed at all', async () => {
    // This is the core of #3640: the readiness signal (not the result set)
    // must tell an agent this brain's symbol index can't be trusted for
    // count:0 — it does not, and structurally cannot, tell "makeThing was
    // merged away" apart from "makeWidget never existed" from readiness
    // alone (both come back count:0 from the actual symbol_name lookup).
    // What must NOT happen is what happened before this fix: this same
    // shape reporting `status: 'ready'` as if the index were trustworthy.
    const r = await resolveCodeReadiness(engine, { kind: 'symbol', count: 0 });
    expect(r.status).toBe('no_symbols');
    expect(r.status).not.toBe('ready');
  });

  test('edge grain is unaffected — it never reads symbol_name, only edges_backfilled_at', async () => {
    const r = await resolveCodeReadiness(engine, { kind: 'edge', count: 0 });
    expect(r.status).toBe('indexing'); // edges_backfilled_at is NULL, same as the SAMPLE fixture
    expect(r.pending_edges).toBe(true);
  });

  test('source scoping: no_symbols on the source that holds the merged chunk', async () => {
    const r = await resolveCodeReadiness(engine, { kind: 'symbol', count: 0, sourceId: 'default' });
    expect(r.status).toBe('no_symbols');
  });

  test('source scoping: not_built on an unrelated source (no code at all)', async () => {
    const r = await resolveCodeReadiness(engine, { kind: 'symbol', count: 0, sourceId: 'no-such-source' });
    expect(r.status).toBe('not_built');
  });

  test('count > 0 still short-circuits to ready even with a symbol-less chunk present', async () => {
    // A different, non-merged symbol_name match elsewhere would still be
    // found by the real result query; readiness must not second-guess it.
    const r = await resolveCodeReadiness(engine, { kind: 'symbol', count: 1 });
    expect(r.status).toBe('ready');
    expect(r.ready).toBe(true);
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
  test('not_built / indexing / no_symbols / unknown produce a hint; ready does not', () => {
    expect(readinessHint({ status: 'not_built', ready: false, has_code: false, pending_edges: false })).toContain('not built');
    expect(readinessHint({ status: 'indexing', ready: false, has_code: true, pending_edges: true })).toContain('still building');
    expect(readinessHint({ status: 'no_symbols', ready: false, has_code: true, pending_edges: false })).toContain('symbol metadata');
    expect(readinessHint({ status: 'unknown', ready: false, has_code: false, pending_edges: false })).toContain('unavailable');
    expect(readinessHint({ status: 'ready', ready: true, has_code: true, pending_edges: false })).toBeNull();
  });
});
