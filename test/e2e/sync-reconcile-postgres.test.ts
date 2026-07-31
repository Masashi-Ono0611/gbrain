/**
 * #3583 — the full-sync reconcile against REAL PostgreSQL.
 *
 * The reconcile's removal binds a slug array (`= ANY($1::text[])`) and a
 * timestamp (`$3::timestamptz`) through `engine.executeRaw`, which on this
 * engine goes through postgres.js `unsafe()`. Every other test for this
 * feature runs on PGLite, where those bindings cannot fail the way they can
 * on the real driver — the review named exactly this as inferred rather than
 * executed. These two tests exercise the statement end to end on Postgres:
 * one row that must go, one that must stay.
 *
 * Requires DATABASE_URL (skipped otherwise, like every e2e file here).
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { setupDB, teardownDB, hasDatabase } from './helpers.ts';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { execSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const skip = !hasDatabase();
const describeIfDB = skip ? describe.skip : describe;

let engine: PostgresEngine;
const repos: string[] = [];

beforeAll(async () => {
  if (skip) return;
  engine = (await setupDB()) as PostgresEngine;
});

afterAll(async () => {
  if (skip) return;
  while (repos.length) {
    const d = repos.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
  await teardownDB();
});

beforeEach(async () => {
  if (skip) return;
  await engine.executeRaw(`DELETE FROM pages WHERE source_id = 'default'`);
  await engine.executeRaw(
    `UPDATE sources SET last_sync_at = NULL, last_commit = NULL WHERE id = 'default'`,
  );
});

function personMd(title: string, body: string): string {
  return ['---', 'type: person', `title: ${title}`, '---', '', body].join('\n');
}

function mkRepo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-3583-pg-'));
  repos.push(dir);
  execSync('git init', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.email "test@test.com"', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.name "Test"', { cwd: dir, stdio: 'pipe' });
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
  execSync('git add -A && git commit -m "initial"', { cwd: dir, stdio: 'pipe' });
  return dir;
}

const SYNC_OPTS = { noPull: true, noEmbed: true, noExtract: true, sourceId: 'default' } as const;

describeIfDB('#3583: full-sync reconcile on PostgreSQL', () => {
  test('a stale row is soft-removed — the array + timestamptz bindings execute', async () => {
    const { performSync } = await import('../../src/commands/sync.ts');
    const repo = mkRepo({
      'people/alpha.md': personMd('Alpha', 'Alpha is a person.'),
      'people/keeper.md': personMd('Keeper', 'Keeper stays.'),
    });
    await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    expect(await engine.getPage('people/alpha')).not.toBeNull();

    execSync('git rm -q people/alpha.md && git commit -m "delete alpha"', { cwd: repo, stdio: 'pipe' });
    const full = await performSync(engine, { repoPath: repo, ...SYNC_OPTS, full: true });
    expect(full.status).not.toBe('blocked_by_failures');

    expect(await engine.getPage('people/alpha')).toBeNull();
    // Soft, not hard: the row is still there carrying its tombstone, which is
    // what makes `gbrain restore-page` work for the recovery window.
    const raw = await engine.executeRaw<{ deleted_at: string | null }>(
      `SELECT deleted_at::text FROM pages WHERE source_id = 'default' AND slug = 'people/alpha'`,
    );
    expect(raw).toHaveLength(1);
    expect(raw[0].deleted_at).not.toBeNull();
    expect(await engine.getPage('people/keeper')).not.toBeNull();
  }, 300_000);

  test('a row written since the watermark is deferred, not removed', async () => {
    const { performSync } = await import('../../src/commands/sync.ts');
    const repo = mkRepo({
      'people/beta.md': personMd('Beta', 'State A body.'),
      'people/keeper2.md': personMd('Keeper2', 'Keeper2 stays.'),
    });
    await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    execSync('git rm -q people/beta.md && git commit -m "delete beta"', { cwd: repo, stdio: 'pipe' });
    // The state put_page leaves when its best-effort file write does not land.
    await engine.putPage('people/beta', {
      type: 'note', title: 'Beta', compiled_truth: 'ACCEPTED USER UPDATE.',
    }, { sourceId: 'default' });

    const full = await performSync(engine, { repoPath: repo, ...SYNC_OPTS, full: true });
    expect(full.status).not.toBe('blocked_by_failures');
    const survivor = await engine.getPage('people/beta');
    expect(survivor).not.toBeNull();
    expect(survivor!.compiled_truth).toContain('ACCEPTED USER UPDATE.');
  }, 300_000);
});
