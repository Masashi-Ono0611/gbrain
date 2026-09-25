import { describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { checkPostgresCancellationDriver } from '../src/commands/doctor.ts';

function fakePostgresEngine(owner: { discard?: () => void; release: () => void }): BrainEngine {
  return {
    kind: 'postgres',
    sql: { reserve: async () => owner },
  } as unknown as BrainEngine;
}

describe('postgres_cancellation_driver', () => {
  test('fails when the reserved owner lacks discard and releases it', async () => {
    let released = false;
    const check = await checkPostgresCancellationDriver(fakePostgresEngine({ release: () => { released = true; } }));

    expect(check?.name).toBe('postgres_cancellation_driver');
    expect(check?.status).toBe('fail');
    expect(check?.message).toContain('cancellation/write admission will fail');
    expect(check?.message).toContain('/health returns 503');
    expect(check?.message).toContain('INSTALL_FOR_AGENTS.md');
    expect(check?.message).toContain('~/.bun/install/global/patches/');
    expect(released).toBe(true);
  });

  test('passes when the reserved owner has discard', async () => {
    let released = false;
    const check = await checkPostgresCancellationDriver(fakePostgresEngine({ discard() {}, release: () => { released = true; } }));

    expect(check?.status).toBe('ok');
    expect(released).toBe(true);
  });

  test('skips non-Postgres engines', async () => {
    expect(await checkPostgresCancellationDriver({ kind: 'pglite' } as BrainEngine)).toBeNull();
  });
});
