/**
 * #4091 — hybridSearch's keyword arm (`engine.searchKeyword`) had no fail-open,
 * unlike its sibling title arm (`engine.searchTitles`, added under
 * fix/title-retrieval-arm with an explicit `.catch()`). Both arms build their
 * SQL around `websearch_to_tsquery` with no query-length gate; a sufficiently
 * long/complex query can overflow Postgres's internal parser and raise "stack
 * depth limit exceeded" (Postgres error 54001) — verified against a live
 * Postgres brain (not reproducible against PGLite at the tested scale, hence
 * the mock-based approach here: PGLite's embedded Postgres apparently applies
 * a different/higher stack-depth ceiling, or none, for the same input size).
 *
 * Before the fix, `searchTitles` failing this way degraded gracefully (its
 * error was caught and logged), but the IDENTICAL error from `searchKeyword`
 * propagated uncaught through the `Promise.all` in `hybridSearch`, crashing
 * direct callers instead of returning degraded-but-successful results.
 *
 * This test doesn't attempt to reproduce the real Postgres stack-depth error
 * (unreproducible on PGLite, and reproducing it for real requires a live
 * Postgres connection + a ~300KB query — see the issue for that repro). It
 * spies on `engine.searchKeyword` to inject an arbitrary rejection and
 * confirms `hybridSearch` still returns a result (title/other arms) instead
 * of rejecting — i.e. it tests the fail-open CONTRACT this PR adds, not the
 * specific Postgres failure mode that motivated it.
 *
 * Serial: spyOn engine methods (isolation guard R2).
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';
import { hybridSearch } from '../../src/core/search/hybrid.ts';
import { configureGateway } from '../../src/core/ai/gateway.ts';

let engine: PGLiteEngine;
const DIM = 1536;

beforeAll(async () => {
  // Empty env so isAvailable('embedding') is false -> hybridSearch takes the
  // keyword(+title)-only no-embed path, same hermetic setup as the sibling
  // title-retrieval-arm.test.ts file.
  configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: DIM, env: {} });
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
  configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: DIM, env: { ...process.env } });
});

beforeEach(async () => {
  await resetPgliteState(engine);
  await engine.putPage('notes/widget', {
    type: 'note',
    title: 'Widget gbrain4091test Notes',
    compiled_truth: 'A page about widgets for the gbrain4091test keyword arm fail-open test.',
  });
  await engine.upsertChunks('notes/widget', [
    { chunk_index: 0, chunk_text: 'A page about widgets for the gbrain4091test keyword arm fail-open test.', chunk_source: 'compiled_truth' },
  ]);
});

afterEach(() => {
  // Restore engine.searchKeyword unconditionally, even if a test's own
  // hybridSearch call or assertion throws before reaching an explicit
  // spy.mockRestore() — otherwise a failure in the first test leaves the
  // spy in place and silently contaminates the control test that follows.
  const maybeSpy = engine.searchKeyword as unknown as { mockRestore?: () => void };
  maybeSpy.mockRestore?.();
});

describe('#4091 — hybridSearch keyword arm fails open on a searchKeyword rejection', () => {
  test('searchKeyword rejecting does not crash hybridSearch — it degrades like searchTitles already does', async () => {
    spyOn(engine, 'searchKeyword').mockRejectedValue(new Error('stack depth limit exceeded'));

    // Before the fix, this await would reject (the uncaught Promise.all
    // rejection). After the fix, it resolves with whatever the title arm
    // (and other RRF inputs) still found.
    const results = await hybridSearch(engine, 'gbrain4091test', {
      limit: 5,
      expansion: false,
    });

    // The title arm should still have found the seeded page by its title
    // tokens — proving the OTHER arm's results survive a keyword-arm crash,
    // not just that the call didn't throw.
    expect(results.some((r) => r.slug === 'notes/widget')).toBe(true);
  });

  test('control: searchKeyword succeeding normally still returns results (regression guard)', async () => {
    // No spy here — this pins that the fix doesn't accidentally suppress
    // real keyword-arm results in the non-error path.
    const results = await hybridSearch(engine, 'widgets gbrain4091test', {
      limit: 5,
      expansion: false,
    });
    expect(results.some((r) => r.slug === 'notes/widget')).toBe(true);
  });
});
