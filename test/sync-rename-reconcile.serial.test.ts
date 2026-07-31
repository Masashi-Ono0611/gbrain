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
  test('sentinel survives while ANY active row still carries the old path; reconcile removes every stale active one and spares the live row', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    const { loadSyncFailures } = await import('../src/core/sync-failure-ledger.ts');
    const openRenameRows = () => loadSyncFailures().filter(
      f => f.path === '<rename:people/dana.md>' && f.state === 'open',
    );
    const repo = mkRepo({
      'people/carol.md': personMd('Carol', 'Carol is a person.'),
      'people/erin.md': personMd('Erin', 'Erin is a person.'),
    });
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
    // A LIVE row also sharing the old path — the bookkeeping a prior cheap
    // rename leaves behind (updateSlug never rewrites source_path). Its
    // backing file people/erin.md is in the working tree, so the widened
    // delete must NOT touch it (#3583 review, the data-loss blocker).
    await engine.executeRaw(
      `UPDATE pages SET source_path = 'people/carol.md'
       WHERE source_id = 'default' AND slug = 'people/erin'`,
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

    // Convergence must remove BOTH genuinely-stale active rows carrying the
    // old path — a single-row reconcile would leave one behind with the
    // rename already checkpointed, never to be retried. The LIVE erin row
    // (backed by people/erin.md in the working tree) must survive.
    const result = await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    expect(result.status).toBe('synced');
    expect(await engine.getPage('people/carol')).toBeNull();
    expect(await engine.getPage('people/carol-duplicate')).toBeNull();
    const erin = await engine.getPage('people/erin');
    expect(erin).not.toBeNull();
    expect(erin!.compiled_truth).toContain('Erin is a person.');
    expect(openRenameRows()).toHaveLength(0);
    const dana = await engine.getPage('people/dana');
    expect(dana).not.toBeNull();
    expect(dana!.compiled_truth).toContain('Carol is a person.');
  });
});

describe('#3583 review: a live page sharing the stale source_path survives the reconcile', () => {
  test('cheap rename leaves the old source_path on the live row; a later occupied-destination rename must not delete it', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    const repo = mkRepo({ 'people/alpha.md': personMd('Alpha', 'Alpha original body.') });
    await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    expect(await engine.getPage('people/alpha')).not.toBeNull();

    // Ordinary cheap rename alpha -> beta. updateSlug moves the slug but
    // never rewrites source_path, and the follow-up import is an
    // unchanged-content no-write skip — so the LIVE beta row keeps the OLD
    // path. Pinned here because it is the precondition that made the
    // widened source_path delete a data-loss bug (#3583 review).
    execSync('git mv people/alpha.md people/beta.md', { cwd: repo, stdio: 'pipe' });
    execSync('git commit -m "cheap rename alpha to beta"', { cwd: repo, stdio: 'pipe' });
    await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    const betaRows = await engine.executeRaw<{ source_path: string | null }>(
      `SELECT source_path FROM pages
        WHERE source_id = 'default' AND slug = 'people/beta' AND deleted_at IS NULL`,
    );
    expect(betaRows).toHaveLength(1);
    expect(betaRows[0].source_path).toBe('people/alpha.md');

    // An unrelated NEW file appears at the old path — two active rows now
    // share source_path=people/alpha.md.
    writeFileSync(join(repo, 'people/alpha.md'), personMd('Alpha II', 'A fresh, unrelated alpha.'));
    execSync('git add -A && git commit -m "new unrelated alpha"', { cwd: repo, stdio: 'pipe' });
    await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    expect(await engine.getPage('people/alpha')).not.toBeNull();
    expect(await engine.getPage('people/beta')).not.toBeNull();

    // Rename the recreated alpha into an OCCUPIED destination (the #3056
    // fallback this reconcile exists for). Only the recreated-alpha row is
    // genuinely stale; beta is a live page whose backing file is present in
    // the working tree.
    await engine.putPage('people/gamma', {
      type: 'person', title: 'Gamma occupier', compiled_truth: 'occupies the destination slug',
    }, { sourceId: 'default' });
    execSync('git mv people/alpha.md people/gamma.md', { cwd: repo, stdio: 'pipe' });
    execSync('git commit -m "rename alpha into occupied gamma"', { cwd: repo, stdio: 'pipe' });
    const result = await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    expect(result.status).toBe('synced');

    // The destination carries the recreated file's content...
    const gamma = await engine.getPage('people/gamma');
    expect(gamma).not.toBeNull();
    expect(gamma!.compiled_truth).toContain('A fresh, unrelated alpha.');
    // ...the genuinely-stale row (recreated alpha, file gone) is removed...
    expect(await engine.getPage('people/alpha')).toBeNull();
    // ...and the LIVE beta page survives with its content intact.
    const beta = await engine.getPage('people/beta');
    expect(beta).not.toBeNull();
    expect(beta!.compiled_truth).toContain('Alpha original body.');

    // The very next sync is quiet and beta is still alive — the review's
    // loss was permanent precisely because no incremental sync healed it.
    const quiet = await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    expect(quiet.status).toBe('up_to_date');
    expect(await engine.getPage('people/beta')).not.toBeNull();
  });
});

