/**
 * v0.31 Phase 6 — facts engine round-trip tests on PGLite (in-memory, no
 * DATABASE_URL required).
 *
 * Pins every BrainEngine facts method end-to-end:
 *   - insertFact (insert, supersede)
 *   - expireFact (idempotent-as-false)
 *   - listFactsByEntity / Since / Session / Supersessions
 *   - findCandidateDuplicates (entity-prefiltered, k cap, cosine ordering)
 *   - consolidateFact
 *   - getFactsHealth
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import {
  TERMINAL_AUDIT_SOURCE,
  NON_EXTRACTABLE_AUDIT_SOURCE,
} from '../src/core/facts/audit-sources.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  // Pin the embedding dim to 1536 BEFORE initSchema. vec() hardcodes
  // Float32Array(1536), but initSchema sizes vector columns from
  // process-global gateway state (getEmbeddingDimensions(), default 1280).
  // Whether this file passes therefore depends on which test files run
  // before it in the shard; adding test files to the repo reshuffles the
  // weight-packed shards, so unrelated PRs trip it ("expected 1280
  // dimensions, not 1536"). Same fix + rationale as
  // doctor-hidden-by-search-policy.test.ts (#2801),
  // engine-find-trajectory.test.ts and cosine-rescore-column.test.ts.
  resetGateway();
  configureGateway({
    embedding_model: 'openai:text-embedding-3-large',
    embedding_dimensions: 1536,
    env: { OPENAI_API_KEY: 'sk-test-facts-engine' },
  });
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
  resetGateway();
});

const vec = (...vals: number[]): Float32Array => {
  const a = new Float32Array(1536);
  for (let i = 0; i < vals.length; i++) a[i] = vals[i];
  return a;
};

describe('insertFact + listFactsByEntity', () => {
  test('inserts a fact and reads it back', async () => {
    const r = await engine.insertFact(
      { fact: 'alice example fact', kind: 'fact', entity_slug: 'people/alice-example', source: 'test' },
      { source_id: 'default' },
    );
    expect(r.id).toBeGreaterThan(0);
    expect(r.status).toBe('inserted');
    const rows = await engine.listFactsByEntity('default', 'people/alice-example');
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const ours = rows.find(x => x.id === r.id);
    expect(ours).toBeDefined();
    expect(ours!.fact).toBe('alice example fact');
    expect(ours!.kind).toBe('fact');
    expect(ours!.visibility).toBe('private');
    // v0.31.2: row mapper exposes notability; default 'medium' when caller omits.
    expect(ours!.notability).toBe('medium');
    expect(ours!.confidence).toBe(1.0);
  });

  test('respects kind CHECK', async () => {
    const r = await engine.insertFact(
      { fact: 'durable', kind: 'preference', entity_slug: 'alice-test', source: 'test' },
      { source_id: 'default' },
    );
    const rows = await engine.listFactsByEntity('default', 'alice-test');
    const ours = rows.find(x => x.id === r.id);
    expect(ours?.kind).toBe('preference');
  });

  test('v0.31.2: notability round-trips for each tier (PR1 commit 4 contract pin)', async () => {
    const tiers: Array<'high' | 'medium' | 'low'> = ['high', 'medium', 'low'];
    for (const tier of tiers) {
      const r = await engine.insertFact(
        {
          fact: `notability ${tier} test`,
          kind: 'fact',
          entity_slug: `notability-${tier}-pin`,
          source: 'test',
          notability: tier,
        },
        { source_id: 'default' },
      );
      const rows = await engine.listFactsByEntity('default', `notability-${tier}-pin`);
      const ours = rows.find(x => x.id === r.id);
      expect(ours).toBeDefined();
      // The row mapper MUST expose notability; without this assertion, the
      // codex P1 #4 regression (FactRow drops the column) reappears silently.
      expect(ours!.notability).toBe(tier);
    }
  });

  test('supersede path: superseding row marks old as expired_at + superseded_by', async () => {
    const old = await engine.insertFact(
      { fact: 'old fact', kind: 'fact', entity_slug: 'super-test', source: 'test' },
      { source_id: 'default' },
    );
    const newer = await engine.insertFact(
      { fact: 'new fact', kind: 'fact', entity_slug: 'super-test', source: 'test' },
      { source_id: 'default', supersedeId: old.id },
    );
    expect(newer.status).toBe('superseded');
    expect(newer.id).toBeGreaterThan(old.id);

    const supersessions = await engine.listSupersessions('default');
    const oldRow = supersessions.find(r => r.id === old.id);
    expect(oldRow).toBeDefined();
    expect(oldRow!.expired_at).not.toBeNull();
    expect(oldRow!.superseded_by).toBe(newer.id);
  });
});

describe('expireFact', () => {
  test('returns true on first call, false on idempotent re-call', async () => {
    const r = await engine.insertFact(
      { fact: 'will expire', kind: 'fact', source: 'test' },
      { source_id: 'default' },
    );
    expect(await engine.expireFact(r.id)).toBe(true);
    expect(await engine.expireFact(r.id)).toBe(false);
  });

  test('returns false on unknown id', async () => {
    expect(await engine.expireFact(99999999)).toBe(false);
  });
});

describe('listFactsSince + listFactsBySession', () => {
  test('listFactsSince filters by created_at', async () => {
    const before = new Date();
    await engine.insertFact(
      { fact: 'recent', kind: 'fact', source: 'test', source_session: 'topic-since' },
      { source_id: 'default' },
    );
    const rows = await engine.listFactsSince('default', before);
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.every(r => r.created_at.getTime() >= before.getTime())).toBe(true);
  });

  test('listFactsBySession filters by source_session', async () => {
    await engine.insertFact(
      { fact: 'topic-A note', kind: 'fact', source: 'test', source_session: 'topic-A' },
      { source_id: 'default' },
    );
    await engine.insertFact(
      { fact: 'topic-B note', kind: 'fact', source: 'test', source_session: 'topic-B' },
      { source_id: 'default' },
    );
    const a = await engine.listFactsBySession('default', 'topic-A');
    const b = await engine.listFactsBySession('default', 'topic-B');
    expect(a.every(r => r.source_session === 'topic-A')).toBe(true);
    expect(b.every(r => r.source_session === 'topic-B')).toBe(true);
    expect(a.find(r => r.source_session === 'topic-B')).toBeUndefined();
  });
});

describe('excludeAuditRows (internal extraction audit rows) — listFactsSince', () => {
  // extract-conversation-facts writes per-page terminal audit rows
  // (kind:'fact', entity_slug:null, never expired) as internal completion
  // markers. Every non-engine caller of listFacts* is a user-facing
  // knowledge surface (recall, entity, ambient turn-context, meta-hook,
  // CLI recall) — none of them are diagnostic, so these rows must not leak
  // into them by default. extract-conversation-facts' own resume logic
  // reads them via raw SQL, not listFacts*, so this filter cannot affect
  // resume.
  test('audit row (TERMINAL_AUDIT_SOURCE) is NOT returned by listFactsSince by default', async () => {
    const before = new Date();
    await engine.insertFact(
      {
        fact: 'EXTRACTION_COMPLETE',
        kind: 'fact',
        entity_slug: null,
        source: TERMINAL_AUDIT_SOURCE,
        source_session: 'audit-row-filter-test-complete',
      },
      { source_id: 'default' },
    );
    const rows = await engine.listFactsSince('default', before);
    expect(rows.find(r => r.source_session === 'audit-row-filter-test-complete')).toBeUndefined();
  });

  test('audit row IS returned when excludeAuditRows: false is passed explicitly (proves it is a filter, not a delete)', async () => {
    const before = new Date();
    await engine.insertFact(
      {
        fact: 'EXTRACTION_NOT_APPLICABLE',
        kind: 'fact',
        entity_slug: null,
        source: NON_EXTRACTABLE_AUDIT_SOURCE,
        source_session: 'audit-row-filter-test-non-applicable',
      },
      { source_id: 'default' },
    );
    const rows = await engine.listFactsSince('default', before, { excludeAuditRows: false });
    const row = rows.find(r => r.source_session === 'audit-row-filter-test-non-applicable');
    expect(row).toBeDefined();
    expect(row!.source).toBe(NON_EXTRACTABLE_AUDIT_SOURCE);
  });

  test('real facts seeded alongside an audit row are still returned (filter is not over-broad)', async () => {
    const before = new Date();
    const session = 'audit-row-filter-test-mixed';
    await engine.insertFact(
      { fact: 'real user fact', kind: 'fact', source: 'test', source_session: session },
      { source_id: 'default' },
    );
    await engine.insertFact(
      {
        fact: 'EXTRACTION_COMPLETE',
        kind: 'fact',
        entity_slug: null,
        source: TERMINAL_AUDIT_SOURCE,
        source_session: session,
      },
      { source_id: 'default' },
    );
    const rows = await engine.listFactsSince('default', before);
    const scoped = rows.filter(r => r.source_session === session);
    expect(scoped.length).toBe(1);
    expect(scoped[0].fact).toBe('real user fact');
  });
});

describe('excludeAuditRows — listFactsByEntity', () => {
  // In production, writeTerminalAuditRow/writeNonExtractableAuditRow always
  // set entity_slug: null, so listFactsByEntity (which requires an
  // entity_slug match) would never reach a real audit row regardless of
  // this filter — that would make a test seeding a null-entity_slug audit
  // row here VACUOUS (it'd pass whether or not the source predicate exists,
  // since the entity_slug predicate alone already excludes it). To actually
  // exercise the source predicate, seed an audit-sourced row WITH a
  // non-null entity_slug the query COULD otherwise reach.
  const ENTITY = 'people/audit-row-filter-entity-test';

  test('audit-sourced row reachable by entity_slug is NOT returned by default', async () => {
    await engine.insertFact(
      {
        fact: 'EXTRACTION_COMPLETE',
        kind: 'fact',
        entity_slug: ENTITY,
        source: TERMINAL_AUDIT_SOURCE,
        source_session: 'audit-row-filter-entity-test-complete',
      },
      { source_id: 'default' },
    );
    const rows = await engine.listFactsByEntity('default', ENTITY);
    expect(rows.find(r => r.source_session === 'audit-row-filter-entity-test-complete')).toBeUndefined();
  });

  test('audit-sourced row IS returned when excludeAuditRows: false is passed explicitly', async () => {
    await engine.insertFact(
      {
        fact: 'EXTRACTION_NOT_APPLICABLE',
        kind: 'fact',
        entity_slug: ENTITY,
        source: NON_EXTRACTABLE_AUDIT_SOURCE,
        source_session: 'audit-row-filter-entity-test-non-applicable',
      },
      { source_id: 'default' },
    );
    const rows = await engine.listFactsByEntity('default', ENTITY, { excludeAuditRows: false });
    const row = rows.find(r => r.source_session === 'audit-row-filter-entity-test-non-applicable');
    expect(row).toBeDefined();
    expect(row!.source).toBe(NON_EXTRACTABLE_AUDIT_SOURCE);
  });

  test('a real fact under the same entity_slug is still returned (filter is not over-broad)', async () => {
    await engine.insertFact(
      { fact: 'real entity fact', kind: 'fact', entity_slug: ENTITY, source: 'test', source_session: 'audit-row-filter-entity-test-real' },
      { source_id: 'default' },
    );
    const rows = await engine.listFactsByEntity('default', ENTITY);
    const row = rows.find(r => r.source_session === 'audit-row-filter-entity-test-real');
    expect(row).toBeDefined();
    expect(row!.fact).toBe('real entity fact');
  });
});

describe('excludeAuditRows — listFactsBySession', () => {
  test('audit row (entity_slug: null, as production writes it) is NOT returned by listFactsBySession by default', async () => {
    const session = 'audit-row-filter-bysession-test';
    await engine.insertFact(
      { fact: 'EXTRACTION_COMPLETE', kind: 'fact', entity_slug: null, source: TERMINAL_AUDIT_SOURCE, source_session: session },
      { source_id: 'default' },
    );
    const rows = await engine.listFactsBySession('default', session);
    expect(rows.length).toBe(0);
  });

  test('audit row IS returned when excludeAuditRows: false is passed explicitly', async () => {
    const session = 'audit-row-filter-bysession-test-override';
    await engine.insertFact(
      { fact: 'EXTRACTION_NOT_APPLICABLE', kind: 'fact', entity_slug: null, source: NON_EXTRACTABLE_AUDIT_SOURCE, source_session: session },
      { source_id: 'default' },
    );
    const rows = await engine.listFactsBySession('default', session, { excludeAuditRows: false });
    expect(rows.length).toBe(1);
    expect(rows[0].source).toBe(NON_EXTRACTABLE_AUDIT_SOURCE);
  });

  test('a real fact in the same session is still returned (filter is not over-broad)', async () => {
    const session = 'audit-row-filter-bysession-test-mixed';
    await engine.insertFact(
      { fact: 'real session fact', kind: 'fact', source: 'test', source_session: session },
      { source_id: 'default' },
    );
    await engine.insertFact(
      { fact: 'EXTRACTION_COMPLETE', kind: 'fact', entity_slug: null, source: TERMINAL_AUDIT_SOURCE, source_session: session },
      { source_id: 'default' },
    );
    const rows = await engine.listFactsBySession('default', session);
    expect(rows.length).toBe(1);
    expect(rows[0].fact).toBe('real session fact');
  });
});

describe('listSupersessions is NOT filtered by excludeAuditRows (audit-log parity, Item 1)', () => {
  // listSupersessions is a supersession AUDIT LOG, not a knowledge-recall
  // surface — postgres-engine.ts's listSupersessions never filtered audit
  // rows, so pglite-engine.ts's must not either, or the two engines
  // diverge (adversarial-review finding: PGLite's shared `_listFacts`
  // helper defaults excludeAuditRows to true, and without an explicit
  // override at the listSupersessions call site, a superseded audit row
  // would vanish from PGLite's log while staying visible on Postgres's).
  // Any row — including an audit row — can be superseded: expireFact(id,
  // { supersededBy }) sets expired_at/superseded_by on whatever id it's
  // given, with nothing that special-cases audit sources.
  test('a superseded audit row IS returned by listSupersessions (matches Postgres, which never filtered it)', async () => {
    const audit = await engine.insertFact(
      {
        fact: 'EXTRACTION_COMPLETE',
        kind: 'fact',
        entity_slug: null,
        source: TERMINAL_AUDIT_SOURCE,
        source_session: 'audit-row-supersession-test',
      },
      { source_id: 'default' },
    );
    const newer = await engine.insertFact(
      { fact: 'superseder of audit row', kind: 'fact', source: 'test' },
      { source_id: 'default' },
    );
    const didExpire = await engine.expireFact(audit.id, { supersededBy: newer.id });
    expect(didExpire).toBe(true);

    const supersessions = await engine.listSupersessions('default');
    const row = supersessions.find(r => r.id === audit.id);
    expect(row).toBeDefined();
    expect(row!.source).toBe(TERMINAL_AUDIT_SOURCE);
    expect(row!.superseded_by).toBe(newer.id);
  });
});

describe('findCandidateDuplicates', () => {
  test('entity-prefiltered: rows from other entities never returned', async () => {
    await engine.insertFact(
      { fact: 'alice fact', kind: 'fact', entity_slug: 'cand-alice', source: 'test' },
      { source_id: 'default' },
    );
    await engine.insertFact(
      { fact: 'tim fact', kind: 'fact', entity_slug: 'cand-tim', source: 'test' },
      { source_id: 'default' },
    );
    const candidates = await engine.findCandidateDuplicates('default', 'cand-alice', 'alice fact');
    expect(candidates.every(c => c.entity_slug === 'cand-alice')).toBe(true);
    expect(candidates.find(c => c.entity_slug === 'cand-tim')).toBeUndefined();
  });

  test('k cap honored', async () => {
    for (let i = 0; i < 7; i++) {
      await engine.insertFact(
        { fact: `cap-test ${i}`, kind: 'fact', entity_slug: 'cap-entity', source: 'test' },
        { source_id: 'default' },
      );
    }
    const result = await engine.findCandidateDuplicates('default', 'cap-entity', 'x', { k: 3 });
    expect(result.length).toBe(3);
  });

  test('embedding cosine ordering when both sides have embeddings', async () => {
    // Use per-run unique entity_slug so the assertion is immune to any
    // cross-test pollution (no other test in the file uses 'embed-test',
    // but parallel CI shard runs have surfaced a flake where the
    // position-0 assertion failed without a visible assertion-detail in
    // the truncated log). The contract this test pins is "A ranks higher
    // than B because cos(A,query)=1.0 vs cos(B,query)=0.0" — assert that
    // RELATIONSHIP, not the absolute index, so any unrelated row in the
    // result set can't flip the test.
    const slug = `embed-test-${Math.random().toString(36).slice(2, 10)}`;
    await engine.insertFact(
      { fact: 'A', kind: 'fact', entity_slug: slug, source: 'test', embedding: vec(1, 0, 0) },
      { source_id: 'default' },
    );
    await engine.insertFact(
      { fact: 'B', kind: 'fact', entity_slug: slug, source: 'test', embedding: vec(0, 1, 0) },
      { source_id: 'default' },
    );
    const result = await engine.findCandidateDuplicates(
      'default', slug, 'q',
      { embedding: vec(1, 0, 0) },
    );
    const aIdx = result.findIndex(r => r.fact === 'A');
    const bIdx = result.findIndex(r => r.fact === 'B');
    expect(aIdx).toBeGreaterThanOrEqual(0); // A is in the result
    expect(bIdx).toBeGreaterThanOrEqual(0); // B is in the result
    // Closest by cosine MUST come first.
    expect(aIdx).toBeLessThan(bIdx);
  });
});

describe('consolidateFact', () => {
  test('marks consolidated_at + consolidated_into; never DELETE', async () => {
    // Need a take to point at — seed a page + take.
    await engine.executeRaw(
      `INSERT INTO pages (slug, type, title) VALUES ('cons-test', 'concept', 'Cons Test') ON CONFLICT DO NOTHING`,
    );
    const pageRows = await engine.executeRaw<{ id: number }>(
      `SELECT id FROM pages WHERE slug = 'cons-test' AND source_id = 'default'`,
    );
    const pageId = pageRows[0].id;
    await engine.executeRaw(
      `INSERT INTO takes (page_id, row_num, claim, kind, holder) VALUES ($1, 99, 'cons claim', 'fact', 'self') ON CONFLICT DO NOTHING`,
      [pageId],
    );
    const takeRows = await engine.executeRaw<{ id: number }>(
      `SELECT id FROM takes WHERE page_id = $1 AND row_num = 99`,
      [pageId],
    );
    const takeId = takeRows[0].id;

    const fact = await engine.insertFact(
      { fact: 'will be consolidated', kind: 'fact', entity_slug: 'cons-test', source: 'test' },
      { source_id: 'default' },
    );

    await engine.consolidateFact(fact.id, takeId);
    const rows = await engine.executeRaw<{ id: number; consolidated_at: Date | null; consolidated_into: number | null }>(
      `SELECT id, consolidated_at, consolidated_into FROM facts WHERE id = $1`,
      [fact.id],
    );
    expect(rows.length).toBe(1);
    expect(rows[0].consolidated_at).not.toBeNull();
    expect(Number(rows[0].consolidated_into)).toBe(takeId);
  });
});

describe('getFactsHealth', () => {
  test('returns counters keyed by source_id', async () => {
    const health = await engine.getFactsHealth('default');
    expect(health.source_id).toBe('default');
    expect(health.total_active).toBeGreaterThanOrEqual(0);
    expect(health.total_today).toBeGreaterThanOrEqual(0);
    expect(health.total_week).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(health.top_entities)).toBe(true);
  });

  test('total_today subset of total_week subset of total_active+expired', async () => {
    const health = await engine.getFactsHealth('default');
    expect(health.total_today).toBeLessThanOrEqual(health.total_week);
    expect(health.total_active + health.total_expired).toBeGreaterThanOrEqual(health.total_week);
  });
});
