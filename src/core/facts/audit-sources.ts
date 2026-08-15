/**
 * Source-string constants for the durable audit checkpoint rows that
 * extract-conversation-facts writes into the facts table to mark
 * batch-run progress:
 *   - `TERMINAL_AUDIT_SOURCE` — page-level "extraction complete" checkpoint
 *     (Eng-v2 C7). Doctor's backlog query matches this source +
 *     source_session, not the per-segment fact source.
 *   - `NON_EXTRACTABLE_AUDIT_SOURCE` — durable outcome for a successfully
 *     scanned page that contains no eligible multi-message segment, kept
 *     distinct from successful extraction so operator surfaces can report
 *     the truth without rescanning the page forever.
 *
 * These are checkpoints, not user facts. Recall-side callers filter rows
 * whose `source` is one of these out of the newest-N fetch window (see
 * `FactListOpts.excludeAuditRows` in `../engine.ts`).
 *
 * Pulled into a leaf module (no other imports) so `pglite-engine.ts` and
 * `postgres-engine.ts` — engine-live paths where runtime dynamic `import()`
 * is forbidden (`scripts/check-engine-dynamic-import.sh`) — can reference
 * these values via a static top-level import instead of reaching into the
 * much heavier `commands/extract-conversation-facts.ts` command module.
 * `extract-conversation-facts.ts` re-exports both names unchanged so its
 * existing importers are unaffected.
 */

export const TERMINAL_AUDIT_SOURCE = 'cli:extract-conversation-facts:terminal:v2';

export const NON_EXTRACTABLE_AUDIT_SOURCE =
  'cli:extract-conversation-facts:non-extractable:v2';

/** Both audit-row source values, for callers that want a single IN-list. */
export const AUDIT_ROW_SOURCES = [TERMINAL_AUDIT_SOURCE, NON_EXTRACTABLE_AUDIT_SOURCE] as const;
