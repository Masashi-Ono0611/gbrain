/**
 * conversation-facts type allowlist — single source of truth + drift guard.
 *
 * The conversation-facts type allowlist (`conversation`, `meeting`, `slack`,
 * `email`, `imessage`, `imessage-daily`) used to be hand-copied into five
 * places across four files:
 *   1. extract-conversation-facts.ts's ALLOWED_TYPES (canonical)
 *   2. doctor.ts's conversation_facts_backlog config default
 *   3. doctor.ts's conversation_format_coverage sample scan
 *   4. jobs.ts's extract-conversation-facts Minion job handler filter
 *   5. sources.ts's facts-backfill audit estimator
 *
 * It had already drifted: jobs.ts's runExtractConversationFactsCore call cast
 * `types` to `('conversation' | 'meeting' | 'slack' | 'email')[] | undefined`
 * — the pre-#2756 four-element set, missing `imessage` and `imessage-daily`
 * that the runtime filter one line above it already accepted. Same class of
 * bug CLAUDE.md calls out for pricing tables: "One canonical ... table ...
 * Every other table is a DERIVED view, never a hand-copied duplicate — so
 * cross-table ... drift is structurally impossible."
 *
 * Two kinds of guard below, mirroring test/model-pricing.test.ts:
 *   - identity/behavioral assertions where a site's resolved list is
 *     reachable at runtime (doctor.ts's backlog-check `details.types`);
 *   - source-text drift guards (mirroring model-pricing.test.ts's "no heavy
 *     import" cycle guard) for sites whose list isn't independently
 *     reachable/exported — these fail if anyone re-hardcodes a duplicate
 *     array/union literal instead of deriving from ALLOWED_TYPES.
 */
import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ALLOWED_TYPES } from '../src/commands/extract-conversation-facts.ts';
import { computeConversationFactsBacklogCheck } from '../src/commands/doctor.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

const EXPECTED_TYPES = [
  'conversation',
  'meeting',
  'slack',
  'email',
  'imessage',
  'imessage-daily',
] as const;

function readSrc(path: string): string {
  return readFileSync(fileURLToPath(new URL(`../src/commands/${path}`, import.meta.url)), 'utf8');
}

// The exact hand-copied array literal that used to live at all 5 sites
// (whitespace-tolerant). Should appear ONLY in extract-conversation-facts.ts
// (the canonical ALLOWED_TYPES definition) after the fix.
const HARDCODED_SIX_LITERAL =
  /\[\s*['"]conversation['"]\s*,\s*['"]meeting['"]\s*,\s*['"]slack['"]\s*,\s*['"]email['"]\s*,\s*['"]imessage['"]\s*,\s*['"]imessage-daily['"]\s*,?\s*\]/g;

