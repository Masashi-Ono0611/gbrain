/**
 * #4399 — config.syncEnabled=false is a single choke-point exclusion.
 *
 * Before this fix, `syncEnabled: false` was checked in exactly two places
 * (sync-cost-gate.ts's inline estimate, and the `sync --all` fan-out filter
 * in sync.ts) but NOT inside `performSync()` — the one function every sync
 * execution path funnels through (CLI single-source, the minion `sync` job,
 * autopilot's per-source freshness dispatcher, cycle.ts's sync phase). A
 * source disabled to avoid a known duplicate-page bug got auto-resynced by
 * autopilot anyway.
 *
 * This file pins:
 *   - isSyncDisabledConfig / isSyncDisabledForSource (src/core/sync-policy.ts):
 *     the shared predicate, including its fail-open behavior.
 *   - performSync (src/commands/sync.ts): throws SyncDisabledError for a
 *     disabled source's sourceId, regardless of the skipLock path, and does
 *     NOT throw for an enabled/unset source.
 *   - the Minion 'sync' job handler (src/commands/jobs.ts): catches
 *     SyncDisabledError and marks the job skipped (reason: sync_disabled),
 *     not failed — mirroring the existing SyncLockBusyError classification
 *     pinned in test/sync-lock-busy-classification.test.ts.
 *
 * Real seams throughout (no stubs): a genuine PGLite `sources` row with
 * config.syncEnabled=false drives the real performSync / real minion worker.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv, emptyHome } from './helpers/with-env.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { MinionWorker } from '../src/core/minions/worker.ts';
import type { MinionJob } from '../src/core/minions/types.ts';
import { registerBuiltinHandlers } from '../src/commands/jobs.ts';
import { performSync, SyncDisabledError } from '../src/commands/sync.ts';
import { isSyncDisabledConfig, isSyncDisabledForSource } from '../src/core/sync-policy.ts';
import type { BrainEngine } from '../src/core/engine.ts';

let engine: PGLiteEngine;
let schemaVersion: string | null = null;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  schemaVersion = await engine.getConfig('version');
}, 120_000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  if (schemaVersion) await engine.setConfig('version', schemaVersion);
});

function makeGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-f4399-sync-disabled-'));
  execSync('git init', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.email t@t.co', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.name t', { cwd: dir, stdio: 'pipe' });
  writeFileSync(join(dir, '.gitkeep'), '');
  execSync('git add -A && git commit -m init', { cwd: dir, stdio: 'pipe' });
  return dir;
}

async function insertSource(id: string, localPath: string, config: Record<string, unknown>): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO sources (id, name, local_path, config, archived, created_at)
     VALUES ($1, $1, $2, $3::jsonb, false, NOW())
     ON CONFLICT (id) DO UPDATE SET local_path = EXCLUDED.local_path, config = EXCLUDED.config`,
    [id, localPath, JSON.stringify(config)],
  );
}

// ─── isSyncDisabledConfig (pure predicate) ─────────────────────────────────

describe('isSyncDisabledConfig', () => {
  test('true only for the literal syncEnabled: false', () => {
    expect(isSyncDisabledConfig({ syncEnabled: false })).toBe(true);
  });

  test('false for syncEnabled: true', () => {
    expect(isSyncDisabledConfig({ syncEnabled: true })).toBe(false);
  });

  test('false when syncEnabled is absent (the common case)', () => {
    expect(isSyncDisabledConfig({})).toBe(false);
    expect(isSyncDisabledConfig(undefined)).toBe(false);
    expect(isSyncDisabledConfig(null)).toBe(false);
  });

  test('driver-shape tolerant: a JSON-string config (PGLite raw-query shape) parses the same as an object', () => {
    expect(isSyncDisabledConfig(JSON.stringify({ syncEnabled: false }))).toBe(true);
    expect(isSyncDisabledConfig(JSON.stringify({ syncEnabled: true }))).toBe(false);
  });
});

// ─── isSyncDisabledForSource (DB-backed lookup) ────────────────────────────

describe('isSyncDisabledForSource', () => {
  test('undefined sourceId → false (no lookup needed)', async () => {
    expect(await isSyncDisabledForSource(engine, undefined)).toBe(false);
  });

  test('source not found → false (fail open)', async () => {
    expect(await isSyncDisabledForSource(engine, 'does-not-exist')).toBe(false);
  });

  test('source with config.syncEnabled=false → true', async () => {
    await insertSource('dis', '/tmp/dis-src', { syncEnabled: false });
    expect(await isSyncDisabledForSource(engine, 'dis')).toBe(true);
  });

  test('source with config.syncEnabled=true or absent → false', async () => {
    await insertSource('on', '/tmp/on-src', { syncEnabled: true });
    await insertSource('unset', '/tmp/unset-src', {});
    expect(await isSyncDisabledForSource(engine, 'on')).toBe(false);
    expect(await isSyncDisabledForSource(engine, 'unset')).toBe(false);
  });

  test('fails CLOSED — a genuine lookup failure propagates rather than being swallowed', async () => {
    // Codex review finding (P1): this guards an unconditional exclusion, not
    // a best-effort estimate — silently returning "not disabled" on a DB
    // hiccup would let exactly the disabled source it couldn't verify
    // slip through. Contrast: a source simply not being FOUND (tested
    // above) is a legitimate "nothing to exclude on" outcome, not an error.
    const poisoned = { executeRaw: async () => { throw new Error('boom'); } } as unknown as BrainEngine;
    await expect(isSyncDisabledForSource(poisoned, 'anything')).rejects.toThrow('boom');
  });
});

// ─── performSync choke point ────────────────────────────────────────────────

describe('performSync — SyncDisabledError choke point', () => {
  test('a disabled source refuses with SyncDisabledError naming the sourceId', async () => {
    await withEnv({ GBRAIN_HOME: emptyHome() }, async () => {
      const repo = makeGitRepo();
      await insertSource('perfdis', repo, { syncEnabled: false });
      let caught: unknown;
      try {
        await performSync(engine, { repoPath: repo, sourceId: 'perfdis', noPull: true });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(SyncDisabledError);
      expect((caught as SyncDisabledError).sourceId).toBe('perfdis');
      expect((caught as SyncDisabledError).message).toContain('perfdis');
      expect((caught as SyncDisabledError).message).toContain('syncEnabled=false');
    });
  }, 30_000);

  test('skipLock does NOT bypass the disabled check (no special-case escape hatch)', async () => {
    await withEnv({ GBRAIN_HOME: emptyHome() }, async () => {
      const repo = makeGitRepo();
      await insertSource('perfdisskip', repo, { syncEnabled: false });
      let caught: unknown;
      try {
        await performSync(engine, { repoPath: repo, sourceId: 'perfdisskip', noPull: true, skipLock: true });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(SyncDisabledError);
    });
  }, 30_000);

  test('an enabled source syncs normally (no false-positive refusal)', async () => {
    await withEnv({ GBRAIN_HOME: emptyHome() }, async () => {
      const repo = makeGitRepo();
      await insertSource('perfok', repo, { syncEnabled: true });
      const result = await performSync(engine, {
        repoPath: repo, sourceId: 'perfok', noPull: true, noEmbed: true, noExtract: true,
      });
      expect(result.status).not.toBe('blocked_by_failures');
    });
  }, 30_000);

  test('a source with no syncEnabled key syncs normally (absent ≠ disabled)', async () => {
    await withEnv({ GBRAIN_HOME: emptyHome() }, async () => {
      const repo = makeGitRepo();
      await insertSource('perfunset', repo, {});
      const result = await performSync(engine, {
        repoPath: repo, sourceId: 'perfunset', noPull: true, noEmbed: true, noExtract: true,
      });
      expect(result.status).not.toBe('blocked_by_failures');
    });
  }, 30_000);

  test('no sourceId, "default" row exists but is not disabled: resolves to DEFAULT_SOURCE_ID and proceeds', async () => {
    await withEnv({ GBRAIN_HOME: emptyHome() }, async () => {
      const repo = makeGitRepo();
      // resetPgliteState() always re-seeds a 'default' row (config:
      // {federated:true}, no syncEnabled key) — every brain has one from
      // initSchema(). The choke point resolves opts.sourceId ?? 'default',
      // finds this row, sees syncEnabled unset (not false), and proceeds.
      const result = await performSync(engine, { repoPath: repo, noPull: true, noEmbed: true, noExtract: true });
      expect(result.status).not.toBe('blocked_by_failures');
    });
  }, 30_000);

  test('no sourceId AND no "default" row at all: fetchSource finds nothing, proceeds (pre-v0.17 global-config path)', async () => {
    await withEnv({ GBRAIN_HOME: emptyHome() }, async () => {
      const repo = makeGitRepo();
      // Explicitly remove the row resetPgliteState() seeds, so
      // DEFAULT_SOURCE_ID truly resolves to nothing — the choke point must
      // not require a resolvable row to decide "not disabled".
      await engine.executeRaw(`DELETE FROM sources WHERE id = 'default'`);
      const result = await performSync(engine, { repoPath: repo, noPull: true, noEmbed: true, noExtract: true });
      expect(result.status).not.toBe('blocked_by_failures');
    });
  }, 30_000);

  test('#4399 review finding: no explicit sourceId but a disabled "default" row exists → still refused', async () => {
    await withEnv({ GBRAIN_HOME: emptyHome() }, async () => {
      const repo = makeGitRepo();
      // Codex review (P1): every other write path in sync.ts falls back to
      // DEFAULT_SOURCE_ID ('default') when opts.sourceId is omitted — an
      // omitted sourceId is NOT the same as "no source", it's an implicit
      // 'default'. A bare `gbrain sync` / a minion job with neither
      // sourceId nor a resolvable repoPath->sourceId still writes pages
      // under source_id='default', so a disabled 'default' row must be
      // honored here too, not just when the caller names it explicitly.
      await insertSource('default', repo, { syncEnabled: false });
      let caught: unknown;
      try {
        await performSync(engine, { repoPath: repo, noPull: true, noEmbed: true, noExtract: true });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(SyncDisabledError);
      expect((caught as SyncDisabledError).sourceId).toBe('default');
    });
  }, 30_000);
});

// ─── Minion 'sync' job handler classification ──────────────────────────────

const TERMINAL = new Set(['completed', 'failed', 'dead', 'cancelled']);

async function waitForTerminal(queue: MinionQueue, id: number, timeoutMs = 45_000): Promise<MinionJob> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const job = await queue.getJob(id);
    if (job && TERMINAL.has(job.status)) return job;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`job ${id} did not reach a terminal state within ${timeoutMs}ms`);
}

async function runJobToTerminal(job: MinionJob, queue: MinionQueue): Promise<MinionJob> {
  const worker = new MinionWorker(engine, { pollInterval: 50 });
  await registerBuiltinHandlers(worker, engine, { quiet: true });
  const workerPromise = worker.start();
  try {
    return await waitForTerminal(queue, job.id);
  } finally {
    worker.stop();
    await workerPromise;
  }
}

describe('minion sync handler — SyncDisabledError is skipped, not failed', () => {
  test('disabled source → job completes with { skipped: true, reason: "sync_disabled" }', async () => {
    await withEnv({ GBRAIN_HOME: emptyHome() }, async () => {
      const repo = makeGitRepo();
      await insertSource('jobdis', repo, { syncEnabled: false });
      const queue = new MinionQueue(engine);
      const job = await queue.add(
        'sync',
        { repoPath: repo, sourceId: 'jobdis', pull: false },
        { max_attempts: 1 },
      );
      const terminal = await runJobToTerminal(job, queue);

      expect(terminal.status).toBe('completed');
      expect(terminal.result).toEqual({
        skipped: true,
        reason: 'sync_disabled',
        source_id: 'jobdis',
      });
      expect(terminal.error_text ?? null).toBeNull();
    });
  }, 90_000);

  test('red control: an enabled source with the SAME shape still runs (and does not report sync_disabled)', async () => {
    await withEnv({ GBRAIN_HOME: emptyHome() }, async () => {
      const repo = makeGitRepo();
      await insertSource('jobok', repo, { syncEnabled: true });
      const queue = new MinionQueue(engine);
      const job = await queue.add(
        'sync',
        { repoPath: repo, sourceId: 'jobok', pull: false, noEmbed: true, noExtract: true },
        { max_attempts: 1 },
      );
      const terminal = await runJobToTerminal(job, queue);

      expect(terminal.status).toBe('completed');
      expect(terminal.result).not.toMatchObject({ reason: 'sync_disabled' });
    });
  }, 90_000);
});

// ─── cycle sync phase classification (src/core/cycle.ts runPhaseSync) ─────
// Codex review finding (P2): the standalone jobs handler above does not
// cover the dream/autopilot-cycle path — runPhaseSync has its own catch
// that only recognized SyncLockBusyError pre-fix, so a disabled source
// made a sync-only cycle report 'fail' forever. runPhaseSync is
// module-private; the real seam (same pattern as
// test/sync-lock-busy-classification.test.ts) is runCycle with
// phases: ['sync'] against the real performSync.

describe('cycle sync phase — SyncDisabledError is a skip, not a phase failure', () => {
  test('disabled source → phase skipped with details.syncStatus sync_disabled (cycle not failed)', async () => {
    await withEnv({ GBRAIN_HOME: emptyHome() }, async () => {
      const { runCycle } = await import('../src/core/cycle.ts');
      const brainDir = makeGitRepo();
      await insertSource('cycledis', brainDir, { syncEnabled: false });
      const report = await runCycle(engine, { brainDir, phases: ['sync'] });
      const sync = report.phases.find((p) => p.phase === 'sync');
      expect(sync).toBeDefined();
      expect(sync!.status).toBe('skipped');
      expect(sync!.details.syncStatus).toBe('sync_disabled');
      expect(sync!.error).toBeUndefined();
      expect(report.status).not.toBe('failed');
    });
  }, 90_000);
});
