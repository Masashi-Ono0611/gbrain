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
 *       source_slug/source_path) are untouched, even though neither carries
 *       the hash being reconciled and neither's quote is in this page. Only
 *       the binding check saves them. (Q's own hash is current for Q; it is
 *       simply not P's.)
 *   (c) reverse control for (b): the same run DID soft-delete the page's own
 *       invalidated atom — so (b) cannot pass vacuously on a no-op.
 *   (d) dry-run: no row changes at all, and the reported would-be count
 *       excludes a title this run would refresh in place.
 *   (e) a changed hash with every quote preserved retires nothing and leaves
 *       an omitted atom's old binding alone.
 *   (f) the zero-yield lane reconciles too: an edit that leaves no extractable
 *       claim still retires the atoms whose quotes it deleted.
 *   (g) a reconciliation failure leaves the page RETRYABLE — it lands before
 *       the completion markers, so real discovery still returns the page and
 *       the next run finishes the job.
 *   (j) a cosmetic edit is not evidence: NFKC-equal text (NFD re-encode,
 *       full-width punctuation) and markdown reshaping (emphasis, a link,
 *       re-bulleting) keep their atoms, while a genuinely deleted sentence
 *       still retires — the reverse control that keeps (j) honest.
 *   (k) a retirement is not permanent: reverting the page re-discovers it and
 *       the re-extraction revives the retired atom in place, because the atoms
 *       kept on evidence were re-anchored to the hash that retired it.
 *   (l) deletion and re-anchoring each process two full batches plus a tail.
 *
 * Every case seeds its own page namespace and drives the phase with the page's
 * REAL persisted content hash, so the reconciliation's "page still carries
 * this hash" guard is exercised rather than bypassed. PGLite round-trip,
 * stubbed chat gateway.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { DELETE_BATCH_SIZE } from '../../src/core/engine-constants.ts';
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

/** Complete source and atom rows, including all frontmatter and timestamps. */
async function reconciliationSnapshot(pageSlug: string) {
  return engine.executeRaw(
    `SELECT * FROM pages WHERE type = 'atom' OR (source_id = 'default' AND slug = $1)
      ORDER BY source_id, slug`,
    [pageSlug],
  );
}

function isReanchorUpdate(sql: string): boolean {
  return /^\s*UPDATE pages/.test(sql)
    && sql.includes("jsonb_build_object('source_hash', $3::text)");
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
 * atom. P is extracted at body1(ns); Q is extracted once and never again, so
 * Q's atom keeps Q's hash — current for Q, but never P's.
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
  // #4733 locator fold — with a quote that lives only in Q's own body, so
  // reconciling P sees a bound-elsewhere row whose quote P does not contain.
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
    // Kept on evidence — and therefore RE-ANCHORED: its quote is in the body
    // at the new hash, and a live atom still carrying the OLD hash would mask
    // that content in discovery forever, so a revert could never re-earn what
    // this run retired (case (j)).
    expect(keeper!.source_hash).not.toBe(keeperBefore.source_hash);
    expect(keeper!.source_hash).toBe((await atomRow(T_SHARED, p))!.source_hash);
    expect(result.details?.atoms_reanchored).toBe(1);
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

    // body3 drops BOTH Q_SHARED and Q_NEW, so both of those atoms' quotes are
    // gone. T_SHARED is re-emitted (with a quote from the new body), so the
    // run would refresh it in place and it must NOT be counted; T_NEW is not
    // re-emitted and its quote is gone, so it must be. Without the
    // written-this-run exclusion the count would be 2.
    const b3 = body3(f.ns);
    const h3 = await putAndHash(p, `P ${f.ns}`, b3);
    const before = await reconciliationSnapshot(p);
    let deleteCalls = 0;
    let reanchorCalls = 0;
    let result;
    try {
      // Unbound wrappers preserve the transaction engine's `this` as well.
      engine.softDeletePages = async function (slugs, opts) {
        deleteCalls++;
        return PGLiteEngine.prototype.softDeletePages.call(this, slugs, opts);
      };
      engine.executeRaw = async function <T>(sql: string, params?: unknown[]): Promise<T[]> {
        if (isReanchorUpdate(sql)) reanchorCalls++;
        return PGLiteEngine.prototype.executeRaw.call(this, sql, params) as Promise<T[]>;
      };
      result = await runPhaseExtractAtoms(engine, {
        dryRun: true,
        _transcripts: [],
        _pages: [{ slug: p, content: b3, contentHash: h3 }],
        _chat: stubChat([[T_SHARED, Q_THIRD]]),
      });
    } finally {
      delete (engine as { softDeletePages?: unknown }).softDeletePages;
      delete (engine as { executeRaw?: unknown }).executeRaw;
    }
    expect(result.status).toBe('ok');
    expect(result.details?.dry_run).toBe(true);
    expect(result.details?.atoms_superseded).toBe(1);
    expect(result.details?.atoms_reanchored).toBe(1);
    expect(deleteCalls).toBe(0);
    expect(reanchorCalls).toBe(0);
    expect(await reconciliationSnapshot(p)).toEqual(before);
  }, 120_000);

  test('(e) a changed hash with every quote preserved does not re-bind an omitted atom', async () => {
    const f = await seed('e');
    const p = f.p;
    const before = (await atomRow(T_KEEPER, p))!;
    expect(before.verified).toBe('true');
    const edited = body([Q_SHARED, Q_OLD, Q_KEEPER], `${f.ns} revised metadata`);
    const h2 = await putAndHash(p, `P ${f.ns}`, edited);
    expect(h2).not.toBe(before.source_hash);

    const again = await runOne(p, edited, h2, [[T_SHARED, Q_SHARED], [T_OLD, Q_OLD]]);
    expect(again.status).toBe('ok');
    expect(again.details?.atoms_extracted).toBe(2);
    expect(again.details?.atoms_superseded).toBe(0);
    expect(again.details?.atoms_reanchored).toBe(0); // no retirement, no re-binding
    expect(String(again.summary)).not.toContain('superseded');
    expect(await atomRow(T_KEEPER, p)).toEqual(before);
    expect((await atomRow(T_KEEPER, p))!.source_hash).toBe(before.source_hash);
    expect((await atomRow(T_OLD, p))!.deleted_at).toBeNull();
    expect((await atomRow(T_SHARED, p))!.deleted_at).toBeNull();
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
    const retiredBefore = (await atomRow(T_OLD, p))!;
    const keeperBefore = (await atomRow(T_KEEPER, p))!;
    let deletedSlugs: string[] = [];
    let deleteEngine: PGLiteEngine | undefined;
    let reanchorCompleted = false;
    let failed;
    try {
      // Shadow the prototype method with an own property, and DELETE it to
      // restore: re-assigning an engine-BOUND copy would make the reconciler's
      // transaction write on the outer connection instead of its own and
      // self-deadlock against the row lock it is holding.
      engine.softDeletePages = async function (slugs, opts) {
        const deleted = await PGLiteEngine.prototype.softDeletePages.call(this, slugs, opts);
        deleteEngine = this;
        deletedSlugs.push(...deleted);
        return deleted;
      };
      engine.executeRaw = async function <T>(sql: string, params?: unknown[]): Promise<T[]> {
        const rows = await PGLiteEngine.prototype.executeRaw.call(this, sql, params) as T[];
        if (isReanchorUpdate(sql)) {
          expect(this === deleteEngine).toBe(true);
          expect(this).not.toBe(engine);
          expect(deletedSlugs).toEqual([retiredBefore.slug]);
          expect(rows as Array<{ slug: string }>).toEqual([{ slug: keeperBefore.slug }]);
          // Fail AFTER both writes actually ran on the same transaction.
          // Without rollback, both the deletion and the new binding leak.
          reanchorCompleted = true;
          throw new Error('injected re-anchor failure');
        }
        return rows;
      };
      failed = await reextract(f);
    } finally {
      delete (engine as { softDeletePages?: unknown }).softDeletePages;
      delete (engine as { executeRaw?: unknown }).executeRaw;
    }

    // Surfaced, not swallowed.
    expect(reanchorCompleted).toBe(true);
    expect(failed.status).toBe('warn');
    const failures = failed.details?.failures as Array<{ source: string; error: string }>;
    expect(failures.some(f => f.source === p && f.error.includes('injected re-anchor failure'))).toBe(true);
    expect(failed.details?.atoms_superseded).toBe(0);
    expect(failed.details?.atoms_reanchored).toBe(0);
    expect((await atomRow(T_OLD, p))!.deleted_at).toBeNull();
    expect(await atomRow(T_OLD, p)).toEqual(retiredBefore);
    expect((await atomRow(T_KEEPER, p))!.deleted_at).toBeNull();
    expect((await atomRow(T_KEEPER, p))!.source_hash).toBe(keeperBefore.source_hash);
    expect(await atomRow(T_KEEPER, p)).toEqual(keeperBefore);

    // And still retryable: the completion markers were never written, so REAL
    // discovery (not the _pages seam) still offers the page.
    const discovered = await discoverExtractablePages(engine, 'default');
    expect(discovered.some(d => d.slug === p)).toBe(true);

    const retry = await reextract(f);
    expect(retry.status).toBe('ok');
    expect(retry.details?.atoms_superseded).toBe(1);
    expect(retry.details?.atoms_reanchored).toBe(1);
    expect((await atomRow(T_OLD, p))!.deleted_at).not.toBeNull();
    expect((await atomRow(T_KEEPER, p))!.source_hash).not.toBe(keeperBefore.source_hash);
    expect((await discoverExtractablePages(engine, 'default')).some(d => d.slug === p)).toBe(false);
  }, 120_000);
});

