// Peeled out of extract-atoms.ts: the page lane's stale-atom reconciliation,
// kept in its own module so the phase file stays under the module-size
// ratchet.

import type { BrainEngine } from '../engine.ts';
import { DELETE_BATCH_SIZE } from '../engine-constants.ts';
import { normForGrounding } from './synthesize-verify.ts';

/**
 * A normalized quote shorter than this (under EITHER fold) is not evidence
 * enough to destroy a row: at that length an accidental substring match — or
 * miss — is as likely as a real one, and the atom is cheap to keep and
 * expensive to lose. Retirement skips these; they stay live with their stale
 * binding.
 */
const MIN_RETIREMENT_QUOTE_CHARS = 8;

/**
 * The presence test that gates a DESTRUCTIVE decision, deliberately looser
 * than `normForGrounding` (the grounding primitive, which folds only
 * whitespace, curly quotes, unicode dashes, ellipsis and case — and is left
 * alone here because other callers depend on its exact fold).
 *
 * Grounding asks "did the model quote this text?", where a strict fold is
 * right. Retirement asks "is this claim still on the page?", where a stricter
 * fold turns a COSMETIC edit into data loss: an NFC→NFD re-encode of Japanese
 * prose, a half→full-width punctuation pass, `**emphasis**` added inside the
 * quoted span, a link wrapped around one word, or re-bulleting two sentences
 * all leave the claim verbatim on screen while changing its bytes.
 *
 * So, in order: NFKC (composes NFD, folds full-width forms to ASCII), strip
 * the markdown syntax that carries no meaning (blockquote/heading/list
 * markers at line start, `[text](url)` → text, `<url>` → url, emphasis and
 * code marks), then the shared fold + whitespace collapse.
 *
 * It is applied to BOTH sides, but symmetry alone does NOT make it a superset
 * of the strict fold: a quote that starts mid-link (`[Procurement](https://ex`
 * — the model's span cut through the syntax) keeps its literal brackets while
 * the page's copy folds to `Procurement`, and the strict fold would have found
 * that text. So the caller does not REPLACE the strict test with this one — it
 * requires BOTH to report the quote absent before retiring. The permissive
 * fold can then only ever save an atom, never condemn one, by construction
 * rather than by regex reasoning.
 */
