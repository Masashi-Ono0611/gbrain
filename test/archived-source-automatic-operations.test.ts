/**
 * Issue #3880 — archived sources are historical rows, not candidates for
 * automatic operations that enumerate filesystem-backed active sources.
 *
 * These tests use a real PGLite engine so every fixed SQL predicate is
 * executed against the production schema. Explicit single-source lookups are
 * intentionally left alone; this suite covers only automatic/all-source paths.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSync } from '../src/commands/sync.ts';
import { runFrontmatterInstallHook } from '../src/commands/frontmatter-install-hook.ts';
import { loadSourceRows } from '../src/commands/sources-harden.ts';
import {
  checkDbOnlyCollectorCollision,
  checkSyncFreshness,
  checkUndeclaredDbOnlyPages,
} from '../src/commands/doctor.ts';
import { scanBrainSources } from '../src/core/brain-writer.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resolveSourceId, resolveSourceWithTier } from '../src/core/source-resolver.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;
let scratch: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
}, 60_000);

beforeEach(async () => {
  await resetPgliteState(engine);
  scratch = mkdtempSync(join(tmpdir(), 'gbrain-archived-sources-'));
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

async function addSource(
  id: string,
  localPath: string | null,
  archived: boolean,
): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO sources (id, name, local_path, config, archived)
     VALUES ($1, $1, $2, '{}'::jsonb, $3)`,
    [id, localPath, archived],
  );
}

async function addPage(sourceId: string, slug: string): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO pages
       (slug, source_id, type, page_kind, title, compiled_truth, timeline, frontmatter, content_hash)
     VALUES ($1, $2, 'concept', 'markdown', $1, 'body', '', '{}'::jsonb, $3)`,
    [slug, sourceId, `hash-${sourceId}-${slug}`],
  );
}

function gitInit(dir: string): void {
  mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q', dir]);
}

async function captureConsoleLogs(fn: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const logSpy = spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  });
  try {
    await fn();
  } finally {
    logSpy.mockRestore();
  }
  return lines;
}

describe('automatic active-source operations', () => {
  test('sync --all includes the active source and excludes the archived source', async () => {
    const activePath = join(scratch, 'missing-active');
    const archivedPath = join(scratch, 'missing-archived');
    await addSource('active-sync', activePath, false);
    await addSource('archived-sync', archivedPath, true);

    const logs = await captureConsoleLogs(() => runSync(engine, [
      '--all',
      '--source', 'active-sync',
      '--dry-run',
      '--no-embed',
      '--no-pull',
      '--serial',
      '--missing-path', 'skip',
      '--json',
    ]));
    const envelope = JSON.parse(logs.at(-1)!) as {
      sources: Array<{ source_id: string }>;
    };

    expect(envelope.sources.map((source) => source.source_id)).toEqual(['active-sync']);
  });

  test('brain-writer automatic scan includes active and excludes archived repos', async () => {
    const activePath = join(scratch, 'active-writer');
    const archivedPath = join(scratch, 'archived-writer');
    mkdirSync(activePath, { recursive: true });
    mkdirSync(archivedPath, { recursive: true });
    writeFileSync(join(activePath, 'bad.md'), '---\ntitle: active\n---\nbody\u0000');
    writeFileSync(join(archivedPath, 'bad.md'), '---\ntitle: archived\n---\nbody\u0000');
    await addSource('active-writer', activePath, false);
    await addSource('archived-writer', archivedPath, true);

    const report = await scanBrainSources(engine);

    expect(report.per_source.map((source) => source.source_id)).toEqual(['active-writer']);
    expect(report.per_source[0]?.errors_by_code.NULL_BYTES).toBeGreaterThanOrEqual(1);
  });

  test('both cwd resolvers fail closed on a deeper archived path instead of falling to the active parent', async () => {
    // Codex review correction: the archived child is the longest-prefix
    // match, so both resolvers must still find it and reject it via the
    // existing assertSourceExists() fail-closed contract (see
    // test/cli-ambient-source-fail-closed.test.ts) rather than silently
    // resolving up to the active parent source.
    const activePath = join(scratch, 'active-resolver');
    const archivedPath = join(activePath, 'historical-copy');
    mkdirSync(archivedPath, { recursive: true });
    await addSource('active-resolver', activePath, false);
    await addSource('archived-resolver', archivedPath, true);

    await withEnv({ GBRAIN_SOURCE: undefined }, async () => {
      await expect(resolveSourceId(engine, null, archivedPath)).rejects.toThrow(/archived/i);
      await expect(resolveSourceWithTier(engine, null, archivedPath)).rejects.toThrow(/archived/i);
    });
  });

  test('doctor filesystem and freshness checks include active and exclude archived sources', async () => {
    const activePath = join(scratch, 'active-doctor');
    const archivedPath = join(scratch, 'archived-doctor');
    mkdirSync(activePath, { recursive: true });
    mkdirSync(archivedPath, { recursive: true });
    writeFileSync(join(activePath, 'gbrain.yml'), 'storage:\n  db_only:\n    - inbox/\n');
    writeFileSync(join(archivedPath, 'gbrain.yml'), 'storage:\n  db_only:\n    - inbox/\n');
    await addSource('active-doctor', activePath, false);
    await addSource('archived-doctor', archivedPath, true);
    await addPage('active-doctor', 'people/active-missing');
    await addPage('archived-doctor', 'people/archived-missing');

    const undeclared = await checkUndeclaredDbOnlyPages(engine);
    expect(undeclared.status).toBe('warn');
    expect(undeclared.details).toMatchObject({
      total: 1,
      per_source: { 'active-doctor': 1 },
    });
    expect(JSON.stringify(undeclared.details)).not.toContain('archived-doctor');

    const collision = await checkDbOnlyCollectorCollision(engine, {
      collectors: [{ id: 'collector-a', output_path: 'inbox/' }],
    });
    expect(collision.status).toBe('warn');
    expect((collision.details as { collisions: string[] }).collisions).toHaveLength(1);
    expect(JSON.stringify(collision.details)).toContain('active-doctor');
    expect(JSON.stringify(collision.details)).not.toContain('archived-doctor');

    const freshness = await checkSyncFreshness(engine);
    expect(freshness.status).toBe('fail');
    expect(freshness.details).toMatchObject({
      unchanged_count: 0,
      synced_recently_count: 0,
      stale_count: 1,
    });
    expect(freshness.message).toContain("'active-doctor'");
    expect(freshness.message).not.toContain('archived-doctor');
  });

  test('default hook installation touches the active repo only', async () => {
    const activePath = join(scratch, 'active-hook');
    const archivedPath = join(scratch, 'archived-hook');
    gitInit(activePath);
    gitInit(archivedPath);
    await addSource('active-hook', activePath, false);
    await addSource('archived-hook', archivedPath, true);

    await captureConsoleLogs(() => runFrontmatterInstallHook([], engine));

    expect(existsSync(join(activePath, '.githooks', 'pre-commit'))).toBe(true);
    expect(existsSync(join(archivedPath, '.githooks', 'pre-commit'))).toBe(false);
  });

  test('sources harden --all selection includes active and excludes archived rows', async () => {
    const activePath = join(scratch, 'active-harden');
    const archivedPath = join(scratch, 'archived-harden');
    await addSource('active-harden', activePath, false);
    await addSource('archived-harden', archivedPath, true);

    const automatic = await loadSourceRows(engine, undefined, true);
    expect(automatic.map((source) => source.id)).toEqual(['active-harden']);

    // Explicit recovery/history addressing remains available by design.
    const explicit = await loadSourceRows(engine, 'archived-harden', false);
    expect(explicit.map((source) => source.id)).toEqual(['archived-harden']);
  });
});
