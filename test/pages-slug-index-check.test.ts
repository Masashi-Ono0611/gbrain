/**
 * #550 — pages(source_id, slug) unique-index presence (detection only).
 *
 * A brain whose `pages_source_slug_key` constraint was dropped or renamed
 * by an external migration is stamped past v23 with the arbiter missing —
 * `putPage`'s `ON CONFLICT (source_id, slug)` then fails brain-wide while
 * reads stay green, and the version counter can't see it. These tests
 * simulate the drifted states directly and pin: detection of the healthy
 * fresh-init state, detection of an absent arbiter, and several shapes
 * that must NOT count as the arbiter (wrong columns, partial, deferrable)
 * or that must count despite looking unusual (renamed, INCLUDE clause).
 *
 * Each test restores `pages_source_slug_key` in a `finally` block so an
 * assertion failure mid-test can't leave the shared engine in a state that
 * cascades into unrelated failures in later tests.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { checkPagesSlugUniqueIndex, describePagesSlugIndexStatus } from '../src/core/pages-slug-index-check.ts';
import { buildChecks, doctorReportRemote, type Check } from '../src/commands/doctor.ts';
import { doctorSource } from './helpers/doctor-source.ts';

function findCheck(checks: Check[], name: string): Check | undefined {
  return checks.find((c) => c.name === name);
}

/** Drop the standard arbiter, run `body`, then restore it — even on failure. */
async function withArbiterDropped(engine: PGLiteEngine, body: () => Promise<void>): Promise<void> {
  await engine.executeRaw(`ALTER TABLE pages DROP CONSTRAINT IF EXISTS pages_source_slug_key`);
  try {
    await body();
  } finally {
    await engine.executeRaw(
      `ALTER TABLE pages ADD CONSTRAINT pages_source_slug_key UNIQUE (source_id, slug)`,
    );
  }
}

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

