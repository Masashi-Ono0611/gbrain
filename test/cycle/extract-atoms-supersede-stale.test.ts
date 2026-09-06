/**
 * #4566 follow-through — extract_atoms supersedes a re-extracted page's stale
 * atoms.
 *
 * The doctor's `atom_provenance_drift` check counts atoms whose `source_hash`
 * matches no live page and never deletes; its `source_changed` bucket (source
 * page edited, atom left behind) had nothing to reclaim it. The page lane now
 * soft-deletes, right after a page's replacement atom set has been imported
 * and stamped, every live atom bound to THAT page whose `source_hash` is
 * neither the in-flight `pending:` marker nor the page's current hash and
 * whose slug was not written by this run.
 *
 * What the cases pin:
 *   (a) reworded claim → the old atom is soft-deleted, the same-title atom is
 *       upserted IN PLACE (same slug, refreshed hash), the new atom is live.
 *   (b) live-mix: an atom bound to a DIFFERENT page (same date prefix, same
 *       title — the #4733 locator-fold case) and a pre-binding-era atom (no
 *       source_slug/source_path) are both untouched.
 *   (c) reverse control for (b): in that same run, P's own stale atom WAS
 *       soft-deleted — so (b) cannot pass vacuously on a no-op implementation.
 *   (d) dry-run: no row changes at all, and the would-be count is reported.
 *   (e) idempotency: an identical re-run supersedes nothing and changes
 *       nothing.
 *
 * PGLite round-trip with a stubbed chat gateway (no model calls).
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

// Two same-date source pages, so their atoms share the `atoms/2026-07-01/`
// slug prefix and only the locator fold separates them.
const P = 'writings/2026-07-01-p-brief';
const Q = 'writings/2026-07-01-q-brief';
const H1 = '1111111111111111';
const H2 = '2222222222222222';
const H3 = '3333333333333333';
const HQ = '4444444444444444';

const T_SHARED = 'Prototypes beat renders';
const T_OLD = 'Enterprise buyers want renders';
const T_NEW = 'Enterprise buyers want tangible prototypes';
const T_THIRD = 'Procurement decides before the demo';

const LEGACY_SLUG = 'atoms/2026-07-01/legacy-unbound-atom-000000';
const LEGACY_TITLE = 'Legacy unbound atom';

const stubChat = (titles: string[]) => async (_o: ChatOpts): Promise<ChatResult> => ({
  text: JSON.stringify(
    titles.map(title => ({ title, atom_type: 'insight', body: `Body for ${title}.` })),
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
};

/** Every atom row in the brain, full enough that any write shows up. */
async function atomSnapshot(): Promise<AtomRow[]> {
  return await engine.executeRaw<AtomRow>(
    `SELECT slug, title, deleted_at::text AS deleted_at, updated_at::text AS updated_at,
            content_hash,
            frontmatter->>'source_hash' AS source_hash,
            frontmatter->>'source_slug' AS source_slug
       FROM pages WHERE type = 'atom' ORDER BY slug`,
  );
}

/**
 * The state this reconciliation owns: identity, liveness, binding. A re-run
 * legitimately re-imports each atom (extracted_at moves, so content_hash and
 * updated_at move with it) — that is the pre-existing upsert, not a
 * supersede, so the idempotency case asserts stillness on THIS projection.
 */
async function bindingSnapshot(): Promise<Array<Omit<AtomRow, 'updated_at' | 'content_hash'>>> {
  return (await atomSnapshot()).map(({ slug, title, deleted_at, source_hash, source_slug }) => ({
    slug, title, deleted_at, source_hash, source_slug,
  }));
}

/** One atom, keyed by title + binding (T_SHARED exists for both P and Q). */
async function atomRow(title: string, sourceSlug: string | null): Promise<AtomRow | null> {
  const rows = await engine.executeRaw<AtomRow>(
    `SELECT slug, title, deleted_at::text AS deleted_at, updated_at::text AS updated_at,
            content_hash,
            frontmatter->>'source_hash' AS source_hash,
            frontmatter->>'source_slug' AS source_slug
       FROM pages
      WHERE type = 'atom' AND title = $1
        AND frontmatter->>'source_slug' IS NOT DISTINCT FROM $2`,
    [title, sourceSlug],
  );
  return rows[0] ?? null;
}

// Captured before the re-extraction so (b) can assert byte-level stillness.
let qBefore: AtomRow | null = null;
let legacyBefore: AtomRow | null = null;
let sharedSlugBefore = '';

