import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromFile } from '../src/core/import-file.ts';
import { runSources } from '../src/commands/sources.ts';
import { extractTimelineFromDB } from '../src/commands/extract-timeline-db.ts';
import { pruneTimelineOrphans } from '../src/core/timeline-extract.ts';

let engine: PGLiteEngine;
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);
afterAll(async () => engine.disconnect());

test('prunes a linked-source row produced by an older plain-source version', async () => {
  await runSources(engine, ['add', 'notes', '--no-federated']);
  const dir = mkdtempSync(join(tmpdir(), 'timeline-prune-7874-'));
  mkdirSync(join(dir, 'people'));
  const path = join(dir, 'people/example.md');
  const page = (timeline: string) => `---\ntype: person\ntitle: Example\n---\n\n<!-- timeline -->\n\n## Timeline\n\n${timeline}\n`;
  writeFileSync(path, page('- **2024-01-02** | meetings/x — board discussion'));
  await importFromFile(engine, path, 'people/example.md', { noEmbed: true, sourceId: 'notes' });
  writeFileSync(path, page(''));
  await importFromFile(engine, path, 'people/example.md', { noEmbed: true, sourceId: 'notes' });
  await engine.addTimelineEntry('people/example', {
    date: '2024-01-02', source: '[meetings/x](../meetings/x.md)', summary: 'board discussion',
  }, { sourceId: 'notes' });

  const preview = await pruneTimelineOrphans(engine, { sourceId: 'notes', dryRun: true });
  expect(preview.orphans).toBe(1);
  const applied = await pruneTimelineOrphans(engine, { sourceId: 'notes', dryRun: false });
  expect(applied.removed).toBe(1);
}, 30_000);

async function historyFixture(sourceId: string, previous: string, current: string, options: { nested?: boolean; segmented?: boolean } = {}) {
  await runSources(engine, ['add', sourceId, '--no-federated']);
  await engine.setConfig('pages.segmented_storage', options.segmented ? 'on' : 'off');
  const slug = options.nested ? 'people/deep/example' : 'people/example';
  const dir = mkdtempSync(join(tmpdir(), 'timeline-identity-7874-'));
  const path = join(dir, `${slug}.md`);
  mkdirSync(join(dir, options.nested ? 'people/deep' : 'people'), { recursive: true });
  const padding = options.segmented ? 'A neutral retained detail.\n\n'.repeat(50_000) : '';
  const page = (source: string) => `---\ntype: person\ntitle: Example\n---\n\n${padding}<!-- timeline -->\n\n## Timeline\n\n`
    + (source ? `- **2024-01-02** | ${source} — board discussion\n` : '');
  for (const source of [previous, current]) {
    writeFileSync(path, page(source));
    await importFromFile(engine, path, `${slug}.md`, { noEmbed: true, sourceId });
  }
  const [snapshot] = await engine.executeRaw<{ body_storage: string }>(
    'SELECT body_storage FROM pages WHERE source_id=$1 AND slug=$2', [sourceId, slug]);
  expect(snapshot!.body_storage).toBe(options.segmented ? 'segmented' : 'inline');
  return {
    slug,
    add: (source: string) => engine.addTimelineEntry(slug, { date: '2024-01-02', source, summary: 'board discussion' }, { sourceId }),
    sources: async () => (await engine.executeRaw<{ source: string }>(
      `SELECT t.source FROM timeline_entries t JOIN pages p ON p.id=t.page_id
        WHERE p.source_id=$1 AND p.slug=$2 ORDER BY t.source`, [sourceId, slug])).map(row => row.source),
  };
}

test('a plain historical slug cannot authorize pruning a different same-label target', async () => {
  const sourceId = 'plain-provenance';
  const fixture = await historyFixture(sourceId, 'meetings/x', '');
  await fixture.add('[meetings/x](../meetings/x.md)');
  const unrelated = '[meetings/x](../other/x.md)';
  await fixture.add(unrelated);
  expect((await pruneTimelineOrphans(engine, { sourceId, dryRun: true })).orphans).toBe(1);
  expect((await pruneTimelineOrphans(engine, { sourceId, dryRun: false })).removed).toBe(1);
  expect(await fixture.sources()).toEqual([unrelated]);
}, 30_000);

test('a current plain slug keeps its identity-proven linked row', async () => {
  const sourceId = 'current-plain';
  const fixture = await historyFixture(sourceId, 'meetings/x', 'meetings/x');
  const linked = '[meetings/x](../meetings/x.md)';
  await fixture.add(linked);
  expect((await pruneTimelineOrphans(engine, { sourceId, dryRun: false })).removed).toBe(0);
  expect(await fixture.sources()).toEqual([linked]);
}, 30_000);

test('legacy slug identity resolves relative to a nested page instead of stripping parents', async () => {
  const sourceId = 'nested-identity';
  const fixture = await historyFixture(sourceId, 'meetings/x', '', { nested: true });
  await fixture.add('[meetings/x](../../meetings/x.md)');
  const unrelated = '[meetings/x](../meetings/x.md)';
  await fixture.add(unrelated);
  expect((await pruneTimelineOrphans(engine, { sourceId, dryRun: false })).removed).toBe(1);
  expect(await fixture.sources()).toEqual([unrelated]);
}, 30_000);

test('destination edits retract the exact old row and preserve current and unrelated targets, inline and segmented', async () => {
  for (const segmented of [false, true]) {
    const sourceId = segmented ? 'segmented-destination' : 'inline-destination';
    const old = '[meetings/x](../old/x.md)', current = '[meetings/x](../new/x.md)';
    const unrelated = '[meetings/x](../unrelated/x.md)';
    const fixture = await historyFixture(sourceId, old, current, { segmented });
    for (const source of [old, current, unrelated]) await fixture.add(source);
    expect((await pruneTimelineOrphans(engine, { sourceId, dryRun: true })).orphans).toBe(1);
    if (segmented) {
      const extracted = await extractTimelineFromDB(engine, { dryRun: false, jsonMode: false, quiet: true, sourceIdFilter: sourceId, slugs: [fixture.slug] });
      expect(extracted.refused).toBe(0);
      expect(extracted.pending).toBe(0);
    } else {
      expect((await pruneTimelineOrphans(engine, { sourceId, dryRun: false })).removed).toBe(1);
    }
    expect(await fixture.sources()).toEqual([current, unrelated]);
  }
}, 60_000);


test('the parser markdown sentinel is not provenance for a page named markdown', async () => {
  const sourceId = 'sentinel-identity';
  const fixture = await historyFixture(sourceId, 'markdown', '');
  const unrelated = '[markdown](../markdown.md)';
  await fixture.add(unrelated);
  expect((await pruneTimelineOrphans(engine, { sourceId, dryRun: false })).removed).toBe(0);
  expect(await fixture.sources()).toEqual([unrelated]);
}, 30_000);