describe('#550 pages(source_id, slug) unique-index detection', () => {
  test('a fresh-init brain has the arbiter', async () => {
    const status = await checkPagesSlugUniqueIndex(engine);
    expect(status.tablePresent).toBe(true);
    expect(status.hasArbiter).toBe(true);
  });

  test('detects an absent arbiter after the constraint is dropped', async () => {
    await withArbiterDropped(engine, async () => {
      const status = await checkPagesSlugUniqueIndex(engine);
      expect(status.tablePresent).toBe(true);
      expect(status.hasArbiter).toBe(false);
    });
    const restored = await checkPagesSlugUniqueIndex(engine);
    expect(restored.hasArbiter).toBe(true);
  });

  test('a unique index under a DIFFERENT name still satisfies the arbiter (matched by columns, not name)', async () => {
    await withArbiterDropped(engine, async () => {
      await engine.executeRaw(`CREATE UNIQUE INDEX renamed_slug_arbiter ON pages(source_id, slug)`);
      try {
        const status = await checkPagesSlugUniqueIndex(engine);
        expect(status.hasArbiter).toBe(true);
      } finally {
        await engine.executeRaw(`DROP INDEX IF EXISTS renamed_slug_arbiter`);
      }
    });
  });

  test('a unique index on the wrong columns does NOT satisfy the arbiter', async () => {
    await withArbiterDropped(engine, async () => {
      await engine.executeRaw(`CREATE UNIQUE INDEX wrong_cols_idx ON pages(slug)`);
      try {
        const status = await checkPagesSlugUniqueIndex(engine);
        expect(status.hasArbiter).toBe(false);
      } finally {
        await engine.executeRaw(`DROP INDEX IF EXISTS wrong_cols_idx`);
      }
    });
  });

  test('a PARTIAL unique index on the right columns does NOT satisfy the arbiter (cannot arbitrate a bare ON CONFLICT)', async () => {
    await withArbiterDropped(engine, async () => {
      await engine.executeRaw(
        `CREATE UNIQUE INDEX partial_slug_idx ON pages(source_id, slug) WHERE deleted_at IS NULL`,
      );
      try {
        const status = await checkPagesSlugUniqueIndex(engine);
        expect(status.hasArbiter).toBe(false);
      } finally {
        await engine.executeRaw(`DROP INDEX IF EXISTS partial_slug_idx`);
      }
    });
  });

  test('a unique index with an INCLUDE clause on the right key columns DOES satisfy the arbiter (INCLUDE columns are not key columns)', async () => {
    await withArbiterDropped(engine, async () => {
      await engine.executeRaw(`CREATE UNIQUE INDEX include_arbiter ON pages(source_id, slug) INCLUDE (title)`);
      try {
        const status = await checkPagesSlugUniqueIndex(engine);
        expect(status.hasArbiter).toBe(true);
        // Ground truth: an actual ON CONFLICT (source_id, slug) upsert
        // succeeds against this index — confirms the detection matches real
        // behavior, not just the parsed shape.
        await engine.executeRaw(
          `INSERT INTO pages(source_id, slug, type, title) VALUES ('default', 'x-include', 'note', 'x') ` +
          `ON CONFLICT (source_id, slug) DO UPDATE SET title = EXCLUDED.title`,
        );
      } finally {
        await engine.executeRaw(`DROP INDEX IF EXISTS include_arbiter`);
      }
    });
  });

  test('a DEFERRABLE unique constraint on the right columns does NOT satisfy the arbiter (Postgres itself rejects deferrable arbiters)', async () => {
    await withArbiterDropped(engine, async () => {
      await engine.executeRaw(
        `ALTER TABLE pages ADD CONSTRAINT deferrable_arbiter UNIQUE (source_id, slug) DEFERRABLE INITIALLY IMMEDIATE`,
      );
      try {
        const status = await checkPagesSlugUniqueIndex(engine);
        expect(status.hasArbiter).toBe(false);
        // Ground truth: Postgres rejects this exact shape as an ON CONFLICT
        // arbiter, confirming the check isn't over-cautious versus real
        // behavior.
        await expect(
          engine.executeRaw(
            `INSERT INTO pages(source_id, slug, type, title) VALUES ('default', 'x-defsingle', 'note', 'x') ` +
            `ON CONFLICT (source_id, slug) DO UPDATE SET title = EXCLUDED.title`,
          ),
        ).rejects.toThrow(/deferrable/i);
      } finally {
        await engine.executeRaw(`ALTER TABLE pages DROP CONSTRAINT IF EXISTS deferrable_arbiter`);
      }
    });
  });

  test('a unique index with a DUPLICATE key column still satisfies the arbiter (Postgres compares key columns as a SET)', async () => {
    await withArbiterDropped(engine, async () => {
      await engine.executeRaw(`CREATE UNIQUE INDEX dup_col_arbiter ON pages(source_id, slug, slug)`);
      try {
        const status = await checkPagesSlugUniqueIndex(engine);
        expect(status.hasArbiter).toBe(true);
        // Ground truth: a real ON CONFLICT (source_id, slug) upsert succeeds
        // against this 3-key-position index with a repeated column — a naive
        // exact-length-2 comparison would false-negative here.
        await engine.executeRaw(
          `INSERT INTO pages(source_id, slug, type, title) VALUES ('default', 'x-dupcol', 'note', 'x') ` +
          `ON CONFLICT (source_id, slug) DO UPDATE SET title = EXCLUDED.title`,
        );
      } finally {
        await engine.executeRaw(`DROP INDEX IF EXISTS dup_col_arbiter`);
      }
    });
  });

  test('a unique index with an EXPRESSION key does NOT satisfy the arbiter, even though its plain-column keys match {source_id, slug}', async () => {
    await withArbiterDropped(engine, async () => {
      await engine.executeRaw(`CREATE UNIQUE INDEX expr_arbiter ON pages(source_id, slug, lower(title))`);
      try {
        const status = await checkPagesSlugUniqueIndex(engine);
        expect(status.hasArbiter).toBe(false);
        // Ground truth: the expression key makes this a 3-key-column index
        // that ON CONFLICT (source_id, slug) can't infer, even though the
        // first two key positions are the right plain columns.
        await expect(
          engine.executeRaw(
            `INSERT INTO pages(source_id, slug, type, title) VALUES ('default', 'x-expr', 'note', 'x') ` +
            `ON CONFLICT (source_id, slug) DO UPDATE SET title = EXCLUDED.title`,
          ),
        ).rejects.toThrow();
      } finally {
        await engine.executeRaw(`DROP INDEX IF EXISTS expr_arbiter`);
      }
    });
  });

  test('a DEFERRABLE constraint on the right columns poisons the arbiter even when a separate non-deferrable one on the same columns also exists', async () => {
    // Note: does NOT use withArbiterDropped — the point is that the healthy
    // pages_source_slug_key stays in place while a second, deferrable
    // constraint on the SAME columns is added alongside it.
    await engine.executeRaw(
      `ALTER TABLE pages ADD CONSTRAINT deferrable_coexist UNIQUE (source_id, slug) DEFERRABLE INITIALLY IMMEDIATE`,
    );
    try {
      const status = await checkPagesSlugUniqueIndex(engine);
      expect(status.hasArbiter).toBe(false);
      // The offending constraint is named specifically (not just "no
      // arbiter") so the repair message can tell the operator what to
      // actually drop, instead of always suggesting pages_source_slug_key
      // (which, in this coexistence case, is the healthy one already there).
      expect(status.deferrablePoisonConstraints).toEqual(['deferrable_coexist']);
      expect(status.deferrablePoisonPrimaryKeys).toEqual([]);
      expect(status.healthyMatchExists).toBe(true);
      // Ground truth: Postgres's column-list conflict inference considers
      // every matching index and errors if ANY of them is deferrable — it
      // does not silently prefer the immediate one.
      await expect(
        engine.executeRaw(
          `INSERT INTO pages(source_id, slug, type, title) VALUES ('default', 'x-poison', 'note', 'x') ` +
          `ON CONFLICT (source_id, slug) DO UPDATE SET title = EXCLUDED.title`,
        ),
      ).rejects.toThrow(/deferrable/i);
      // Ground truth for the repair advice itself (Codex round-4 finding):
      // dropping ONLY the poison — no re-add — must be sufficient, since
      // pages_source_slug_key is still there. Executing the actual DROP
      // statement the message would generate must restore the arbiter
      // without an "already exists" collision.
      await engine.executeRaw(`ALTER TABLE pages DROP CONSTRAINT "deferrable_coexist"`);
      const afterDropOnly = await checkPagesSlugUniqueIndex(engine);
      expect(afterDropOnly.hasArbiter).toBe(true);
    } finally {
      await engine.executeRaw(`ALTER TABLE pages DROP CONSTRAINT IF EXISTS deferrable_coexist`);
    }
    const restored = await checkPagesSlugUniqueIndex(engine);
    expect(restored.hasArbiter).toBe(true);
    expect(restored.deferrablePoisonConstraints).toEqual([]);
  });

  test('a DEFERRABLE constraint whose name needs identifier-quoting (commas, spaces, embedded quotes) is detected and its repair DDL is actually executable', async () => {
    // Codex round-4 finding: a constraint name is an arbitrary identifier —
    // concatenating it unquoted into generated DDL can produce invalid SQL
    // or let the name inject additional statements. This name deliberately
    // has all three hazards.
    const weirdName = 'odd,name "quoted"';
    await engine.executeRaw(
      `ALTER TABLE pages ADD CONSTRAINT "odd,name ""quoted""" UNIQUE (source_id, slug) DEFERRABLE INITIALLY IMMEDIATE`,
    );
    try {
      const status = await checkPagesSlugUniqueIndex(engine);
      expect(status.deferrablePoisonConstraints).toEqual([weirdName]);
      const { message } = describePagesSlugIndexStatus(status);
      // Ground truth: run the EXACT DROP CONSTRAINT statement the message
      // embeds (regex-extracted, not hand-written) — it must execute
      // without a syntax error and must drop the actual constraint.
      const dropStmt = message.match(/ALTER TABLE pages DROP CONSTRAINT "[^;]+;/)?.[0];
      expect(dropStmt).toBeDefined();
      await engine.executeRaw(dropStmt!);
      const afterDrop = await checkPagesSlugUniqueIndex(engine);
      expect(afterDrop.hasArbiter).toBe(true);
      expect(afterDrop.deferrablePoisonConstraints).toEqual([]);
    } finally {
      await engine.executeRaw(`ALTER TABLE pages DROP CONSTRAINT IF EXISTS "odd,name ""quoted"""`);
    }
  });
});

describe('#550 describePagesSlugIndexStatus (message construction, pure — no DB)', () => {
  test('missing pages table reports FAIL (not ok — a versioned brain without its own core table is corrupt, not "not yet initialized"), and points at init --migrate-only', () => {
    const result = describePagesSlugIndexStatus({
      tablePresent: false,
      hasArbiter: false,
      deferrablePoisonConstraints: [],
      deferrablePoisonPrimaryKeys: [],
      healthyMatchExists: false,
    });
    expect(result.status).toBe('fail');
    expect(result.message).toContain('pages table does not exist');
    expect(result.message).toContain('gbrain init --migrate-only');
  });

  test('no matching index at all gives the generic ADD CONSTRAINT pages_source_slug_key repair', () => {
    const result = describePagesSlugIndexStatus({
      tablePresent: true,
      hasArbiter: false,
      deferrablePoisonConstraints: [],
      deferrablePoisonPrimaryKeys: [],
      healthyMatchExists: false,
    });
    expect(result.status).toBe('fail');
    expect(result.message).toContain('ALTER TABLE pages ADD CONSTRAINT pages_source_slug_key UNIQUE (source_id, slug);');
    expect(result.message).not.toContain('DEFERRABLE');
  });

  test('a deferrable-poisoned arbiter with NO healthy match names the offending constraint and includes the re-add', () => {
    const result = describePagesSlugIndexStatus({
      tablePresent: true,
      hasArbiter: false,
      deferrablePoisonConstraints: ['deferrable_arbiter'],
      deferrablePoisonPrimaryKeys: [],
      healthyMatchExists: false,
    });
    expect(result.status).toBe('fail');
    expect(result.message).toContain('DROP CONSTRAINT "deferrable_arbiter";');
    expect(result.message).toContain('NOT DEFERRABLE');
    // No healthy arbiter exists yet, so the re-add IS needed here.
    expect(result.message).toContain('ALTER TABLE pages ADD CONSTRAINT pages_source_slug_key UNIQUE (source_id, slug);');
    // Quotes the actual runtime error, not the "no matching index" one.
    expect(result.message).toContain('ON CONFLICT does not support deferrable unique constraints/exclusion constraints as arbiters');
  });

  test('a deferrable-poisoned arbiter that COEXISTS with a healthy match names the offending constraint but must NOT re-add pages_source_slug_key (round-4 Critical: it already exists)', () => {
    const result = describePagesSlugIndexStatus({
      tablePresent: true,
      hasArbiter: false,
      deferrablePoisonConstraints: ['deferrable_coexist'],
      deferrablePoisonPrimaryKeys: [],
      healthyMatchExists: true,
    });
    expect(result.status).toBe('fail');
    expect(result.message).toContain('DROP CONSTRAINT "deferrable_coexist";');
    expect(result.message).not.toContain('ADD CONSTRAINT pages_source_slug_key');
  });

  test('multiple deferrable-poisoning constraints are all named in the repair instruction, each individually quoted', () => {
    const result = describePagesSlugIndexStatus({
      tablePresent: true,
      hasArbiter: false,
      deferrablePoisonConstraints: ['def_a', 'def_b'],
      deferrablePoisonPrimaryKeys: [],
      healthyMatchExists: false,
    });
    expect(result.message).toContain('DROP CONSTRAINT "def_a";');
    expect(result.message).toContain('DROP CONSTRAINT "def_b";');
  });

  test('constraint names containing special characters are identifier-quoted, not concatenated raw (round-4 Critical: SQL-injection-shaped hazard)', () => {
    const result = describePagesSlugIndexStatus({
      tablePresent: true,
      hasArbiter: false,
      deferrablePoisonConstraints: ['odd,name "quoted"; DROP TABLE pages'],
      deferrablePoisonPrimaryKeys: [],
      healthyMatchExists: false,
    });
    // Embedded double-quotes are doubled per Postgres identifier escaping;
    // the whole thing is one quoted token, so the embedded `;` and comma
    // stay inert data instead of terminating/extending the statement.
    expect(result.message).toContain('DROP CONSTRAINT "odd,name ""quoted""; DROP TABLE pages";');
  });

  test('a DEFERRABLE PRIMARY KEY gets conservative manual-review advice, never a drop-and-recreate-as-UNIQUE prescription', () => {
    const result = describePagesSlugIndexStatus({
      tablePresent: true,
      hasArbiter: false,
      deferrablePoisonConstraints: ['pages_pkey'],
      deferrablePoisonPrimaryKeys: ['pages_pkey'],
      healthyMatchExists: false,
    });
    expect(result.status).toBe('fail');
    expect(result.message).toContain('pages_pkey');
    expect(result.message).toContain('PRIMARY KEY');
    expect(result.message).toContain('manual review');
    // Must NOT hand out the generic unique-constraint DROP/ADD DDL for a PK
    // — that would silently change NOT NULL enforcement and break FKs.
    expect(result.message).not.toContain('DROP CONSTRAINT');
    expect(result.message).not.toContain('ADD CONSTRAINT pages_source_slug_key');
  });
});

describe('#550 doctor surface wiring', () => {
  test('buildChecks() includes pages_slug_unique_index', async () => {
    const checks = await buildChecks(engine, ['--scope=brain']);
    const check = findCheck(checks, 'pages_slug_unique_index');
    expect(check).toBeDefined();
    expect(check!.status).toBe('ok');
  });

  test('doctorReportRemote() includes pages_slug_unique_index (cross-surface parity)', async () => {
    const report = await doctorReportRemote(engine);
    const check = findCheck(report.checks, 'pages_slug_unique_index');
    expect(check).toBeDefined();
    expect(check!.status).toBe('ok');
  });

  test('buildChecks() reports fail when the arbiter is absent, with an accurate (not --force-schema) recovery instruction', async () => {
    await withArbiterDropped(engine, async () => {
      const checks = await buildChecks(engine, ['--scope=brain']);
      const check = findCheck(checks, 'pages_slug_unique_index');
      expect(check!.status).toBe('fail');
      expect(check!.message).toContain('#550');
      // The recovery instruction must not claim --force-schema fixes a
      // brain already stamped past v23 (it doesn't — it only runs
      // migrations forward from the current version); it must instead
      // give the actual manual repair.
      expect(check!.message).not.toContain('Run `gbrain apply-migrations --force-schema` to restore it');
      expect(check!.message).toContain('ALTER TABLE pages ADD CONSTRAINT pages_source_slug_key UNIQUE (source_id, slug);');
    });
  });
});

describe('cross-surface parity (source-grep regression guard)', () => {
  test('doctor.ts wires checkPagesSlugUniqueIndex into BOTH buildChecks and doctorReportRemote', () => {
    // Static regression assertion: the helper must be called from BOTH
    // surfaces. If a future maintainer removes the call from one, this test
    // fails pointing at the asymmetry (same pattern as the
    // embedding_env_override guard in doctor-embedding-env-override.test.ts).
    const src = doctorSource();
    const matches = src.match(/await checkPagesSlugUniqueIndex\(engine\)/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });
});
