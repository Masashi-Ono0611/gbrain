/**
 * Source strings written on internal extraction-audit rows by
 * `src/commands/extract-conversation-facts.ts` (Eng-v2 C7). These are
 * per-page completion markers, not user-facing knowledge: kind:'fact',
 * entity_slug:null, never expired. `extract-conversation-facts`'s own
 * resume logic reads them via raw SQL (`findFreshExtractionOutcomes`),
 * not via listFacts* — so filtering listFacts* by these sources does
 * not affect resume.
 *
 * Lives in `src/core/` (not `src/commands/`) so both engines
 * (`postgres-engine.ts`, `pglite-engine.ts`) can import it via a static
 * top-level import — engine-live paths must not use runtime dynamic
 * `import()`, and pulling the whole extract-conversation-facts module
 * into both engines would be unnecessarily heavy.
 *
 * `src/commands/extract-conversation-facts.ts` re-exports both names
 * verbatim so existing importers (eval write-back, its own tests, the
 * doctor backlog tests) keep working unchanged.
 */

/**
 * Source string written on the page-level terminal audit row (Eng-v2 C7).
 * Doctor queries this source + source_session; this variant marks the
 * page as fully scanned (as opposed to PER_SEGMENT_SOURCE_PREFIX, which
 * marks individual fact provenance).
 */
export const TERMINAL_AUDIT_SOURCE = 'cli:extract-conversation-facts:terminal:v2';

/**
 * Durable outcome for a successfully scanned page that contains no eligible
 * multi-message segment. Kept distinct from successful extraction so operator
 * surfaces can report the truth without rescanning the page forever.
 */
export const NON_EXTRACTABLE_AUDIT_SOURCE =
  'cli:extract-conversation-facts:non-extractable:v2';

/** Both audit sources together, for use in exclusion predicates. */
export const AUDIT_SOURCES: readonly string[] = [
  TERMINAL_AUDIT_SOURCE,
  NON_EXTRACTABLE_AUDIT_SOURCE,
];
