/**
 * Protects cold-consumer claims: the committed foreground probe must use a
 * worktree/sequence index with an empty sync cursor. Without it the probe
 * scans permanent receipts. Fairness tests cover ordering on tiny journals,
 * not access paths. Uses a real isolated engine without a new production seam.
 */
import { expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MIGRATIONS } from '../src/core/schema-migrations/registry.generated.ts';

const indexName = 'persistence_requests_foreground_committed';

test('cold claim committed probe uses an index and the upgrade rebuilds it', async () => {
  const engine = new PGLiteEngine();
  await engine.connect({});
  try {
    await engine.initSchema();
    await engine.executeRaw(`INSERT INTO persistence_worktrees(id,owner_host_id)
      VALUES ('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000003'),
        ('00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000003')`);
    await engine.executeRaw(`INSERT INTO persistence_requests
      (principal_kind,principal_id,request_id,operation,source_id,source_incarnation,
       worktree_id,slug,digest,intent,authority,intent_bytes,terminal_reservation,state)
      SELECT 'local_cli','seed',gen_random_uuid(),'put_page','default',
        (SELECT incarnation FROM sources WHERE id='default'),
        CASE WHEN g<=2 THEN '00000000-0000-0000-0000-000000000002'::uuid
          ELSE '00000000-0000-0000-0000-000000000001'::uuid END,'seed-'||g,'d',
        CASE WHEN g=2 THEN '{"kind":"managed_sync_import"}'::jsonb ELSE '{}'::jsonb END,
        '{}'::jsonb,1,64,'committed' FROM generate_series(1,12000) g`);
    await engine.executeRaw('ANALYZE persistence_requests');
    // Same committed predicate and empty syncSeen bound as FOREGROUND_WAITING_ON.
    const probe = `SELECT 1 FROM persistence_requests c
      WHERE c.worktree_id='00000000-0000-0000-0000-000000000002'::uuid
        AND c.sequence>COALESCE(('{}'::jsonb->>'00000000-0000-0000-0000-000000000002')::bigint,0)
        AND c.state='committed' AND NOT (COALESCE(c.intent->>'kind','') LIKE 'managed_sync_%')`;
    const plan = async () => (await engine.executeRaw<{ 'QUERY PLAN': string }>(`EXPLAIN ${probe}`))
      .map(row => row['QUERY PLAN']).join('\n');
    expect(await engine.executeRaw(probe)).toHaveLength(1);
    expect(await plan()).toContain(`Scan using ${indexName}`);
    expect(await plan()).not.toContain('Seq Scan on persistence_requests');
    await engine.executeRaw(`DROP INDEX ${indexName}`);
    expect(await plan()).toContain('Seq Scan on persistence_requests');
    const migration = MIGRATIONS.find(m => m.name === 'persistence_foreground_committed_index');
    expect(migration).toMatchObject({ transaction: false, idempotent: true });
    await migration!.handler!(engine);
    expect(await plan()).toContain(`Scan using ${indexName}`);
    expect(await engine.executeRaw(probe)).toHaveLength(1);
  } finally {
    await engine.disconnect();
  }
}, 120_000);
