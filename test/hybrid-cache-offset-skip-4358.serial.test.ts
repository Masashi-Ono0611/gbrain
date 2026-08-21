/**
 * #4358 — semantic-cache hit path double-applies `offset`.
 *
 * The miss path (bare `hybridSearch`, in hybrid.ts) stores
 * `returnPool.slice(offset, offset + limit)` — an ALREADY offset-sliced
 * page. The hit path (`hybridSearchCached`) then re-applies
 * `hit.results.slice(offset, offset + limit)` to that already-sliced page,
 * double-applying offset. At offset=0 this is a no-op (slicing from 0
 * twice is harmless); at offset>0 it silently drops rows: for
 * `{ limit: 9, offset: 2 }`, the write stores a 9-row page
 * (`pool[2..11)`), and a hit re-slices `[2, 11)` of THAT 9-row array,
 * returning only 7. Compounding factor: `offset` is not folded into
 * `knobsHash`, so two different offsets can collide on the same cache row.
 *
 * The fix (`skipCache` in `hybridSearchCached`) skips the cache entirely
 * for any offset>0 request, so the double-slice path is unreachable and a
 * stale pre-fix row can never satisfy a post-fix lookup (KNOBS_HASH_VERSION
 * bump 19→20 invalidates any pre-fix rows that were written before the
 * skip existed). This file drives a real store→hit roundtrip (mocked
 * `embedQuery`/`embed` for a deterministic vector, real PGLite
 * SemanticQueryCache) — same harness shape as
 * `hybrid-cached-hit-budget-meta.serial.test.ts`.
 *
 * Serial: mock.module + gateway/global-env mutation (isolation guard R2).
 */

import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as realEmbedding from '../src/core/embedding.ts';

/** Deterministic 1536d unit vector — identical for every call, so the
 * second consult matches the first write at cosine 1.0. */
function fixedEmbedding(): Float32Array {
  const arr = new Float32Array(1536);
  for (let i = 0; i < 1536; i++) arr[i] = Math.sin(1 + i * 0.001);
  let norm = 0;
  for (let i = 0; i < 1536; i++) norm += arr[i] * arr[i];
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < 1536; i++) arr[i] /= norm;
  return arr;
}

// Mock BEFORE importing hybrid.ts (spread keeps every other export live).
mock.module('../src/core/embedding.ts', () => ({
  ...realEmbedding,
  embed: async () => fixedEmbedding(),
  embedQuery: async () => fixedEmbedding(),
}));

// Import AFTER mocking.
const { hybridSearchCached, awaitPendingSearchCacheWrites } =
  await import('../src/core/search/hybrid.ts');
const { configureGateway, resetGateway } = await import('../src/core/ai/gateway.ts');
const { PGLiteEngine } = await import('../src/core/pglite-engine.ts');

let engine: InstanceType<typeof PGLiteEngine>;
let tmpHome: string;
const savedGbrainHome = process.env.GBRAIN_HOME;

// 15 keyword-findable pages on a distinctive, collision-free term, spread
// across 5 types (3 each) so dedup's type-diversity layer (no type >60% of
// results) never trims below what's needed for an offset=2/limit=9 slice
// (needs a pool of >=11 survivors). dedup's text-similarity layer is scoped
// PER PAGE (dedup.ts:dedupByTextSimilarity), so reusing identical filler
// text across DIFFERENT pages — same pattern as the sibling
// hybrid-cached-hit-budget-meta test — is safe.
const TYPES = ['person', 'company', 'note', 'idea', 'project'];
const FIXTURE_COUNT = 15;
const QUERY_TERM = 'wobblesnark';

beforeAll(async () => {
  // Hermetic config home so the developer's real ~/.gbrain/config.json
  // can't leak an embedding_model that flips the cache consult to
  // 'disabled' via isCacheSafe.
  tmpHome = mkdtempSync(join(tmpdir(), 'gbrain-offset-skip-4358-'));
  process.env.GBRAIN_HOME = tmpHome;

  // Pin the gateway to a 1536d provider BEFORE initSchema so the
  // query_cache.embedding column is sized for the mock vectors. The fake
  // key is never used — embedQuery is mocked above.
  resetGateway();
  configureGateway({
    embedding_model: 'openai:text-embedding-3-large',
    embedding_dimensions: 1536,
    env: { OPENAI_API_KEY: 'sk-fake' },
  });

  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();

  const longText = 'x'.repeat(800);
  for (let i = 0; i < FIXTURE_COUNT; i++) {
    const type = TYPES[i % TYPES.length];
    const slug = `${QUERY_TERM}-fixture-${i}`;
    const title = `${QUERY_TERM} fixture ${i}`;
    const truth = `${title} is a ${QUERY_TERM} record. ${longText}`;
    await engine.putPage(slug, { type, title, compiled_truth: truth });
    await engine.upsertChunks(slug, [
      { chunk_index: 0, chunk_text: truth, chunk_source: 'compiled_truth' },
    ]);
  }
});

