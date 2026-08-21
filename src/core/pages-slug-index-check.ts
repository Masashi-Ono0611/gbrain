/**
 * #550 — pages(source_id, slug) unique-index presence (detection only).
 *
 * `putPage` in BOTH engines upserts via `ON CONFLICT (source_id, slug)`,
 * which needs a valid, non-deferrable, non-partial unique index whose KEY
 * column set is exactly {source_id, slug} as its arbiter. Migration v23
 * adds `pages_source_slug_key` by NAME, so a brain whose constraint was
 * dropped/renamed by an external migration (or a `pages` table created
 * outside gbrain's own migration chain) is stamped past v23 with the
 * arbiter missing — every write then fails with "no unique or exclusion
 * constraint matching the ON CONFLICT specification" while reads stay
 * green, and the version counter can't see it. Match by column SET, not
 * name — any conforming unique index satisfies the arbiter (mirror of the
 * #2038 timeline_dedup shape check in timeline-dedup-repair.ts).
 *
 * Queries `pg_index`/`pg_attribute` directly rather than text-parsing
 * `pg_indexes.indexdef`, so it correctly:
 *  - separates KEY columns from INCLUDE columns (`indkey[0:indnkeyatts-1]`
 *    — text-parsing the trailing parens of indexdef instead would grab the
 *    INCLUDE list and false-negative on a real arbiter with INCLUDE cols)
 *  - excludes expression-key indexes (`indexprs IS NULL`) — an expression
 *    key's `indkey` slot is the sentinel attnum 0, which has no
 *    `pg_attribute` row; without this exclusion the expression silently
 *    drops out of the aggregated column list, so e.g.
 *    `(source_id, slug, lower(title))` would be MIScounted as the exact
 *    2-column {source_id, slug} shape — a false "healthy" read while the
 *    real `ON CONFLICT (source_id, slug)` upsert fails (verified directly)
 *  - excludes invalid indexes (`indisvalid = false`, e.g. a failed
 *    CONCURRENTLY build)
 *  - excludes partial indexes (`indpred IS NOT NULL` — can't arbitrate a
 *    bare `ON CONFLICT (source_id, slug)`)
 *  - excludes PG18 unique exclusion-constraint indexes (`indisexclusion`) —
 *    a different arbiter class `ON CONFLICT` column-list inference doesn't
 *    consider
 *  - dedupes a key column list before comparing (`UNIQUE(source_id, slug,
 *    slug)` verified live to still arbitrate `ON CONFLICT (source_id,
 *    slug)` — Postgres compares key columns as a SET, so a 3-key-position
 *    index with a repeated column must not miscount as a non-matching
 *    3-column shape)
 *  - treats a DEFERRABLE unique constraint on the matching columns as
 *    POISONING the arbiter even when a separate non-deferrable one on the
 *    same columns also exists: Postgres's column-list conflict inference
 *    considers every matching index, and errors ("ON CONFLICT does not
 *    support deferrable unique constraints/exclusion constraints as
 *    arbiters") if ANY of them is deferrable — it does not just skip the
 *    deferrable one and use the immediate one (verified directly).
 *    Deferred-ness is read from `pg_index.indimmediate` (false exactly
 *    when the constraint backing the index is DEFERRABLE, INITIALLY
 *    IMMEDIATE or DEFERRED alike — verified directly against
 *    `pg_constraint.condeferrable`), not a `pg_constraint` join: a plain
 *    `CREATE UNIQUE INDEX` has no DEFERRABLE syntax, so any index with
 *    `indimmediate = false` is necessarily constraint-backed and its own
 *    name IS the constraint name — letting the repair message name the
 *    exact offending constraint(s) without a second query (and without
 *    the FK-fanout duplicate-row hazard a `pg_constraint` join on
 *    `conindid` has: any table FK'ing to `pages.id` also registers a
 *    constraint row whose `conindid` is `pages_pkey`'s oid)
 *  - is schema-qualified via `to_regclass('pages')`'s OID rather than a
 *    bare `tablename` string match, so a same-named table in another
 *    schema can't produce a false "healthy" read
 *
 * Detection only, deliberately: an earlier attempt at this check paired it
 * with an automatic repair path, which the maintainer declined at review —
 * a brain in this state needs a human decision (a real column-set index
 * exists elsewhere under a different name? a genuinely fresh migration
 * run is needed?), not a silent DDL change on doctor's read path.
 */

import type { BrainEngine } from './engine.ts';

const EXPECTED_COLUMNS = ['slug', 'source_id']; // sorted for order-independent comparison

interface CandidateIndexRow {
  index_name: string;
  indisvalid: boolean;
  is_partial: boolean;
  is_deferrable: boolean;
  is_primary: boolean;
  key_columns: string[] | null;
}

