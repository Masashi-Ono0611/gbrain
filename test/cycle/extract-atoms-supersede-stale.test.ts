/**
 * #4566 follow-through — extract_atoms retires atoms its source page no longer
 * supports.
 *
 * The doctor's `atom_provenance_drift` check counts atoms whose `source_hash`
 * matches no live page and never deletes; its `source_changed` bucket (source
 * page edited, atom left behind) had nothing to reclaim it. The page lane now
 * soft-deletes, once a page has been scanned, every live atom bound to THAT
 * page whose `source_hash` is neither the in-flight `pending:` marker nor the
 * page's current hash, whose slug this run did not write, and whose VERIFIED
 * `source_quote` is absent from the page's current content.
 *
 * What the cases pin:
 *   (a) a reworded claim → the old atom is soft-deleted, the same-title atom
 *       is upserted IN PLACE (same slug, refreshed hash), the new atom lives.
 *   (a2) omission is NOT evidence: an atom the new pass simply did not re-emit
 *       stays live while its quote is still in the page. This is the guard
 *       against deleting still-valid atoms — the extractor sees a truncated
 *       cut and returns only a handful of atoms per pass.
 *   (b) live-mix: an atom bound to a DIFFERENT page (same date prefix, same
 *       title — the #4733 locator-fold case) and a pre-binding-era atom (no
 *       source_slug/source_path) are untouched, even though both carry a
 *       stale hash and a quote absent from this page.
 *   (c) reverse control for (b): the same run DID soft-delete the page's own
 *       invalidated atom — so (b) cannot pass vacuously on a no-op.
 *   (d) dry-run: no row changes at all, and the reported would-be count
 *       excludes a title this run would refresh in place.
 *   (e) idempotency: an identical re-run retires nothing and moves no atom in
 *       or out of the live set.
 *
 * Every case seeds its own page namespace, so the tests are independent and
 * can be run individually. PGLite round-trip, stubbed chat gateway.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { runPhaseExtractAtoms } from '../../src/core/cycle/extract-atoms.ts';
import type { ChatResult, ChatOpts } from '../../src/core/ai/gateway.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 120_000);

afterAll(async () => {
  if (engine) await engine.disconnect();
}, 60_000);

// Each quote is a distinct sentence that appears exactly once in whichever
// body carries it, so extract_atoms' quote verification locates it uniquely
// and stores `source_quote_verified: true`.
const Q_SHARED = 'Enterprise buyers want tangible prototypes.';
const Q_OLD = 'Renders close deals faster than anything physical.';
const Q_KEEPER = 'Procurement decides long before the demo.';
const Q_NEW = 'A working prototype survives the procurement review.';
const Q_THIRD = 'Pilot budgets outlive the quarter they were approved in.';
const Q_SIBLING = 'A second brief argues the opposite of the first.';
const Q_LEGACY = 'An orphan sentence that lives in no page at all.';

const T_SHARED = 'Prototypes beat renders';
const T_OLD = 'Renders close deals';
const T_KEEPER = 'Procurement decides early';
const T_NEW = 'Prototypes survive review';

const H1 = '1111111111111111';
const H2 = '2222222222222222';
const H3 = '3333333333333333';
const HQ = '4444444444444444';

const BODY_1 = [Q_SHARED, Q_OLD, Q_KEEPER].join(' ');
// Q_OLD is gone (the reworded claim); Q_SHARED and Q_KEEPER survive verbatim.
const BODY_2 = [Q_SHARED, Q_NEW, Q_KEEPER].join(' ');
// Only Q_KEEPER survives; Q_SHARED and Q_NEW are both gone.
const BODY_3 = [Q_THIRD, Q_KEEPER].join(' ');

type Pair = [title: string, quote: string];

const stubChat = (pairs: Pair[]) => async (_o: ChatOpts): Promise<ChatResult> => ({
  text: JSON.stringify(
    pairs.map(([title, source_quote]) => ({
      title, atom_type: 'insight', body: `Body for ${title}.`, source_quote,
    })),
  ),
  blocks: [{ type: 'text', text: '' }],
  stopReason: 'end',
  usage: { input_tokens: 500, output_tokens: 200, cache_read_tokens: 0, cache_creation_tokens: 0 },
  model: 'anthropic:claude-haiku-4-5',
  providerId: 'anthropic',
});

type AtomRow = {
  slug: string;
  title: string;
  deleted_at: string | null;
  updated_at: string | null;
  content_hash: string | null;
  source_hash: string | null;
  source_slug: string | null;
  verified: string | null;
};

const ATOM_COLS = `slug, title, deleted_at::text AS deleted_at, updated_at::text AS updated_at,
                   content_hash,
                   frontmatter->>'source_hash' AS source_hash,
                   frontmatter->>'source_slug' AS source_slug,
                   frontmatter->>'source_quote_verified' AS verified`;

/** Every atom row in the brain, full enough that any write shows up. */
async function atomSnapshot(): Promise<AtomRow[]> {
  return await engine.executeRaw<AtomRow>(
    `SELECT ${ATOM_COLS} FROM pages WHERE type = 'atom' ORDER BY slug`,
  );
}

