/**
 * #3056 — sync rename path: a failed `updateSlug` must be surfaced, not
 * silently swallowed.
 *
 * Before the fix, the rename loop in src/commands/sync.ts swallowed
 * `updateSlug` failures with an empty catch ("treat as add") and could not
 * see a zero-row UPDATE at all (updateSlug returned void). The run then
 * fell through to importFile, which created/updated the row at the new
 * path — while the old row stayed behind, live, with its slug occupied.
 * Nothing was logged and no counter moved, so the failed rename was
 * indistinguishable from a successful one.
 *
 * This is the surfacing-only cut: it observes and reports the fallback
 * (SyncResult.renameFallbacks + a per-file stderr warn naming both slugs).
 * It intentionally does NOT reconcile (delete) the stale old row — that's
 * out of scope for this PR; cleanup stays with the existing `integrity` /
 * `orphans` tooling.
 *
 * Coverage:
 *   - engine contract: updateSlug returns the number of rows moved
 *     (0 = old slug not present, i.e. the silent no-op case).
 *   - collision fallback: destination slug already occupied → updateSlug
 *     throws UNIQUE → surfaced (warn + counter), old row left in place.
 *   - zero-row fallback: stored slug diverged from the path-derived one →
 *     UPDATE matches nothing → surfaced (warn + counter), old row left in
 *     place.
 *   - happy path: a clean git mv reports renameFallbacks 0 and keeps the
 *     page_id (no regression to the cheap rename).
 *   - partial-result survival: renameFallbacks counted before a mid-run
 *     abort must reach the returned partial SyncResult, not be dropped
 *     (buildPartialResult didn't carry this field originally).
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { execSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;
const repos: string[] = [];
// Serial-file requirement: blocked runs write real rows to the sync-failure
// ledger under $HOME/.gbrain — isolate HOME per test so the operator's actual
// ledger is never touched (same pattern as sync-failure-ledger.serial.test.ts).
let tmpHome: string;
const originalGbrainHome = process.env.GBRAIN_HOME;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  tmpHome = mkdtempSync(join(tmpdir(), 'gbrain-3056-home-'));
  // configDir() resolves under GBRAIN_HOME when set (see
  // gbrain-home-isolation.test.ts) — os.homedir() itself isn't
  // overridable from process.env.HOME on Bun, so GBRAIN_HOME is the real
  // isolation lever for the operator's ~/.gbrain sync-failure ledger.
  process.env.GBRAIN_HOME = tmpHome;
  await resetPgliteState(engine);
});

afterEach(() => {
  if (originalGbrainHome !== undefined) process.env.GBRAIN_HOME = originalGbrainHome;
  else delete process.env.GBRAIN_HOME;
  try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
  while (repos.length) {
    const d = repos.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

function personMd(title: string, body: string): string {
  return ['---', 'type: person', `title: ${title}`, '---', '', body].join('\n');
}

/** Create a temp git repo seeded with the given files + an initial commit. */
function mkRepo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-3056-'));
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

/** Capture stderr warnings (serr falls through to console.error in tests). */
async function captureErr<T>(fn: () => Promise<T>): Promise<{ result: T; err: string }> {
  const lines: string[] = [];
  const origErr = console.error;
  console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  try {
    const result = await fn();
    return { result, err: lines.join('\n') };
  } finally {
    console.error = origErr;
  }
}

async function countPages(): Promise<number> {
  const rows = await engine.executeRaw<{ n: number | string }>(
    `SELECT count(*)::int AS n FROM pages WHERE source_id = 'default'`,
  );
  return Number(rows[0]?.n ?? 0);
}

describe('updateSlug engine contract (#3056)', () => {
  test('returns 1 when the old slug row is moved', async () => {
    await engine.putPage('people/old', {
      type: 'person', title: 'Old', compiled_truth: 'body',
    }, { sourceId: 'default' });
    const moved = await engine.updateSlug('people/old', 'people/new', { sourceId: 'default' });
    expect(moved).toBe(1);
    expect(await engine.getPage('people/new')).not.toBeNull();
  });

  test('returns 0 when the old slug has no row (the silent no-op case)', async () => {
    const moved = await engine.updateSlug('people/ghost', 'people/new', { sourceId: 'default' });
    expect(moved).toBe(0);
  });
});

