/**
 * #4566 follow-through — extract_atoms retires atoms its source page no longer
 * supports.
 *
 * The doctor's `atom_provenance_drift` check counts atoms whose `source_hash`
 * matches no live page and never deletes; its `source_changed` bucket (source
 * page edited, atom left behind) had nothing to reclaim it. The page lane now
 * soft-deletes, before it marks a scanned page complete, every live atom bound
 * to THAT page whose `source_hash` is neither the in-flight `pending:` marker
 * nor the page's current hash, whose slug this run did not write, and whose
 * VERIFIED `source_quote` is absent from the page's current content.
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
 *   (f) the zero-yield lane reconciles too: an edit that leaves no extractable
 *       claim still retires the atoms whose quotes it deleted.
 *   (g) a reconciliation failure leaves the page RETRYABLE — it lands before
 *       the completion markers, so real discovery still returns the page and
 *       the next run finishes the job.
 *
 * Every case seeds its own page namespace and drives the phase with the page's
 * REAL persisted content hash, so the reconciliation's "page still carries
 * this hash" guard is exercised rather than bypassed. PGLite round-trip,
 * stubbed chat gateway.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { runPhaseExtractAtoms, discoverExtractablePages } from '../../src/core/cycle/extract-atoms.ts';
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

// Page discovery ignores bodies under 500 chars, and case (g) drives real
// discovery, so every body carries neutral padding. The filler shares no
// sentence with any quote above.
const FILLER = [
  'The brief opens with background on the buying committee and how it forms.',
  'It walks through the evaluation window, the pilot, and the paperwork after.',
  'It notes which stakeholders read the appendix and which never open it.',
  'It closes with a short list of open questions for the next revision.',
  'None of this padding carries a claim worth extracting on its own.',
  'It exists so the body clears the discovery floor for page extraction.',
  'The remaining lines simply restate the structure of the document itself.',
  'A summary, a body, an appendix, and a list of unresolved follow-ups.',
].join(' ');

const T_SHARED = 'Prototypes beat renders';
const T_OLD = 'Renders close deals';
const T_KEEPER = 'Procurement decides early';
const T_NEW = 'Prototypes survive review';

// Bodies carry their namespace so two cases can never share a content_hash:
// discovery's "already extracted" subquery matches ANY atom in the source with
// that hash, so identical bodies in different namespaces would cross-talk.
const body = (parts: string[], ns: string) => [...parts, FILLER, `Filed under revision marker ${ns}.`].join(' ');
const body1 = (ns: string) => body([Q_SHARED, Q_OLD, Q_KEEPER], ns);
// Q_OLD is gone (the reworded claim); Q_SHARED and Q_KEEPER survive verbatim.
const body2 = (ns: string) => body([Q_SHARED, Q_NEW, Q_KEEPER], ns);
// Only Q_KEEPER survives; Q_SHARED and Q_NEW are both gone.
const body3 = (ns: string) => body([Q_THIRD, Q_KEEPER], ns);

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

/**
 * Persist a body and hand back the hash the phase would have discovered for
 * it. Using the REAL hash matters: reconciliation refuses to act when the live
 * page no longer carries the hash the run is reconciling against.
 */
async function putAndHash(slug: string, title: string, body: string): Promise<string> {
  // 'article' (not 'note') so the page is in the extractable-type allowlist —
  // case (g) drives real discovery.
  await engine.putPage(slug, { type: 'article', title, compiled_truth: body, timeline: '' });
  const rows = await engine.executeRaw<{ h: string }>(
    `SELECT content_hash AS h FROM pages WHERE slug = $1 AND source_id = 'default'`, [slug],
  );
  return rows[0]!.h.slice(0, 16);
}

interface Fixture { ns: string; p: string; q: string; legacyTitle: string; legacySlug: string }

/**
 * Two same-date source pages (so their atoms share the `atoms/2026-07-01/`
 * prefix and only the locator fold separates them) plus a pre-binding-era
 * atom. P is extracted at body1(ns); Q is extracted once and never again, so its
 * atom's hash stays stale for the rest of the fixture.
 */
async function seed(ns: string): Promise<Fixture> {
  const p = `writings/2026-07-01-p-${ns}`;
  const q = `writings/2026-07-01-q-${ns}`;
  const legacySlug = `atoms/2026-07-01/legacy-unbound-${ns}`;
  const legacyTitle = `Legacy unbound atom ${ns}`;

  const h1 = await putAndHash(p, `P ${ns}`, body1(ns));
  const hq = await putAndHash(q, `Q ${ns}`, body([Q_SIBLING], ns));
  // Pre-binding era: no source_slug and no source_path. Deliberately given a
  // stale hash AND a verified quote that appears in no page, so only the
  // missing binding stands between it and the reconciler.
  await engine.putPage(legacySlug, {
    type: 'atom', title: legacyTitle,
    compiled_truth: 'An atom written before source bindings existed.', timeline: '',
    frontmatter: { source_hash: 'ffffffffffffffff', source_quote: Q_LEGACY, source_quote_verified: true },
  });

  const first = await runPhaseExtractAtoms(engine, {
    _transcripts: [],
    _pages: [{ slug: p, content: body1(ns), contentHash: h1 }],
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
    _pages: [{ slug: q, content: body([Q_SIBLING], ns), contentHash: hq }],
    _chat: stubChat([[T_SHARED, Q_SIBLING]]),
  });
  expect(sibling.status).toBe('ok');

  return { ns, p, q, legacyTitle, legacySlug };
}

