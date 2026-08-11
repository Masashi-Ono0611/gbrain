/**
 * Canonical page-type allowlist for conversation-facts extraction.
 *
 * Lives in core/ rather than beside the command it primarily serves because
 * four call sites need the list and hand-copying it is exactly how they drift:
 * the backfill command, the Minion job handler, two `gbrain doctor` checks,
 * and the `sources audit` cost estimator each used to carry their own literal,
 * so a type added in one place stayed invisible to the other three.
 *
 * Keeping it here (a constants-only module with no CLI surface) also keeps the
 * generated known-flags registry honest. That generator walks one level of a
 * command module's relative imports and harvests every flag-shaped string it
 * finds — including help text — so importing the command module just to read
 * this constant would splice the backfill command's whole flag vocabulary into
 * the allowlists of `doctor`, `sources`, and `repos`, making them accept flags
 * they never implement. This module has no such text to harvest.
 */

/**
 * Allowlist of page types conversation-facts extraction operates on. Mirrors
 * the cycle.conversation_facts_backfill.types config default; the backfill
 * command's types flag is an explicit per-run override, while cycle config is
 * the single source of truth.
 */
export const ALLOWED_TYPES = [
  'conversation',
  'transcript',
  'meeting',
  'slack',
  'email',
  'imessage',
  'imessage-daily',
] as const;

export type AllowedType = (typeof ALLOWED_TYPES)[number];

/**
 * Granular collector page-types that alias into each canonical conversation
 * bucket. The v2 type-consolidation pack retypes these to the canonical names
 * (`slack-dm-day`/`slack-thread` → `slack`, `email-digest` → `email`), but a
 * brain that hasn't run that pack still carries the collector's granular types
 * in `pages.type`. Without this expansion, `listPages({ type: 'slack' })`
 * matches zero rows on such brains and the whole comms corpus is silently
 * skipped (facts stay empty → `find_trajectory` returns nothing). The canonical
 * name is always included first so consolidated brains keep working unchanged.
 */
export const ALLOWED_TYPE_ALIASES: Record<AllowedType, readonly string[]> = {
  conversation: ['conversation'],
  transcript: ['transcript'],
  meeting: ['meeting'],
  slack: ['slack', 'slack-dm-day', 'slack-thread'],
  email: ['email', 'email-digest'],
  imessage: ['imessage'],
  'imessage-daily': ['imessage-daily'],
};