/**
 * The state this reconciliation owns: identity, liveness, binding. A re-run
 * legitimately re-imports each atom (extracted_at moves, so content_hash and
 * updated_at move with it) — that is the pre-existing upsert, not a retirement,
 * so the idempotency case asserts stillness on THIS projection.
 */
async function bindingSnapshot(): Promise<Array<Omit<AtomRow, 'updated_at' | 'content_hash'>>> {
  return (await atomSnapshot()).map(({ slug, title, deleted_at, source_hash, source_slug, verified }) => ({
    slug, title, deleted_at, source_hash, source_slug, verified,
  }));
}

/** One atom, keyed by title + binding (T_SHARED exists for both P and Q). */
async function atomRow(title: string, sourceSlug: string | null): Promise<AtomRow | null> {
  const rows = await engine.executeRaw<AtomRow>(
    `SELECT ${ATOM_COLS} FROM pages
      WHERE type = 'atom' AND title = $1
        AND frontmatter->>'source_slug' IS NOT DISTINCT FROM $2`,
    [title, sourceSlug],
  );
  return rows[0] ?? null;
}

interface Fixture { p: string; q: string; legacySlug: string }

/**
 * Two same-date source pages (so their atoms share the `atoms/2026-07-01/`
 * prefix and only the locator fold separates them) plus a pre-binding-era
 * atom. P is extracted at H1; Q is extracted once and never again, so its
 * atom's hash stays stale for the rest of the fixture.
 */
async function seed(ns: string): Promise<Fixture> {
  const p = `writings/2026-07-01-p-${ns}`;
  const q = `writings/2026-07-01-q-${ns}`;
  const legacySlug = `atoms/2026-07-01/legacy-unbound-${ns}`;

  await engine.putPage(p, { type: 'note', title: `P ${ns}`, compiled_truth: BODY_1, timeline: '' });
  await engine.putPage(q, { type: 'note', title: `Q ${ns}`, compiled_truth: Q_SIBLING, timeline: '' });
  // Pre-binding era: no source_slug and no source_path. Deliberately given a
  // stale hash AND a verified quote that appears in no page, so only the
  // missing binding stands between it and the reconciler.
  await engine.putPage(legacySlug, {
    type: 'atom', title: `Legacy unbound atom ${ns}`,
    compiled_truth: 'An atom written before source bindings existed.', timeline: '',
    frontmatter: { source_hash: 'ffffffffffffffff', source_quote: Q_LEGACY, source_quote_verified: true },
  });

  const first = await runPhaseExtractAtoms(engine, {
    _transcripts: [],
    _pages: [{ slug: p, content: BODY_1, contentHash: H1 }],
    _chat: stubChat([[T_SHARED, Q_SHARED], [T_OLD, Q_OLD], [T_KEEPER, Q_KEEPER]]),
  });
  expect(first.status).toBe('ok');
  expect(first.details?.atoms_extracted).toBe(3);
  // The whole design rests on these quotes verifying; assert it once here so a
  // silent verification regression cannot make later cases pass vacuously.
  expect((await atomRow(T_OLD, p))?.verified).toBe('true');

  // Q emits the SAME atom title on the SAME date — distinct slug via the
  // #4733 locator fold — with a quote that lives only in Q's own body.
  const sibling = await runPhaseExtractAtoms(engine, {
    _transcripts: [],
    _pages: [{ slug: q, content: Q_SIBLING, contentHash: HQ }],
    _chat: stubChat([[T_SHARED, Q_SIBLING]]),
  });
  expect(sibling.status).toBe('ok');

  return { p, q, legacySlug };
}

/** The re-extraction under test: P edited to BODY_2, one claim reworded. */
function reextract(p: string) {
  return runPhaseExtractAtoms(engine, {
    _transcripts: [],
    _pages: [{ slug: p, content: BODY_2, contentHash: H2 }],
    _chat: stubChat([[T_SHARED, Q_SHARED], [T_NEW, Q_NEW]]),
  });
}

