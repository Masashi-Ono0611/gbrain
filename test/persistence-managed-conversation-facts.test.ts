import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { runExtractConversationFactsCore } from '../src/commands/extract-conversation-facts.ts';
import { registerLocalWriter } from '../src/core/persistence/identity.ts';
import { submissionAuthority } from '../src/core/persistence/authority.ts';
import { prepareManagedConversationFactsMutation } from '../src/core/persistence/conversation-facts-prepare.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { withEnv } from './helpers/with-env.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { readConversationBodyForParsing } from '../src/core/conversation-parser/body.ts';
import { conversationSnapshotVersionToken, regularPageVersionToken } from '../src/core/conversation-parser/snapshot.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-managed-conversation-facts-'));
let engine: BrainEngine;

beforeAll(async () => withEnv({ GBRAIN_HOME: home, GBRAIN_SOURCE: undefined, GBRAIN_BRAIN_ID: 'host' }, async () => {
  engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema();
  await engine.setConfig('facts.extraction_enabled', 'true');
  await engine.setConfig('conversation_parser.llm_fallback_enabled', 'false');
  await engine.putPage('conversations/managed-example', { type: 'conversation', title: 'Managed example',
    compiled_truth: '**Alice Example** (2026-01-01 9:00 AM): We shipped a durable archive.\n**Bob Demo** (2026-01-01 9:05 AM): The archive stays available.', timeline: '', frontmatter: {} });
  await engine.putPage('conversations/stale-managed-example', { type: 'conversation', title: 'Stale example', compiled_truth: 'original', timeline: '', frontmatter: {} });
  writeFileSync(join(home, 'managed-transcript.txt'), 'Alice Example: original transcript.');
  await engine.executeRaw("UPDATE sources SET local_path=$1 WHERE id='default'", [home]);
  await engine.putPage('conversations/sidecar-managed-example', { type: 'conversation', title: 'Sidecar example',
    compiled_truth: 'summary', timeline: '', frontmatter: { raw_transcript: 'managed-transcript.txt' } });
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
}), 120_000);

afterAll(async () => {
  await withEnv({ GBRAIN_HOME: home }, async () => { await disposePersistenceConsumer(engine); await (engine as any)?.disconnect(); });
  rmSync(home, { recursive: true, force: true });
});

test('managed extraction journals one page batch with its terminal row and skips unchanged content on replay', async () => withEnv({ GBRAIN_HOME: home }, async () => {
  await engine.executeRaw("DELETE FROM facts WHERE source_markdown_slug='conversations/managed-example'");
  const run = () => runExtractConversationFactsCore(engine, {
    sourceId: 'default', slug: 'conversations/managed-example', sleepMs: 0, managedJournalWrites: true,
    extractor: async () => [{ fact: 'A durable archive shipped', kind: 'fact', entity_slug: null, source: 'test', confidence: 1 }],
  });
  const first = await run();
  expect(first).toMatchObject({ pages_processed: 1, facts_inserted: 1, pages_failed: 0 });
  const facts = await engine.executeRaw<{ source: string; row_num: number }>("SELECT source,row_num FROM facts WHERE source_markdown_slug='conversations/managed-example' ORDER BY row_num");
  expect(facts).toEqual([
    { source: 'cli:extract-conversation-facts', row_num: 0 },
    { source: 'cli:extract-conversation-facts:terminal:v2', row_num: 1 },
  ]);
  expect(await engine.executeRaw("SELECT state,intent->>'kind' AS kind FROM persistence_requests WHERE operation='extract_facts' AND slug='conversations/managed-example'")).toEqual([{ state: 'committed', kind: 'managed_conversation_facts_page' }]);
  const second = await run();
  expect(second.pages_skipped_completed).toBe(1);
  expect(await engine.executeRaw("SELECT id FROM facts WHERE source_markdown_slug='conversations/managed-example'")).toHaveLength(2);
  await disposePersistenceConsumer(engine);
}));

test('managed publication rejects a page edited after prepare without installing stale facts', async () => withEnv({ GBRAIN_HOME: home }, async () => {
  const slug = 'conversations/stale-managed-example';
  await registerLocalWriter(engine, 'cli');
  const snapshot = await engine.readPageSnapshot(slug, { sourceId: 'default' });
  if (!snapshot) throw new Error('fixture page missing');
  const context = { engine, remote: false, sourceId: 'default', config: { engine: engine.kind } } as any;
  const authority = await submissionAuthority(context, 'extract_facts', 'default', snapshot.sourceIncarnation, slug);
  const contentToken = regularPageVersionToken(snapshot.page);
  const intent = { kind: 'managed_conversation_facts_page', contentToken, expectedRevision: snapshot.revision,
    facts: [{ fact: 'stale fact', kind: 'fact', entity_slug: null, source: 'cli:extract-conversation-facts', source_session: `${'cli:extract-conversation-facts'}:${slug}`, embedding: null }],
    outcome: 'complete', outcomeSession: `cli:extract-conversation-facts:terminal:v2:${slug}:${contentToken}`, terminal: true };
  const row = { operation: 'extract_facts', source_id: 'default', source_incarnation: snapshot.sourceIncarnation,
    slug, page_id: snapshot.page.id, authority, intent } as any;
  const prepared = await prepareManagedConversationFactsMutation(engine, row, { engine: engine.kind } as any);
  await engine.transaction(tx => withCoordinatedWrite(tx, ['default'], () => tx.putPage(slug, {
    type: 'conversation', title: 'Stale example', compiled_truth: 'edited after prepare', timeline: '', frontmatter: {},
  })));
  await expect(prepared.validate?.(engine)).rejects.toMatchObject({ code: 'revision_conflict' });
  expect(await engine.executeRaw("SELECT id FROM facts WHERE source_markdown_slug=$1", [slug])).toHaveLength(0);
}));

test('managed publication rejects a raw transcript sidecar changed after prepare', async () => withEnv({ GBRAIN_HOME: home }, async () => {
  const slug = 'conversations/sidecar-managed-example';
  await registerLocalWriter(engine, 'cli');
  const snapshot = await engine.readPageSnapshot(slug, { sourceId: 'default' });
  if (!snapshot) throw new Error('fixture page missing');
  const token = conversationSnapshotVersionToken(snapshot.page, await readConversationBodyForParsing(engine, snapshot.page));
  const context = { engine, remote: false, sourceId: 'default', config: { engine: engine.kind } } as any;
  const authority = await submissionAuthority(context, 'extract_facts', 'default', snapshot.sourceIncarnation, slug);
  const intent = { kind: 'managed_conversation_facts_page', contentToken: token, expectedRevision: snapshot.revision,
    facts: [{ fact: 'stale sidecar fact', kind: 'fact', entity_slug: null, source: 'cli:extract-conversation-facts', embedding: null }],
    outcome: 'complete', outcomeSession: `cli:extract-conversation-facts:terminal:v2:${slug}:${token}`, terminal: true };
  const prepared = await prepareManagedConversationFactsMutation(engine, { operation: 'extract_facts', source_id: 'default',
    source_incarnation: snapshot.sourceIncarnation, slug, page_id: snapshot.page.id, authority, intent } as any, { engine: engine.kind } as any);
  writeFileSync(join(home, 'managed-transcript.txt'), 'Alice Example: edited sidecar transcript.');
  await expect(prepared.validate?.(engine)).rejects.toMatchObject({ code: 'revision_conflict' });
  expect(await engine.executeRaw('SELECT id FROM facts WHERE source_markdown_slug=$1', [slug])).toHaveLength(0);
}));
