/**
 * checkStaleLocks — live-holder exclusion.
 *
 * `checkStaleLocks` (src/commands/doctor.ts) previously reported every row
 * from `listStaleLocks` (ttl_expires_at < NOW()) as stale, with a
 * `--break-lock` hint. That ignores the heartbeat-aware liveness signal
 * `isLockHolderLive` (src/core/db-lock.ts, v0.42.x #1794) already computes
 * for the exact same table: a holder whose `last_refreshed_at` is within
 * the steal-grace window is still alive even though its TTL lapsed (a
 * starved-but-alive holder, e.g. a CPU-bound long-running dream cycle).
 * Warning on those and recommending `--break-lock` invites the user to
 * steal a lock out from under live, in-progress work.
 *
 * These tests insert `gbrain_cycle_locks` rows directly (mirroring
 * test/db-lock-inspect.test.ts's pattern) to control both `ttl_expires_at`
 * and `last_refreshed_at` independently, then assert:
 *   - a TTL-expired row with a recent heartbeat is NOT warned on (live holder)
 *   - a TTL-expired row with a stale/absent heartbeat IS warned on (dead holder)
 *   - mixed live + dead rows: only the dead one appears in the warn message
 *   - a row from a non-default-TTL lock class (e.g. the cycle lock's real
 *     5-minute TTL, not isLockHolderLive's implicit 30-minute default) is
 *     still correctly classified — checkStaleLocks derives each row's own
 *     ttlMinutes from `ttl_expires_at - last_refreshed_at` rather than
 *     assuming the default, since this table holds many lock classes with
 *     different TTLs
 *   - a migration-v98-backfill-shaped row (small `ttl_expires_at -
 *     last_refreshed_at` gap that does NOT reflect the row's real TTL —
 *     see migrate.ts version 98's BACKFILL POLICY) falls back to the
 *     default grace instead of being misread as a genuinely-short-TTL lock
 *
 * `GBRAIN_LOCK_STEAL_GRACE_SECONDS` is cleared for the whole suite so a
 * value leaking in from the shell environment can't change which branch
 * (derived vs. default vs. migration-guard) a test actually exercises.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';
import { checkStaleLocks } from '../src/commands/doctor.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

describe('checkStaleLocks — live-holder exclusion', () => {
  async function checkStaleLocksHermetic(...args: Parameters<typeof checkStaleLocks>) {
    return withEnv({ GBRAIN_LOCK_STEAL_GRACE_SECONDS: undefined }, () => checkStaleLocks(...args));
  }

  test('TTL-expired but recently-heartbeating holder is NOT flagged as stale', async () => {
    // ttl_expires_at is 5 minutes in the past (TTL lapsed) but
    // last_refreshed_at is 1 minute ago — well inside the default
    // 600s steal-grace window, so isLockHolderLive should read this as alive.
    await (engine as any).db.query(
      `INSERT INTO gbrain_cycle_locks (id, holder_pid, holder_host, acquired_at, ttl_expires_at, last_refreshed_at)
       VALUES ($1, $2, $3, NOW() - INTERVAL '40 minutes', NOW() - INTERVAL '5 minutes', NOW() - INTERVAL '1 minute')`,
      ['gbrain-cycle', 42424, 'live-host'],
    );

    const check = await checkStaleLocksHermetic(engine);
    expect(check.name).toBe('stale_locks');
    expect(check.status).toBe('ok');
    expect(check.message).not.toContain('break-lock');
    expect(check.message).not.toContain('gbrain-cycle (pid');
    expect(check.message.toLowerCase()).toContain('heartbeat');
  });

  test('genuinely dead holder (heartbeat past the steal-grace window) IS flagged', async () => {
    // ttl_expires_at lapsed AND last_refreshed_at is 20 minutes ago — past
    // the default 600s (10min) steal grace, so isLockHolderLive reads dead.
    await (engine as any).db.query(
      `INSERT INTO gbrain_cycle_locks (id, holder_pid, holder_host, acquired_at, ttl_expires_at, last_refreshed_at)
       VALUES ($1, $2, $3, NOW() - INTERVAL '2 hours', NOW() - INTERVAL '1 hour', NOW() - INTERVAL '20 minutes')`,
      ['gbrain-sync:dead-source', 55555, 'dead-host'],
    );

    const check = await checkStaleLocksHermetic(engine);
    expect(check.name).toBe('stale_locks');
    expect(check.status).toBe('warn');
    expect(check.message).toContain('gbrain-sync:dead-source');
    expect(check.message).toContain('gbrain sync --break-lock --source dead-source');
  });

  test('non-default-TTL lock class (5min cycle TTL) is classified using its OWN ttl, not the 30min default', async () => {
    // The cycle lock's real TTL is 5 minutes (src/core/cycle.ts
    // LOCK_TTL_MINUTES), not isLockHolderLive's implicit 30-minute default.
    // Respect the invariant tryAcquireDbLock/refresh() always maintain:
    // ttl_expires_at = last_refreshed_at + ttlMinutes. Here last_refreshed_at
    // is 301s ago and ttl_expires_at = last_refreshed_at + 5min, i.e. TTL
    // lapsed 1 second ago.
    //   - correct grace for ttlMinutes=5 is 100s → 301s > 100s → DEAD (must warn)
    //   - the WRONG 30min-default grace is 600s → 301s < 600s → would read LIVE
    // If checkStaleLocks fell back to isLockHolderLive's bare default instead
    // of deriving this row's real ttlMinutes, it would misclassify this
    // genuinely-dead cycle lock as live and fail to warn on it.
    await (engine as any).db.query(
      `INSERT INTO gbrain_cycle_locks (id, holder_pid, holder_host, acquired_at, ttl_expires_at, last_refreshed_at)
       VALUES ($1, $2, $3, NOW() - INTERVAL '1 hour', NOW() - INTERVAL '1 seconds', NOW() - INTERVAL '301 seconds')`,
      ['gbrain-cycle', 77777, 'dead-cycle-host'],
    );

    const check = await checkStaleLocksHermetic(engine);
    expect(check.status).toBe('warn');
    expect(check.message).toContain('gbrain-cycle (pid 77777');
    expect(check.message).toContain('gbrain dream --break-lock');
  });

  test('migration-v98-backfill-shaped gap does NOT get misread as the row\'s real TTL', async () => {
    // Migration v98 (src/core/migrate.ts, version 98) backfills
    // last_refreshed_at = NOW() at MIGRATION time, without touching
    // ttl_expires_at. A pre-existing 60-minute-class lock (e.g.
    // embed-backfill/skillopt) whose old ttl_expires_at happened to be
    // close to lapsing right when the migration ran can, right after that
    // migration, show a tiny `ttl_expires_at - last_refreshed_at` gap that
    // has nothing to do with its real ~60min TTL. Simulate that shape here:
    // last_refreshed_at 90s ago (the backfill), ttl_expires_at 65s ago (its
    // old TTL, untouched, already lapsed) — a 25s gap, well under the
    // HOLDER_TAKEOVER_GRACE_MS (60s) floor.
    //   - naive derivation (no floor) would infer ttlMinutes≈0.4 → grace≈60s
    //     (floored by resolveStealGraceSeconds itself) → ms_since_refresh
    //     (90s) > 60s → misread as DEAD → would recommend --break-lock on a
    //     holder that might still be genuinely alive under its real 60min
    //     TTL — the exact false-positive class this whole check exists to
    //     avoid, just reintroduced via a bad TTL guess instead of a bare
    //     default.
    //   - the migration guard refuses to trust a sub-floor gap and falls
    //     back to the 30min default instead (grace=600s), so the 90s-old
    //     heartbeat correctly reads LIVE — not flagged.
    await (engine as any).db.query(
      `INSERT INTO gbrain_cycle_locks (id, holder_pid, holder_host, acquired_at, ttl_expires_at, last_refreshed_at)
       VALUES ($1, $2, $3, NOW() - INTERVAL '1 hour', NOW() - INTERVAL '65 seconds', NOW() - INTERVAL '90 seconds')`,
      ['gbrain-embed-backfill:default', 88888, 'migrated-host'],
    );

    const check = await checkStaleLocksHermetic(engine);
    expect(check.status).toBe('ok');
    expect(check.message).not.toContain('break-lock');
    expect(check.message).not.toContain('gbrain-embed-backfill:default (pid');
  });

  test('dead holder with NULL last_refreshed_at (pre-v98 row) IS flagged', async () => {
    // Pre-v98 brains may have rows with no last_refreshed_at at all.
    // isLockHolderLive treats null heartbeat as dead once TTL has expired.
    await (engine as any).db.query(
      `INSERT INTO gbrain_cycle_locks (id, holder_pid, holder_host, acquired_at, ttl_expires_at)
       VALUES ($1, $2, $3, NOW() - INTERVAL '2 hours', NOW() - INTERVAL '1 hour')`,
      ['gbrain-sync:no-heartbeat', 66666, 'old-host'],
    );

    const check = await checkStaleLocksHermetic(engine);
    expect(check.status).toBe('warn');
    expect(check.message).toContain('gbrain-sync:no-heartbeat');
  });

  test('mixed: live holder is excluded, dead holder is warned on, in the same run', async () => {
    await (engine as any).db.query(
      `INSERT INTO gbrain_cycle_locks (id, holder_pid, holder_host, acquired_at, ttl_expires_at, last_refreshed_at)
       VALUES ($1, $2, $3, NOW() - INTERVAL '40 minutes', NOW() - INTERVAL '5 minutes', NOW() - INTERVAL '1 minute')`,
      ['gbrain-cycle:live-source', 11111, 'live-host'],
    );
    await (engine as any).db.query(
      `INSERT INTO gbrain_cycle_locks (id, holder_pid, holder_host, acquired_at, ttl_expires_at, last_refreshed_at)
       VALUES ($1, $2, $3, NOW() - INTERVAL '2 hours', NOW() - INTERVAL '1 hour', NOW() - INTERVAL '20 minutes')`,
      ['gbrain-cycle:dead-source', 22222, 'dead-host'],
    );

    const check = await checkStaleLocksHermetic(engine);
    expect(check.status).toBe('warn');
    // The dead one is named with a break-lock hint.
    expect(check.message).toContain('gbrain-cycle:dead-source');
    expect(check.message).toContain('gbrain dream --break-lock --source dead-source');
    // The live one is NOT named as a stale lock line, but its exclusion is
    // surfaced as an informational count.
    expect(check.message).not.toContain('gbrain-cycle:live-source (pid');
    expect(check.message.toLowerCase()).toContain('1 lock(s) past ttl');
  });

  test('no rows at all → ok, unchanged baseline message', async () => {
    const check = await checkStaleLocksHermetic(engine);
    expect(check.status).toBe('ok');
    expect(check.message).toContain('No stale locks');
  });
});
