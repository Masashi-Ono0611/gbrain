/**
 * Protects initSchema upgrades of the v265 generation ledger with existing data.
 * Missing v266 forward columns must fail schema replay before migrations run.
 * Existing bootstrap tests do not exercise the v265 generation-table boundary;
 * this uses the historical migration SQL and the production init path, no seam.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { LATEST_VERSION } from '../src/core/migrate.ts';
import { v265 } from '../src/core/schema-migrations/v265-derived-generations.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;
beforeAll(async () => {
  // Exercise schema replay rather than restoring a post-init snapshot.
  await withEnv({ GBRAIN_PGLITE_SNAPSHOT: undefined }, async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  });
}, 120000);
afterAll(async () => {
  await engine.disconnect();
});

test('v265 generation tables upgrade to latest without losing existing items', async () => {
  // Other subsystems retain their current shape; the affected tables are
  // recreated from v265 itself rather than approximated by dropping columns.
  await engine.runMigration(265, `
    DROP TABLE derived_generation_activations;
    DROP TABLE derived_generation_items;
    DROP TABLE derived_generations;
    DROP TABLE derived_generation_valve;
    DROP TABLE derived_generation_attempts;
  `);
  await engine.runMigration(265, v265.sql);
  await engine.runMigration(265, `
    INSERT INTO derived_generations
      (id, source_id, kind, owner_key, state, operation_id, item_set_hash)
      VALUES (1, 'default', 'links', 'synthetic-owner', 'live', 'synthetic-operation', 'synthetic-hash');
    INSERT INTO derived_generation_items (generation_id, item_key, identity_hash, action)
      VALUES (1, 'synthetic-item', 'synthetic-identity', 'published');
  `);
  await engine.setConfig('version', '265');

  await engine.initSchema();
  expect(await engine.getConfig('version')).toBe(String(LATEST_VERSION));
  expect(await engine.executeRaw(`
    SELECT g.operation_id, g.locator, g.activation_id, i.item_key, i.identity_hash, i.action, i.pending
    FROM derived_generations g JOIN derived_generation_items i ON i.generation_id = g.id
    WHERE g.id = 1
  `)).toEqual([{
    operation_id: 'synthetic-operation', locator: null, activation_id: null,
    item_key: 'synthetic-item', identity_hash: 'synthetic-identity', action: 'published', pending: false,
  }]);
  expect(await engine.executeRaw(`
    SELECT indexname FROM pg_indexes WHERE indexname = 'derived_generation_items_pending'
  `)).toHaveLength(1);
  await engine.initSchema();
  expect(await engine.getConfig('version')).toBe(String(LATEST_VERSION));
}, 120000);