afterAll(async () => {
  if (savedGbrainHome === undefined) delete process.env.GBRAIN_HOME;
  else process.env.GBRAIN_HOME = savedGbrainHome;
  try { await engine.disconnect(); } catch { /* ignore */ }
  resetGateway();
  try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('#4358 — offset>0 skips the semantic cache', () => {
  test('offset=0 (baseline) still caches normally: miss then hit, same page both times', async () => {
    let missMeta: import('../src/core/types.ts').HybridSearchMeta | undefined;
    const missResults = await hybridSearchCached(engine, QUERY_TERM, {
      limit: 9,
      onMeta: (m) => { missMeta = m; },
    });
    expect(missMeta?.cache?.status).toBe('miss');
    expect(missResults.length).toBe(9);

    await awaitPendingSearchCacheWrites();

    let hitMeta: import('../src/core/types.ts').HybridSearchMeta | undefined;
    const hitResults = await hybridSearchCached(engine, QUERY_TERM, {
      limit: 9,
      onMeta: (m) => { hitMeta = m; },
    });
    expect(hitMeta?.cache?.status).toBe('hit');
    // offset=0 double-slicing a 9-row page with slice(0, 9) is a no-op —
    // the pre-#4358 bug only manifests at offset>0. This pins the baseline
    // stays correct (both page identity and count).
    expect(hitResults.length).toBe(9);
    expect(hitResults.map((r) => r.slug)).toEqual(missResults.map((r) => r.slug));
  });

  test('offset=2/limit=9 never becomes a cache hit and always returns 9 rows (not 7)', async () => {
    // First call: cache is skipped for offset>0 (skipCache = ... ||
    // offsetPaginated), so this is never a 'hit' — it's 'disabled', the
    // same status the sibling skip-cache dimensions (dateFiltered,
    // nearSymbol, adaptiveReturnOn, isNonDefaultColumn) already use.
    let firstMeta: import('../src/core/types.ts').HybridSearchMeta | undefined;
    const firstResults = await hybridSearchCached(engine, QUERY_TERM, {
      limit: 9,
      offset: 2,
      onMeta: (m) => { firstMeta = m; },
    });
    expect(firstMeta?.cache?.status).not.toBe('hit');
    expect(firstMeta?.cache?.status).toBe('disabled');
    // Pre-#4358 this FIRST call already double-sliced down to 7 (verified by
    // temporarily reverting the fix): the preceding test in this file
    // already wrote a cache row for the same query at the same knobsHash
    // (offset isn't hashed), so THIS call's offset=2 lookup collided with
    // that offset=0 row and re-sliced its already-offset-sliced 9-row page.
    // Asserting 9 here pins that the fix makes this call bypass the cache
    // entirely (not just "eventually self-heal").
    expect(firstResults.length).toBe(9);

    await awaitPendingSearchCacheWrites();

    // Second call, identical params: if the cache were consulted (pre-fix
    // behavior) this would become a 'hit' and double-slice the already
    // offset-sliced 9-row stored page down to 7. Post-fix it must still be
    // fully bypassed.
    let secondMeta: import('../src/core/types.ts').HybridSearchMeta | undefined;
    const secondResults = await hybridSearchCached(engine, QUERY_TERM, {
      limit: 9,
      offset: 2,
      onMeta: (m) => { secondMeta = m; },
    });
    expect(secondMeta?.cache?.status).not.toBe('hit');
    expect(secondMeta?.cache?.status).toBe('disabled');
    expect(secondResults.length).toBe(9);
    expect(secondResults.map((r) => r.slug)).toEqual(firstResults.map((r) => r.slug));
  });
});