/** The re-extraction under test: P edited to body2, one claim reworded. */
async function reextract(f: Fixture, pairs: Pair[] = [[T_SHARED, Q_SHARED], [T_NEW, Q_NEW]]) {
  const b2 = body2(f.ns);
  const h2 = await putAndHash(f.p, `P ${f.ns}`, b2);
  return runPhaseExtractAtoms(engine, {
    _transcripts: [],
    _pages: [{ slug: f.p, content: b2, contentHash: h2 }],
    _chat: stubChat(pairs),
  });
}

describe('extract_atoms retires atoms its source page no longer supports (#4566 follow-through)', () => {
  test('(a) a reworded claim is retired; the same-title atom is upserted in place', async () => {
    const f = await seed('a');
    const p = f.p;
    const before = (await atomRow(T_SHARED, p))!;

    const result = await reextract(f);
    expect(result.status).toBe('ok');
    expect(result.details?.atoms_superseded).toBe(1);
    expect(String(result.summary)).toContain('1 superseded');

    // The reworded claim's quote is gone from the page: retired.
    const retired = await atomRow(T_OLD, p);
    expect(retired!.source_hash).toBe(before.source_hash);
    expect(retired!.deleted_at).not.toBeNull();

    // Unchanged title: SAME slug, refreshed hash, still live (upsert in place).
    const shared = await atomRow(T_SHARED, p);
    expect(shared!.slug).toBe(before.slug);
    expect(shared!.deleted_at).toBeNull();
    expect(shared!.source_hash).not.toBe(before.source_hash);

    // The replacement atom is live at the new hash.
    const fresh = await atomRow(T_NEW, p);
    expect(fresh!.deleted_at).toBeNull();
    expect(fresh!.source_hash).toBe(shared!.source_hash);
  }, 120_000);

  test('(a2) an atom the new pass merely omitted is KEPT while its quote survives', async () => {
    const f = await seed('a2');
    const p = f.p;
    const keeperBefore = (await atomRow(T_KEEPER, p))!;
    // T_KEEPER is not re-emitted by the re-extraction, but Q_KEEPER is still
    // in body2 verbatim — omission alone must never retire an atom.
    const result = await reextract(f);
    expect(result.details?.atoms_superseded).toBe(1);

    const keeper = await atomRow(T_KEEPER, p);
    expect(keeper!.deleted_at).toBeNull();
    expect(keeper!.source_hash).toBe(keeperBefore.source_hash); // still stale, still kept
  }, 120_000);

  test('(b) atoms bound elsewhere — sibling page Q, pre-binding era — are untouched', async () => {
    const f = await seed('b');
    const { p, q, legacyTitle, legacySlug } = f;
    const qBefore = await atomRow(T_SHARED, q);
    const legacyBefore = await atomRow(legacyTitle, null);
    expect(qBefore).not.toBeNull();
    expect(qBefore!.slug).not.toBe((await atomRow(T_SHARED, p))!.slug);
    expect(legacyBefore!.slug).toBe(legacySlug);

    await reextract(f);

    expect(await atomRow(T_SHARED, q)).toEqual(qBefore);
    expect(await atomRow(legacyTitle, null)).toEqual(legacyBefore);
  }, 120_000);

  test('(c) reverse control: in that same run, the page\'s own invalidated atom IS retired', async () => {
    const f = await seed('c');
    const p = f.p;
    const result = await reextract(f);
    expect(result.details?.atoms_superseded).toBe(1);
    expect((await atomRow(T_OLD, p))!.deleted_at).not.toBeNull();
  }, 120_000);

  test('(d) dry-run writes nothing and excludes a title it would refresh in place', async () => {
    const f = await seed('d');
    const p = f.p;
    await reextract(f);
    const before = await atomSnapshot();

    // body3 drops BOTH Q_SHARED and Q_NEW, so both of those atoms' quotes are
    // gone. T_SHARED is re-emitted (with a quote from the new body), so the
    // run would refresh it in place and it must NOT be counted; T_NEW is not
    // re-emitted and its quote is gone, so it must be. Without the
    // written-this-run exclusion the count would be 2.
    const b3 = body3(f.ns);
    const h3 = await putAndHash(p, `P ${f.ns}`, b3);
    const result = await runPhaseExtractAtoms(engine, {
      dryRun: true,
      _transcripts: [],
      _pages: [{ slug: p, content: b3, contentHash: h3 }],
      _chat: stubChat([[T_SHARED, Q_THIRD]]),
    });
    expect(result.status).toBe('ok');
    expect(result.details?.dry_run).toBe(true);
    expect(result.details?.atoms_superseded).toBe(1);
    expect(await atomSnapshot()).toEqual(before);
  }, 120_000);

  test('(e) an identical re-run retires nothing and moves no atom in or out of the live set', async () => {
    const f = await seed('e');
    const p = f.p;
    await reextract(f);
    const before = await bindingSnapshot();

    const again = await reextract(f);
    expect(again.status).toBe('ok');
    expect(again.details?.atoms_superseded).toBe(0);
    expect(String(again.summary)).not.toContain('superseded');
    expect(await bindingSnapshot()).toEqual(before);
  }, 120_000);

  test('(f) the zero-yield lane reconciles: an edit that yields no atoms still retires', async () => {
    const f = await seed('f');
    const p = f.p;
    const b2 = body2(f.ns);
    const h2 = await putAndHash(p, `P ${f.ns}`, b2);
    const result = await runPhaseExtractAtoms(engine, {
      _transcripts: [],
      _pages: [{ slug: p, content: b2, contentHash: h2 }],
      _chat: stubChat([]), // model finds nothing extractable in the edited body
    });
    expect(result.status).toBe('ok');
    expect(result.details?.atoms_extracted).toBe(0);
    expect(result.details?.atoms_superseded).toBe(1);
    expect((await atomRow(T_OLD, p))!.deleted_at).not.toBeNull();
    // Omission-immune here too: the zero-yield pass exempts nothing, so only
    // the quote evidence keeps T_KEEPER and T_SHARED alive.
    expect((await atomRow(T_KEEPER, p))!.deleted_at).toBeNull();
    expect((await atomRow(T_SHARED, p))!.deleted_at).toBeNull();
  }, 120_000);

  test('(h) a page edited while the model was thinking is not judged on the stale snapshot', async () => {
    const f = await seed('h');
    const p = f.p;
    const b2 = body2(f.ns);
    const h2 = await putAndHash(p, `P ${f.ns}`, b2);

    const result = await runPhaseExtractAtoms(engine, {
      _transcripts: [],
      _pages: [{ slug: p, content: b2, contentHash: h2 }],
      // The page is edited back to body1 (Q_OLD returns) mid-call, so the
      // snapshot the phase is holding no longer describes the live page.
      _chat: async (o) => {
        await putAndHash(p, `P ${f.ns}`, body1(f.ns));
        return stubChat([[T_SHARED, Q_SHARED], [T_NEW, Q_NEW]])(o);
      },
    });

    // The run really did reach reconciliation — it succeeded and imported its
    // atoms; the zero count is the guard firing, not an early exception.
    expect(result.status).toBe('ok');
    expect(result.details?.atoms_extracted).toBe(2);
    expect(result.details?.atoms_superseded).toBe(0);
    expect((await atomRow(T_OLD, p))!.deleted_at).toBeNull();
  }, 120_000);

  test('(i) a pending row abandoned by an interrupted earlier run is reclaimable', async () => {
    const f = await seed('i');
    const p = f.p;
    // An interrupted run leaves atoms stamped `pending:<its hash>`; nothing
    // else ever reclaims them, so only THIS run's marker is exempt.
    await engine.executeRaw(
      `UPDATE pages SET frontmatter = frontmatter || jsonb_build_object('source_hash', 'pending:aaaaaaaaaaaaaaaa')
        WHERE type = 'atom' AND title = $1 AND frontmatter->>'source_slug' = $2`,
      [T_OLD, p],
    );
    expect((await atomRow(T_OLD, p))!.source_hash).toBe('pending:aaaaaaaaaaaaaaaa');

    const result = await reextract(f);
    expect(result.details?.atoms_superseded).toBe(1);
    expect((await atomRow(T_OLD, p))!.deleted_at).not.toBeNull();
  }, 120_000);

  test('(g) a reconciliation failure leaves the page retryable, and the retry finishes it', async () => {
    const f = await seed('g');
    const p = f.p;
    let failed;
    try {
      // Shadow the prototype method with an own property, and DELETE it to
      // restore: re-assigning an engine-BOUND copy would make the reconciler's
      // transaction write on the outer connection instead of its own and
      // self-deadlock against the row lock it is holding.
      (engine as { softDeletePages?: unknown }).softDeletePages = async () => {
        throw new Error('injected soft-delete failure');
      };
      failed = await reextract(f);
    } finally {
      delete (engine as { softDeletePages?: unknown }).softDeletePages;
    }

    // Surfaced, not swallowed.
    expect(failed.status).toBe('warn');
    const failures = failed.details?.failures as Array<{ source: string; error: string }>;
    expect(failures.some(f => f.source === p && f.error.includes('injected soft-delete failure'))).toBe(true);
    expect(failed.details?.atoms_superseded).toBe(0);

    // And still retryable: the completion markers were never written, so REAL
    // discovery (not the _pages seam) still offers the page.
    const discovered = await discoverExtractablePages(engine, 'default');
    expect(discovered.some(d => d.slug === p)).toBe(true);

    const retry = await reextract(f);
    expect(retry.status).toBe('ok');
    expect(retry.details?.atoms_superseded).toBe(1);
    expect((await atomRow(T_OLD, p))!.deleted_at).not.toBeNull();
    expect((await discoverExtractablePages(engine, 'default')).some(d => d.slug === p)).toBe(false);
  }, 120_000);
});