describe('extract_atoms supersedes stale atoms of a re-extracted page (#4566 follow-through)', () => {
  test('setup: P extracted at H1, sibling page Q extracted, plus a pre-binding-era atom', async () => {
    await engine.putPage(P, {
      type: 'note', title: 'P Brief',
      compiled_truth: 'A long brief with extractable claims.', timeline: '',
    });
    await engine.putPage(Q, {
      type: 'note', title: 'Q Brief',
      compiled_truth: 'A second brief with extractable claims.', timeline: '',
    });
    // Pre-binding era: an atom with NO source_slug and NO source_path. It is
    // adoptable by an upsert but bound to nothing, so it must never be reaped.
    await engine.putPage(LEGACY_SLUG, {
      type: 'atom', title: LEGACY_TITLE,
      compiled_truth: 'An atom written before source bindings existed.', timeline: '',
      frontmatter: { source_hash: 'ffffffffffffffff' },
    });

    const first = await runPhaseExtractAtoms(engine, {
      _transcripts: [],
      _pages: [{ slug: P, content: 'A long brief with extractable claims.', contentHash: H1 }],
      _chat: stubChat([T_SHARED, T_OLD]),
    });
    expect(first.status).toBe('ok');
    expect(first.details?.atoms_extracted).toBe(2);
    expect(first.details?.atoms_superseded).toBe(0);

    // Q emits the SAME atom title on the SAME date — distinct slug via the
    // #4733 locator fold — and is never re-extracted, so its source_hash stays
    // stale relative to P's current content for the rest of the fixture.
    const sibling = await runPhaseExtractAtoms(engine, {
      _transcripts: [],
      _pages: [{ slug: Q, content: 'A second brief with extractable claims.', contentHash: HQ }],
      _chat: stubChat([T_SHARED]),
    });
    expect(sibling.status).toBe('ok');

    const sharedP = await atomRow(T_SHARED, P);
    qBefore = await atomRow(T_SHARED, Q);
    legacyBefore = await atomRow(LEGACY_TITLE, null);
    expect(sharedP?.source_hash).toBe(H1);
    expect(qBefore?.source_hash).toBe(HQ);
    expect(qBefore!.slug).not.toBe(sharedP!.slug);
    expect(legacyBefore?.slug).toBe(LEGACY_SLUG);
    sharedSlugBefore = sharedP!.slug;
  }, 120_000);

  test('(a) re-extraction supersedes the reworded atom, upserts the unchanged one in place', async () => {
    const result = await runPhaseExtractAtoms(engine, {
      _transcripts: [],
      _pages: [{ slug: P, content: 'A long brief, one claim reworded.', contentHash: H2 }],
      _chat: stubChat([T_SHARED, T_NEW]),
    });
    expect(result.status).toBe('ok');
    expect(result.details?.atoms_superseded).toBe(1);
    expect(String(result.summary)).toContain('1 superseded');

    // Unchanged title: SAME slug, refreshed hash, still live (upsert in place).
    const shared = await atomRow(T_SHARED, P);
    expect(shared!.slug).toBe(sharedSlugBefore);
    expect(shared!.deleted_at).toBeNull();
    expect(shared!.source_hash).toBe(H2);

    // The replacement atom is live at the new hash.
    const fresh = await atomRow(T_NEW, P);
    expect(fresh!.deleted_at).toBeNull();
    expect(fresh!.source_hash).toBe(H2);
  }, 120_000);

  test('(b) atoms bound elsewhere — sibling page Q, pre-binding era — are untouched', async () => {
    const qAfter = await atomRow(T_SHARED, Q);
    expect(qAfter).toEqual(qBefore);
    expect(qAfter!.deleted_at).toBeNull();
    expect(qAfter!.source_hash).toBe(HQ);

    const legacyAfter = await atomRow(LEGACY_TITLE, null);
    expect(legacyAfter).toEqual(legacyBefore);
    expect(legacyAfter!.deleted_at).toBeNull();
  });

  test('(c) reverse control: P\'s own stale atom in that same run WAS soft-deleted', async () => {
    const stale = await atomRow(T_OLD, P);
    expect(stale).not.toBeNull();
    expect(stale!.source_hash).toBe(H1);
    expect(stale!.deleted_at).not.toBeNull();
  });

  test('(e) an identical re-run supersedes nothing and moves no atom in or out of the live set', async () => {
    const before = await bindingSnapshot();
    const result = await runPhaseExtractAtoms(engine, {
      _transcripts: [],
      _pages: [{ slug: P, content: 'A long brief, one claim reworded.', contentHash: H2 }],
      _chat: stubChat([T_SHARED, T_NEW]),
    });
    expect(result.status).toBe('ok');
    expect(result.details?.atoms_superseded).toBe(0);
    expect(String(result.summary)).not.toContain('superseded');
    expect(await bindingSnapshot()).toEqual(before);
  }, 120_000);

  test('(d) dry-run reports the would-be count and writes nothing', async () => {
    const before = await atomSnapshot();
    const result = await runPhaseExtractAtoms(engine, {
      dryRun: true,
      _transcripts: [],
      _pages: [{ slug: P, content: 'A long brief, rewritten again.', contentHash: H3 }],
      // Neither surviving title is re-emitted, so both of P's live atoms
      // would be superseded by a real run.
      _chat: stubChat([T_THIRD]),
    });
    expect(result.status).toBe('ok');
    expect(result.details?.dry_run).toBe(true);
    expect(result.details?.atoms_superseded).toBe(2);
    expect(await atomSnapshot()).toEqual(before);
  }, 120_000);
});
