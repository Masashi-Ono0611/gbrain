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
 * ALLOWED_TYPES/AllowedType now live in a leaf module,
 * src/core/facts/conversation-types.ts, NOT in extract-conversation-facts.ts
 * (which re-exports both verbatim). That's a second-order fix: sites 2-5
 * originally imported the constant straight from extract-conversation-
 * facts.ts, and scripts/generate-flag-registry.ts scans every relative
 * import of a command module for `--flag`-shaped string literals — so
 * importing anything from that command module (even just this constant)
 * transitively attributed its whole CLI flag surface (`--background`,
 * `--concurrency`, `--limit`, ... about ten flags) to doctor/repos/sources
 * in the generated registry, silently widening what those three commands'
 * strict unknown-flag validation (#2185) accepts (#4135 CI failure). The
 * leaf module has no flags of its own, so importing it doesn't leak
 * anything, regardless of whether the importer uses a static or dynamic
 * import (generate-flag-registry.ts's one-level relative-import scan
 * matches both forms identically).
 *
 * Guards below, mirroring test/model-pricing.test.ts:
 *   - identity/behavioral assertions where a site's resolved list is
 *     reachable at runtime (doctor.ts's backlog-check `details.types`);
 *   - source-text drift guards (mirroring model-pricing.test.ts's "no heavy
 *     import" cycle guard) for sites whose list isn't independently
 *     reachable/exported — these fail if anyone re-hardcodes a duplicate
 *     array/union literal instead of deriving from ALLOWED_TYPES, or points
 *     a site back at extract-conversation-facts.ts instead of the leaf;
 *   - a flag-registry regression guard pinning the exact bug this file's
 *     history hit: doctor/repos/sources must never carry
 *     extract-conversation-facts.ts's own flags.
 */
import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ALLOWED_TYPES } from '../src/core/facts/conversation-types.ts';
import { computeConversationFactsBacklogCheck } from '../src/commands/doctor.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { buildFlagRegistry } from '../scripts/generate-flag-registry.ts';

const EXPECTED_TYPES = [
  'conversation',
  'meeting',
  'slack',
  'email',
  'imessage',
  'imessage-daily',
] as const;

function readSrc(relPath: string): string {
  return readFileSync(fileURLToPath(new URL(`../src/${relPath}`, import.meta.url)), 'utf8');
}

// The exact hand-copied array literal that used to live at all 5 sites
// (whitespace-tolerant). Should appear ONLY in
// src/core/facts/conversation-types.ts (the canonical ALLOWED_TYPES
// definition) after the fix.
const HARDCODED_SIX_LITERAL =
  /\[\s*['"]conversation['"]\s*,\s*['"]meeting['"]\s*,\s*['"]slack['"]\s*,\s*['"]email['"]\s*,\s*['"]imessage['"]\s*,\s*['"]imessage-daily['"]\s*,?\s*\]/g;

// The stale pre-#2756 four-element union type cast that drifted in jobs.ts.
const STALE_FOUR_ELEMENT_UNION_CAST =
  /\(\s*['"]conversation['"]\s*\|\s*['"]meeting['"]\s*\|\s*['"]slack['"]\s*\|\s*['"]email['"]\s*\)\s*\[\]/g;

// Any import (static `from '...'` or dynamic `import('...')`) of
// ALLOWED_TYPES (optionally aliased) from the given relative module path.
function countAllowedTypesImportsFrom(src: string, modulePathEscaped: string): number {
  const staticRe = new RegExp(
    `import\\s*\\{[^}]*\\bALLOWED_TYPES\\b[^}]*\\}\\s*from\\s*['"]${modulePathEscaped}['"]`,
    'g',
  );
  const dynamicRe = new RegExp(
    `\\{\\s*[^}]*\\bALLOWED_TYPES\\b[^}]*\\}\\s*=\\s*await\\s+import\\(\\s*['"]${modulePathEscaped}['"]\\s*\\)`,
    'g',
  );
  return [...src.matchAll(staticRe)].length + [...src.matchAll(dynamicRe)].length;
}

// A site still pointed at extract-conversation-facts.ts for ALLOWED_TYPES
// (the exact regression this file's history hit) rather than the leaf.
function countAllowedTypesImportsFromCommandModule(src: string): number {
  return countAllowedTypesImportsFrom(src, '\\.\\/extract-conversation-facts\\.ts');
}

describe('ALLOWED_TYPES — canonical source of truth (leaf module)', () => {
  test('has exactly the 6 expected types, in order', () => {
    expect([...ALLOWED_TYPES]).toEqual([...EXPECTED_TYPES]);
  });

  test('appears as a hardcoded literal exactly once, in the leaf module', () => {
    const src = readSrc('core/facts/conversation-types.ts');
    const matches = [...src.matchAll(HARDCODED_SIX_LITERAL)];
    expect(matches.length).toBe(1);
  });

  test('the leaf module carries no CLI-flag-shaped literals of its own', () => {
    // This is the actual invariant the leaf module exists to guarantee: it
    // must never gain a `--flag`-shaped string (e.g. from a comment example
    // or a hand-added constant), or generate-flag-registry.ts's relative-
    // import scan would once again attribute flags to every consumer that
    // imports ALLOWED_TYPES from here — reopening #4135.
    const src = readSrc('core/facts/conversation-types.ts');
    expect([...src.matchAll(/--[a-z0-9][a-z0-9-]*/g)]).toEqual([]);
  });

  test('extract-conversation-facts.ts no longer hardcodes the literal; re-exports from the leaf', () => {
    const src = readSrc('commands/extract-conversation-facts.ts');
    expect([...src.matchAll(HARDCODED_SIX_LITERAL)]).toEqual([]);
    expect(countAllowedTypesImportsFrom(src, '\\.\\./core/facts/conversation-types\\.ts')).toBe(1);
    expect(src).toContain('export { ALLOWED_TYPES }');
    expect(src).toContain('export type { AllowedType }');
  });
});

describe('DRIFT GUARD — consumer sites derive from the leaf module (re-hardcode + wrong-import trip-wire)', () => {
  for (const [label, relPath] of [
    ['doctor.ts', 'commands/doctor.ts'],
    ['jobs.ts', 'commands/jobs.ts'],
    ['sources.ts', 'commands/sources.ts'],
  ] as const) {
    test(`${label}: no hand-copied 6-element literal remains`, () => {
      const src = readSrc(relPath);
      expect([...src.matchAll(HARDCODED_SIX_LITERAL)]).toEqual([]);
    });

    test(`${label}: does not import ALLOWED_TYPES from extract-conversation-facts.ts`, () => {
      const src = readSrc(relPath);
      expect(countAllowedTypesImportsFromCommandModule(src)).toBe(0);
    });
  }

  test('doctor.ts: imports ALLOWED_TYPES from the leaf exactly once (both sites reference the same binding)', () => {
    const src = readSrc('commands/doctor.ts');
    expect(countAllowedTypesImportsFrom(src, '\\.\\./core/facts/conversation-types\\.ts')).toBe(1);
    // Both call sites reference the top-level import, not a re-import.
    expect((src.match(/\bALLOWED_TYPES\b/g) ?? []).length).toBeGreaterThanOrEqual(3); // import + 2 usages
  });

  test('jobs.ts: no stale 4-element union cast remains (the #2756-drift class)', () => {
    const src = readSrc('commands/jobs.ts');
    expect([...src.matchAll(STALE_FOUR_ELEMENT_UNION_CAST)]).toEqual([]);
  });

  test('jobs.ts: imports ALLOWED_TYPES + AllowedType from the leaf exactly once', () => {
    const src = readSrc('commands/jobs.ts');
    expect(countAllowedTypesImportsFrom(src, '\\.\\./core/facts/conversation-types\\.ts')).toBe(1);
    expect(src).toContain("type AllowedType } from '../core/facts/conversation-types.ts'");
  });

  test('sources.ts: FACTS_BACKFILL_ALLOWED imports ALLOWED_TYPES from the leaf', () => {
    const src = readSrc('commands/sources.ts');
    expect(countAllowedTypesImportsFrom(src, '\\.\\./core/facts/conversation-types\\.ts')).toBe(1);
  });
});

describe('DRIFT GUARD — jobs.ts filter accepts all 6 canonical types at runtime', () => {
  // jobs.ts's filter is `(t): t is AllowedType => (ALLOWED_TYPES as readonly
  // string[]).includes(t)` — the same predicate shape as
  // extract-conversation-facts.ts's own resolveTypesFromConfig filter. Since
  // the source-text guard above proves jobs.ts's filter is wired to the
  // canonical ALLOWED_TYPES (not a hand-copied duplicate), proving
  // ALLOWED_TYPES itself accepts every canonical type closes the loop:
  // jobs.ts accepts all 6, including `imessage`/`imessage-daily`, which the
  // stale cast's *type* (but not its runtime behavior — see the commit
  // message) used to exclude.
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

describe('DRIFT GUARD — #4135 regression: doctor.ts/sources.ts never relative-import extract-conversation-facts.ts', () => {
  // The exact bug: doctor.ts (both sites) and sources.ts each imported
  // ALLOWED_TYPES straight from extract-conversation-facts.ts.
  // generate-flag-registry.ts's one-level relative-import scan
  // (`from '...'` AND `import('...')`, matched identically) then read that
  // whole command module's text for `--flag`-shaped literals and folded
  // them into doctor/repos/sources's registry entries — silently widening
  // what those commands' #2185 strict unknown-flag validation accepts.
  // Reproduces the generator's own relative-import regex (scripts/
  // generate-flag-registry.ts:relativeImports) rather than guessing which
  // flag names are "foreign": other legitimately-imported modules can
  // independently contribute overlapping flag names, so a flag-allowlist
  // test would be both wrong and fragile. jobs.ts is deliberately excluded:
  // it independently, legitimately imports extract-conversation-facts.ts
  // for runExtractConversationFactsCore, so its registry entry already (and
  // correctly) carries that command's flag surface — see the "no #2756-
  // drift-class" jobs.ts guards above for what DOES need to hold there.
  const RELATIVE_IMPORT_RE = /(?:from\s+'(\.\.?\/[^']+\.ts)'|import\('(\.\.?\/[^']+\.ts)'\))/g;

  function relativeImportPaths(src: string): string[] {
    return [...src.matchAll(RELATIVE_IMPORT_RE)].map((m) => m[1] ?? m[2]);
  }

  for (const [label, relPath] of [
    ['doctor.ts', 'commands/doctor.ts'],
    ['sources.ts', 'commands/sources.ts'],
  ] as const) {
    test(`${label}: source contains no relative import path ending in extract-conversation-facts.ts`, () => {
      const src = readSrc(relPath);
      const hits = relativeImportPaths(src).filter((p) => p.endsWith('extract-conversation-facts.ts'));
      expect(hits).toEqual([]);
    });
  }

  test('flag-registry freshness: rebuilding the registry now produces the exact same doctor/repos/sources/jobs entries as committed', () => {
    // Narrow, targeted companion to test/cli-flag-validation.test.ts's
    // whole-registry freshness guard (#2185) — pinned specifically to the
    // four command names this bug touched (or, for jobs, deliberately did
    // NOT touch), so a regression here fails right next to its cause.
    const registry = buildFlagRegistry();
    const committedSrc = readSrc('core/cli-flag-registry.generated.ts');
    for (const command of ['doctor', 'repos', 'sources', 'jobs']) {
      const entryMatch = committedSrc.match(
        new RegExp(`'${command}': \\[([^\\]]*)\\]`),
      );
      expect(entryMatch, `no committed registry entry found for '${command}'`).not.toBeNull();
      const committedFlags = [...(entryMatch![1].matchAll(/'([^']+)'/g))].map((m) => m[1]).sort();
      expect(registry[command]).toEqual(committedFlags);
    }
  });
});