function normForRetirement(s: string): string {
  return normForGrounding(
    s
      .normalize('NFKC')
      .replace(/^[ \t]*(?:>[ \t]?)+/gm, '')                 // blockquote markers
      .replace(/^[ \t]*#{1,6}[ \t]+/gm, '')                 // ATX headings
      .replace(/^[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+/gm, '')  // list bullets
      // [text](url) → text. The destination may carry ONE level of balanced
      // parentheses (`https://x/a_(b)`, a common wiki-style URL shape); without
      // that allowance the fold stopped at the inner `)` and left a stray `)`
      // in the page text, so a supported quote read as absent and was retired.
      .replace(/!?\[([^\]\n]*)\]\((?:[^()\n]|\([^()\n]*\))*\)/g, '$1')
      .replace(/<((?:https?|mailto):[^>\s]+)>/g, '$1')      // <url> → url
      .replace(/[`*_~]/g, ''),                              // emphasis / code marks
  );
}

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
 * demands character-aligned boundaries and uniqueness), applied to the whole
 * page rather than the model's truncated cut, and run under TWO folds (the
 * strict grounding one and `normForRetirement`'s NFKC + markdown fold): either
 * one finding the quote keeps the atom. All three choices err toward "still
 * present", i.e. toward keeping the atom.
 *
 * RE-ANCHORING. A run that retires anything also repoints the atoms it KEPT on
 * VERBATIM evidence — same page, stale `source_hash`, verified quote still
 * present under the STRICT fold — at the hash just reconciled. Two reasons,
 * and both are about not making the retirement permanent:
 *   - It is truthful. The atom is supported by the content at THIS hash; the
 *     hash it carried says only which pass minted it.
 *   - `discoverExtractablePages` skips a page when any live atom already
 *     carries its current hash. A kept atom still holding the OLD hash
 *     therefore masks the old content forever: revert the page and discovery
 *     says "already extracted", so the atoms retired at the new hash are never
 *     re-derived and the purge window ends them. Re-anchoring frees the old
 *     hash, the revert re-discovers the page, and the deterministic atom slug
 *     makes the re-import revive the soft-deleted row in place.
 * Only the verbatim-evidenced set moves. An atom with no quote, an unverified
 * one, or one the permissive fold alone could find keeps its hash — and can
 * still mask an older one. That residual is deliberate: those rows have no
 * evidence strong enough to restate their provenance, and they are rows this
 * reconciler would never retire anyway. Runs that retire nothing re-anchor
 * nothing: without a retirement the old hash's extraction is still fully
 * represented, and the common no-op page must not pay a write.
 *
 * The one contract this costs: the reconciliation deliberately lands BEFORE
 * the item's completion markers so a failure leaves the page retryable, and a
 * re-anchored row carries the current hash from that moment on. If the
 * provisional→real flip that follows then fails, discovery skips the page
 * (any live atom at the current hash makes it "already extracted") and this
 * run's `pending:` rows wait for the next edit to that page instead of the
 * next run. That window is the flip's own pre-existing crash window widened by
 * two statements, it strands nothing that a later pass cannot reclaim (a
 * `pending:` row is explicitly eligible here), and closing it properly means
 * teaching discovery about incomplete runs — a change to the phase's
 * eligibility rule, not to this reconciler.
 *
 * Revival after a revert is in-place for atoms at the current deterministic
 * slug. A pre-#4733 LEGACY-slug atom is re-minted at the new-format slug
 * instead: `resolvePageAtomSlug` adopts a legacy row only while it is live, so
 * a retired one is invisible to it. The claim comes back either way; the row
 * identity does not.
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
 * purge window rather than being destroyed. Returns how many rows were
 * actually flipped active → soft-deleted and how many were re-anchored.
 * `dryRun` runs the SELECT only and returns the would-be counts without
 * touching a row.
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

/** One page's stale-bound atoms, split by what the current content says. */
interface Verdict {
  /** Verified quote no longer in the page → soft-delete. */
  retire: string[];
  /** Verified quote still in the page → repoint at the current hash. */
  reanchor: string[];
}

/**
 * The evidence query: which of this page's atoms its current text no longer
 * supports, and which it still does. `lock` adds `FOR UPDATE` so the
 * transactional pass holds the candidate atom rows themselves — otherwise a
 * concurrent import could refresh an atom's quote between the judgement and
 * the soft-delete, and the delete (which matches on slug alone) would retire a
 * row that is supported again.
 */
async function classifyStaleAtoms(
  engine: BrainEngine,
  args: SupersedeArgs,
  lock = false,
): Promise<Verdict> {
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
  // Two folds, both of which must miss before a row is retired: the strict
  // grounding one (what the rest of the phase means by "quoted from here") and
  // the permissive retirement one (cosmetic edits are not deletions).
  const currentStrict = normForGrounding(args.currentContent);
  const currentFolded = normForRetirement(args.currentContent);
  const verdict: Verdict = { retire: [], reanchor: [] };
  for (const r of rows) {
    // No verified quote → no evidence in either direction: neither retire nor
    // re-anchor, so the row keeps whatever binding it has.
    if (r.verified !== 'true' || !r.quote) continue;
    const strict = normForGrounding(r.quote);
    const folded = normForRetirement(r.quote);
    if (Math.min(strict.length, folded.length) < MIN_RETIREMENT_QUOTE_CHARS) continue;
    // Verbatim-present under the strict fold: strong enough to REBIND the row.
    if (currentStrict.includes(strict)) { verdict.reanchor.push(r.slug); continue; }
    // Present only under the permissive fold: strong enough to KEEP the row,
    // not to restate its provenance. That fold is deliberately lossy (it drops
    // `_`, and NFKC rewrites `x²` to `x2`), so a match can mean the page still
    // carries the claim OR that an edit changed a token the fold erased. Keep
    // — the destructive direction needs the evidence — but leave the binding
    // alone so `atom_provenance_drift` still reports the row.
    if (currentFolded.includes(folded)) continue;
    verdict.retire.push(r.slug);
  }
  return verdict;
}

/**
 * Repoint kept-but-stale atoms at the hash just reconciled. Runs INSIDE the
 * retirement transaction (same row locks, same all-or-nothing rollback), and
 * touches only `frontmatter.source_hash` — not `updated_at`, matching
 * `softDeletePages`, so a reconciliation does not read downstream as a content
 * edit. Returns the rows actually repointed.
 */
async function reanchorAtoms(
  tx: BrainEngine,
  args: SupersedeArgs,
  slugs: string[],
): Promise<number> {
  let moved = 0;
  for (let i = 0; i < slugs.length; i += DELETE_BATCH_SIZE) {
    const rows = await tx.executeRaw<{ slug: string }>(
      `UPDATE pages
          SET frontmatter = frontmatter || jsonb_build_object('source_hash', $3::text)
        WHERE source_id = $1
          AND type = 'atom'
          AND deleted_at IS NULL
          AND frontmatter->>'source_slug' = $2
          AND slug = ANY($4::text[])
        RETURNING slug`,
      [args.sourceId, args.pageSlug, args.hash16, slugs.slice(i, i + DELETE_BATCH_SIZE)],
    );
    moved += rows.length;
  }
  return moved;
}

export interface ReconcileCounts {
  superseded: number;
  reanchored: number;
}

const NOTHING: ReconcileCounts = { superseded: 0, reanchored: 0 };

async function supersedeStaleAtomsForPage(
  engine: BrainEngine,
  args: SupersedeArgs,
): Promise<ReconcileCounts> {
  if (args.dryRun) {
    const would = await classifyStaleAtoms(engine, args);
    // Report the same coupling a real run applies: no retirement, no
    // re-anchoring.
    return would.retire.length === 0
      ? NOTHING
      : { superseded: would.retire.length, reanchored: would.reanchor.length };
  }
  // Fast path first: the overwhelming majority of re-extracted pages have
  // nothing to retire, and this is a batch phase — one plain SELECT per page,
  // no transaction. Only a page that actually has candidates pays for the
  // locked re-check below.
  if ((await classifyStaleAtoms(engine, args)).retire.length === 0) return NOTHING;
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
    if (held.length === 0) return NOTHING;
    // Re-derived under the lock, not reused from the fast path: the lock is
    // what makes this list current.
    const { retire, reanchor } = await classifyStaleAtoms(tx, args, true);
    // The lock may have revealed that nothing is unsupported after all —
    // then this is a no-op run and the kept atoms' bindings stay put.
    if (retire.length === 0) return NOTHING;
    // softDeletePages is a single-batch primitive — oversized input throws.
    let superseded = 0;
    for (let i = 0; i < retire.length; i += DELETE_BATCH_SIZE) {
      const flipped = await tx.softDeletePages(retire.slice(i, i + DELETE_BATCH_SIZE), {
        sourceId: args.sourceId,
      });
      superseded += flipped.length;
    }
    return { superseded, reanchored: await reanchorAtoms(tx, args, reanchor) };
  });
}

/**
 * Bind the reconciler to one phase run. The returned function is a no-op for
 * transcript items (a transcript is a file, not a page, so nothing is bound to
 * it) and otherwise returns how many of the page's atoms were retired and how
 * many were re-anchored.
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
  ): Promise<ReconcileCounts> => {
    if (item.kind !== 'page' || !item.slug) return NOTHING;
    return supersedeStaleAtomsForPage(engine, {
      sourceId, pageSlug: item.slug, hash16: item.contentHash.slice(0, 16),
      currentContent: item.content, keepSlugs, dryRun,
    });
  };
}
