/**
 * CRAG auto-think must inherit the query's resolved source scope. Recomputing
 * from ctx drops an explicit source_id when the default differs or is absent.
 * Existing CRAG tests cover grading/retrieval retries, not runThink's scope;
 * the embed-question wiring pin does not execute this branch. No new seam:
 * stub only runThink, keeping the real query handler and keyless PGLite search.
 * Serial because mock.module affects every importer in the Bun process (R2).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { OperationContext } from '../../src/core/operations.ts';
import type { CragMetaBlock } from '../../src/core/search/crag.ts';
import type { RunThinkOpts } from '../../src/core/think/index.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';

const thinkCalls: RunThinkOpts[] = [];
const actualThink = await import('../../src/core/think/index.ts');
mock.module('../../src/core/think/index.ts', () => ({
  ...actualThink,
  runThink: async (_engine: unknown, opts: RunThinkOpts) => {
    thinkCalls.push(opts);
    return { answer: 'Synthetic answer', citations: [], modelUsed: 'synthetic-model' };
  },
}));
const { operationsByName } = await import('../../src/core/operations.ts');
let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => {
  await resetPgliteState(engine);
  await engine.executeRaw("INSERT INTO sources (id, name) VALUES ('source-a', 'Source A'), ('source-b', 'Source B')");
  await engine.setConfig('search.crag_think', 'true');
  thinkCalls.length = 0;
});

async function query(overrides: Partial<OperationContext> = {}, sourceId?: string) {
  const meta: Record<string, unknown> = {};
  const ctx = {
    engine, remote: false, config: { engine: 'pglite' }, dryRun: false,
    logger: { info() {}, warn() {}, error() {} },
    emitResponseMeta: (key: string, value: unknown) => { meta[key] = value; },
    ...overrides,
  } as OperationContext; // Exercise absent sourceId / remote at the runtime boundary too.
  await operationsByName.query.handler(ctx, {
    query: 'zxqv nonexistent quux', expand: false,
    ...(sourceId === undefined ? {} : { source_id: sourceId }),
  });
  const crag = (meta.retrieval as { crag: CragMetaBlock }).crag;
  expect(crag.confidence).toBe('weak');
  expect(crag.escalate_to_think).toBe(true);
  return crag;
}

describe('query CRAG auto-think source scope', () => {
  test.each(['source-b', undefined])('explicit source-a overrides ctx source %s', async sourceId => {
    const crag = await query({ sourceId }, 'source-a');
    expect(crag.think?.answer).toBe('Synthetic answer');
    expect(thinkCalls).toHaveLength(1);
    expect(thinkCalls[0].sourceId).toBe('source-a');
    expect(thinkCalls[0].allowedSources).toBeUndefined();
  });

  test.each(['source-b', undefined])('no explicit source preserves ctx source %s', async sourceId => {
    await query({ sourceId });
    expect(thinkCalls).toHaveLength(1);
    expect(thinkCalls[0].sourceId).toBe(sourceId);
    expect(thinkCalls[0].allowedSources).toBeUndefined();
  });

  test('federated query scope maps to think allowedSources', async () => {
    await query({ auth: { allowedSources: ['source-a', 'source-b'] } as OperationContext['auth'] });
    expect(thinkCalls).toHaveLength(1);
    expect(thinkCalls[0].sourceId).toBeUndefined();
    expect(thinkCalls[0].allowedSources).toEqual(['source-a', 'source-b']);
  });

  test.each([true, undefined])('remote=%s keeps the hint without running think', async remote => {
    const crag = await query({ remote, sourceId: 'source-a' }, 'source-a');
    expect(crag.think).toBeUndefined();
    expect(thinkCalls).toHaveLength(0);
  });

  test('without opt-in keeps the hint without running think', async () => {
    await engine.unsetConfig('search.crag_think');
    const crag = await query({}, 'source-a');
    expect(crag.think).toBeUndefined();
    expect(thinkCalls).toHaveLength(0);
  });
});