export interface PagesSlugIndexStatus {
  /** The `pages` table exists. A brain that's actually reached this check
   *  (past `initSchema`) should always have it — a missing table here means
   *  something outside gbrain's own migration chain dropped or never
   *  created it, which is itself a fail condition (every write depends on
   *  this table), not a "not yet initialized" state. */
  tablePresent: boolean;
  /** A valid, non-partial, non-deferrable unique index on exactly
   *  {source_id, slug} exists — i.e. `ON CONFLICT (source_id, slug)` has an
   *  arbiter to bind to. */
  hasArbiter: boolean;
  /** Names (sorted, for deterministic messaging) of DEFERRABLE unique/PK
   *  constraints found on exactly {source_id, slug} — non-empty only when
   *  `hasArbiter` is false BECAUSE a matching index exists but is poisoned
   *  by deferrability, as opposed to no matching index existing at all.
   *  Each name is a real constraint name (see file header: any deferrable
   *  unique index is necessarily constraint-backed and shares its
   *  constraint's name), safe to use in an `ALTER TABLE pages DROP
   *  CONSTRAINT <name>` repair instruction PROVIDED it's identifier-quoted
   *  (see `quoteIdent` — a constraint name is an arbitrary identifier that
   *  can itself contain commas, quotes, or `;`). */
  deferrablePoisonConstraints: string[];
  /** Subset of `deferrablePoisonConstraints` that are PRIMARY KEY
   *  constraints rather than plain UNIQUE ones. Dropping/recreating a
   *  PRIMARY KEY changes NOT NULL enforcement and breaks any foreign key
   *  referencing it — categorically different from a plain unique
   *  constraint, so these must NOT get the generic drop-and-recreate DDL. */
  deferrablePoisonPrimaryKeys: string[];
  /** True when a non-deferrable matching index already exists ALONGSIDE the
   *  poison — removing just the poisoning constraint(s) is then sufficient
   *  to restore the arbiter, and suggesting `ADD CONSTRAINT
   *  pages_source_slug_key` would collide with the one already there
   *  (`relation "pages_source_slug_key" already exists`, verified live). */
  healthyMatchExists: boolean;
}

/** Double-quotes a Postgres identifier per the standard escaping rule
 *  (embedded `"` doubled) so a constraint name containing commas, spaces,
 *  quotes, or `;` can't break or extend the generated DDL. */
