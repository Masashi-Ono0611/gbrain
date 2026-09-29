import { expect, test } from 'bun:test';
import { linksOperations } from '../src/core/ops/links.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { extractManagedStaleLinks } from '../src/core/persistence/links-maintenance.ts';
import { managedBrain } from './helpers/managed-brain.ts';

const operation = (name: string) => linksOperations.find(item => item.name === name)!;

test('manual link operations use managed publication while preserving unmanaged behavior and remote refusal', async () => {
  await managedBrain(async ({ engine, ctx }) => {
    await engine.transaction(tx => withCoordinatedWrite(tx, ['default'], async () => {
      for (const slug of ['notes/from', 'notes/to']) await tx.putPage(slug, {
        type: 'note', title: slug, compiled_truth: 'A stable note about managed link publication.', timeline: '', frontmatter: {}, content_hash: slug,
      }, { sourceId: 'default' });
    }));

    await operation('add_link').handler(ctx, { from: 'notes/from', to: 'notes/to' });
    expect(await engine.getLinks('notes/from', { sourceId: 'default' })).toMatchObject([
      { to_slug: 'notes/to', link_source: 'manual' },
    ]);
    await extractManagedStaleLinks(engine, { sourceId: 'default' });
    expect(await engine.getLinks('notes/from', { sourceId: 'default' })).toMatchObject([
      { to_slug: 'notes/to', link_source: 'manual' },
    ]);
    await operation('remove_link').handler(ctx, { from: 'notes/from', to: 'notes/to' });
    expect(await engine.getLinks('notes/from', { sourceId: 'default' })).toHaveLength(0);

    await expect(operation('add_link').handler({ ...ctx, remote: true }, {
      from: 'notes/from', to: 'notes/to',
    })).rejects.toMatchObject({ code: 'writer_coordinator_required' });

    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    try {
      await operation('add_link').handler(ctx, { from: 'notes/from', to: 'notes/to' });
      expect(await engine.getLinks('notes/from', { sourceId: 'default' })).toMatchObject([
        { to_slug: 'notes/to', link_source: 'manual' },
      ]);
    } finally {
      await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    }
  });
});
