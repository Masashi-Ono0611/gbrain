/**
 * #3056 — sync rename path: a failed `updateSlug` must not leave a live
 * duplicate of the renamed page behind.
 *
 * Before the fix, the rename loop swallowed `updateSlug` failures with an
 * empty catch ("treat as add") and could not see a zero-row UPDATE at all
 * (updateSlug returned void). The run then fell through to importFile,
 * which created/updated the row at the new path — while the old row stayed
 * behind, live, with its slug occupied. Nothing was logged, no counter
 * moved, and the duplicate was permanent.
 *
 * The fix reconciles: when the cheap rename didn't move a row AND the
 * destination demonstrably materialized, the stale old row is located
 * positively by `source_path = from` and deleted. Two safety rails:
 *
 *   - dedup-skip protection: identity dedup can skip the import against
 *     the OLD row, in which case nothing landed at the destination and
 *     deleting the old row would destroy the only copy — no reconcile.
 *   - no slug-guess deletes: the stale row is found by source_path only;
 *     an unrelated row that happens to sit at the guessed slug survives.
 *
 * A failed reconcile delete lands in failedFiles so the existing failure
 * gate blocks the bookmark and the next run retries the same rename diff.
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
// ledger under the gbrain home — isolate it per test so the operator's
// actual ledger is never touched (GBRAIN_HOME is the isolation lever;
// process.env.HOME does not redirect Bun's os.homedir()).
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

describe('#3056: rename fallback reconciles the stale old row', () => {
  test('collision: destination slug occupied → stale old row deleted after import lands', async () => {
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

    const result = await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    expect(result.status).toBe('synced');

    // The destination carries the renamed file's content...
    const dana = await engine.getPage('people/dana');
    expect(dana).not.toBeNull();
    expect(dana!.compiled_truth).toContain('Carol is a person.');

    // ...and the stale old row is gone — no live duplicate.
    expect(await engine.getPage('people/carol')).toBeNull();
    expect(await countPages()).toBe(1);
  });

  test('dedup-skip against the old row must NOT reconcile: the only copy survives', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    // frontmatter.id gives identity dedup a handle: the import at the new
    // path can skip as "identical to <old row>" — in which case NOTHING
    // landed at the destination and deleting the old row would destroy the
    // only copy of the content.
    const md = ['---', 'type: person', 'title: Carol', 'id: ext-3056', '---', '', 'Carol is a person.'].join('\n');
    const repo = mkRepo({ 'people/carol.md': md });
    await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    expect(await engine.getPage('people/carol')).not.toBeNull();

    // Destination occupied → updateSlug throws → fallback path.
    await engine.putPage('people/dana', {
      type: 'person', title: 'Dana (stale)', compiled_truth: 'occupies the destination slug',
    }, { sourceId: 'default' });

    execSync('git mv people/carol.md people/dana.md', { cwd: repo, stdio: 'pipe' });
    execSync('git commit -m "rename carol to dana"', { cwd: repo, stdio: 'pipe' });

    await performSync(engine, { repoPath: repo, ...SYNC_OPTS });

    // The import skipped against the OLD row (identity dedup), so the
    // destination never materialized with the renamed content — the
    // reconcile must not have deleted the old row, which still holds the
    // only copy.
    const carol = await engine.getPage('people/carol');
    expect(carol).not.toBeNull();
    expect(carol!.compiled_truth).toContain('Carol is a person.');
  });

  test('reconcile never deletes by slug guess: unrelated manual row survives', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    const repo = mkRepo({ 'people/carol.md': personMd('Carol', 'Carol is a person.') });
    await performSync(engine, { repoPath: repo, ...SYNC_OPTS });

    // The file's real row drifts to a divergent slug with no source_path
    // (unlocatable), and an UNRELATED manually-curated page happens to sit
    // at the path-derived slug a naive reconcile would guess.
    await engine.executeRaw(
      `UPDATE pages SET slug = 'people/carol-divergent', source_path = NULL
       WHERE source_id = 'default' AND slug = 'people/carol'`,
    );
    await engine.putPage('people/carol', {
      type: 'person', title: 'Manual Carol', compiled_truth: 'hand-authored, not from the file',
    }, { sourceId: 'default' });
    // Destination occupied → updateSlug throws UNIQUE → fallback path.
    await engine.putPage('people/dana', {
      type: 'person', title: 'Dana (stale)', compiled_truth: 'occupies the destination slug',
    }, { sourceId: 'default' });

    execSync('git mv people/carol.md people/dana.md', { cwd: repo, stdio: 'pipe' });
    execSync('git commit -m "rename carol to dana"', { cwd: repo, stdio: 'pipe' });

    const result = await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    expect(result.status).toBe('synced');

    // The destination materialized with the file's content...
    const dana = await engine.getPage('people/dana');
    expect(dana).not.toBeNull();
    expect(dana!.compiled_truth).toContain('Carol is a person.');
    // ...but no row had source_path = from, so the reconcile deleted
    // NOTHING: the unrelated manual row at the guessed slug survives.
    const manual = await engine.getPage('people/carol');
    expect(manual).not.toBeNull();
    expect(manual!.compiled_truth).toContain('hand-authored');
  });

  test('happy path: clean git mv rename keeps page_id and touches nothing else', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    const repo = mkRepo({ 'people/carol.md': personMd('Carol', 'Carol is a person.') });
    await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    const before = await engine.getPage('people/carol');
    expect(before).not.toBeNull();

    execSync('git mv people/carol.md people/dana.md', { cwd: repo, stdio: 'pipe' });
    execSync('git commit -m "rename carol to dana"', { cwd: repo, stdio: 'pipe' });

    const result = await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    expect(result.status).toBe('synced');

    const after = await engine.getPage('people/dana');
    expect(after).not.toBeNull();
    expect(after!.id).toBe(before!.id); // cheap-path rename preserved the row
    expect(await engine.getPage('people/carol')).toBeNull();
    expect(await countPages()).toBe(1);
  });

  test('reconcile failure blocks the bookmark and the next run retries to convergence', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    const repo = mkRepo({ 'people/carol.md': personMd('Carol', 'Carol is a person.') });
    await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    await engine.putPage('people/dana', {
      type: 'person', title: 'Dana (stale)', compiled_truth: 'occupies the destination slug',
    }, { sourceId: 'default' });

    execSync('git mv people/carol.md people/dana.md', { cwd: repo, stdio: 'pipe' });
    execSync('git commit -m "rename carol to dana"', { cwd: repo, stdio: 'pipe' });

    // Inject a transient failure into the reconcile delete.
    const origDelete = engine.deletePage.bind(engine);
    engine.deletePage = async () => { throw new Error('injected transient delete failure'); };
    let blocked;
    try {
      blocked = await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    } finally {
      engine.deletePage = origDelete;
    }

    // The failed reconcile is not checkpointed past: the run blocks and the
    // stale duplicate is still visible. The failure is recorded as a
    // `<rename:…>` SENTINEL, which the auto-skip valve can never
    // chronic-skip — an outage lasting longer than the threshold must not
    // quietly bank the duplicate.
    expect(blocked.status).toBe('blocked_by_failures');
    expect(blocked.failedFiles).toBe(1);
    expect(await engine.getPage('people/carol')).not.toBeNull();
    const { loadSyncFailures } = await import('../src/core/sync-failure-ledger.ts');
    const openSentinels = loadSyncFailures().filter(
      f => f.path === '<rename:people/dana.md>' && f.state === 'open',
    );
    expect(openSentinels).toHaveLength(1);

    // Next run (failure gone) retries the same rename diff and converges.
    const result = await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    expect(result.status).toBe('synced');
    expect(await engine.getPage('people/carol')).toBeNull();
    const dana = await engine.getPage('people/dana');
    expect(dana).not.toBeNull();
    expect(dana!.compiled_truth).toContain('Carol is a person.');
    expect(await countPages()).toBe(1);

    // The convergence also clears the sentinel row — doctor must not keep
    // warning about a rename that has since reconciled.
    const remaining = loadSyncFailures().filter(
      f => f.path === '<rename:people/dana.md>' && f.state === 'open',
    );
    expect(remaining).toHaveLength(0);
  });

  test('#3479: an errorless unchanged-skip AT the new slug counts as materialized — the stale row reconciles without any write', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    const repo = mkRepo({ 'people/carol.md': personMd('Carol', 'Carol is a person.') });
    await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    expect(await engine.getPage('people/carol')).not.toBeNull();

    // The destination row pre-exists AND its content_hash matches what the
    // renamed file would import to (forged via SQL to construct the shape;
    // in reality equal hashes mean byte-identical parsed content). The
    // import at the new path is then an errorless unchanged-skip at the NEW
    // slug — the one destMaterialized path where NOTHING is written.
    await engine.putPage('people/dana', {
      type: 'person', title: 'Dana occupier', compiled_truth: 'occupier body, untouched by the skip',
    }, { sourceId: 'default' });
    await engine.executeRaw(
      `UPDATE pages SET content_hash =
         (SELECT content_hash FROM pages WHERE source_id = 'default' AND slug = 'people/carol')
       WHERE source_id = 'default' AND slug = 'people/dana'`,
    );

    execSync('git mv people/carol.md people/dana.md', { cwd: repo, stdio: 'pipe' });
    execSync('git commit -m "rename carol to dana"', { cwd: repo, stdio: 'pipe' });

    const result = await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    expect(result.status).toBe('synced');

    // The stale old row reconciled away even though the skip wrote nothing...
    expect(await engine.getPage('people/carol')).toBeNull();
    // ...and the destination row is genuinely untouched (the skip was real).
    const dana = await engine.getPage('people/dana');
    expect(dana).not.toBeNull();
    expect(dana!.compiled_truth).toContain('occupier body');
    expect(await countPages()).toBe(1);
  });
});

describe('#3479 blocker 1: a permanent reconcile failure has a documented operator exit', () => {
  test('hard-blocks every --skip-failed run, names the gbrain delete remedy, and the remedy converges it', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    const { loadSyncFailures } = await import('../src/core/sync-failure-ledger.ts');
    const repo = mkRepo({ 'people/carol.md': personMd('Carol', 'Carol is a person.') });
    await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    await engine.putPage('people/dana', {
      type: 'person', title: 'Dana (stale)', compiled_truth: 'occupies the destination slug',
    }, { sourceId: 'default' });
    execSync('git mv people/carol.md people/dana.md', { cwd: repo, stdio: 'pipe' });
    execSync('git commit -m "rename carol to dana"', { cwd: repo, stdio: 'pipe' });

    // A PERMANENT delete failure (RLS denying DELETE, FK RESTRICT — an
    // environment where UPDATE still works but this DELETE never will):
    // every retry fails the same way. Capture stderr to pin that the
    // blocked message documents the operator exit, not just the retry.
    const origDelete = engine.deletePage.bind(engine);
    engine.deletePage = async () => { throw new Error('permission denied for table pages (injected permanent failure)'); };
    const stderrChunks: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    const origConsoleError = console.error;
    process.stderr.write = ((chunk: unknown, ...rest: unknown[]) => {
      stderrChunks.push(String(chunk));
      return (origWrite as (...a: unknown[]) => boolean)(chunk, ...rest);
    }) as typeof process.stderr.write;
    console.error = (...args: unknown[]) => { stderrChunks.push(args.map(String).join(' ')); origConsoleError(...args); };
    let result;
    try {
      for (let i = 0; i < 3; i++) {
        const blocked = await performSync(engine, { repoPath: repo, ...SYNC_OPTS, skipFailed: true });
        // Structural: the sentinel hard-blocks EVEN with --skip-failed —
        // acknowledgeFailures explicitly skips sentinels, so without a
        // documented remedy this is a total sync outage.
        expect(blocked.status).toBe('blocked_by_failures');
      }
      const open = loadSyncFailures().filter(
        f => f.path === '<rename:people/dana.md>' && f.state === 'open',
      );
      expect(open).toHaveLength(1);
      expect(open[0].attempts).toBeGreaterThanOrEqual(3);

      // The documented remedy — exercised faithfully: `gbrain delete` is a
      // SOFT-delete (the row keeps its source_path until the purge phase),
      // and the environment's DELETE is STILL denied (the mock stays
      // active). Convergence therefore requires the reconcile to treat a
      // soft-deleted stale row as "nothing left to delete" instead of
      // re-attempting the hard delete that keeps failing here.
      expect(await engine.softDeletePage('people/carol', { sourceId: 'default' })).not.toBeNull();
      result = await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    } finally {
      process.stderr.write = origWrite;
      console.error = origConsoleError;
      engine.deletePage = origDelete;
    }
    const stderrText = stderrChunks.join('');
    expect(stderrText).toContain("'gbrain delete <stale-slug>'");
    // The error names the exact stale slug the remedy should target
    // (JSON-quoted — the format is machine-parsed by the orphan probe).
    expect(stderrText).toContain('stale row "people/carol" for "people/carol.md" not removed');
    expect(result.status).toBe('synced');
    const dana = await engine.getPage('people/dana');
    expect(dana).not.toBeNull();
    expect(dana!.compiled_truth).toContain('Carol is a person.');
    expect(loadSyncFailures().filter(
      f => f.path === '<rename:people/dana.md>' && f.state === 'open',
    )).toHaveLength(0);
  });
});

describe('#3479 blocker 2: an orphaned rename sentinel self-clears; a real duplicate never does', () => {
  test('force-push invalidates the pin: sentinel clears once the stale row is gone, stays open while it is real', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    const { loadSyncFailures } = await import('../src/core/sync-failure-ledger.ts');
    const openRenameRows = () => loadSyncFailures().filter(
      f => f.path === '<rename:people/dana.md>' && f.state === 'open',
    );

    const repo = mkRepo({ 'people/carol.md': personMd('Carol', 'Carol is a person.') });
    const preRenameCommit = execSync('git rev-parse HEAD', { cwd: repo, stdio: 'pipe' }).toString().trim();
    await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    expect(await engine.getPage('people/carol')).not.toBeNull();

    // Rename with a failing reconcile → open sentinel, bookmark blocked.
    await engine.putPage('people/dana', {
      type: 'person', title: 'Dana (stale)', compiled_truth: 'occupies the destination slug',
    }, { sourceId: 'default' });
    execSync('git mv people/carol.md people/dana.md', { cwd: repo, stdio: 'pipe' });
    execSync('git commit -m "rename carol to dana"', { cwd: repo, stdio: 'pipe' });
    const origDelete = engine.deletePage.bind(engine);
    engine.deletePage = async () => { throw new Error('injected transient delete failure'); };
    try {
      const blocked = await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
      expect(blocked.status).toBe('blocked_by_failures');
    } finally {
      engine.deletePage = origDelete;
    }
    expect(openRenameRows()).toHaveLength(1);

    // FORCE-PUSH: history is rewritten to BEFORE the rename (carol.md is
    // back in the tree, the rename commit is gone) and moves on with an
    // unrelated add — the rename never re-enters any diff, so the ordinary
    // convergence path can now never fire for it, and the banked pin is
    // invalidated. This is the reviewer's orphaning shape.
    execSync(`git reset --hard ${preRenameCommit}`, { cwd: repo, stdio: 'pipe' });
    writeFileSync(join(repo, 'people/dana.md'), personMd('Dana', 'A fresh, unrelated dana file.'));
    execSync('git add -A && git commit -m "fresh dana on rewritten history"', { cwd: repo, stdio: 'pipe' });

    // FAIL-CLOSED CONTROL: the stale duplicate row still resolves (carol.md
    // is untouched by the new diff), so the sentinel must survive however
    // many syncs run — auto-clearing here would silently drop the only
    // signal that a real duplicate exists.
    await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    expect(openRenameRows()).toHaveLength(1);
    expect(await engine.getPage('people/carol')).not.toBeNull();

    // The duplicate disappears — via the operator's actual tool, `gbrain
    // delete` (a SOFT-delete: the row keeps its source_path). The sentinel
    // now guards nothing live: the next run — even a quiet up_to_date one,
    // the reviewer's exact probe shape — self-clears it.
    expect(await engine.softDeletePage('people/carol', { sourceId: 'default' })).not.toBeNull();
    const quiet = await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    expect(quiet.status).toBe('up_to_date');
    expect(openRenameRows()).toHaveLength(0);
  });
});

describe('#3479: rename sentinel error format round-trips', () => {
  test('parseRenameReconcileFrom inverts renameReconcileErrorMessage for awkward paths', async () => {
    const { renameReconcileErrorMessage, parseRenameReconcileFrom } =
      await import('../src/core/sync-failure-ledger.ts');
    const awkward = [
      'people/carol.md',
      'dir with spaces/x y.md',
      'a(b)/weird):.md',
      // The delimiter-collision counterexample (#3479 codex review): a raw
      // interpolation would truncate this at its embedded ' not removed): '
      // and hand the orphan probe a WRONG path — JSON-quoting makes the
      // span self-delimiting.
      'dir/a not removed): b.md',
      'quotes "inside" and \\backslash\\.md',
      'ユニコード/パス.md',
    ];
    for (const from of awkward) {
      for (const slug of ['people/carol', undefined]) {
        const err = renameReconcileErrorMessage(from, slug, 'boom: nested (cause) text not removed): decoy');
        expect(parseRenameReconcileFrom(err)).toBe(from);
      }
    }
  });

  test('anything else parses to undefined (fail-closed: never auto-clear on a misread)', async () => {
    const { parseRenameReconcileFrom } = await import('../src/core/sync-failure-ledger.ts');
    expect(parseRenameReconcileFrom('some legacy error text')).toBeUndefined();
    expect(parseRenameReconcileFrom('')).toBeUndefined();
    // Pre-#3479 unquoted legacy shape: unparseable by design (left open).
    expect(parseRenameReconcileFrom('rename reconcile failed (stale row for people/x.md not removed): boom')).toBeUndefined();
    expect(parseRenameReconcileFrom('rename reconcile failed (stale row "x" for "unterminated): boom')).toBeUndefined();
  });
});

describe('#3479: non-unique source_path — a soft-deleted row must not mask a live duplicate', () => {
  test('sentinel survives while ANY active row still carries the old path; reconcile removes every active one', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    const { loadSyncFailures } = await import('../src/core/sync-failure-ledger.ts');
    const openRenameRows = () => loadSyncFailures().filter(
      f => f.path === '<rename:people/dana.md>' && f.state === 'open',
    );
    const repo = mkRepo({ 'people/carol.md': personMd('Carol', 'Carol is a person.') });
    await performSync(engine, { repoPath: repo, ...SYNC_OPTS });

    // A SECOND row sharing source_path=people/carol.md (non-unique index):
    // one active, plus a soft-deleted decoy that a one-row resolve could
    // hand back first — masking the live duplicate behind a null getPage.
    await engine.putPage('people/carol-duplicate', {
      type: 'person', title: 'Carol (dup)', compiled_truth: 'second row for the same file',
    }, { sourceId: 'default' });
    await engine.executeRaw(
      `UPDATE pages SET source_path = 'people/carol.md'
       WHERE source_id = 'default' AND slug = 'people/carol-duplicate'`,
    );
    await engine.putPage('people/carol-decoy', {
      type: 'person', title: 'Carol (decoy)', compiled_truth: 'soft-deleted decoy sharing the path',
    }, { sourceId: 'default' });
    await engine.executeRaw(
      `UPDATE pages SET source_path = 'people/carol.md'
       WHERE source_id = 'default' AND slug = 'people/carol-decoy'`,
    );
    expect(await engine.softDeletePage('people/carol-decoy', { sourceId: 'default' })).not.toBeNull();

    // Rename with a failing delete → open sentinel.
    await engine.putPage('people/dana', {
      type: 'person', title: 'Dana (stale)', compiled_truth: 'occupies the destination slug',
    }, { sourceId: 'default' });
    execSync('git mv people/carol.md people/dana.md', { cwd: repo, stdio: 'pipe' });
    execSync('git commit -m "rename carol to dana"', { cwd: repo, stdio: 'pipe' });
    const origDelete = engine.deletePage.bind(engine);
    engine.deletePage = async () => { throw new Error('injected transient delete failure'); };
    try {
      const blocked = await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
      expect(blocked.status).toBe('blocked_by_failures');
    } finally {
      engine.deletePage = origDelete;
    }
    expect(openRenameRows()).toHaveLength(1);

    // Convergence must remove BOTH active rows carrying the old path — a
    // single-row reconcile would leave one behind with the rename already
    // checkpointed, never to be retried.
    const result = await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    expect(result.status).toBe('synced');
    expect(await engine.getPage('people/carol')).toBeNull();
    expect(await engine.getPage('people/carol-duplicate')).toBeNull();
    expect(openRenameRows()).toHaveLength(0);
    const dana = await engine.getPage('people/dana');
    expect(dana).not.toBeNull();
    expect(dana!.compiled_truth).toContain('Carol is a person.');
  });
});