// The stale pre-#2756 four-element union type cast that drifted in jobs.ts.
const STALE_FOUR_ELEMENT_UNION_CAST =
  /\(\s*['"]conversation['"]\s*\|\s*['"]meeting['"]\s*\|\s*['"]slack['"]\s*\|\s*['"]email['"]\s*\)\s*\[\]/g;

// A site deriving its list from the canonical ALLOWED_TYPES via dynamic
// import, e.g. `const { ALLOWED_TYPES } = await import('./extract-conversation-facts.ts')`
// or `const { ALLOWED_TYPES: allowedTypes } = await import(...)`.
function countAllowedTypesImports(src: string): number {
  const re =
    /\{\s*[^}]*\bALLOWED_TYPES\b[^}]*\}\s*=\s*await\s+import\(\s*['"]\.\/extract-conversation-facts\.ts['"]\s*\)/g;
  return [...src.matchAll(re)].length;
}

describe('ALLOWED_TYPES — canonical source of truth', () => {
  test('has exactly the 6 expected types, in order', () => {
    expect([...ALLOWED_TYPES]).toEqual([...EXPECTED_TYPES]);
  });

  test('appears as a hardcoded literal exactly once (its own definition)', () => {
    const src = readSrc('extract-conversation-facts.ts');
    const matches = [...src.matchAll(HARDCODED_SIX_LITERAL)];
    expect(matches.length).toBe(1);
  });
});

describe('DRIFT GUARD — consumer sites derive from ALLOWED_TYPES (re-hardcode trip-wire)', () => {
  test('doctor.ts: no hand-copied 6-element literal remains', () => {
    const src = readSrc('doctor.ts');
    expect([...src.matchAll(HARDCODED_SIX_LITERAL)]).toEqual([]);
  });

  test('doctor.ts: both sites (backlog default + format-coverage sample) import ALLOWED_TYPES', () => {
    const src = readSrc('doctor.ts');
    expect(countAllowedTypesImports(src)).toBe(2);
  });

  test('jobs.ts: no hand-copied 6-element literal remains', () => {
    const src = readSrc('jobs.ts');
    expect([...src.matchAll(HARDCODED_SIX_LITERAL)]).toEqual([]);
  });

  test('jobs.ts: no stale 4-element union cast remains (the #2756-drift class)', () => {
    const src = readSrc('jobs.ts');
    expect([...src.matchAll(STALE_FOUR_ELEMENT_UNION_CAST)]).toEqual([]);
  });

  test('jobs.ts: extract-conversation-facts job handler imports ALLOWED_TYPES', () => {
    const src = readSrc('jobs.ts');
    expect(countAllowedTypesImports(src)).toBe(1);
  });

  test('sources.ts: no hand-copied 6-element literal remains', () => {
    const src = readSrc('sources.ts');
    expect([...src.matchAll(HARDCODED_SIX_LITERAL)]).toEqual([]);
  });

  test('sources.ts: FACTS_BACKFILL_ALLOWED imports ALLOWED_TYPES', () => {
    const src = readSrc('sources.ts');
    expect(countAllowedTypesImports(src)).toBe(1);
  });
});

describe('DRIFT GUARD — jobs.ts filter accepts all 6 canonical types at runtime', () => {
  // jobs.ts's filter is `(t): t is AllowedType => (ALLOWED_TYPES as readonly
  // string[]).includes(t)` — the same predicate shape as
  // extract-conversation-facts.ts's own resolveTypesFromConfig filter. Since
  // the source-text guard above proves jobs.ts's filter is wired to
  // ALLOWED_TYPES (not a hand-copied duplicate), proving ALLOWED_TYPES itself
  // accepts every canonical type closes the loop: jobs.ts accepts all 6,
  // including `imessage`/`imessage-daily`, which the stale cast's *type*
  // (but not its runtime behavior — see below) used to exclude.
  test('ALLOWED_TYPES accepts every canonical type via .includes()', () => {
    for (const t of EXPECTED_TYPES) {
      expect((ALLOWED_TYPES as readonly string[]).includes(t)).toBe(true);
    }
  });
});

describe('DRIFT GUARD — doctor.ts conversation_facts_backlog default is reachable + correct', () => {
  let engine: PGLiteEngine;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  });

  afterAll(async () => {
    await engine.disconnect();
  });

  test('with no cycle.conversation_facts_backfill.types override, the resolved default equals ALLOWED_TYPES', async () => {
    await resetPgliteState(engine);
    await engine.setConfig('cycle.conversation_facts_backfill.enabled', 'true');
    // No pages of any conversation type exist, so backlog === 0 and the
    // check takes the 'ok' branch, which reports the resolved `types` it
    // used in `details.types` — the actual default this code path runs
    // with, not a value we're asserting in isolation.
    const check = await computeConversationFactsBacklogCheck(engine);
    expect(check.status).toBe('ok');
    const resolvedTypes = (check.details as { types?: string[] } | undefined)?.types;
    expect(resolvedTypes).toBeDefined();
    expect([...(resolvedTypes ?? [])].sort()).toEqual([...EXPECTED_TYPES].sort());
  });
});