const openDanaRows = async () => {
  const { loadSyncFailures } = await import('../src/core/sync-failure-ledger.ts');
  return loadSyncFailures().filter(
    f => f.path === '<rename:people/dana.md>' && f.state === 'open',
  );
};

/** Plant one open, ORPHANED `<rename:…>` sentinel (its old path has no
 * active row) — exactly what the self-heal sweep would clear, which is
 * why a preview must not run the sweep. */
async function plantOrphanedSentinel(): Promise<void> {
  const { recordFailures, renameSentinelPath, renameReconcileErrorMessage } =
    await import('../src/core/sync-failure-ledger.ts');
  recordFailures('default', [{
    path: renameSentinelPath('people/dana.md'),
    error: renameReconcileErrorMessage('people/dana-old.md', 'people/dana-old', 'injected wedge'),
  }], 'deadbeef');
}

describe('#3583 review: --dry-run must not rewrite the failure ledger', () => {

  test('quiet-repo dry run reports up_to_date and leaves the open sentinel untouched; the real run still self-heals it', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    const repo = mkRepo({ 'people/carol.md': personMd('Carol', 'Carol is a person.') });
    await performSync(engine, { repoPath: repo, ...SYNC_OPTS });

    await plantOrphanedSentinel();
    expect(await openDanaRows()).toHaveLength(1);

    // Byte-identical, not just semantically-open: a preview must not touch
    // the ledger file at all (a rewrite that happened to preserve the open
    // row would still pass a rows-only assertion).
    const { syncFailuresPath } = await import('../src/core/sync-failure-ledger.ts');
    const { readFileSync: readLedger } = await import('node:fs');
    const ledgerBefore = readLedger(syncFailuresPath(), 'utf-8');

    const dry = await performSync(engine, { repoPath: repo, ...SYNC_OPTS, dryRun: true });
    expect(dry.status).toBe('up_to_date');
    // The operator's only wedge signal survives the preview.
    expect(await openDanaRows()).toHaveLength(1);
    expect(readLedger(syncFailuresPath(), 'utf-8')).toBe(ledgerBefore);

    // Control: the same quiet run WITHOUT --dry-run self-heals the orphan.
    const real = await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    expect(real.status).toBe('up_to_date');
    expect(await openDanaRows()).toHaveLength(0);
  });

  test('totalChanges==0 sweep site: git advanced with no syncable changes — dry run preserves the row, the real run clears it', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    const repo = mkRepo({ 'people/carol.md': personMd('Carol', 'Carol is a person.') });
    await performSync(engine, { repoPath: repo, ...SYNC_OPTS });

    await plantOrphanedSentinel();
    expect(await openDanaRows()).toHaveLength(1);

    // Advance git HEAD with a change the markdown strategy filters out, so
    // the run reaches the totalChanges==0 early return (not the
    // HEAD-equality one).
    writeFileSync(join(repo, 'notes.txt'), 'not syncable under the markdown strategy');
    execSync('git add -A && git commit -m "non-syncable change"', { cwd: repo, stdio: 'pipe' });

    const dry = await performSync(engine, { repoPath: repo, ...SYNC_OPTS, dryRun: true });
    expect(dry.status).toBe('dry_run');
    expect(await openDanaRows()).toHaveLength(1);

    const real = await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    expect(real.status).toBe('up_to_date');
    expect(await openDanaRows()).toHaveLength(0);
  });

  test('performFullSync pre-gate probe: a full sync self-heals an orphaned sentinel', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    const repo = mkRepo({ 'people/carol.md': personMd('Carol', 'Carol is a person.') });

    await plantOrphanedSentinel();
    expect(await openDanaRows()).toHaveLength(1);

    const result = await performSync(engine, { repoPath: repo, ...SYNC_OPTS, full: true });
    expect(result.status).toBe('first_sync');
    expect(await engine.getPage('people/carol')).not.toBeNull();
    expect(await openDanaRows()).toHaveLength(0);
  });
});