/**
 * Probe-derived: an independent adversarial probe of this branch found the
 * retirement gate destroying atoms over edits that changed only bytes, and
 * making a retirement permanent across a revert. These cases pin both fixes
 * (and the reverse control that keeps them from passing vacuously).
 */

/** Drive the phase over one page with a stubbed model reply. */
async function runOne(slug: string, content: string, contentHash: string, pairs: Pair[]) {
  return runPhaseExtractAtoms(engine, {
    _transcripts: [],
    _pages: [{ slug, content, contentHash }],
    _chat: stubChat(pairs),
  });
}

/** A page whose body carries `quoted`, with one atom verified against it. */
async function seedVerified(ns: string, quoted: string, title: string): Promise<[slug: string, body: string]> {
  const slug = `writings/2026-07-01-${ns}`;
  const b = body([quoted], ns);
  const h = await putAndHash(slug, `P ${ns}`, b);
  const first = await runOne(slug, b, h, [[title, quoted]]);
  expect(first.status).toBe('ok');
  // Load-bearing: an unverified quote makes every assertion below vacuous.
  expect((await atomRow(title, slug))!.verified).toBe('true');
  expect((await atomRow(title, slug))!.deleted_at).toBeNull();
  return [slug, b];
}

/** Re-put an edited body and reconcile it in the zero-yield lane (nothing exempt). */
async function editAndReconcile(slug: string, ns: string, edited: string) {
  const h = await putAndHash(slug, `P ${ns}`, edited);
  return runOne(slug, edited, h, []);
}

