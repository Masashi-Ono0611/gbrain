/**
 * #3754: backlink and graph reads must ignore every edge that touches a
 * soft-deleted page. The links row remains during the recovery window, so
 * endpoint visibility has to be enforced by each read query.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

async function seedPair(prefix: string): Promise<{ source: string; target: string }> {
  const source = `${prefix}/source`;
  const target = `${prefix}/target`;
  await engine.putPage(source, {
    type: 'note', title: 'Live source', compiled_truth: 'source body', timeline: '',
  });
  await engine.putPage(target, {
    type: 'note', title: 'Live target', compiled_truth: 'target body', timeline: '',
  });
  await engine.addLink(source, target, '', 'mentions');
  return { source, target };
}

describe('PGLite backlinks and graph traversal hide soft-deleted endpoints (#3754)', () => {
  test('healthy live-to-live edge is still returned', async () => {
    const { source, target } = await seedPair('softdelete/control');

    expect((await engine.getBacklinks(target)).map((link) => link.from_slug)).toEqual([source]);
    expect((await engine.traversePaths(source, { depth: 1 })).map((edge) => edge.to_slug)).toEqual([target]);
    const nodes = await engine.traverseGraph(source, 1);
    expect(nodes.map((node) => node.slug).sort()).toEqual([source, target].sort());
    expect(nodes.find((node) => node.slug === source)?.links.map((link) => link.to_slug)).toEqual([target]);
  });

  test('edge is excluded when its source endpoint is soft-deleted', async () => {
    const { source, target } = await seedPair('softdelete/dead-source');
    await engine.softDeletePage(source);

    expect(await engine.getBacklinks(target)).toEqual([]);
    expect(await engine.traversePaths(target, { depth: 1, direction: 'in' })).toEqual([]);
    expect(await engine.traverseGraph(source, 1)).toEqual([]);
  });

  test('edge is excluded when its target endpoint is soft-deleted', async () => {
    const { source, target } = await seedPair('softdelete/dead-target');
    await engine.softDeletePage(target);

    expect(await engine.getBacklinks(target)).toEqual([]);
    expect(await engine.traversePaths(source, { depth: 1, direction: 'out' })).toEqual([]);
    const nodes = await engine.traverseGraph(source, 1);
    expect(nodes.map((node) => node.slug)).toEqual([source]);
    expect(nodes[0]?.links).toEqual([]);
  });

  test('a soft-deleted MIDDLE node breaks a multi-hop chain (A -> deleted B -> C)', async () => {
    const a = 'softdelete/chain/a';
    const b = 'softdelete/chain/b';
    const c = 'softdelete/chain/c';
    await engine.putPage(a, { type: 'note', title: 'A', compiled_truth: 'a', timeline: '' });
    await engine.putPage(b, { type: 'note', title: 'B', compiled_truth: 'b', timeline: '' });
    await engine.putPage(c, { type: 'note', title: 'C', compiled_truth: 'c', timeline: '' });
    await engine.addLink(a, b, '', 'mentions');
    await engine.addLink(b, c, '', 'mentions');

    await engine.softDeletePage(b);

    // A 2-hop traversal from A must not walk through the dead middle node.
    const nodes = await engine.traverseGraph(a, 2);
    expect(nodes.map((node) => node.slug)).toEqual([a]);
    expect(nodes[0]?.links).toEqual([]);

    expect(await engine.traversePaths(a, { depth: 2, direction: 'out' })).toEqual([]);
    expect(await engine.traversePaths(a, { depth: 2, direction: 'both' })).toEqual([]);

    // C's only backlink is via the dead B, so it must report none.
    expect(await engine.getBacklinks(c)).toEqual([]);
  });

  test('direction "both" excludes an edge touching a soft-deleted endpoint in either direction', async () => {
    const { source, target } = await seedPair('softdelete/both-direction');
    await engine.softDeletePage(target);

    expect(await engine.traversePaths(source, { depth: 1, direction: 'both' })).toEqual([]);
    expect(await engine.traversePaths(target, { depth: 1, direction: 'both' })).toEqual([]);
  });
});
