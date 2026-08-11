/**
 * v0.31 E2E — Cross-session recall test against real Postgres (parity gate).
 *
 * Mirrors test/facts-separation-pglite.test.ts. Skips gracefully when
 * DATABASE_URL is unset.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { setupDB, teardownDB, hasDatabase, getEngine } from './helpers.ts';

const RUN = hasDatabase();
const d = RUN ? describe : describe.skip;

beforeAll(async () => { if (RUN) await setupDB(); });
afterAll(async () => { if (RUN) await teardownDB(); });

d("Cross-session recall test (Postgres)", () => {
  test('cross-session recall: insert in session-A, recall via entity from session-B', async () => {
    const engine = getEngine();
    await engine.insertFact(
      {
        fact: 'sample event Tuesday',
        kind: 'event',
        entity_slug: 'travel',
        source: 'mcp:extract_facts',
        source_session: 'session-A',
        visibility: 'world',
      },
      { source_id: 'default' },
    );

    const byEntity = await engine.listFactsByEntity('default', 'travel');
    expect(byEntity.length).toBe(1);
    expect(byEntity[0].fact).toBe('sample event Tuesday');
    expect(byEntity[0].source_session).toBe('session-A');

    const eightHoursAgo = new Date(Date.now() - 8 * 60 * 60 * 1000);
    const bySince = await engine.listFactsSince('default', eightHoursAgo);
    expect(bySince.find(f => f.fact === 'sample event Tuesday')).toBeDefined();

    const sessionA = await engine.listFactsBySession('default', 'session-A');
    expect(sessionA.length).toBe(1);

    const sessionB = await engine.listFactsBySession('default', 'session-B');
    expect(sessionB.length).toBe(0);
  });

  test('expireFact + listSupersessions on real Postgres', async () => {
    const engine = getEngine();
    const r1 = await engine.insertFact(
      { fact: 'old', kind: 'fact', entity_slug: 'super-pg', source: 'test' },
      { source_id: 'default' },
    );
    const r2 = await engine.insertFact(
      { fact: 'new', kind: 'fact', entity_slug: 'super-pg', source: 'test' },
      { source_id: 'default', supersedeId: r1.id },
    );
    expect(r2.status).toBe('superseded');
    const sup = await engine.listSupersessions('default');
    const old = sup.find(s => s.id === r1.id);
    expect(old).toBeDefined();
    expect(old!.expired_at).not.toBeNull();
    expect(old!.superseded_by).toBe(r2.id);
  });

  // Mirrors test/facts-separation-pglite.test.ts. extract-conversation-facts
  // writes durable audit checkpoint rows (EXTRACTION_COMPLETE /
  // EXTRACTION_NOT_APPLICABLE) into the facts table; excludeAuditRows keeps
  // them out of listFactsSince in SQL on both engines.
  test('excludeAuditRows filters extraction audit checkpoint rows out of listFactsSince', async () => {
    const engine = getEngine();
    const before = new Date();
    await engine.insertFact(
      {
        fact: 'EXTRACTION_COMPLETE',
        kind: 'fact',
        entity_slug: null,
        source: 'cli:extract-conversation-facts:terminal:v2',
        source_session: 'audit-checkpoint-session-pg',
        notability: 'low',
      },
      { source_id: 'default' },
    );
    await engine.insertFact(
      {
        fact: 'EXTRACTION_NOT_APPLICABLE',
        kind: 'fact',
        entity_slug: null,
        source: 'cli:extract-conversation-facts:non-extractable:v2',
        source_session: 'audit-checkpoint-session-pg',
        notability: 'low',
      },
      { source_id: 'default' },
    );
    await engine.insertFact(
      { fact: 'real user fact about travel plans (pg)', kind: 'fact', entity_slug: 'travel-pg', source: 'test' },
      { source_id: 'default' },
    );

    const withAudit = await engine.listFactsSince('default', before);
    expect(withAudit.some(r => r.fact === 'EXTRACTION_COMPLETE')).toBe(true);
    expect(withAudit.some(r => r.fact === 'EXTRACTION_NOT_APPLICABLE')).toBe(true);
    expect(withAudit.some(r => r.fact === 'real user fact about travel plans (pg)')).toBe(true);

    const withoutAudit = await engine.listFactsSince('default', before, { excludeAuditRows: true });
    expect(withoutAudit.some(r => r.fact === 'EXTRACTION_COMPLETE')).toBe(false);
    expect(withoutAudit.some(r => r.fact === 'EXTRACTION_NOT_APPLICABLE')).toBe(false);
    expect(withoutAudit.some(r => r.fact === 'real user fact about travel plans (pg)')).toBe(true);
  });

  // The filter is an exact-match `fact NOT IN (...)`, not a substring/ILIKE
  // match — a real fact that happens to CONTAIN one of the audit literals as
  // a substring must still survive excludeAuditRows.
  test('excludeAuditRows is exact-match, not substring — facts merely containing the audit literal survive (pg)', async () => {
    const engine = getEngine();
    const before = new Date();
    await engine.insertFact(
      {
        fact: "the user's project tracker calls its done column EXTRACTION_COMPLETE (pg)",
        kind: 'fact',
        entity_slug: 'tracker-naming-pg',
        source: 'test',
      },
      { source_id: 'default' },
    );
    const rows = await engine.listFactsSince('default', before, { excludeAuditRows: true });
    expect(
      rows.some(r => r.fact === "the user's project tracker calls its done column EXTRACTION_COMPLETE (pg)"),
    ).toBe(true);
  });

  // excludeAuditRows is honored consistently across all three FactListOpts
  // consumers (listFactsSince above, listFactsByEntity + listFactsBySession
  // here) — not silently ignored on the shared options bag.
  test('excludeAuditRows also filters listFactsByEntity and listFactsBySession (pg)', async () => {
    const engine = getEngine();
    await engine.insertFact(
      {
        fact: 'EXTRACTION_COMPLETE',
        kind: 'fact',
        entity_slug: 'audit-entity-scope-test-pg',
        source: 'test',
        source_session: 'audit-entity-scope-session-pg',
      },
      { source_id: 'default' },
    );
    await engine.insertFact(
      {
        fact: 'real fact under the same entity/session (pg)',
        kind: 'fact',
        entity_slug: 'audit-entity-scope-test-pg',
        source: 'test',
        source_session: 'audit-entity-scope-session-pg',
      },
      { source_id: 'default' },
    );

    const byEntity = await engine.listFactsByEntity('default', 'audit-entity-scope-test-pg', {
      excludeAuditRows: true,
    });
    expect(byEntity.some(r => r.fact === 'EXTRACTION_COMPLETE')).toBe(false);
    expect(byEntity.some(r => r.fact === 'real fact under the same entity/session (pg)')).toBe(true);

    const bySession = await engine.listFactsBySession('default', 'audit-entity-scope-session-pg', {
      excludeAuditRows: true,
    });
    expect(bySession.some(r => r.fact === 'EXTRACTION_COMPLETE')).toBe(false);
    expect(bySession.some(r => r.fact === 'real fact under the same entity/session (pg)')).toBe(true);
  });
});