describe('(j) a cosmetically edited page keeps its atoms', () => {
  for (const { ns, quoted, pageCopy } of [
    {
      ns: 'j-bullet-boundary',
      quoted: 'Results: - Alpha is enabled.',
      pageCopy: 'Results:\n- Alpha is enabled.',
    },
    {
      ns: 'j-balanced-link',
      quoted: 'Use the prototype for procurement.',
      pageCopy: 'Use [the prototype](https://example.invalid/a_(b)) for procurement.',
    },
    {
      ns: 'j-mid-link',
      quoted: '[Procurement](https://ex',
      pageCopy: '[Procurement](https://example.invalid/p) decides before the demo.',
    },
  ]) {
    test(`${ns}: a supported quote survives markdown normalization boundaries`, async () => {
      const [slug, seeded] = await seedVerified(ns, quoted, ns);
      const before = (await atomRow(ns, slug))!;
      const edited = seeded.replace(quoted, pageCopy);
      const r = await editAndReconcile(slug, ns, edited);
      expect(r.status).toBe('ok');
      expect(r.details?.atoms_superseded).toBe(0);
      expect((await atomRow(ns, slug))!.deleted_at).toBeNull();
      expect((await atomRow(ns, slug))!.source_hash).toBe(before.source_hash);
    }, 120_000);
  }

  test('NFD re-encoding of Japanese prose is not a deleted claim', async () => {
    const quoted = 'ダミーのプロトタイプでも購買部長は納得する。';
    const [slug, seeded] = await seedVerified('j-nfd', quoted, 'JP claim');
    // Same visible text, decomposed — what a re-import from an NFD-producing
    // source (macOS filesystem, some clipboard paths) yields.
    const edited = seeded.normalize('NFD');
    expect(edited).not.toBe(seeded);

    const r = await editAndReconcile(slug, 'j-nfd', edited);
    expect(r.details?.atoms_superseded).toBe(0);
    expect((await atomRow('JP claim', slug))!.deleted_at).toBeNull();
  }, 120_000);

  test('half-width → full-width punctuation is not a deleted claim', async () => {
    const quoted = 'The pilot budget (approved in Q2) outlives its quarter.';
    const [slug, seeded] = await seedVerified('j-width', quoted, 'Width claim');
    const edited = seeded.replace(/\(/g, '（').replace(/\)/g, '）');

    const r = await editAndReconcile(slug, 'j-width', edited);
    expect(r.details?.atoms_superseded).toBe(0);
    expect((await atomRow('Width claim', slug))!.deleted_at).toBeNull();
  }, 120_000);

  test('emphasis added inside the quoted span is not a deleted claim', async () => {
    const quoted = 'A working prototype survives the procurement review here.';
    const [slug, seeded] = await seedVerified('j-em', quoted, 'Emphasis claim');
    const edited = seeded.replace('prototype', '**prototype**');

    const r = await editAndReconcile(slug, 'j-em', edited);
    expect(r.details?.atoms_superseded).toBe(0);
    expect((await atomRow('Emphasis claim', slug))!.deleted_at).toBeNull();
  }, 120_000);

  test('a link wrapped around a quoted word is not a deleted claim', async () => {
    const quoted = 'Procurement decides long before the demo is booked.';
    const [slug, seeded] = await seedVerified('j-link', quoted, 'Link claim');
    const edited = seeded.replace('Procurement', '[Procurement](https://example.invalid/p)');

    const r = await editAndReconcile(slug, 'j-link', edited);
    expect(r.details?.atoms_superseded).toBe(0);
    expect((await atomRow('Link claim', slug))!.deleted_at).toBeNull();
  }, 120_000);

  test('reflowing and then re-bulleting a two-sentence quote is not a deleted claim', async () => {
    const quoted = 'Enterprise buyers want tangible prototypes here. Pilot budgets outlive the quarter here.';
    const [slug] = await seedVerified('j-flow', quoted, 'Span claim');

    // (i) pure whitespace reflow — the strict grounding fold already handled
    // this one; it is the control for the markdown folds.
    const reflow = [
      'Enterprise buyers want tangible prototypes here.\n\n   Pilot budgets outlive the quarter here.',
      FILLER, 'Filed under revision marker j-flow reflow.',
    ].join('\n');
    const rR = await editAndReconcile(slug, 'j-flow', reflow);
    expect(rR.details?.atoms_superseded).toBe(0);
    expect((await atomRow('Span claim', slug))!.deleted_at).toBeNull();

    // (ii) the same two sentences as list items. Claims unchanged.
    const bulleted = [
      '- Enterprise buyers want tangible prototypes here.',
      '- Pilot budgets outlive the quarter here.',
      FILLER, 'Filed under revision marker j-flow bullets.',
    ].join('\n');
    const rB = await editAndReconcile(slug, 'j-flow', bulleted);
    expect(rB.details?.atoms_superseded).toBe(0);
    expect((await atomRow('Span claim', slug))!.deleted_at).toBeNull();
  }, 120_000);

  test('reverse control: a genuinely deleted sentence IS still retired', async () => {
    // Without this the whole (j) group could pass on a reconciler that never
    // retires anything.
    const quoted = 'Renders close deals faster than anything physical here.';
    const [slug] = await seedVerified('j-control', quoted, 'Gone claim');
    const edited = body(['A wholly different claim now stands in its place.'], 'j-control edited');

    const r = await editAndReconcile(slug, 'j-control', edited);
    expect(r.details?.atoms_superseded).toBe(1);
    expect((await atomRow('Gone claim', slug))!.deleted_at).not.toBeNull();
  }, 120_000);
});

