/**
 * #3765 — `sync_brain` resolves the caller's own cwd for its source pin
 * (via `ctx.sourceId`, threaded per #2830), never the `repo` argument's
 * directory. A worktree pinned to a non-default source via `.gbrain-source`,
 * or simply registered as a source's `local_path`, is therefore invisible
 * whenever the CALLER's cwd carries no pin of its own: `ctx.sourceId`
 * auto-fills to 'default' (dispatch.ts D4 / `gbrain call`'s own
 * `resolveSourceId(engine, explicitSource)` — both resolve against the
 * PROCESS's cwd, not the `repo` param), and an explicit `repo` argument
 * then imports INTO 'default' instead of the source the repo is actually
 * registered/pinned to.
 *
 * The consequence flagged in the issue as a bypassed "autopilot-race guard"
 * is this same mis-resolution: `performSync`'s per-source lock (v0.40.5.0,
 * `syncLockId(sourceId)`) only serializes two callers that resolve the SAME
 * sourceId. Pre-fix, an autopilot cycle holding the lock for the repo's real
 * source never blocks an MCP `sync_brain` call that mis-resolved to
 * 'default' — different lock row, no contention. (Note: issue #3765's body
 * cites this as "(#1734)"; #1734 is an unrelated HNSW-dimension bug and no
 * such guard exists anywhere in the CLI `sync` path today — verified against
 * current master. The real serialization mechanism is the pre-existing
 * per-source lock; fixing source resolution is what lets it apply to the
 * pair of callers that actually collide on the same repo.)
 *
 * Both assertions below are pinned against CURRENT master (pre-fix): the
 * pages test resolves into 'default' rather than the repo's real source, and
 * the lock-contention test finds performSync's lock free (and the sync
 * therefore proceeds) even while the repo's real source lock is held.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'fs';
import { execSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runSources } from '../src/commands/sources.ts';
import { operationsByName, type OperationContext } from '../src/core/operations.ts';
import { tryAcquireDbLock, syncLockId, type DbLockHandle } from '../src/core/db-lock.ts';

const SOURCE_A = 'srcb-3765-a'; // registered via `sources add --path` (tier 4)
const SOURCE_B = 'srcb-3765-b'; // pinned via `.gbrain-source` dotfile (tier 3)

let engine: PGLiteEngine;
let repoA: string; // registered as SOURCE_A's local_path
let repoB: string; // NOT registered anywhere; carries a .gbrain-source pin to SOURCE_B

function makeRepo(prefix: string, slug: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  execSync('git init', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.email "test@test.com"', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.name "Test"', { cwd: dir, stdio: 'pipe' });
  mkdirSync(join(dir, 'topics'), { recursive: true });
  writeFileSync(join(dir, `topics/${slug}.md`), [
    '---',
    'type: concept',
    `title: ${slug}`,
    '---',
    '',
    'Body long enough to import cleanly for the sync-op repo-resolution test.',
    '',
  ].join('\n'));
  execSync('git add -A && git commit -m seed', { cwd: dir, stdio: 'pipe' });
  return dir;
}

function baseCtx(sourceId: string): OperationContext {
  return {
    engine,
    config: {},
    logger: { info() {}, warn() {}, error() {} },
    dryRun: false,
    remote: false,
    sourceId,
  } as unknown as OperationContext;
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();

  repoA = makeRepo('gbrain-syncop-a-', 'anchor-a');
  repoB = makeRepo('gbrain-syncop-b-', 'anchor-b');
  writeFileSync(join(repoB, '.gbrain-source'), `${SOURCE_B}\n`);

  await runSources(engine, ['add', SOURCE_A, '--path', repoA, '--no-federated']);
  // SOURCE_B is registered (so the dotfile pin resolves to a real source)
  // but deliberately has NO local_path — the pin, not a path match, is
  // what must resolve it.
  await runSources(engine, ['add', SOURCE_B, '--no-federated']);
}, 60_000);

afterAll(async () => {
  if (engine) await engine.disconnect();
  if (repoA) rmSync(repoA, { recursive: true, force: true });
  if (repoB) rmSync(repoB, { recursive: true, force: true });
}, 60_000);

async function pageCount(sourceId: string): Promise<number> {
  const rows = await engine.executeRaw<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM pages WHERE source_id = $1`,
    [sourceId],
  );
  return rows[0]!.n;
}

describe('sync_brain op resolves the repo argument\'s own source (#3765)', () => {
  test('default-fallback ctx + registered local_path (tier 4): imports into the REGISTERED source, not default', async () => {
    const op = operationsByName['sync_brain']!;
    // Simulates the real MCP shape: the caller's own cwd/env carry no pin,
    // so dispatch.ts / `gbrain call` resolved the D4 'default' auto-fill —
    // but the caller passed an explicit `repo` pointing at a DIFFERENT,
    // registered source.
    const ctx = baseCtx('default');
    const result = await op.handler(ctx, { repo: repoA, no_embed: true, no_pull: true });

    expect(result).toBeDefined();
    expect(await pageCount(SOURCE_A)).toBeGreaterThan(0);
    expect(await pageCount('default')).toBe(0);
  }, 60_000);

  test('default-fallback ctx + .gbrain-source dotfile at the repo (tier 3): imports into the PINNED source, not default', async () => {
    const op = operationsByName['sync_brain']!;
    const ctx = baseCtx('default');
    const result = await op.handler(ctx, { repo: repoB, no_embed: true, no_pull: true });

    expect(result).toBeDefined();
    expect(await pageCount(SOURCE_B)).toBeGreaterThan(0);
    // Only SOURCE_B should have grown from this call; 'default' stays empty
    // across both tests in this suite.
    expect(await pageCount('default')).toBe(0);
  }, 60_000);

  test('an EXPLICIT non-default ctx.sourceId is never overridden by the repo pin', async () => {
    const op = operationsByName['sync_brain']!;
    // The caller genuinely resolved SOURCE_A upstream (their own --source
    // flag / GBRAIN_SOURCE / cwd dotfile) — that must win even though the
    // repo argument itself carries a DIFFERENT pin (SOURCE_B).
    const ctx = baseCtx(SOURCE_A);
    await op.handler(ctx, { repo: repoB, no_embed: true, no_pull: true });

    // repoB's content lands under the caller's explicit source (A), not the
    // dotfile-pinned one (B).
    const bCountBefore = await pageCount(SOURCE_B);
    expect(bCountBefore).toBeGreaterThan(0); // from the previous test — unchanged
    const aRows = await engine.executeRaw<{ slug: string }>(
      `SELECT slug FROM pages WHERE source_id = $1`,
      [SOURCE_A],
    );
    expect(aRows.some((r) => r.slug.includes('anchor-b'))).toBe(true);
  }, 60_000);
});

describe('sync_brain op restores the per-source sync lock as the race-serialization mechanism (#3765)', () => {
  test('a lock held for the REPO\'S OWN source blocks the MCP call once resolution is correct', async () => {
    // Simulates an autopilot cycle already mid-sync for the source repoA
    // is actually registered to.
    const holder: DbLockHandle | null = await tryAcquireDbLock(engine, syncLockId(SOURCE_A));
    expect(holder).not.toBeNull();
    try {
      const op = operationsByName['sync_brain']!;
      const ctx = baseCtx('default');
      let threw: unknown = null;
      try {
        await op.handler(ctx, { repo: repoA, no_embed: true, no_pull: true, dry_run: true });
      } catch (e) {
        threw = e;
      }
      // Correct resolution takes syncLockId(SOURCE_A) — the SAME row the
      // simulated autopilot cycle holds — so performSync must fail to
      // acquire it (SyncLockBusyError) instead of silently proceeding
      // against an unrelated 'default' lock row.
      expect(threw).not.toBeNull();
      expect(String(threw)).toMatch(/lock/i);
    } finally {
      await holder!.release();
    }
  }, 60_000);
});
