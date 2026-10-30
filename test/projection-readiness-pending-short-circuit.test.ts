import { expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { probeProjectionReadiness } from '../src/core/search/projection-readiness.ts';
import { withEnv } from './helpers/with-env.ts';

test('pending readiness defers the by-design scan', async () => {
  let probeSql = '';
  const engine = {
    executeRaw: async (sql: string) => {
      if (sql.includes('IS DISTINCT FROM')) {
        probeSql = sql;
        return [{ pending: true, by_design: false }];
      }
      return [];
    },
  } as unknown as Pick<BrainEngine, 'executeRaw'>;
  const result = await withEnv({ GBRAIN_PROJECTION_READINESS_CACHE: '0' }, () =>
    probeProjectionReadiness(engine, {}));

  expect(result.status).toBe('projection_pending');
  expect(probeSql).toMatch(/WITH r AS MATERIALIZED[\s\S]*CASE WHEN r\.pending THEN false ELSE/);
});
