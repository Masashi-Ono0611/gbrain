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
 *   - `source_hash` is present, is not the in-flight `pending:` marker, and
 *     differs from the page's current hash16 — the page's OWN current content
 *     is the staleness authority, judged inside the run that just wrote it;
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
 * Soft-delete via `softDeletePages`, so rows stay recoverable inside the usual
 * purge window rather than being destroyed. Returns the number of rows
 * actually flipped active → soft-deleted. `dryRun` runs the SELECT only and
 * returns the would-be count without touching a row.
 *
 * Atoms whose source page was DELETED (the doctor's `source_gone` bucket) are
 * out of scope: this only ever runs for a page that was just re-extracted.
 */
export async function supersedeStaleAtomsForPage(
  engine: BrainEngine,
  args: {
    sourceId: string;
    pageSlug: string;
    hash16: string;
    currentContent: string;
    keepSlugs: string[];
    dryRun: boolean;
  },
): Promise<number> {
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
        AND frontmatter->>'source_hash' NOT LIKE 'pending:%'
        AND frontmatter->>'source_hash' <> $3
        AND NOT (slug = ANY($4::text[]))`,
    [args.sourceId, args.pageSlug, args.hash16, args.keepSlugs],
  );
  const currentNorm = normForGrounding(args.currentContent);
  const slugs = rows
    .filter(r => r.verified === 'true' && !!r.quote && !currentNorm.includes(normForGrounding(r.quote)))
    .map(r => r.slug);
  if (args.dryRun || slugs.length === 0) return slugs.length;
  // softDeletePages is a single-batch primitive — oversized input throws.
  let superseded = 0;
  for (let i = 0; i < slugs.length; i += DELETE_BATCH_SIZE) {
    const flipped = await engine.softDeletePages(slugs.slice(i, i + DELETE_BATCH_SIZE), {
      sourceId: args.sourceId,
    });
    superseded += flipped.length;
  }
  return superseded;
}