function quoteIdent(name: string): string {
  return '"' + name.replace(/"/g, '""') + '"';
}

export async function checkPagesSlugUniqueIndex(engine: BrainEngine): Promise<PagesSlugIndexStatus> {
  const tbl = await engine.executeRaw<{ reg: string | null }>(
    `SELECT to_regclass('pages')::text AS reg`,
  );
  const tablePresent = !!tbl[0]?.reg;
  if (!tablePresent) {
    return {
      tablePresent: false,
      hasArbiter: false,
      deferrablePoisonConstraints: [],
      deferrablePoisonPrimaryKeys: [],
      healthyMatchExists: false,
    };
  }

  const rows = await engine.executeRaw<CandidateIndexRow>(`
    SELECT
      ix_class.relname AS index_name,
      i.indisvalid,
      (i.indpred IS NOT NULL) AS is_partial,
      (NOT i.indimmediate) AS is_deferrable,
      i.indisprimary AS is_primary,
      (SELECT array_agg(a.attname ORDER BY u.ord)
         FROM unnest(i.indkey[0:i.indnkeyatts-1]) WITH ORDINALITY AS u(attnum, ord)
         JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = u.attnum
      ) AS key_columns
    FROM pg_index i
    JOIN pg_class ix_class ON ix_class.oid = i.indexrelid
    JOIN pg_class t ON t.oid = i.indrelid
    WHERE t.oid = to_regclass('pages')
      AND i.indisunique = true
      AND i.indexprs IS NULL
      AND NOT i.indisexclusion
  `);

  const matching = rows.filter(r => {
    if (!r.indisvalid || r.is_partial) return false;
    const cols = [...new Set(r.key_columns ?? [])].sort();
    return cols.length === EXPECTED_COLUMNS.length && cols.every((c, i) => c === EXPECTED_COLUMNS[i]);
  });
  // A deferrable match poisons inference even alongside a non-deferrable
  // one on the same columns (see file header) — require at least one
  // matching index AND none of the matching indexes deferrable.
  const poisonRows = matching.filter(r => r.is_deferrable);
  const deferrablePoisonConstraints = poisonRows.map(r => r.index_name).sort();
  const deferrablePoisonPrimaryKeys = poisonRows.filter(r => r.is_primary).map(r => r.index_name).sort();
  const healthyMatchExists = matching.some(r => !r.is_deferrable);
  const hasArbiter = matching.length > 0 && deferrablePoisonConstraints.length === 0;
  return { tablePresent: true, hasArbiter, deferrablePoisonConstraints, deferrablePoisonPrimaryKeys, healthyMatchExists };
}

/**
 * Turns a {@link PagesSlugIndexStatus} into the doctor check's status/message
 * pair. Centralized so both doctor surfaces (buildChecks + doctorReportRemote)
 * report byte-identical, and correctly branched, text — the two surfaces
 * previously duplicated this logic inline and could drift (#550 Codex review:
 * a deferrable-poison state was reported with a repair instruction naming the
 * wrong constraint, since the inline text didn't distinguish "no matching
 * index at all" from "a matching index exists but is deferrable").
 */
export function describePagesSlugIndexStatus(
  status: PagesSlugIndexStatus,
): { status: 'ok' | 'fail'; message: string } {
  if (!status.tablePresent) {
    return {
      status: 'fail',
      message:
        'pages table does not exist — every put_page write, and most of gbrain, depends on it. ' +
        'If this brain was ever initialized, something outside gbrain\'s own migration chain ' +
        'dropped it; if it genuinely never was, run `gbrain init --migrate-only` to apply the base ' +
        'schema (NOT `apply-migrations`, which can report a brain already up-to-date without ' +
        'actually checking that core tables like `pages` exist).',
    };
  }
  if (status.hasArbiter) {
    return { status: 'ok', message: 'pages has a unique index on (source_id, slug)' };
  }
  if (status.deferrablePoisonPrimaryKeys.length > 0) {
    const pkNames = status.deferrablePoisonPrimaryKeys.join(', ');
    return {
      status: 'fail',
      message:
        `A PRIMARY KEY constraint on pages(source_id, slug) — ${pkNames} — is DEFERRABLE and poisons ` +
        'the ON CONFLICT arbiter (#550): Postgres refuses column-list conflict inference if ANY ' +
        'matching index is deferrable, so every put_page write fails with "ON CONFLICT does not ' +
        'support deferrable unique constraints/exclusion constraints as arbiters". This needs manual ' +
        'review, not a copy-paste fix: unlike a plain unique constraint, dropping/recreating a ' +
        'PRIMARY KEY changes NOT NULL enforcement and breaks any foreign key referencing it.',
    };
  }
  if (status.deferrablePoisonConstraints.length > 0) {
    const names = status.deferrablePoisonConstraints; // already sorted
    const dropStatements = names.map((n) => `ALTER TABLE pages DROP CONSTRAINT ${quoteIdent(n)};`).join(' ');
    // Only suggest re-adding pages_source_slug_key when nothing already
    // arbitrates — if a healthy match coexists (the poison is a SEPARATE
    // constraint on the same columns), dropping the poison alone restores
    // the arbiter, and the ADD would collide with the constraint already
    // there ("relation ... already exists", verified live).
    const addStatement = status.healthyMatchExists
      ? ''
      : ' ALTER TABLE pages ADD CONSTRAINT pages_source_slug_key UNIQUE (source_id, slug);';
    return {
      status: 'fail',
      message:
        `DEFERRABLE unique constraint(s) on pages(source_id, slug) — ${names.join(', ')} — poison the ` +
        'ON CONFLICT arbiter (#550): Postgres refuses column-list conflict inference if ANY ' +
        'matching index is deferrable, even alongside a non-deferrable one on the same columns, ' +
        'so every put_page write fails with "ON CONFLICT does not support deferrable unique ' +
        'constraints/exclusion constraints as arbiters". Manual repair (drop and recreate NOT ' +
        "DEFERRABLE — ALTER TABLE can't change an existing unique constraint's deferrability in place" +
        (status.healthyMatchExists ? '; a healthy pages_source_slug_key already exists, so no re-add is needed' : '') +
        '): ' +
        dropStatements +
        addStatement,
    };
  }
  return {
    status: 'fail',
    message:
      'No unique index on pages(source_id, slug) — every put_page write fails with ' +
      '"no unique or exclusion constraint matching the ON CONFLICT specification" (#550). ' +
      '`apply-migrations --force-schema` runs migrations forward from the CURRENT version, so ' +
      'it will NOT replay v23 on a brain already stamped past it. Manual repair: ' +
      '`ALTER TABLE pages ADD CONSTRAINT pages_source_slug_key UNIQUE (source_id, slug);` ' +
      '(fails loudly if duplicate (source_id, slug) rows already exist — resolve those first).',
  };
}
