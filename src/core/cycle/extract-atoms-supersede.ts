// Peeled out of extract-atoms.ts: the page lane's stale-atom reconciliation,
// kept in its own module so the phase file stays under the module-size
// ratchet.

import type { BrainEngine } from '../engine.ts';
import { DELETE_BATCH_SIZE } from '../engine-constants.ts';
import { locateQuote } from './extract-atoms.ts';
import { normForGrounding } from './synthesize-verify.ts';

/**
 * A normalized quote shorter than this (under EITHER fold) is not evidence
 * enough to destroy a row: at that length an accidental substring match — or
 * miss — is as likely as a real one, and the atom is cheap to keep and
 * expensive to lose. Retirement skips these; unless locatable, they block
 * retirement and stay live with their stale binding.
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
 * markers at line start, inline/reference links → text, reference definitions,
 * `<url>` → url, emphasis and code marks), then the shared fold + whitespace
 * collapse.
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
      .replace(/^[ \t]*\[[^\]\n]+\]:[ \t]*(?:<[^>\n]+>|[^\s<>]+)[^\n]*(?:\n|$)/gm, '') // reference definitions
      .replace(/!?\[([^\]\n]*)\]\[[^\]\n]*\]/g, '$1') // reference links / images
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
 * RE-ANCHORING. A run that retires anything also repoints every keeper
 * whose verified quote can be located by extraction's `locateQuote`, updating
 * both source_hash and source_quote_offset and keeping verification true.
 * Containment under either fold alone is NOT enough: the locator requires
 * unique, character-aligned evidence in the current content.
 *
 * Revert-recovery requires the page's old hash to be fully released: discovery
 * skips content when any live atom already carries its hash. Retirement is
 * therefore deferred until every other stale-bound atom can be re-verified
 * against the current content at extraction standard. A missing/unverified
 * quote, fold-only match, ambiguous locator, or insufficient retirement
 * evidence is a BLOCKER. Any blocker means no retirement and no re-anchoring
 * for this page; the original atoms remain live even after a revert. Runs with
 * no retirement also leave keeper bindings alone.
 *
 * The provisional→real hash flip shares the reconciliation transaction,
 * ordered flip → retire → re-anchor. A failure anywhere rolls all three back,
 * leaving imported atoms pending and the page retryable.
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
 * — pay one SELECT plus only the completion flip transaction when needed.
 *
 * Soft-delete via `softDeletePages`, so rows stay recoverable inside the usual
 * purge window rather than being destroyed. Returns how many rows were
 * actually flipped active → soft-deleted, re-anchored, or blocked retirement.
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
  flip?: (tx: BrainEngine) => Promise<void>;
}

/** One page's stale-bound atoms, split by what the current content says. */
interface Verdict {
  /** Verified quote no longer in the page → soft-delete. */
  retire: string[];
  /** Verified quote still in the page → repoint at the current hash. */
  reanchor: Array<{ slug: string; start: number; end: number }>;
  blocked: number;
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
  const verdict: Verdict = { retire: [], reanchor: [], blocked: 0 };
  for (const r of rows) {
    if (r.verified !== 'true' || !r.quote) { verdict.blocked++; continue; }
    const loc = locateQuote(args.currentContent, r.quote);
    if (loc) { verdict.reanchor.push({ slug: r.slug, ...loc }); continue; }
    const strict = normForGrounding(r.quote);
    const folded = normForRetirement(r.quote);
    if (Math.min(strict.length, folded.length) < MIN_RETIREMENT_QUOTE_CHARS
      || currentStrict.includes(strict) || currentFolded.includes(folded)) {
      verdict.blocked++;
      continue;
    }
    verdict.retire.push(r.slug);
  }
  return verdict;
}

/**
 * Repoint kept-but-stale atoms at the hash just reconciled. Runs INSIDE the
 * retirement transaction (same row locks, same all-or-nothing rollback), and
 * refreshes the hash, quote offsets and verification — not `updated_at`, matching
 * `softDeletePages`, so a reconciliation does not read downstream as a content
 * edit. Returns the rows actually repointed.
 */