describe('#3583 review: frontmatter-fallback (CJK-wave) live rows survive the reconcile', () => {
  // A markdown file whose PATH derives no slug (emoji filename) imports
  // under its frontmatter `slug:` (#598). Such a live row's slug is NOT
  // path-derivable, so a tracked-file index built from resolveSlugForPath
  // alone would miss it and misclassify the row as stale — the same
  // data-loss shape as the ordinary cheap-rename case, one regime deeper.
  // Mixed-case on purpose: importFromContent normalizes through
  // validateSlug (lowercase), so the row is stored as `party-notes` — an
  // index that carried the raw frontmatter casing would miss it and
  // delete the live row all the same.
  const exoticMd = [
    '---', 'type: person', 'title: Party Notes', 'slug: Party-Notes', '---',
    '', 'Party notes live here.',
  ].join('\n');

  async function setupExoticScenario(): Promise<string> {
    const { performSync } = await import('../src/commands/sync.ts');
    const repo = mkRepo({
      '\u{1F389}.md': exoticMd,
      'people/alpha.md': personMd('Alpha', 'Alpha is a person.'),
    });
    await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    const party = await engine.getPage('party-notes');
    expect(party).not.toBeNull();
    expect(party!.compiled_truth).toContain('Party notes live here.');

    // Manufacture the stale bookkeeping a prior cheap rename leaves behind:
    // the LIVE party-notes row (backed by the tracked emoji file) carries
    // the old path of the rename below. A genuinely-stale ghost row shares
    // the same path as the inverse control — it has no backing file and
    // MUST still be deleted.
    await engine.executeRaw(
      `UPDATE pages SET source_path = 'people/alpha.md'
       WHERE source_id = 'default' AND slug = 'party-notes'`,
    );
    await engine.putPage('people/ghost', {
      type: 'person', title: 'Ghost (stale)', compiled_truth: 'no backing file anywhere',
    }, { sourceId: 'default' });
    await engine.executeRaw(
      `UPDATE pages SET source_path = 'people/alpha.md'
       WHERE source_id = 'default' AND slug = 'people/ghost'`,
    );

    // Occupied destination forces the fallback-to-add reconcile with
    // from=people/alpha.md.
    await engine.putPage('people/beta', {
      type: 'person', title: 'Beta (stale)', compiled_truth: 'occupies the destination slug',
    }, { sourceId: 'default' });
    execSync('git mv people/alpha.md people/beta.md', { cwd: repo, stdio: 'pipe' });
    execSync('git commit -m "rename alpha to beta"', { cwd: repo, stdio: 'pipe' });
    return repo;
  }

  test('emoji-filename row with a frontmatter slug is spared; the stale ghost sharing the path is still deleted', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    const repo = await setupExoticScenario();

    const result = await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    expect(result.status).toBe('synced');

    // The frontmatter-fallback row is LIVE (its emoji file is tracked and
    // still derives to party-notes through the import path) — it survives.
    const party = await engine.getPage('party-notes');
    expect(party).not.toBeNull();
    expect(party!.compiled_truth).toContain('Party notes live here.');

    // Inverse control: the ghost row sharing the same stale path has no
    // backing file — the widened reconcile still removes it.
    expect(await engine.getPage('people/ghost')).toBeNull();

    // And the rename itself converged.
    const beta = await engine.getPage('people/beta');
    expect(beta).not.toBeNull();
    expect(beta!.compiled_truth).toContain('Alpha is a person.');
  });

  test('sparse-checkout shape: the emoji file absent from the working tree still resolves through the git index blob', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    const repo = await setupExoticScenario();

    // Simulate a sparse/partial checkout: the file is tracked (in the git
    // index) but its working-tree copy is absent. The uncommitted disk
    // deletion never enters the commit diff, so sync does not see it as a
    // delete — but a naive on-disk read would now fail, and liveness must
    // fall through to the index blob.
    rmSync(join(repo, '\u{1F389}.md'));

    const result = await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    expect(result.status).toBe('synced');

    const party = await engine.getPage('party-notes');
    expect(party).not.toBeNull();
    expect(party!.compiled_truth).toContain('Party notes live here.');
    expect(await engine.getPage('people/ghost')).toBeNull();
  });
});

