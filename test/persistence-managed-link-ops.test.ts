import { expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { linksOperations } from '../src/core/ops/links.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { extractManagedStaleLinks } from '../src/core/persistence/links-maintenance.ts';
import { persistenceHome } from '../src/core/persistence/identity.ts';
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
    const { remote: _remote, ...remoteUnsetCtx } = ctx;
    for (const name of ['add_link', 'remove_link']) {
      await expect(operation(name).handler({ ...remoteUnsetCtx } as typeof ctx, {
        from: 'notes/from', to: 'notes/to',
      })).rejects.toMatchObject({ code: 'writer_coordinator_required' });
    }
    await expect(operation('remove_link').handler({ ...ctx, remote: true }, {
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

test('managed manual links stay isolated between sources with duplicate page slugs', async () => {
  let otherSourceId = '';
  await managedBrain(async ({ engine, ctx }) => {
    await engine.transaction(tx => withCoordinatedWrite(tx, ['default', otherSourceId], async () => {
      for (const sourceId of ['default', otherSourceId]) {
        for (const slug of ['notes/from', 'notes/to']) await tx.putPage(slug, {
          type: 'note', title: `${sourceId}:${slug}`, compiled_truth: 'A stable note for source isolation.',
          timeline: '', frontmatter: {}, content_hash: `${sourceId}:${slug}`,
        }, { sourceId });
      }
    }));

    // Seed the matching edge in source B so remove_link in A must preserve it.
    await engine.transaction(tx => withCoordinatedWrite(tx, [otherSourceId], async () => {
      await tx.addLink('notes/from', 'notes/to', '', '', 'manual', undefined, undefined, {
        fromSourceId: otherSourceId, toSourceId: otherSourceId, originSourceId: otherSourceId,
      });
    }));

    await operation('add_link').handler(ctx, { from: 'notes/from', to: 'notes/to' });
    expect(await engine.getLinks('notes/from', { sourceId: 'default' })).toMatchObject([
      { to_slug: 'notes/to', link_source: 'manual' },
    ]);
    expect(await engine.getLinks('notes/from', { sourceId: otherSourceId })).toMatchObject([
      { to_slug: 'notes/to', link_source: 'manual' },
    ]);

    await operation('remove_link').handler(ctx, { from: 'notes/from', to: 'notes/to' });
    expect(await engine.getLinks('notes/from', { sourceId: 'default' })).toHaveLength(0);
    expect(await engine.getLinks('notes/from', { sourceId: otherSourceId })).toMatchObject([
      { to_slug: 'notes/to', link_source: 'manual' },
    ]);
  }, { setup: async ({ engine, root }) => {
    otherSourceId = `links-${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const otherRoot = join(root, '..', 'other-source');
    mkdirSync(otherRoot);
    await engine.executeRaw('INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,\'{}\')', [otherSourceId, otherRoot]);
    await claimWorktree(engine, otherSourceId, otherRoot);
  } });
});

test('managed add_link refuses without a local writer registration and writes no row', async () => {
  await managedBrain(async ({ engine, ctx }) => {
    const [brain] = await engine.executeRaw<{ brain_id: string }>('SELECT brain_id FROM persistence_brain WHERE singleton=1');
    const registrationPath = join(persistenceHome(), `${brain.brain_id}.cli.json`);
    const registration = readFileSync(registrationPath, 'utf8');
    unlinkSync(registrationPath);
    try {
      await expect(operation('add_link').handler(ctx, { from: 'notes/from', to: 'notes/to' }))
        .rejects.toMatchObject({ code: 'writer_registration_required' });
      expect(await engine.getLinks('notes/from', { sourceId: 'default' })).toHaveLength(0);
    } finally {
      writeFileSync(registrationPath, registration, { mode: 0o600 });
    }
  });
});

test('managed link writes enforce the registered writer source, scope, and operation grants', async () => {
  await managedBrain(async ({ engine, ctx }) => {
    await engine.transaction(tx => withCoordinatedWrite(tx, ['default'], async () => {
      for (const slug of ['notes/from', 'notes/to']) await tx.putPage(slug, {
        type: 'note', title: slug, compiled_truth: 'A stable note about managed link authorization.', timeline: '', frontmatter: {}, content_hash: slug,
      }, { sourceId: 'default' });
    }));
    const grants = [
      { sourceIds: ['another-source'], operations: null, scopes: ['read', 'write'], slugPrefixes: null },
      { sourceIds: ['default'], operations: null, scopes: ['read'], slugPrefixes: null },
      { sourceIds: ['default'], operations: ['remove_link'], scopes: ['read', 'write'], slugPrefixes: null },
    ];
    const [brain] = await engine.executeRaw<{ brain_id: string }>('SELECT brain_id FROM persistence_brain WHERE singleton=1');
    const registration = JSON.parse(readFileSync(join(persistenceHome(), `${brain.brain_id}.cli.json`), 'utf8')) as { id: string };
    const setGrant = async (grant: typeof grants[number]) => {
      await engine.executeRaw('UPDATE persistence_local_writers SET grant_ceiling=$2::text::jsonb WHERE id=$1::uuid',
        [registration.id, JSON.stringify(grant)]);
    };

    await setGrant(grants[0]!);
    await expect(operation('add_link').handler(ctx, { from: 'notes/from', to: 'notes/to' }))
      .rejects.toMatchObject({ code: 'permission_denied' });
    expect(await engine.getLinks('notes/from', { sourceId: 'default' })).toHaveLength(0);

    await setGrant(grants[1]!);
    await expect(operation('add_link').handler(ctx, { from: 'notes/from', to: 'notes/to' }))
      .rejects.toMatchObject({ code: 'permission_denied' });
    expect(await engine.getLinks('notes/from', { sourceId: 'default' })).toHaveLength(0);

    await setGrant(grants[2]!);
    await expect(operation('add_link').handler(ctx, { from: 'notes/from', to: 'notes/to' }))
      .rejects.toMatchObject({ code: 'permission_denied' });
    expect(await engine.getLinks('notes/from', { sourceId: 'default' })).toHaveLength(0);

    await setGrant({ sourceIds: ['default'], operations: null, scopes: ['read', 'write'], slugPrefixes: null });
    await operation('add_link').handler(ctx, { from: 'notes/from', to: 'notes/to' });
    await setGrant({ sourceIds: ['default'], operations: ['add_link'], scopes: ['read', 'write'], slugPrefixes: null });
    await expect(operation('remove_link').handler(ctx, { from: 'notes/from', to: 'notes/to' }))
      .rejects.toMatchObject({ code: 'permission_denied' });
    expect(await engine.getLinks('notes/from', { sourceId: 'default' })).toMatchObject([
      { to_slug: 'notes/to', link_source: 'manual' },
    ]);
  });
});