describe('#3056: surfacing a failed updateSlug in the sync rename path', () => {
  test('collision: destination slug occupied → surfaced, old row left in place (add semantics)', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    const repo = mkRepo({ 'people/carol.md': personMd('Carol', 'Carol is a person.') });
    await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    expect(await engine.getPage('people/carol')).not.toBeNull();

    // A pre-existing row already occupies the rename destination, so
    // updateSlug throws (source_id, slug) UNIQUE and the loop falls back.
    await engine.putPage('people/dana', {
      type: 'person', title: 'Dana (stale)', compiled_truth: 'occupies the destination slug',
    }, { sourceId: 'default' });

    execSync('git mv people/carol.md people/dana.md', { cwd: repo, stdio: 'pipe' });
    execSync('git commit -m "rename carol to dana"', { cwd: repo, stdio: 'pipe' });

    const { result, err } = await captureErr(() => performSync(engine, { repoPath: repo, ...SYNC_OPTS }));
    expect(result.status).toBe('synced');

    // The failure is surfaced: counted in the run result + warned on stderr.
    expect(result.renameFallbacks).toBe(1);
    expect(err).toContain('people/carol');
    expect(err).toContain('people/dana');

    // Add semantics: updateSlug threw (never touched the row), so importFile
    // upserts the pre-existing "dana" row in place with the renamed file's
    // content — the ORIGINAL "Dana (stale)" content is overwritten. This is
    // the pre-existing add-semantics behavior; this PR's job is only to
    // surface that a fallback happened (asserted above), not to prevent the
    // overwrite — that would need the reconcile machinery, out of scope here.
    const dana = await engine.getPage('people/dana');
    expect(dana).not.toBeNull();
    expect(dana!.compiled_truth).toContain('Carol is a person.');

    // ...and the OLD (now-orphaned) row is left in place, still live under
    // its original slug (no reconcile in this surfacing-only cut — cleanup
    // stays with `integrity` / `orphans` tooling, per maintainer guidance).
    expect(await engine.getPage('people/carol')).not.toBeNull();
    expect(await countPages()).toBe(2); // carol (orphaned) + dana (overwritten with carol's content)
  });

  test('zero-row fallback: divergent stored slug → surfaced, not silent', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    const repo = mkRepo({ 'people/carol.md': personMd('Carol', 'Carol is a person.') });
    await performSync(engine, { repoPath: repo, ...SYNC_OPTS });

    // Corrupt the row the way the field report describes: the stored slug no
    // longer matches the path-derived one, and there is no source_path to
    // find it by. resolveSlugsByPaths misses → the loop falls back to the
    // path-derived slug → the UPDATE matches zero rows.
    await engine.executeRaw(
      `UPDATE pages SET slug = 'people/carol-divergent', source_path = NULL
       WHERE source_id = 'default' AND slug = 'people/carol'`,
    );

    execSync('git mv people/carol.md people/dana.md', { cwd: repo, stdio: 'pipe' });
    execSync('git commit -m "rename carol to dana"', { cwd: repo, stdio: 'pipe' });

    const { result, err } = await captureErr(() => performSync(engine, { repoPath: repo, ...SYNC_OPTS }));
    expect(result.status).toBe('synced');

    // The zero-row UPDATE is no longer invisible: counted + warned with both
    // slugs so an operator can self-diagnose (the exact diagnostic the
    // reporter asked for).
    expect(result.renameFallbacks).toBe(1);
    expect(err).toContain('people/carol');
    expect(err).toContain('people/dana');

    // The new path imported; the divergent row is left as-is.
    expect(await engine.getPage('people/dana')).not.toBeNull();
    expect(await engine.getPage('people/carol-divergent')).not.toBeNull();
  });

  test('happy path: clean git mv rename keeps page_id and reports zero fallbacks', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    const repo = mkRepo({ 'people/carol.md': personMd('Carol', 'Carol is a person.') });
    await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    const before = await engine.getPage('people/carol');
    expect(before).not.toBeNull();

    execSync('git mv people/carol.md people/dana.md', { cwd: repo, stdio: 'pipe' });
    execSync('git commit -m "rename carol to dana"', { cwd: repo, stdio: 'pipe' });

    const result = await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    expect(result.status).toBe('synced');
    expect(result.renameFallbacks ?? 0).toBe(0);

    const after = await engine.getPage('people/dana');
    expect(after).not.toBeNull();
    expect(after!.id).toBe(before!.id); // cheap-path rename preserved the row
    expect(await engine.getPage('people/carol')).toBeNull();
    expect(await countPages()).toBe(1);
  });

  test('renameFallbacks counted before a mid-run abort reaches the partial SyncResult', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    // Deterministic abort, not a timing race: wrap updateSlug so the FIRST
    // call (rename #1, which will fall back) fires ac.abort() synchronously
    // right after it resolves. Iteration #1 still finishes normally
    // (import etc.); the abort check at the top of iteration #2 is what
    // actually short-circuits the loop — guaranteed order, no poll/sleep.
    const origUpdateSlug = engine.updateSlug.bind(engine);
    const ac = new AbortController();
    let calls = 0;
    engine.updateSlug = async (...args: Parameters<typeof origUpdateSlug>) => {
      calls += 1;
      const thisCall = calls;
      // try/finally: the collision scenario this test drives makes
      // origUpdateSlug THROW (UNIQUE violation) — abort() must still fire
      // on that path, not just the resolve path.
      try {
        return await origUpdateSlug(...args);
      } finally {
        if (thisCall === 1) ac.abort();
      }
    };
    try {
      const repo = mkRepo({
        'people/carol.md': personMd('Carol', 'Carol is a person.'),
        'people/erin.md': personMd('Erin', 'Erin is a person.'),
      });
      await performSync(engine, { repoPath: repo, ...SYNC_OPTS });

      // Both destinations pre-occupied so EVERY rename in this run falls
      // back (updateSlug throws) — the first call still increments
      // renameFallbacks before the wrapper's abort() fires.
      await engine.putPage('people/bob', {
        type: 'person', title: 'Bob (stale)', compiled_truth: 'occupies the destination slug',
      }, { sourceId: 'default' });
      await engine.putPage('people/frank', {
        type: 'person', title: 'Frank (stale)', compiled_truth: 'occupies the destination slug',
      }, { sourceId: 'default' });
      execSync('git mv people/carol.md people/bob.md', { cwd: repo, stdio: 'pipe' });
      execSync('git mv people/erin.md people/frank.md', { cwd: repo, stdio: 'pipe' });
      execSync('git commit -m "rename both to occupied destinations"', { cwd: repo, stdio: 'pipe' });

      const result = await performSync(engine, { repoPath: repo, ...SYNC_OPTS, signal: ac.signal });

      // This is the actual regression: buildPartialResult originally had no
      // renameFallbacks field at all, so a mid-run abort silently dropped
      // the count. The wrapper guarantees exactly 1 rename processed (and
      // counted) before the abort short-circuits the 2nd.
      expect(result.status).toBe('partial');
      expect(result.renameFallbacks).toBe(1);
      expect(calls).toBe(1); // proves the abort landed BEFORE the 2nd rename's updateSlug call
    } finally {
      engine.updateSlug = origUpdateSlug;
    }
  });
});
