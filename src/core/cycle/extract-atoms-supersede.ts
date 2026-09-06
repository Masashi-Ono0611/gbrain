// Peeled out of extract-atoms.ts: the page lane's stale-atom reconciliation,
// kept in its own module so the phase file stays under the module-size
// ratchet.

import type { BrainEngine } from '../engine.ts';
import { DELETE_BATCH_SIZE } from '../engine-constants.ts';
import { normForGrounding } from './synthesize-verify.ts';

/**
 * #4566 follow-through — reclaim the atoms a re-extracted page has invalidated.
 *
 * The doctor's `atom_provenance_drift` check counts atoms whose `source_hash`
 * matches no live page and is explicitly diagnostic: it never deletes. Its
 * larger bucket (`source_changed` — the source page still exists, it was
 * merely edited) had nothing to reclaim it. Re-extraction upserts an atom in
 * place only when the new pass produces the SAME title; a reworded claim
 * lands on a new deterministic slug and the old atom stays behind, still
 * searchable, still carrying a `source_quote` no current page contains.
 *
 * OMISSION IS NOT EVIDENCE. The extractor sees a truncated cut of the page and
 * is asked for a handful of atoms, so "this atom is not in the new set" does
 * NOT mean the claim is gone — the same page can legitimately yield a
 * different selection on the next pass. Deleting on omission alone would
 * destroy still-valid atoms (soft-deletes are purged after the recovery
 * window). So the gate is the same evidence the doctor check reports on: the
 * atom's own VERIFIED quote can no longer be found in the page's current
 * content. Everything else is left alone.
 *
 * An atom is superseded only when ALL of these hold:
 *   - `type = 'atom'`, live, in the SAME source as the write;
 *   - `source_slug` EQUALS this page's slug. This is the strict subset of
 *     extract-atoms' `isCompatibleAtomBinding`: that predicate also adopts a
 *     pre-binding-era row (no `source_slug`/`source_path`) for upsert, but
 *     such a row is not bound to THIS page, so it is never reaped.
 *     Transcript-lane atoms carry `source_path` and no `source_slug`, so they
 *     cannot match either;
 *   - `source_hash` is present and is neither the page's current hash16 nor
 *     THIS run's in-flight `pending:<hash16>` marker — the page's OWN current
 *     content is the staleness authority, judged inside the run that just
 *     wrote it. A `pending:` row left behind by an INTERRUPTED earlier run is
 *     deliberately eligible: nothing else ever reclaims it, and it is judged
 *     on the same quote evidence as any other row;
 *   - the slug was NOT written by this run for this page (`keepSlugs`) — a
 *     same-title atom is refreshed in place, not superseded;
 *   - the atom carries `source_quote_verified: true` AND that quote is absent
 *     from `currentContent`. Atoms with no quote, or with a quote that was
 *     never verified against its source (pre-#4706 rows, `quote_unverified`
 *     paraphrases), carry no evidence either way and are never reaped.
 *
 * Presence is a plain normalized-containment test over the page's FULL current
 * content — deliberately looser than extract-atoms' `locateQuote` (which also
 * demands character-aligned boundaries and uniqueness) and applied to the
 * whole page rather than the model's truncated cut. Both choices err toward
 * "still present", i.e. toward keeping the atom.
 *
 * `currentContent` is the snapshot the phase read before the model call, so
 * the work is gated on the live page STILL carrying `hash16`: if the page was
 * edited while the model was thinking, the snapshot no longer describes it and
 * the reconciliation yields nothing rather than judging a claim against text
 * that has moved. When there IS something to retire, the write re-runs the
 * whole judgement inside a transaction that holds a `FOR UPDATE` row lock on
 * the source page, so an edit cannot land between the evidence check and the
 * soft-delete either. Pages with nothing to retire — the overwhelming majority
 * — never open a transaction, so the batch phase keeps paying one SELECT.
 *
 * Soft-delete via `softDeletePages`, so rows stay recoverable inside the usual
 * purge window rather than being destroyed. Returns the number of rows
 * actually flipped active → soft-deleted. `dryRun` runs the SELECT only and
 * returns the would-be count without touching a row.
 *
 * Atoms whose source page was DELETED (the doctor's `source_gone` bucket) are
 * out of scope: this only ever runs for a page that was just re-extracted.
 */
interface SupersedeArgs {
  sourceId: string;
  pageSlug: string;
  hash16: string;
  currentContent: string;
  keepSlugs: string[];
  dryRun: boolean;
}