describe('(k) a retirement survives a revert', () => {
  test('reverting the page re-discovers it and the re-extraction revives the atom', async () => {
    const ns = 'k';
    const slug = `writings/2026-07-01-${ns}`;
    const qA = 'Enterprise buyers want tangible prototypes in the k body.';
    const qB = 'Renders close deals faster than anything physical in the k body.';
    const qK = 'Procurement decides long before the demo in the k body.';

    const b1 = body([qA, qB, qK], `${ns} one`);
    const h1 = await putAndHash(slug, `P ${ns}`, b1);
    const first = await runOne(slug, b1, h1, [['k a', qA], ['k b', qB], ['k k', qK]]);
    expect(first.details?.atoms_extracted).toBe(3);

    // Edit: qB is gone. Re-emit only 'k a', so 'k k' stays live on evidence
    // while still carrying h1 — the row that used to mask h1 forever.
    const b2 = body([qA, qK], `${ns} two`);
    const h2 = await putAndHash(slug, `P ${ns}`, b2);
    const second = await runOne(slug, b2, h2, [['k a', qA]]);
    expect(second.details?.atoms_superseded).toBe(1);
    expect(second.details?.atoms_reanchored).toBe(1);
    expect((await atomRow('k b', slug))!.deleted_at).not.toBeNull();
    expect((await atomRow('k k', slug))!.source_hash).toBe(h2);

    // Revert the page to its original body: no live atom carries h1 any more,
    // so discovery offers the page again...
    await putAndHash(slug, `P ${ns}`, b1);
    expect((await discoverExtractablePages(engine, 'default')).some(d => d.slug === slug)).toBe(true);

    // ...and re-extracting it revives the retired atom in place (deterministic
    // slug → upsert, not a duplicate).
    const retiredSlug = (await atomRow('k b', slug))!.slug;
    const third = await runOne(slug, b1, h1, [['k b', qB]]);
    expect(third.status).toBe('ok');
    const revived = await atomRow('k b', slug);
    expect(revived!.slug).toBe(retiredSlug);
    expect(revived!.deleted_at).toBeNull();
  }, 120_000);
});

