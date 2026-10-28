import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromFile } from '../src/core/import-file.ts';
import { runSources } from '../src/commands/sources.ts';
import { pruneTimelineOrphans } from '../src/core/timeline-extract.ts';

const engine = new PGLiteEngine();
afterAll(async () => engine.disconnect());

test('prunes a linked-source row produced by an older plain-source version', async () => {
  await engine.connect({});
  await engine.initSchema();
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
