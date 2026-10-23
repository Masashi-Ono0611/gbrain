import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FactsBackstopCtx } from '../src/core/facts/backstop.ts';
import { prepareManagedFactsSession, publishManagedFacts, resumeManagedFacts } from '../src/core/persistence/facts-maintenance.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { registerLocalWriter, withVerifiedLocalRegistration } from '../src/core/persistence/identity.ts';
import { runReconcileApply, runReconcilePreview } from '../src/core/persistence/reconcile.ts';
import { readGitSourceHolds, writeGitHold } from '../src/core/persistence/sync-holds.ts';
import { managedBrain } from './helpers/managed-brain.ts';

// Retry retained facts after reconciliation, preserving the historical refusal.
test('a page-triggered facts batch resumes after its stalled hold is reconciled', () => managedBrain(async ({ engine, ctx, root }) => {
  const origin = 'notes/input', target = 'companies/example', requestId = randomUUID();
  for (const slug of [target, origin]) {
    await submitPageMutation(ctx, { operation: 'put_page', params: {
      slug, content: `---\ntype: ${slug === target ? 'company' : 'concept'}\ntitle: Example\n---\nAn example note for ${slug}.\n`,
      request_id: slug === origin ? requestId : randomUUID(),
    } });
  }
  const snapshot = (await engine.readPageSnapshot(origin, { sourceId: 'default' }))!;
  const [original] = await engine.executeRaw<{ id: string }>('SELECT id FROM persistence_requests WHERE request_id=$1::uuid', [requestId]);
  const backstop: FactsBackstopCtx = { engine, sourceId: 'default', source: 'mcp:put_page',
    sessionId: null, persistenceRequestId: original.id, operationContext: ctx };
  const input = { turnText: snapshot.page.compiled_truth, pageSlug: origin };
  const session = (await prepareManagedFactsSession(backstop, input))!;
  const path = `${target}.md`, file = join(root, path), pristine = readFileSync(file, 'utf8');
  writeFileSync(file, pristine + '\nAn unimported edit.\n');
  await engine.transaction(tx => writeGitHold(tx, { source_id: 'default', incarnation: snapshot.sourceIncarnation,
    path, source_path: path, slug: target, page_id: null, code: 'preparation_stalled',
    message: 'The write owner stalled.', upstream_version: null, observed_at: new Date().toISOString(),
    run_id: null, mode: 'managed', meta: {} }));
  const claim = 'The example roadmap ships weekly.';
  const initial = await publishManagedFacts(engine, session, backstop, [{ fact: claim,
    kind: 'fact', source: 'mcp:put_page', entity_slug: target, confidence: 0.9, notability: 'high', embedding: null }], 'private', origin).catch(error => error);
  expect(initial.code).toBe('source_changed');
  const before = await engine.executeRaw<{ request_id: string; error_message: string }>(
    "SELECT request_id,error_message FROM persistence_requests WHERE operation='extract_facts' AND slug=$1", [target]);
  expect(before[0].error_message).toContain('preparation_stalled');
  expect((await resumeManagedFacts(engine, (await prepareManagedFactsSession(backstop, input))!).catch(error => error)).code).toBe('source_changed');
  expect(await engine.executeRaw('SELECT id FROM facts WHERE fact=$1', [claim])).toEqual([]);

  writeFileSync(file, pristine);
  await withVerifiedLocalRegistration(engine, await registerLocalWriter(engine, 'cli'), async () => {
    const preview = await runReconcilePreview(engine, { source_id: 'default', slug: target });
    expect(preview.status).toBe('ready');
    const applied = await runReconcileApply(engine, { source_id: 'default', slug: target,
      preview: preview.preview, request_id: randomUUID() });
    expect(applied.state).toBe('committed');
  });
  expect(await readGitSourceHolds(engine, { sourceIds: ['default'] })).toEqual([]);
  const retry = (await prepareManagedFactsSession(backstop, input))!;
  const resumed = await resumeManagedFacts(engine, retry);
  expect(resumed?.inserted).toBe(1);
  expect(resumed?.refused).toBeUndefined();
  expect(await engine.executeRaw('SELECT fact FROM facts WHERE fact=$1', [claim])).toEqual([{ fact: claim }]);
  expect(await engine.executeRaw('SELECT request_id,error_message FROM persistence_requests WHERE request_id=$1::uuid', [before[0].request_id])).toEqual(before);
  expect((await resumeManagedFacts(engine, retry))?.inserted).toBe(1);
  expect((await engine.executeRaw('SELECT id FROM facts WHERE fact=$1', [claim])).length).toBe(1);
}), 120_000);