describe('(l) a wide page retires and re-anchors every eligible atom in one pass', () => {
  test('two full batches plus one tail row on both mutation paths', async () => {
    const ns = 'l';
    const slug = `writings/2026-07-01-${ns}`;
    const candidates = 2 * DELETE_BATCH_SIZE + 1;
    const gone = 'The l original claim stands here plainly.';
    const kept = 'The l preserved claim still stands here plainly.';
    const h1 = await putAndHash(slug, `P ${ns}`, body([gone, kept], `${ns} one`));
    // One bulk INSERT keeps 2,002 fixture rows cheap; each group contains
    // 1,001 distinct atoms with a verified quote from the original body.
    await engine.executeRaw(
      `INSERT INTO pages (source_id, slug, type, title, compiled_truth, frontmatter)
       SELECT 'default', 'atoms/2026-07-01/l-' || kind || '-' || i, 'atom',
              'l ' || kind || ' atom ' || i, 'Atom ' || i,
              jsonb_build_object('source_slug', $1::text, 'source_hash', $2::text,
                                 'source_quote', quote, 'source_quote_verified', true)
         FROM generate_series(1, $3::int) AS s(i)
         CROSS JOIN (VALUES ('retire', $4::text), ('keep', $5::text)) AS groups(kind, quote)`,
      [slug, h1, candidates, gone, kept],
    );

    const edited = body([kept], `${ns} two`);
    const h2 = await putAndHash(slug, `P ${ns}`, edited);
    expect(h2).not.toBe(h1);
    const deleteBatches: number[] = [];
    const reanchorBatches: number[] = [];
    let r;
    try {
      engine.softDeletePages = async function (slugs, opts) {
        deleteBatches.push(slugs.length);
        return PGLiteEngine.prototype.softDeletePages.call(this, slugs, opts);
      };
      engine.executeRaw = async function <T>(sql: string, params?: unknown[]): Promise<T[]> {
        if (isReanchorUpdate(sql)) reanchorBatches.push((params![3] as string[]).length);
        return PGLiteEngine.prototype.executeRaw.call(this, sql, params) as Promise<T[]>;
      };
      r = await runOne(slug, edited, h2, []);
    } finally {
      delete (engine as { softDeletePages?: unknown }).softDeletePages;
      delete (engine as { executeRaw?: unknown }).executeRaw;
    }
    expect(r.status).toBe('ok');
    expect(deleteBatches).toEqual([DELETE_BATCH_SIZE, DELETE_BATCH_SIZE, 1]);
    expect(reanchorBatches).toEqual([DELETE_BATCH_SIZE, DELETE_BATCH_SIZE, 1]);
    expect(r.details?.atoms_superseded).toBe(candidates);
    expect(r.details?.atoms_reanchored).toBe(candidates);
    const rows = await engine.executeRaw<{ total: number; retired: number; reanchored: number }>(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE slug LIKE 'atoms/2026-07-01/l-retire-%'
                AND deleted_at IS NOT NULL AND frontmatter->>'source_hash' = $2)::int AS retired,
              count(*) FILTER (WHERE slug LIKE 'atoms/2026-07-01/l-keep-%'
                AND deleted_at IS NULL AND frontmatter->>'source_hash' = $3)::int AS reanchored
         FROM pages WHERE source_id = 'default' AND type = 'atom'
           AND frontmatter->>'source_slug' = $1`,
      [slug, h1, h2],
    );
    expect(rows).toEqual([{ total: 2 * candidates, retired: candidates, reanchored: candidates }]);
  }, 180_000);
});