async function reanchorAtoms(
  tx: BrainEngine,
  args: SupersedeArgs,
  anchors: Verdict['reanchor'],
): Promise<number> {
  let moved = 0;
  for (let i = 0; i < anchors.length; i += DELETE_BATCH_SIZE) {
    const batch = anchors.slice(i, i + DELETE_BATCH_SIZE);
    const rows = await tx.executeRaw<{ slug: string }>(
      `UPDATE pages
          SET frontmatter = frontmatter || jsonb_build_object('source_hash', $3::text,
                'source_quote_offset', jsonb_build_array(loc.start_offset, loc.end_offset),
                'source_quote_verified', true)
         FROM unnest($4::text[], $5::int[], $6::int[]) AS loc(slug, start_offset, end_offset)
        WHERE source_id = $1
          AND type = 'atom'
          AND deleted_at IS NULL
          AND frontmatter->>'source_slug' = $2
          AND pages.slug = loc.slug
        RETURNING pages.slug`,
      [args.sourceId, args.pageSlug, args.hash16, batch.map(a => a.slug),
        batch.map(a => a.start), batch.map(a => a.end)],
    );
    moved += rows.length;
  }
  return moved;
}

export interface ReconcileCounts {
  superseded: number;
  reanchored: number;
  blocked: number;
}

const NOTHING: ReconcileCounts = { superseded: 0, reanchored: 0, blocked: 0 };

async function supersedeStaleAtomsForPage(
  engine: BrainEngine,
  args: SupersedeArgs,
): Promise<ReconcileCounts> {
  const initial = await classifyStaleAtoms(engine, args);
  if (args.dryRun) {
    return initial.blocked > 0 || initial.retire.length === 0
      ? { ...NOTHING, blocked: initial.blocked }
      : { superseded: initial.retire.length, reanchored: initial.reanchor.length, blocked: 0 };
  }
  // No retirement possible: only the completion flip needs a transaction.
  if (initial.retire.length === 0 || initial.blocked > 0) {
    if (args.flip) await engine.transaction(args.flip);
    return { ...NOTHING, blocked: initial.blocked };
  }
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
    if (held.length === 0) {
      await args.flip?.(tx);
      return NOTHING;
    }
    // Re-derived under the lock, not reused from the fast path: the lock is
    // what makes this list current.
    const { retire, reanchor, blocked } = await classifyStaleAtoms(tx, args, true);
    await args.flip?.(tx);
    // The lock may have revealed that nothing is unsupported after all —
    // then this is a no-op run and the kept atoms' bindings stay put.
    if (retire.length === 0 || blocked > 0) return { ...NOTHING, blocked };
    // softDeletePages is a single-batch primitive — oversized input throws.
    let superseded = 0;
    for (let i = 0; i < retire.length; i += DELETE_BATCH_SIZE) {
      const flipped = await tx.softDeletePages(retire.slice(i, i + DELETE_BATCH_SIZE), {
        sourceId: args.sourceId,
      });
      superseded += flipped.length;
    }
    return { superseded, reanchored: await reanchorAtoms(tx, args, reanchor), blocked: 0 };
  });
}

/**
 * Bind the reconciler to one phase run. Transcript items only run the supplied
 * completion flip (a transcript is a file, not a page, so nothing is bound to
 * it). Page items return retired, re-anchored and blocker counts.
 *
 * It is allowed to THROW. The caller supplies the completion flip so it
 * commits atomically with retirement and re-anchoring, then stamps the page
 * only after this function succeeds. Dry-run never invokes the flip.
 */
export function createAtomReconciler(engine: BrainEngine, sourceId: string, dryRun: boolean) {
  return async (
    item: { kind: string; slug?: string; content: string; contentHash: string },
    keepSlugs: string[],
    flip?: (tx: BrainEngine) => Promise<void>,
  ): Promise<ReconcileCounts> => {
    if (item.kind !== 'page' || !item.slug) {
      if (!dryRun) await flip?.(engine);
      return NOTHING;
    }
    return supersedeStaleAtomsForPage(engine, {
      sourceId, pageSlug: item.slug, hash16: item.contentHash.slice(0, 16),
      currentContent: item.content, keepSlugs, dryRun, flip,
    });
  };
}