describe('#3583 review: --dry-run must not mutate ANY persistent state', () => {
  test('quiet named-source dry run leaves the last_sync_at heartbeat untouched; the real run bumps it', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    const repo = mkRepo({ 'people/carol.md': personMd('Carol', 'Carol is a person.') });
    // The heartbeat UPDATE targets the sources row; create it the way
    // `gbrain sources add` would so the quiet-run UPDATE has a target.
    await engine.executeRaw(
      `INSERT INTO sources (id, name) VALUES ('default', 'default') ON CONFLICT (id) DO NOTHING`,
    );
    await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    await engine.executeRaw(
      `UPDATE sources SET last_sync_at = '2000-01-01T00:00:00Z' WHERE id = 'default'`,
    );
    const heartbeat = async (): Promise<string | undefined> => {
      const rows = await engine.executeRaw<{ t: string }>(
        `SELECT last_sync_at::text AS t FROM sources WHERE id = 'default'`,
      );
      return rows[0]?.t;
    };
    const pinned = await heartbeat();
    expect(pinned).toContain('2000-01-01');

    const dry = await performSync(engine, { repoPath: repo, ...SYNC_OPTS, dryRun: true });
    expect(dry.status).toBe('up_to_date');
    // A preview that bumps the freshness heartbeat masks real staleness
    // from doctor — it must stay pinned.
    expect(await heartbeat()).toBe(pinned);

    const real = await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    expect(real.status).toBe('up_to_date');
    expect(await heartbeat()).not.toBe(pinned);
  });

  test('a preview under a narrower strategy must not hard-delete the now-un-syncable page; the real run still does', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    const repo = mkRepo({ 'people/carol.md': personMd('Carol', 'Carol is a person.') });
    await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    expect(await engine.getPage('people/carol')).not.toBeNull();

    // Modify + commit so the file enters manifest.modified; under
    // strategy=code it is then "modified but un-syncable" — the cleanup
    // class that used to be hard-deleted BEFORE the dry-run return.
    writeFileSync(join(repo, 'people/carol.md'), personMd('Carol', 'Carol updated body.'));
    execSync('git add -A && git commit -m "update carol"', { cwd: repo, stdio: 'pipe' });

    const dry = await performSync(engine, { repoPath: repo, ...SYNC_OPTS, strategy: 'code', dryRun: true });
    expect(dry.status).toBe('dry_run');
    expect(await engine.getPage('people/carol')).not.toBeNull();

    // Control: the real run keeps the pre-existing cleanup behavior.
    await performSync(engine, { repoPath: repo, ...SYNC_OPTS, strategy: 'code' });
    expect(await engine.getPage('people/carol')).toBeNull();
  });
});

describe('#3583 review: orphan-sentinel self-heal probe/clear race', () => {
  test('an active row materializing between the two probes keeps the sentinel open', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    const repo = mkRepo({ 'people/carol.md': personMd('Carol', 'Carol is a person.') });
    await performSync(engine, { repoPath: repo, ...SYNC_OPTS });

    await plantOrphanedSentinel();
    expect(await openDanaRows()).toHaveLength(1);

    // Simulate a writer outside the sync lock (a raw import, restore_page)
    // committing an active row with the sentinel's old path IMMEDIATELY
    // after the first orphan probe returned "no active row". The second
    // probe must see it and keep the sentinel open — a single-probe sweep
    // cleared it while the duplicate existed.
    const origExecuteRaw = engine.executeRaw.bind(engine);
    let probeCalls = 0;
    (engine as unknown as { executeRaw: typeof engine.executeRaw }).executeRaw =
      (async (sql: string, params?: unknown[]) => {
        const res = await origExecuteRaw(sql, params);
        if (sql.includes('source_path = ANY')) {
          probeCalls++;
          if (probeCalls === 1) {
            await engine.putPage('people/dana-old-revenant', {
              type: 'person', title: 'Dana (revenant)',
              compiled_truth: 'materialized between probe and clear',
            }, { sourceId: 'default' });
            await origExecuteRaw(
              `UPDATE pages SET source_path = 'people/dana-old.md'
               WHERE source_id = 'default' AND slug = 'people/dana-old-revenant'`,
            );
          }
        }
        return res;
      }) as typeof engine.executeRaw;
    try {
      const result = await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
      expect(result.status).toBe('up_to_date');
    } finally {
      (engine as unknown as { executeRaw: typeof engine.executeRaw }).executeRaw = origExecuteRaw;
    }

    // The duplicate is real, so its sentinel survives...
    expect(await openDanaRows()).toHaveLength(1);
    // ...and the double-probe actually ran (this assertion fails on a
    // single-probe implementation even before the survival check does).
    expect(probeCalls).toBe(2);
  });
});