/**
 * The evidence query: which of this page's atoms its current text no longer
 * supports. `lock` adds `FOR UPDATE` so the transactional pass holds the
 * candidate atom rows themselves — otherwise a concurrent import could refresh
 * an atom's quote between the judgement and the soft-delete, and the delete
 * (which matches on slug alone) would retire a row that is supported again.
 */
async function findUnsupportedAtoms(
  engine: BrainEngine,
  args: SupersedeArgs,
  lock = false,
): Promise<string[]> {
  const rows = await engine.executeRaw<{ slug: string; quote: string | null; verified: string | null }>(
    `SELECT slug,
            frontmatter->>'source_quote' AS quote,
            frontmatter->>'source_quote_verified' AS verified
       FROM pages
      WHERE source_id = $1
        AND type = 'atom'
        AND deleted_at IS NULL
        AND frontmatter->>'source_slug' = $2
        AND frontmatter->>'source_hash' IS NOT NULL
        AND frontmatter->>'source_hash' <> ('pending:' || $3)
        AND frontmatter->>'source_hash' <> $3
        AND NOT (slug = ANY($4::text[]))
        AND EXISTS (
          SELECT 1 FROM pages p
           WHERE p.source_id = $1 AND p.slug = $2 AND p.deleted_at IS NULL
             AND substring(p.content_hash from 1 for 16) = $3
        )${lock ? '\n        FOR UPDATE' : ''}`,
    [args.sourceId, args.pageSlug, args.hash16, args.keepSlugs],
  );
  const currentNorm = normForGrounding(args.currentContent);
  return rows
    .filter(r => r.verified === 'true' && !!r.quote && !currentNorm.includes(normForGrounding(r.quote)))
    .map(r => r.slug);
}

async function supersedeStaleAtomsForPage(
  engine: BrainEngine,
  args: SupersedeArgs,
): Promise<number> {
  if (args.dryRun) return (await findUnsupportedAtoms(engine, args)).length;
  // Fast path first: the overwhelming majority of re-extracted pages have
  // nothing to retire, and this is a batch phase — one plain SELECT per page,
  // no transaction. Only a page that actually has candidates pays for the
  // locked re-check below.
  if ((await findUnsupportedAtoms(engine, args)).length === 0) return 0;
  return engine.transaction(async (tx) => {
    // Take the "page still carries hash16" gate as a row lock: a concurrent
    // edit to this page now waits for the commit below instead of slipping in
    // between the evidence check and the soft-delete.
    const held = await tx.executeRaw<{ ok: number }>(
      `SELECT 1 AS ok FROM pages
        WHERE source_id = $1 AND slug = $2 AND deleted_at IS NULL
          AND substring(content_hash from 1 for 16) = $3
        FOR UPDATE`,
      [args.sourceId, args.pageSlug, args.hash16],
    );
    if (held.length === 0) return 0;
    // Re-derived under the lock, not reused from the fast path: the lock is
    // what makes this list current.
    const slugs = await findUnsupportedAtoms(tx, args, true);
    // softDeletePages is a single-batch primitive — oversized input throws.
    let superseded = 0;
    for (let i = 0; i < slugs.length; i += DELETE_BATCH_SIZE) {
      const flipped = await tx.softDeletePages(slugs.slice(i, i + DELETE_BATCH_SIZE), {
        sourceId: args.sourceId,
      });
      superseded += flipped.length;
    }
    return superseded;
  });
}

/**
 * Bind the reconciler to one phase run. The returned function is a no-op for
 * transcript items (a transcript is a file, not a page, so nothing is bound to
 * it) and otherwise returns how many of the page's atoms were retired.
 *
 * It is allowed to THROW: callers must run it before the item's completion
 * markers, on the same footing as the provenance-edge flush. Both markers (the
 * `source_hash` flip and `atoms_scan_hash`) make the page undiscoverable for
 * this content, so a reconciliation that failed after them could never be
 * retried; failing first leaves the provisional hashes in place and the next
 * run redoes the whole item.
 */
export function createAtomReconciler(engine: BrainEngine, sourceId: string, dryRun: boolean) {
  return async (
    item: { kind: string; slug?: string; content: string; contentHash: string },
    keepSlugs: string[],
  ): Promise<number> => {
    if (item.kind !== 'page' || !item.slug) return 0;
    return supersedeStaleAtomsForPage(engine, {
      sourceId, pageSlug: item.slug, hash16: item.contentHash.slice(0, 16),
      currentContent: item.content, keepSlugs, dryRun,
    });
  };
}
