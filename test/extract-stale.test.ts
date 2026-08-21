/**
 * Tests for `gbrain extract --stale` + the link-extraction freshness watermark
 * (v0.42.7, #1696). Hermetic PGLite — no DATABASE_URL, no API keys.
 *
 * Covers:
 *   - engine methods: countStalePagesForExtraction (NULL / version / edited-since
 *     arms + source scope), listStalePagesForExtraction (content + keyset),
 *     markPagesExtractedBatch (composite-key stamp).
 *   - `extract --stale`: sweep creates typed edges + stamps every processed page
 *     (incl. zero-link), second run finds 0 stale (idempotent), --dry-run writes
 *     nothing, --source-id scope.
 *   - CRITICAL regression (CDX-1): a page edited after a prior stamp
 *     (updated_at > links_extracted_at) is re-flagged stale and re-extracted.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runExtract, extractStaleFromDB } from '../src/commands/extract.ts';
import { LINK_EXTRACTOR_VERSION_TS } from '../src/core/link-extraction.ts';
import { currentExitCode, _resetCliExitVerdictForTests } from '../src/core/cli-force-exit.ts';
import type { PageInput } from '../src/core/types.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  if (engine) await engine.disconnect();
}, 60_000);

async function truncateAll() {
  for (const t of ['content_chunks', 'links', 'tags', 'raw_data', 'timeline_entries', 'page_versions', 'ingest_log', 'pages']) {
    await (engine as any).db.exec(`DELETE FROM ${t}`);
  }
}
beforeEach(truncateAll);

const personPage = (title: string, body = ''): PageInput => ({ type: 'person', title, compiled_truth: body, timeline: '' });
const companyPage = (title: string, body = ''): PageInput => ({ type: 'company', title, compiled_truth: body, timeline: '' });

async function stampOf(slug: string, sourceId = 'default'): Promise<string | null> {
  const rows = await engine.executeRaw<{ links_extracted_at: string | null }>(
    `SELECT links_extracted_at FROM pages WHERE slug = $1 AND source_id = $2`, [slug, sourceId],
  );
  return rows[0]?.links_extracted_at ?? null;
}

describe('engine: stale-page extraction methods', () => {
  test('countStalePagesForExtraction: NULL arm counts never-extracted pages', async () => {
    await engine.putPage('people/alice', personPage('Alice'));
    await engine.putPage('people/bob', personPage('Bob'));
    expect(await engine.countStalePagesForExtraction()).toBe(2);
  });

  test('countStalePagesForExtraction: stamped pages drop out', async () => {
    await engine.putPage('people/alice', personPage('Alice'));
    await engine.markPagesExtractedBatch([{ slug: 'people/alice', source_id: 'default' }], new Date().toISOString());
    expect(await engine.countStalePagesForExtraction()).toBe(0);
  });

  test('countStalePagesForExtraction: version arm flags pre-version stamps', async () => {
    await engine.putPage('people/alice', personPage('Alice'));
    // Stamp with an OLD timestamp (before LINK_EXTRACTOR_VERSION_TS).
    await engine.markPagesExtractedBatch([{ slug: 'people/alice', source_id: 'default' }], '2000-01-01T00:00:00Z');
    // Without versionTs: only NULL/edited arms → not stale (stamp >= updated? no:
    // stamp is 2000, updated is now → updated_at > stamp → STALE via edited arm).
    // So set updated_at back too, isolating the version arm:
    await engine.executeRaw(`UPDATE pages SET updated_at = '2000-01-01T00:00:00Z' WHERE slug = 'people/alice'`);
    expect(await engine.countStalePagesForExtraction()).toBe(0); // no version, stamp==updated, not NULL
    expect(await engine.countStalePagesForExtraction({ versionTs: LINK_EXTRACTOR_VERSION_TS })).toBe(1); // version arm
  });

  test('countStalePagesForExtraction: edited-since arm (CDX-1)', async () => {
    await engine.putPage('people/alice', personPage('Alice'));
    await engine.markPagesExtractedBatch([{ slug: 'people/alice', source_id: 'default' }], new Date().toISOString());
    expect(await engine.countStalePagesForExtraction()).toBe(0);
    // Simulate an edit AFTER the stamp (put_page / sync --no-extract).
    await engine.executeRaw(`UPDATE pages SET updated_at = '2099-01-01T00:00:00Z' WHERE slug = 'people/alice'`);
    expect(await engine.countStalePagesForExtraction()).toBe(1);
  });

  test('listStalePagesForExtraction: returns content columns + keyset paginates', async () => {
    await engine.putPage('people/alice', personPage('Alice', 'Body A'));
    await engine.putPage('people/bob', personPage('Bob', 'Body B'));
    const batch1 = await engine.listStalePagesForExtraction({ batchSize: 1 });
    expect(batch1.length).toBe(1);
    expect(batch1[0].compiled_truth).toBeTruthy();
    expect(batch1[0].title).toBeTruthy();
    expect(batch1[0].frontmatter).toBeDefined();
    const batch2 = await engine.listStalePagesForExtraction({ batchSize: 10, afterPageId: batch1[0].id });
    expect(batch2.length).toBe(1);
    expect(batch2[0].id).toBeGreaterThan(batch1[0].id);
  });

  test('markPagesExtractedBatch: empty input is a no-op', async () => {
    await engine.markPagesExtractedBatch([], new Date().toISOString());
    expect(true).toBe(true); // no throw
  });
});

describe('gbrain extract --stale', () => {
  test('extracts typed edges + stamps every processed page (incl. zero-link)', async () => {
    await engine.putPage('people/alice', personPage('Alice'));
    await engine.putPage('companies/acme', companyPage('Acme', '[Alice](people/alice) is the CEO of [Acme](companies/acme).'));
    await engine.putPage('people/lonely', personPage('Lonely', 'No links here.'));

    await runExtract(engine, ['--stale']);

    const links = await engine.getLinks('companies/acme');
    expect(links.some(l => l.to_slug === 'people/alice')).toBe(true);
    // EVERY processed page stamped — including the zero-link one.
    expect(await stampOf('people/alice')).not.toBeNull();
    expect(await stampOf('companies/acme')).not.toBeNull();
    expect(await stampOf('people/lonely')).not.toBeNull();
    // Nothing left stale.
    expect(await engine.countStalePagesForExtraction({ versionTs: LINK_EXTRACTOR_VERSION_TS })).toBe(0);
  });

  test('idempotent: second run finds 0 stale and creates no new links', async () => {
    await engine.putPage('people/alice', personPage('Alice'));
    await engine.putPage('companies/acme', companyPage('Acme', '[Alice](people/alice) advises [Acme](companies/acme).'));

    await runExtract(engine, ['--stale']);
    const after1 = (await engine.getLinks('companies/acme')).length;
    const stamp1 = await stampOf('companies/acme');

    await runExtract(engine, ['--stale']);
    const after2 = (await engine.getLinks('companies/acme')).length;
    expect(after2).toBe(after1);
    // Second run had 0 stale → did not re-stamp (stamp unchanged is acceptable;
    // the key invariant is no duplicate links).
    expect(stamp1).not.toBeNull();
  });

  test('--dry-run reports count and writes nothing', async () => {
    await engine.putPage('people/alice', personPage('Alice'));
    await engine.putPage('companies/acme', companyPage('Acme', '[Alice](people/alice) joined [Acme](companies/acme).'));

    await runExtract(engine, ['--stale', '--dry-run']);

    expect(await engine.getLinks('companies/acme')).toHaveLength(0);
    expect(await stampOf('people/alice')).toBeNull();
    expect(await stampOf('companies/acme')).toBeNull();
    // Still stale after dry-run.
    expect(await engine.countStalePagesForExtraction()).toBe(2);
  });

  test('CRITICAL (CDX-1): page edited after stamp is re-extracted', async () => {
    await engine.putPage('people/alice', personPage('Alice'));
    await engine.putPage('companies/acme', companyPage('Acme', 'No links yet.'));
    await runExtract(engine, ['--stale']);
    expect(await engine.countStalePagesForExtraction({ versionTs: LINK_EXTRACTOR_VERSION_TS })).toBe(0);

    // Simulate an edit that adds a link WITHOUT extracting (MCP put_page /
    // sync --no-extract). Use relative intervals so it's clock-agnostic: the
    // stamp + edit both land in the recent past (after LINK_EXTRACTOR_VERSION_TS),
    // with updated_at AFTER the stamp — and crucially both BEFORE real-now, so
    // the re-extract's now()-stamp deterministically supersedes the edit.
    await engine.executeRaw(
      `UPDATE pages
         SET compiled_truth = $1,
             links_extracted_at = now() - interval '2 hours',
             updated_at = now() - interval '1 hour'
       WHERE slug = 'companies/acme'`,
      ['[Alice](people/alice) now works at [Acme](companies/acme).'],
    );
    // Re-flagged stale by the updated_at arm (updated > stamp).
    expect(await engine.countStalePagesForExtraction({ versionTs: LINK_EXTRACTOR_VERSION_TS })).toBe(1);

    // extract --stale picks it up, creates the now-present edge, and re-stamps
    // at now() (> the edit's updated_at) so the page is fresh again.
    await runExtract(engine, ['--stale']);
    const links = await engine.getLinks('companies/acme');
    expect(links.some(l => l.to_slug === 'people/alice')).toBe(true);
    expect(await engine.countStalePagesForExtraction({ versionTs: LINK_EXTRACTOR_VERSION_TS })).toBe(0);
  });

  test('CRITICAL (#1768): microsecond updated_at clears after --stale (no permanent lag)', async () => {
    // Repro of #1768: extractStaleFromDB used to stamp page.updated_at.toISOString()
    // (a JS Date, millisecond-truncated). The DB updated_at keeps microseconds, so
    // `updated_at > links_extracted_at` stayed true forever and links_extraction_lag
    // was stuck at 100% on Postgres. We inject a microsecond updated_at explicitly so
    // the precision gap is deterministic regardless of the engine's now() granularity.
    await engine.putPage('people/alice', personPage('Alice'));
    await engine.putPage('companies/acme', companyPage('Acme', '[Alice](people/alice) advises [Acme](companies/acme).'));
    // Microsecond-precision updated_at, derived from LINK_EXTRACTOR_VERSION_TS
    // (+2 days) so the version arm never fires regardless of future bumps —
    // the edited arm is what must clear.
    const afterVersionIso = new Date(Date.parse(LINK_EXTRACTOR_VERSION_TS) + 48 * 3600 * 1000).toISOString();
    const usUpdatedAt = `${afterVersionIso.slice(0, 10)} ${afterVersionIso.slice(11, 19)}.999166+00`;
    await engine.executeRaw(`UPDATE pages SET updated_at = '${usUpdatedAt}'`);
    expect(await engine.countStalePagesForExtraction({ versionTs: LINK_EXTRACTOR_VERSION_TS })).toBe(2);

    await runExtract(engine, ['--stale']);
    // Fixed: links_extracted_at stamped at the EXACT microsecond updated_at, so the
    // edited arm clears. Pre-fix this stayed at 2 (the bug).
    expect(await engine.countStalePagesForExtraction({ versionTs: LINK_EXTRACTOR_VERSION_TS })).toBe(0);

    // And it stays cleared on a re-run (the "no matter how many times I re-run" symptom).
    await runExtract(engine, ['--stale']);
    expect(await engine.countStalePagesForExtraction({ versionTs: LINK_EXTRACTOR_VERSION_TS })).toBe(0);

    // The stamp itself carries microsecond precision (not millisecond-truncated).
    const stamp = await stampOf('companies/acme');
    expect(stamp).not.toBeNull();
    const usRows = await engine.executeRaw<{ eq: boolean }>(
      `SELECT links_extracted_at >= updated_at AS eq FROM pages WHERE slug = 'companies/acme'`,
    );
    expect(usRows[0]?.eq).toBe(true);
  });

  test('REGRESSION: page with updated_at BEFORE LINK_EXTRACTOR_VERSION_TS clears (no permanent-stale loop)', async () => {
    // The v112 watermark column ships with no backfill, so every pre-existing
    // page starts NULL-stale — and most pre-date the version bump. Pre-fix,
    // extractStaleFromDB stamped links_extracted_at = read updated_at; for a
    // page edited before LINK_EXTRACTOR_VERSION_TS the stamp landed BELOW the
    // version threshold, so the version arm (links_extracted_at < versionTs)
    // re-flagged it stale forever — an infinite re-extract loop that never
    // cleared the lag (observed: 97% of pages stuck permanently).
    await engine.putPage('people/alice', personPage('Alice'));
    await engine.putPage('companies/acme', companyPage('Acme', '[Alice](people/alice) leads [Acme](companies/acme).'));
    // Backdate every page to BEFORE the extractor version timestamp.
    await engine.executeRaw(`UPDATE pages SET updated_at = '2020-01-01T00:00:00Z'`);
    expect(await engine.countStalePagesForExtraction({ versionTs: LINK_EXTRACTOR_VERSION_TS })).toBe(2);

    await runExtract(engine, ['--stale']);
    // Fixed: stamp = GREATEST(read updated_at, versionTs) → lifts old pages to
    // the threshold so the version arm clears, while a real future edit still
    // advances updated_at past the stamp (CDX-1 race protection preserved).
    expect(await engine.countStalePagesForExtraction({ versionTs: LINK_EXTRACTOR_VERSION_TS })).toBe(0);

    // Second run must ALSO find 0 — the defining symptom of the bug was that it
    // never converged.
    await runExtract(engine, ['--stale']);
    expect(await engine.countStalePagesForExtraction({ versionTs: LINK_EXTRACTOR_VERSION_TS })).toBe(0);
  });

  test('CDX-4 (D2): a link-flush throw aborts the sweep and leaves pages UNSTAMPED', async () => {
    await engine.putPage('people/alice', personPage('Alice'));
    await engine.putPage('companies/acme', companyPage('Acme', '[Alice](people/alice) founded [Acme](companies/acme).'));

    // Make the link flush throw mid-sweep. The --stale path flushes
    // NON-swallowing (no try/catch), so the throw must propagate AND no page in
    // the batch may be stamped (stamp runs only AFTER a successful flush).
    const origBatch = engine.addLinksBatch.bind(engine);
    let threw = false;
    (engine as unknown as { addLinksBatch: unknown }).addLinksBatch = async () => { throw new Error('__flush_boom__'); };
    try {
      await runExtract(engine, ['--stale']);
    } catch (e) {
      if ((e as Error).message === '__flush_boom__') threw = true; else throw e;
    } finally {
      (engine as unknown as { addLinksBatch: unknown }).addLinksBatch = origBatch;
    }
    expect(threw).toBe(true);
    // Pages whose edges were lost are NOT stamped fresh — they stay stale.
    expect(await stampOf('people/alice')).toBeNull();
    expect(await stampOf('companies/acme')).toBeNull();
    expect(await engine.countStalePagesForExtraction({ versionTs: LINK_EXTRACTOR_VERSION_TS })).toBe(2);

    // A clean re-run re-extracts idempotently (ON CONFLICT DO NOTHING).
    await runExtract(engine, ['--stale']);
    expect((await engine.getLinks('companies/acme')).some(l => l.to_slug === 'people/alice')).toBe(true);
    expect(await stampOf('companies/acme')).not.toBeNull();
    expect(await engine.countStalePagesForExtraction({ versionTs: LINK_EXTRACTOR_VERSION_TS })).toBe(0);
  });

  // ─── #3737: idx_timeline_dedup's unique btree covers unbounded TEXT
  // (page_id, date, summary, source). A sufficiently long, low-compressibility
  // summary exceeds Postgres's ~2704-byte btree entry-size cap and the insert
  // is rejected — structurally, not transiently. Pre-fix this aborted the
  // WHOLE flush chunk (and, propagating past extractStaleFromDB, the whole
  // `--stale` run), leaving every page in the batch — including healthy
  // siblings — unprocessed and unstamped, with no indication of which page or
  // entry was at fault. ─────────────────────────────────────────────────────

  // Deterministic low-compressibility ~3000-byte string. Mirrors the issue's
  // own repro (md5-hash concatenation defeats btree key compression the way
  // `repeat('a', N)` does not).
  function unindexableSummary(): string {
    const crypto = require('node:crypto') as typeof import('node:crypto');
    return Array.from({ length: 94 }, (_, i) =>
      crypto.createHash('md5').update(`${i}`).digest('hex'),
    ).join('');
  }

  test('REGRESSION (#3737): an unwritable timeline entry is skipped-and-warned, not fatal to the sweep', async () => {
    const bigSummary = unindexableSummary();
    await engine.putPage('meetings/poison', {
      type: 'meeting' as any, title: 'Poison Meeting', compiled_truth: 'A meeting page.',
      timeline: `## Timeline\n- **2026-06-04** | ${bigSummary}\n`,
    });
    await engine.putPage('people/alice', personPage('Alice'));
    await engine.putPage('companies/acme', companyPage('Acme', '[Alice](people/alice) advises [Acme](companies/acme).'));

    _resetCliExitVerdictForTests();
    const origErr = console.error;
    let warnings = '';
    console.error = (m?: unknown) => { warnings += String(m) + '\n'; };
    try {
      await runExtract(engine, ['--stale']); // must NOT throw
    } finally {
      console.error = origErr;
    }

    // The healthy pages in the SAME batch are unaffected: link created, both
    // stamped, nothing left stale.
    const links = await engine.getLinks('companies/acme');
    expect(links.some(l => l.to_slug === 'people/alice')).toBe(true);
    expect(await stampOf('people/alice')).not.toBeNull();
    expect(await stampOf('companies/acme')).not.toBeNull();

    // The poisoned page WAS processed (extraction ran; the page just has one
    // unwritable timeline entry) and is stamped like any other processed page
    // — consistent with the existing "every processed page is stamped, incl.
    // zero-link" invariant. The unwritable entry itself never lands in
    // timeline_entries.
    expect(await stampOf('meetings/poison')).not.toBeNull();
    const rows = await engine.executeRaw<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM timeline_entries te
         JOIN pages p ON p.id = te.page_id WHERE p.slug = 'meetings/poison'`,
    );
    expect(rows[0].n).toBe('0');

    // Backlog is unblocked, not stuck forever (the core #3737 complaint).
    expect(await engine.countStalePagesForExtraction({ versionTs: LINK_EXTRACTOR_VERSION_TS })).toBe(0);

    // Surfaced, not silent: the page is named in a stderr warning, and the
    // exit code is non-zero instead of a clean success.
    expect(warnings).toContain('meetings/poison');
    expect(warnings).toContain('idx_timeline_dedup');
    expect(currentExitCode()).toBe(1);
  });

  test('REGRESSION (#3737): --json summary reports timeline_write_failures instead of a clean success', async () => {
    const bigSummary = unindexableSummary();
    await engine.putPage('meetings/poison-json', {
      type: 'meeting' as any, title: 'Poison Meeting JSON', compiled_truth: 'A meeting page.',
      timeline: `## Timeline\n- **2026-06-05** | ${bigSummary}\n`,
    });

    _resetCliExitVerdictForTests();
    const origLog = console.error;
    console.error = () => {}; // silence the per-row warning for this assertion
    const origWrite = process.stdout.write.bind(process.stdout);
    let out = '';
    (process.stdout as unknown as { write: unknown }).write = (chunk: unknown) => { out += String(chunk); return true; };
    try {
      await runExtract(engine, ['--stale', '--json']);
    } finally {
      console.error = origLog;
      (process.stdout as unknown as { write: unknown }).write = origWrite;
    }

    const parsed = JSON.parse(out.trim().split('\n').pop()!);
    expect(parsed.action).toBe('extract_stale_done');
    expect(parsed.timeline_write_failures).toBe(1);
    expect(typeof parsed.first_timeline_write_error).toBe('string');
    expect(parsed.first_timeline_write_error).toContain('idx_timeline_dedup');
    expect(currentExitCode()).toBe(1);
  });

  test('D4 race: a concurrent edit landing during the sweep is NOT masked', async () => {
    await engine.putPage('people/alice', personPage('Alice'));
    await engine.putPage('companies/acme', companyPage('Acme', '[Alice](people/alice) backs [Acme](companies/acme).'));
    // Anchor acme's updated_at in the past so the read value is well-defined.
    await engine.executeRaw(`UPDATE pages SET updated_at = now() - interval '3 hours' WHERE slug = 'companies/acme'`);

    // Simulate an edit landing BETWEEN the list read (updated_at = now-3h) and
    // the stamp: bump acme's updated_at to now-1h just before the real stamp.
    // D4 stamps with the READ updated_at (now-3h), so now-1h > now-3h → acme
    // stays stale (edit preserved). The OLD now()-stamp would set
    // links_extracted_at = now > now-1h → acme marked fresh, edit silently lost.
    const origStamp = engine.markPagesExtractedBatch.bind(engine);
    let hooked = false;
    (engine as unknown as { markPagesExtractedBatch: unknown }).markPagesExtractedBatch = async (
      refs: Array<{ slug: string; source_id: string; extractedAt?: string }>, def: string,
    ) => {
      if (!hooked) {
        hooked = true;
        await engine.executeRaw(`UPDATE pages SET updated_at = now() - interval '1 hour' WHERE slug = 'companies/acme'`);
      }
      return origStamp(refs, def);
    };
    try {
      await runExtract(engine, ['--stale']);
    } finally {
      (engine as unknown as { markPagesExtractedBatch: unknown }).markPagesExtractedBatch = origStamp;
    }
    expect(hooked).toBe(true);
    // acme stays stale (only the concurrently-edited page); alice was stamped
    // with its own read updated_at and is fresh.
    expect(await engine.countStalePagesForExtraction({ versionTs: LINK_EXTRACTOR_VERSION_TS })).toBe(1);
  });

  test('--source fs is rejected (DB-source only)', async () => {
    const origErr = console.error;
    const origExit = process.exit;
    let exited = false; let msg = '';
    console.error = (m?: unknown) => { msg += String(m); };
    process.exit = ((_code?: number) => { exited = true; throw new Error('__exit__'); }) as unknown as typeof process.exit;
    try {
      await runExtract(engine, ['--stale', '--source', 'fs']);
    } catch (e) {
      if ((e as Error).message !== '__exit__') throw e;
    } finally {
      console.error = origErr;
      process.exit = origExit;
    }
    expect(exited).toBe(true);
    expect(msg).toContain('DB-source only');
  });

  // ─── #2576 bug 1: --stale must run the same resolver passes as
  // `extract links --source db` ─────────────────────────────────────────────

  test('#2576: bare wikilink resolves via global_basename on the --stale path', async () => {
    await engine.putPage('projects/struktura',
      { type: 'project' as any, title: 'Struktura', compiled_truth: 'A project page.', timeline: '' });
    await engine.putPage('concepts/knowledge-graph',
      { type: 'concept' as any, title: 'Knowledge Graph',
        compiled_truth: 'This concept relates to [[struktura]].', timeline: '' });
    await engine.setConfig('link_resolution.global_basename', 'true');
    try {
      await runExtract(engine, ['--stale']);
    } finally {
      await engine.setConfig('link_resolution.global_basename', 'false');
    }

    // Pre-fix: the nullResolver (no resolveBasenameMatches) made
    // extractPageLinks skip the basename pass, so the sweep stamped the page
    // with the wikilink silently dropped — 0 links, watermark green.
    const links = await engine.getLinks('concepts/knowledge-graph');
    const strk = links.find(l => l.to_slug === 'projects/struktura');
    expect(strk).toBeDefined();
    expect(strk!.link_type).toBe('wikilink_basename');
    // Still stamped like every processed page.
    expect(await stampOf('concepts/knowledge-graph')).not.toBeNull();
  });

  test('#2576: bare wikilink still drops on --stale when global_basename is OFF (back-compat)', async () => {
    await engine.putPage('projects/struktura',
      { type: 'project' as any, title: 'Struktura', compiled_truth: 'A project page.', timeline: '' });
    await engine.putPage('concepts/knowledge-graph',
      { type: 'concept' as any, title: 'Knowledge Graph',
        compiled_truth: 'This concept relates to [[struktura]].', timeline: '' });
    await engine.setConfig('link_resolution.global_basename', 'false');

    await runExtract(engine, ['--stale']);

    expect((await engine.getLinks('concepts/knowledge-graph'))).toHaveLength(0);
    // The gate lives in extractPageLinks opts now, not in a resolver swap —
    // the page is still stamped either way.
    expect(await stampOf('concepts/knowledge-graph')).not.toBeNull();
  });

  test('#4062 review: timeBudgetMs caps the sweep between batches (in-cycle drain stays bounded)', async () => {
    // 26 stale pages > STALE_BATCH_SIZE (25): the first keyset batch drains
    // 25, the 0ms budget trips, and the sweep exits with the remainder still
    // stale — exactly how the cycle's in-line drain nibbles a big backlog
    // instead of consuming the whole cycle.
    for (let i = 0; i < 26; i++) {
      await engine.putPage(`people/budget-${String(i).padStart(2, '0')}`, personPage(`Budget ${i}`));
    }
    const r = await extractStaleFromDB(engine, {
      dryRun: false, jsonMode: true, includeFrontmatter: false, catchUp: false,
      timeBudgetMs: 0,
    });
    expect(r.pagesProcessed).toBe(25);
    expect(r.staleRemaining).toBe(1);

    // Default budget (~30 min) finishes the remainder.
    const r2 = await extractStaleFromDB(engine, {
      dryRun: false, jsonMode: true, includeFrontmatter: false, catchUp: false,
    });
    expect(r2.pagesProcessed).toBe(1);
    expect(r2.staleRemaining).toBe(0);
  });

});