describe('extract_atoms retires atoms its source page no longer supports (#4566 follow-through)', () => {
  test('(a) a reworded claim is retired; the same-title atom is upserted in place', async () => {
    const { p } = await seed('a');
    const slugBefore = (await atomRow(T_SHARED, p))!.slug;

    const result = await reextract(p);
    expect(result.status).toBe('ok');
    expect(result.details?.atoms_superseded).toBe(1);
    expect(String(result.summary)).toContain('1 superseded');

    // The reworded claim's quote is gone from the page: retired.
    const retired = await atomRow(T_OLD, p);
    expect(retired!.source_hash).toBe(H1);
    expect(retired!.deleted_at).not.toBeNull();

    // Unchanged title: SAME slug, refreshed hash, still live (upsert in place).
    const shared = await atomRow(T_SHARED, p);
    expect(shared!.slug).toBe(slugBefore);
    expect(shared!.deleted_at).toBeNull();
    expect(shared!.source_hash).toBe(H2);

    // The replacement atom is live at the new hash.
    const fresh = await atomRow(T_NEW, p);
    expect(fresh!.deleted_at).toBeNull();
    expect(fresh!.source_hash).toBe(H2);
  }, 120_000);

  test('(a2) an atom the new pass merely omitted is KEPT while its quote survives', async () => {
    const { p } = await seed('a2');
    // T_KEEPER is not re-emitted by the re-extraction, but Q_KEEPER is still
    // in BODY_2 verbatim — omission alone must never retire an atom.
    const result = await reextract(p);
    expect(result.details?.atoms_superseded).toBe(1);

    const keeper = await atomRow(T_KEEPER, p);
    expect(keeper!.deleted_at).toBeNull();
    expect(keeper!.source_hash).toBe(H1); // still stale, still kept
  }, 120_000);

  test('(b) atoms bound elsewhere — sibling page Q, pre-binding era — are untouched', async () => {
    const { p, q, legacySlug } = await seed('b');
    const qBefore = await atomRow(T_SHARED, q);
    const legacyBefore = await atomRow(`Legacy unbound atom b`, null);
    expect(qBefore).not.toBeNull();
    expect(qBefore!.slug).not.toBe((await atomRow(T_SHARED, p))!.slug);
    expect(legacyBefore!.slug).toBe(legacySlug);

    await reextract(p);

    expect(await atomRow(T_SHARED, q)).toEqual(qBefore);
    expect(await atomRow('Legacy unbound atom b', null)).toEqual(legacyBefore);
  }, 120_000);

  test('(c) reverse control: in that same run, the page\'s own invalidated atom IS retired', async () => {
    const { p } = await seed('c');
    const result = await reextract(p);
    expect(result.details?.atoms_superseded).toBe(1);
    const retired = await atomRow(T_OLD, p);
    expect(retired!.deleted_at).not.toBeNull();
  }, 120_000);

  test('(d) dry-run writes nothing and excludes a title it would refresh in place', async () => {
    const { p } = await seed('d');
    await reextract(p);
    const before = await atomSnapshot();

    // BODY_3 drops BOTH Q_SHARED and Q_NEW, so both of those atoms' quotes are
    // gone. T_SHARED is re-emitted (with a quote from the new body), so the
    // run would refresh it in place and it must NOT be counted; T_NEW is not
    // re-emitted and its quote is gone, so it must be. Without the
    // written-this-run exclusion the count would be 2.
    const result = await runPhaseExtractAtoms(engine, {
      dryRun: true,
      _transcripts: [],
      _pages: [{ slug: p, content: BODY_3, contentHash: H3 }],
      _chat: stubChat([[T_SHARED, Q_THIRD]]),
    });
    expect(result.status).toBe('ok');
    expect(result.details?.dry_run).toBe(true);
    expect(result.details?.atoms_superseded).toBe(1);
    expect(await atomSnapshot()).toEqual(before);
  }, 120_000);

  test('(e) an identical re-run retires nothing and moves no atom in or out of the live set', async () => {
    const { p } = await seed('e');
    await reextract(p);
    const before = await bindingSnapshot();

    const again = await reextract(p);
    expect(again.status).toBe('ok');
    expect(again.details?.atoms_superseded).toBe(0);
    expect(String(again.summary)).not.toContain('superseded');
    expect(await bindingSnapshot()).toEqual(before);
  }, 120_000);
});
