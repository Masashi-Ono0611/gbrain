import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, readlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { acquireLock, releaseLock, peekLock, isPidReusedByOtherProgram, recordedArgvProvesPidReuse, type LockHandle } from '../src/core/pglite-lock';

const TEST_DIR = join(tmpdir(), 'gbrain-lock-test-' + process.pid);

describe('pglite-lock', () => {
  beforeEach(() => {
    // Clean up test directory
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  });

  test('acquires and releases lock', async () => {
    const lock = await acquireLock(TEST_DIR);
    expect(lock.acquired).toBe(true);
    const record = JSON.parse(readFileSync(join(TEST_DIR, '.gbrain-lock', 'lock'), 'utf-8'));
    expect(record.argv).toEqual(process.argv.slice(1));
    expect(record.command).toBe(process.argv.slice(1).join(' '));
    expect(existsSync(join(TEST_DIR, '.gbrain-lock'))).toBe(true);

    await releaseLock(lock);
    expect(existsSync(join(TEST_DIR, '.gbrain-lock'))).toBe(false);
  });

  test('creates missing data directory before acquiring lock', async () => {
    const missingDataDir = join(TEST_DIR, 'missing-data-dir');

    const lock = await acquireLock(missingDataDir);
    expect(lock.acquired).toBe(true);
    expect(existsSync(missingDataDir)).toBe(true);
    expect(existsSync(join(missingDataDir, '.gbrain-lock'))).toBe(true);

    await releaseLock(lock);
    expect(existsSync(join(missingDataDir, '.gbrain-lock'))).toBe(false);
  });

  test('prevents concurrent lock acquisition', async () => {
    const lock1 = await acquireLock(TEST_DIR, { timeoutMs: 2000 });
    expect(lock1.acquired).toBe(true);

    // Second lock attempt should timeout
    await expect(acquireLock(TEST_DIR, { timeoutMs: 1000 })).rejects.toThrow(/Timed out/);

    await releaseLock(lock1);
  });

  test('detects and cleans stale lock from dead process', async () => {
    // Simulate a stale lock from a dead process
    const lockDir = join(TEST_DIR, '.gbrain-lock');
    mkdirSync(lockDir);
    writeFileSync(join(lockDir, 'lock'), JSON.stringify({
      pid: 999999999, // Non-existent PID
      acquired_at: Date.now(),
      command: 'test',
    }));

    // Should clean up the stale lock and acquire
    const lock = await acquireLock(TEST_DIR);
    expect(lock.acquired).toBe(true);

    await releaseLock(lock);
  });

  test('skips lock for in-memory (undefined dataDir)', async () => {
    const lock = await acquireLock(undefined);
    expect(lock.acquired).toBe(true);
    expect(lock.lockDir).toBe('');

    // Release should be a no-op
    await releaseLock(lock);
  });

  test('lock file contains PID and command', async () => {
    const lock = await acquireLock(TEST_DIR);
    const lockData = JSON.parse(readFileSync(join(TEST_DIR, '.gbrain-lock', 'lock'), 'utf-8'));

    expect(lockData.pid).toBe(process.pid);
    expect(lockData.acquired_at).toBeDefined();
    expect(lockData.command).toBeDefined();

    await releaseLock(lock);
  });

  test('releases lock on disconnect even if DB close fails', async () => {
    const lock = await acquireLock(TEST_DIR);
    expect(lock.acquired).toBe(true);

    // Simulate DB already closed
    await releaseLock(lock);
    expect(existsSync(join(TEST_DIR, '.gbrain-lock'))).toBe(false);

    // Second acquisition should work
    const lock2 = await acquireLock(TEST_DIR);
    expect(lock2.acquired).toBe(true);
    await releaseLock(lock2);
  });
});

describe('pglite-lock #2058 heartbeat + steal-grace', () => {
  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
  });
  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  });

  function writeHolder(fields: {
    pid: number;
    acquiredAgoMs: number;
    refreshedAgoMs: number;
    command?: string;
    subcommand?: string;
  }) {
    const lockDir = join(TEST_DIR, '.gbrain-lock');
    mkdirSync(lockDir, { recursive: true });
    const now = Date.now();
    writeFileSync(join(lockDir, 'lock'), JSON.stringify({
      pid: fields.pid,
      acquired_at: now - fields.acquiredAgoMs,
      refreshed_at: now - fields.refreshedAgoMs,
      command: fields.command ?? 'test holder',
      ...(fields.subcommand === undefined ? {} : { subcommand: fields.subcommand }),
    }));
  }

  test('a live gbrain serve owner with global flags fails fast with a clear explanation', async () => {
    writeHolder({
      pid: process.pid,
      acquiredAgoMs: 60_000,
      refreshedAgoMs: 0,
      command: '/path with spaces/gbrain/src/cli.ts --quiet serve',
      subcommand: 'serve',
    });

    const startedAt = Date.now();
    await expect(acquireLock(TEST_DIR, { timeoutMs: 5_000 })).rejects.toThrow(
      /already open through `gbrain serve`.*`gbrain sync` runs through the live serve automatically.*stop `gbrain serve` and retry.*use its MCP tools instead.*will not remove/s,
    );

    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(existsSync(join(TEST_DIR, '.gbrain-lock'))).toBe(true);
  });

  test('legacy serve lock metadata is still recognized', async () => {
    writeHolder({
      pid: process.pid,
      acquiredAgoMs: 60_000,
      refreshedAgoMs: 0,
      command: '/path/to/gbrain/src/cli.ts serve',
    });

    await expect(acquireLock(TEST_DIR, { timeoutMs: 5_000 })).rejects.toThrow(
      /already open through `gbrain serve`/,
    );
    expect(existsSync(join(TEST_DIR, '.gbrain-lock'))).toBe(true);
  });

  test('a search for the word serve is not mistaken for the MCP server', async () => {
    writeHolder({
      pid: process.pid,
      acquiredAgoMs: 60_000,
      refreshedAgoMs: 0,
      command: '/compiled/gbrain search serve',
      subcommand: 'search',
    });

    await expect(acquireLock(TEST_DIR, { timeoutMs: 100 })).rejects.toThrow(/Timed out/);
    expect(existsSync(join(TEST_DIR, '.gbrain-lock'))).toBe(true);
  });

  test('a dead gbrain serve owner is still cleaned up automatically', async () => {
    writeHolder({
      pid: 999999999,
      acquiredAgoMs: 60_000,
      refreshedAgoMs: 0,
      command: '/path/to/gbrain/src/cli.ts serve',
      subcommand: 'serve',
    });

    const lock = await acquireLock(TEST_DIR, { timeoutMs: 2_000 });
    expect(lock.acquired).toBe(true);
    await releaseLock(lock);
  });

  test('[REGRESSION] a LIVE holder with a fresh heartbeat is NOT stolen even when the lock is old', async () => {
    // The WAL-corruption bug: a >5min embed used to get its lock force-removed.
    // Now an alive holder that heartbeated recently is left alone regardless of
    // age. acquired 20min ago, but refreshed just now → must wait, not steal.
    writeHolder({ pid: process.pid, acquiredAgoMs: 20 * 60_000, refreshedAgoMs: 0 });

    await expect(acquireLock(TEST_DIR, { timeoutMs: 1200 })).rejects.toThrow(/Timed out/);
    // Holder's lock still present (was never stolen).
    expect(existsSync(join(TEST_DIR, '.gbrain-lock'))).toBe(true);
  });

  test('[REGRESSION #2348] a LIVE PID with a STALE heartbeat is NOT stolen', async () => {
    // The #2348 corruption: a live `gbrain dream`/embed holder whose heartbeat
    // lapsed (the JS event loop is blocked during a long synchronous WASM
    // import) used to get its lock reaped past the grace window — letting a
    // second OS process open the same data dir and corrupt the catalog +
    // pgvector extension state. A live PID is now NEVER stolen, regardless of
    // how stale its heartbeat is. Acquire must time out, not steal.
    writeHolder({ pid: process.pid, acquiredAgoMs: 25 * 60_000, refreshedAgoMs: 20 * 60_000 });

    await expect(acquireLock(TEST_DIR, { timeoutMs: 1200 })).rejects.toThrow(/Timed out/);
    // The live holder's lock is still present — never force-removed.
    expect(existsSync(join(TEST_DIR, '.gbrain-lock'))).toBe(true);
  });

  test('explains live gbrain serve contention is not a sync advisory lock', async () => {
    writeHolder({
      pid: process.pid,
      acquiredAgoMs: 60_000,
      refreshedAgoMs: 0,
      command: 'bun /Users/master/.bun/bin/gbrain serve',
    });

    let message = '';
    try {
      await acquireLock(TEST_DIR, { timeoutMs: 100 });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('serve↔sync contention');
    expect(message).toContain('not the `gbrain-sync:*` advisory lock');
    expect(message).toContain('`gbrain sync --break-lock` will not clear a live PGLite holder');
    expect(existsSync(join(TEST_DIR, '.gbrain-lock'))).toBe(true);
  });

  test('[REGRESSION] releaseLock does NOT remove a lock that was stolen + re-acquired by another process', async () => {
    // We acquire, then simulate a steal: another process reaped us past grace
    // and now owns the lock (different pid + acquired_at). Our releaseLock must
    // NOT delete their live lock — doing so would let a third process in
    // alongside the new owner (the #2058 corruption class).
    const lock: LockHandle = await acquireLock(TEST_DIR);
    expect(lock.acquired).toBe(true);
    expect(lock.ownerToken).toBeDefined();
    if (lock.heartbeat) clearInterval(lock.heartbeat); // stop our heartbeat for a deterministic test

    // Overwrite the lock file as if process B re-acquired it.
    const lockFile = join(TEST_DIR, '.gbrain-lock', 'lock');
    const bNow = Date.now() + 1;
    writeFileSync(lockFile, JSON.stringify({ pid: 999999, acquired_at: bNow, refreshed_at: bNow, command: 'process B' }));

    await releaseLock(lock); // our (stale) handle

    // B's lock survives — we did not clobber it.
    expect(existsSync(join(TEST_DIR, '.gbrain-lock'))).toBe(true);
    const after = JSON.parse(readFileSync(lockFile, 'utf-8'));
    expect(after.pid).toBe(999999);

    // Cleanup for afterEach.
    rmSync(join(TEST_DIR, '.gbrain-lock'), { recursive: true, force: true });
  });

  test('acquire starts a heartbeat and seeds refreshed_at; release clears it', async () => {
    const lock: LockHandle = await acquireLock(TEST_DIR);
    expect(lock.acquired).toBe(true);
    expect(lock.heartbeat).toBeDefined();
    const data = JSON.parse(readFileSync(join(TEST_DIR, '.gbrain-lock', 'lock'), 'utf-8'));
    expect(data.refreshed_at).toBeDefined();
    expect(typeof data.refreshed_at).toBe('number');

    await releaseLock(lock);
    expect(lock.heartbeat).toBeUndefined();
    expect(existsSync(join(TEST_DIR, '.gbrain-lock'))).toBe(false);
  });
});

describe('pglite-lock reap classification (WAL-repair wave)', () => {
  // Unique per-test tmpdirs: the reap marker lands at `${dataDir}.lock-reap.json`
  // — a SIBLING of the data dir — so each test gets its own parent to rm.
  function freshDataDir(): { parent: string; dataDir: string } {
    const parent = mkdtempSync(join(tmpdir(), 'gbrain-lock-reap-'));
    return { parent, dataDir: join(parent, 'data') };
  }

  /**
   * A PID that provably belongs to no live process: spawn a short-lived child,
   * wait for it (spawnSync reaps it), then verify kill(pid, 0) throws. Retries
   * to dodge instant PID reuse.
   */
  function deadPid(): number {
    for (let attempt = 0; attempt < 5; attempt++) {
      const proc = Bun.spawnSync(['bash', '-c', 'exit 0']);
      const pid = proc.pid;
      try {
        process.kill(pid, 0); // still alive/visible → PID reused, try again
      } catch {
        return pid;
      }
    }
    throw new Error('could not obtain a provably-dead PID after 5 spawns');
  }

  test('corrupt lock file: reaped acquisition + persisted .lock-reap.json marker', async () => {
    const { parent, dataDir } = freshDataDir();
    try {
      const lockDir = join(dataDir, '.gbrain-lock');
      mkdirSync(lockDir, { recursive: true });
      writeFileSync(join(lockDir, 'lock'), 'not json {{{'); // holder liveness UNKNOWABLE

      const lock = await acquireLock(dataDir, { timeoutMs: 5000 });
      try {
        expect(lock.acquired).toBe(true);
        expect(lock.reaped).toBe(true);
        // Unknowable-liveness reap is persisted cross-process for the repair gate.
        expect(existsSync(`${dataDir}.lock-reap.json`)).toBe(true);
        const marker = JSON.parse(readFileSync(`${dataDir}.lock-reap.json`, 'utf-8'));
        expect(typeof marker.ts).toBe('number');
        expect(marker.by).toBe(process.pid);
      } finally {
        await releaseLock(lock);
      }
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test('clean acquisition: reaped falsy, no .lock-reap.json marker', async () => {
    const { parent, dataDir } = freshDataDir();
    try {
      const lock = await acquireLock(dataDir, { timeoutMs: 5000 });
      try {
        expect(lock.acquired).toBe(true);
        expect(lock.reaped).toBeFalsy();
        expect(existsSync(`${dataDir}.lock-reap.json`)).toBe(false);
      } finally {
        await releaseLock(lock);
      }
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test('dead-PID lock: reaped acquisition but NO marker (affirmative ESRCH verdict)', async () => {
    const { parent, dataDir } = freshDataDir();
    try {
      const lockDir = join(dataDir, '.gbrain-lock');
      mkdirSync(lockDir, { recursive: true });
      const now = Date.now();
      writeFileSync(join(lockDir, 'lock'), JSON.stringify({
        pid: deadPid(),
        acquired_at: now - 60_000,
        refreshed_at: now - 60_000,
        command: 'gbrain embed',
        subcommand: 'embed',
      }));

      const lock = await acquireLock(dataDir, { timeoutMs: 5000 });
      try {
        expect(lock.acquired).toBe(true);
        expect(lock.reaped).toBe(true);
        // Dead-PID reaps deliberately do NOT quarantine the next acquirer.
        expect(existsSync(`${dataDir}.lock-reap.json`)).toBe(false);
      } finally {
        await releaseLock(lock);
      }
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  }, 30_000);
});

describe('pglite-lock peekLock (pure read, no side effects)', () => {
  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  });

  test('no lock dir → not held, and never creates one', () => {
    const result = peekLock(TEST_DIR);
    expect(result.held).toBe(false);
    expect(existsSync(join(TEST_DIR, '.gbrain-lock'))).toBe(false);
  });

  test('a lock file that parses but has no usable pid reads as HELD (unprovable ≠ free, #2348)', () => {
    // Erring the other way corrupted catalogs: a holder whose liveness cannot
    // be proven must be treated as alive. This branch currently rides on
    // isProcessAlive's invalid-pid handling — pinned here so a future cleanup
    // of that function cannot silently flip peekLock to not-held.
    const lockDir = join(TEST_DIR, '.gbrain-lock');
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(join(lockDir, 'lock'), JSON.stringify({ acquired_at: 123, command: 'gbrain serve', subcommand: 'serve' }));
    const result = peekLock(TEST_DIR);
    expect(result.held).toBe(true);
    expect(result.pid).toBeUndefined();
  });

  test('live holder, serve subcommand → held, isServe true, pid reported', async () => {
    const lock = await acquireLock(TEST_DIR);
    try {
      const lockPath = join(TEST_DIR, '.gbrain-lock', 'lock');
      const raw = JSON.parse(readFileSync(lockPath, 'utf-8'));
      writeFileSync(lockPath, JSON.stringify({ ...raw, subcommand: 'serve' }));

      const result = peekLock(TEST_DIR);
      expect(result.held).toBe(true);
      expect(result.isServe).toBe(true);
      expect(result.pid).toBe(process.pid);
    } finally {
      await releaseLock(lock);
    }
  });

  test('live holder, non-serve subcommand → held, isServe false', async () => {
    const lock = await acquireLock(TEST_DIR);
    try {
      const result = peekLock(TEST_DIR);
      expect(result.held).toBe(true);
      expect(result.isServe).toBe(false);
    } finally {
      await releaseLock(lock);
    }
  });

  test('dead-pid holder → not held', () => {
    const lockDir = join(TEST_DIR, '.gbrain-lock');
    mkdirSync(lockDir, { recursive: true });
    // PID 999999 is essentially guaranteed not to be a live process.
    writeFileSync(
      join(lockDir, 'lock'),
      JSON.stringify({ pid: 999999, acquired_at: Date.now(), command: 'gbrain serve', subcommand: 'serve' }),
    );
    const result = peekLock(TEST_DIR);
    expect(result.held).toBe(false);
  });

  test('corrupt lock file → not held (falls through to a real connect attempt)', () => {
    const lockDir = join(TEST_DIR, '.gbrain-lock');
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(join(lockDir, 'lock'), 'not json{{{');
    const result = peekLock(TEST_DIR);
    expect(result.held).toBe(false);
  });

  test('never throws LiveServeLockError, unlike acquireLock', async () => {
    const lock = await acquireLock(TEST_DIR);
    try {
      const lockPath = join(TEST_DIR, '.gbrain-lock', 'lock');
      const raw = JSON.parse(readFileSync(lockPath, 'utf-8'));
      writeFileSync(lockPath, JSON.stringify({ ...raw, subcommand: 'serve' }));
      expect(() => peekLock(TEST_DIR)).not.toThrow();
    } finally {
      await releaseLock(lock);
    }
  });
});

describe('pglite-lock PID-reuse detection', () => {
  // The wedge this covers: a gbrain holder dies, the OS recycles its PID into
  // an unrelated process (docker-proxy, a shell, ...), and kill(pid, 0) keeps
  // saying "alive" — so the stale lock was never reaped and every acquirer
  // timed out until manual cleanup.
  const canProbe = process.platform !== 'win32'; // ps + sleep/bash available
  const isLinux = process.platform === 'linux';

  function currentBootId(): string | null {
    try { return readFileSync('/proc/sys/kernel/random/boot_id', 'utf-8').trim() || null; }
    catch { return null; }
  }

  function currentPidNs(): string | null {
    try { return readlinkSync('/proc/self/ns/pid'); } catch { return null; }
  }

  function writeHolderAt(dataDir: string, pid: number, command: string, opts?: { subcommand?: string; bootId?: string | null; pidNs?: string | null; argv?: unknown }) {
    const lockDir = join(dataDir, '.gbrain-lock');
    mkdirSync(lockDir, { recursive: true });
    const now = Date.now();
    writeFileSync(join(lockDir, 'lock'), JSON.stringify({
      pid,
      acquired_at: now - 60_000,
      refreshed_at: now - 60_000,
      command,
      ...(opts?.argv === undefined ? {} : { argv: opts.argv }),
      boot_id: opts?.bootId === undefined ? currentBootId() : opts.bootId,
      pid_ns: opts?.pidNs === undefined ? currentPidNs() : opts.pidNs,
      ...(opts?.subcommand === undefined ? {} : { subcommand: opts.subcommand }),
    }));
  }

  /**
   * Wait until the spawned child has exec'd into its target program. Between
   * spawn and exec, the child's command line still shows the PARENT's argv —
   * which under the repo test runner contains "gbrain" (the checkout path) and
   * would spoof the reuse check. Poll via `ps` until the real args are in place.
   */
  async function waitForExec(pid: number, pattern: RegExp): Promise<void> {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      try {
        const args = execFileSync('ps', ['-p', String(pid), '-o', 'args='], {
          encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 1000,
        }).trim();
        if (args.length > 0 && pattern.test(args)) return;
      } catch { /* not exec'd yet — retry */ }
      await new Promise(r => setTimeout(r, 25));
    }
    throw new Error(`child ${pid} never exec'd into ${pattern}`);
  }

  for (const scriptPath of ['/home/example/Project Space/src/cli.ts', String.raw`C:\Users\Example Person\project\src\cli.ts`]) {
    test.skipIf(!canProbe)(`structured argv preserves live holder with whitespace path: ${scriptPath}`, async () => {
      const holder = Bun.spawn(['bash', '-c', 'sleep 60; exit 0', 'bun run src/cli.ts serve --http'], { stdout: 'ignore', stderr: 'ignore' });
      try {
        await waitForExec(holder.pid, /cli\.ts/);
        writeHolderAt(TEST_DIR, holder.pid, `${scriptPath} serve --http`, { argv: [scriptPath, 'serve', '--http'] });
        await expect(acquireLock(TEST_DIR, { timeoutMs: 1200 })).rejects.toThrow(/Timed out/);
        expect(JSON.parse(readFileSync(join(TEST_DIR, '.gbrain-lock', 'lock'), 'utf-8')).pid).toBe(holder.pid);
      } finally { holder.kill(); }
    }, 15_000);
  }

  test.skipIf(!canProbe)('structured argv still permits proven unrelated PID reuse', async () => {
    const holder = Bun.spawn(['sleep', '60'], { stdout: 'ignore', stderr: 'ignore' });
    try {
      await waitForExec(holder.pid, /sleep/);
      writeHolderAt(TEST_DIR, holder.pid, '/home/example/Project Space/src/cli.ts serve', { argv: ['/home/example/Project Space/src/cli.ts', 'serve'] });
      const lock = await acquireLock(TEST_DIR, { timeoutMs: 5000 });
      try { expect(lock.reaped).toBe(true); } finally { await releaseLock(lock); }
    } finally { holder.kill(); }
  }, 15_000);

  for (const argv of [null, [], [''], [123], ['/some/script.ts', 123]]) {
    test.skipIf(!canProbe)(`malformed structured argv never proves PID reuse: ${JSON.stringify(argv)}`, async () => {
      const holder = Bun.spawn(['sleep', '60'], { stdout: 'ignore', stderr: 'ignore' });
      try {
        await waitForExec(holder.pid, /sleep/);
        writeHolderAt(TEST_DIR, holder.pid, 'different-script.ts', { argv });
        await expect(acquireLock(TEST_DIR, { timeoutMs: 1200 })).rejects.toThrow(/Timed out/);
      } finally { holder.kill(); }
    }, 15_000);
  }

  test.skipIf(!canProbe)('reaps a lock whose PID was recycled by an unrelated program', async () => {
    // `sleep` is a live process that is provably NOT the gbrain holder.
    const squatter = Bun.spawn(['sleep', '60'], { stdout: 'ignore', stderr: 'ignore' });
    try {
      await waitForExec(squatter.pid, /sleep/);
      writeHolderAt(TEST_DIR, squatter.pid, '/home/user/.bun/bin/gbrain serve --http', { subcommand: 'serve' });

      const lock = await acquireLock(TEST_DIR, { timeoutMs: 5000 });
      try {
        expect(lock.acquired).toBe(true);
        expect(lock.reaped).toBe(true);
      } finally {
        await releaseLock(lock);
      }
    } finally {
      squatter.kill();
    }
  }, 15_000);

  test.skipIf(!canProbe)('does NOT reap a live process whose cmdline identifies it as gbrain', async () => {
    // The gbrain marker rides in a REAL argv slot (bash's $0), simulating a
    // live holder without running gbrain itself. Not `exec -a` argv[0]
    // spoofing: on hosts where coreutils is a multicall binary behind shebang
    // wrappers (e.g. sandbox images), the kernel's shebang rewrite destroys
    // the spoofed argv[0]. The compound command keeps bash from exec-replacing
    // itself, so its argv (and the marker) stays visible for the test's life.
    const holder = Bun.spawn(['bash', '-c', 'sleep 60; exit 0', 'gbrain-fake-holder'], { stdout: 'ignore', stderr: 'ignore' });
    try {
      await waitForExec(holder.pid, /gbrain-fake-holder/);
      writeHolderAt(TEST_DIR, holder.pid, 'gbrain-fake-holder embed', { subcommand: 'embed' });

      await expect(acquireLock(TEST_DIR, { timeoutMs: 1200 })).rejects.toThrow(/Timed out/);
      // Live holder's lock was never stolen.
      expect(existsSync(join(TEST_DIR, '.gbrain-lock'))).toBe(true);
    } finally {
      holder.kill();
    }
  }, 15_000);

  test.skipIf(!canProbe)('does NOT reap a live holder whose recorded command is an absolute path but whose cmdline shows the relative bun-run form', async () => {
    // False-steal regression (caught by the harness-lifecycle E2E): a serve
    // spawned as `bun run src/cli.ts serve …` reports a RELATIVE cmdline via
    // ps, while its lock records Bun's ABSOLUTE argv[1]. The literal
    // includes(firstToken) veto never matches and, when the checkout path
    // carries no 'gbrain' substring, the live holder was classified as a
    // recycled PID and its lock stolen — the thief then wrote to a second
    // PGLite instance the live serve never sees. The basename veto
    // ('cli.ts' appears in the cmdline) must keep the holder alive.
    const holder = Bun.spawn(['bash', '-c', 'sleep 60; exit 0', 'bun run src/cli.ts serve --http'], { stdout: 'ignore', stderr: 'ignore' });
    try {
      await waitForExec(holder.pid, /cli\.ts/);
      writeHolderAt(TEST_DIR, holder.pid, '/home/user/checkouts/brain-project/src/cli.ts serve --http', { subcommand: 'serve' });

      await expect(acquireLock(TEST_DIR, { timeoutMs: 1200 })).rejects.toThrow(/already open through `gbrain serve`/);
      expect(existsSync(join(TEST_DIR, '.gbrain-lock'))).toBe(true);
    } finally {
      holder.kill();
    }
  }, 15_000);

  test.skipIf(!isLinux)('does NOT reap on cmdline evidence when the lock belongs to another PID namespace', async () => {
    // #2840 class: a holder in another container shares the data dir; its
    // recorded PID maps to an unrelated process in OUR namespace. The pid_ns
    // mismatch must veto the reap even though the cmdline clearly differs.
    const squatter = Bun.spawn(['sleep', '60'], { stdout: 'ignore', stderr: 'ignore' });
    try {
      await waitForExec(squatter.pid, /sleep/);
      writeHolderAt(TEST_DIR, squatter.pid, '/home/user/.bun/bin/gbrain serve --http', { subcommand: 'serve', pidNs: 'pid:[1]' });

      await expect(acquireLock(TEST_DIR, { timeoutMs: 1200 })).rejects.toThrow(/already open through `gbrain serve`/);
      expect(existsSync(join(TEST_DIR, '.gbrain-lock'))).toBe(true);
    } finally {
      squatter.kill();
    }
  }, 15_000);

  test.skipIf(!isLinux)('never cmdline-reaps a LEGACY lock without namespace markers (fail-safe)', async () => {
    // Pre-marker locks carry no pid_ns: their recorded PID may belong to a
    // different namespace, so a cmdline mismatch proves nothing. ESRCH reaps
    // still apply; cmdline reaps must not.
    const squatter = Bun.spawn(['sleep', '60'], { stdout: 'ignore', stderr: 'ignore' });
    try {
      await waitForExec(squatter.pid, /sleep/);
      writeHolderAt(TEST_DIR, squatter.pid, '/home/user/.bun/bin/gbrain serve --http', { subcommand: 'serve', pidNs: null, bootId: null });

      await expect(acquireLock(TEST_DIR, { timeoutMs: 1200 })).rejects.toThrow(/already open through `gbrain serve`/);
      expect(existsSync(join(TEST_DIR, '.gbrain-lock'))).toBe(true);
    } finally {
      squatter.kill();
    }
  }, 15_000);

  test.skipIf(!isLinux)('never cmdline-reaps when boot_id is missing even if pid_ns matches (cross-host guard)', async () => {
    // pid_ns inode numbers can collide across hosts sharing a data dir, so on
    // Linux BOTH markers must be present and matching before cmdline evidence
    // is trusted.
    const squatter = Bun.spawn(['sleep', '60'], { stdout: 'ignore', stderr: 'ignore' });
    try {
      await waitForExec(squatter.pid, /sleep/);
      writeHolderAt(TEST_DIR, squatter.pid, '/home/user/.bun/bin/gbrain serve --http', { subcommand: 'serve', bootId: null });

      await expect(acquireLock(TEST_DIR, { timeoutMs: 1200 })).rejects.toThrow(/already open through `gbrain serve`/);
      expect(existsSync(join(TEST_DIR, '.gbrain-lock'))).toBe(true);
    } finally {
      squatter.kill();
    }
  }, 15_000);

  test('a lock held by THIS process is never classified as recycled', async () => {
    // Same-process re-acquire: the recorded PID is our own, so the cmdline
    // check must stand down even though `bun test` has no gbrain marker.
    writeHolderAt(TEST_DIR, process.pid, 'test holder');

    await expect(acquireLock(TEST_DIR, { timeoutMs: 1200 })).rejects.toThrow(/Timed out/);
    expect(existsSync(join(TEST_DIR, '.gbrain-lock'))).toBe(true);
  });

  test.skipIf(!canProbe)('concurrent reapers: exactly one reaps, the other never deletes the winner\u2019s fresh lock', async () => {
    // Race regression: two acquirers classify the same recycled-PID victim.
    // Without the atomic rename-aside claim, the slower reaper's rmSync can
    // delete the faster one's freshly installed lock — two writers, one dir.
    const squatter = Bun.spawn(['sleep', '60'], { stdout: 'ignore', stderr: 'ignore' });
    try {
      await waitForExec(squatter.pid, /sleep/);
      writeHolderAt(TEST_DIR, squatter.pid, '/home/user/.bun/bin/gbrain serve --http', { subcommand: 'serve' });

      const results = await Promise.allSettled([
        acquireLock(TEST_DIR, { timeoutMs: 5000 }),
        acquireLock(TEST_DIR, { timeoutMs: 5000 }),
      ]);
      const fulfilled = results.filter(r => r.status === 'fulfilled');
      const rejected = results.filter(r => r.status === 'rejected');
      // Exactly one reaps + acquires; the loser must time out against the
      // winner's live lock — never delete it.
      expect(fulfilled.length).toBe(1);
      expect(rejected.length).toBe(1);
      const lockFile = join(TEST_DIR, '.gbrain-lock', 'lock');
      expect(existsSync(lockFile)).toBe(true);
      const onDisk = JSON.parse(readFileSync(lockFile, 'utf-8'));
      expect(onDisk.pid).toBe(process.pid); // the winner's lock survived intact

      await releaseLock((fulfilled[0] as PromiseFulfilledResult<LockHandle>).value);
    } finally {
      squatter.kill();
    }
  }, 15_000);
});

describe('pglite-lock PID-reuse detection — win32 (#4563)', () => {
  // Before this fix, pglite-lock's own command-line probe (`readProcessArgs`)
  // had no win32 branch: it tried `ps` (absent on Windows) then `/proc`
  // (absent on Windows), always landing on `cmdline === null` —
  // "unknowable" — which `isPidReusedByOtherProgram`'s fail-safe reads as
  // "not reused" (alive). A dead gbrain holder whose PID got recycled by an
  // unrelated Windows process therefore NEVER got reaped: the lock wedged
  // until manual cleanup. The fix adds a win32 branch to `readProcessArgs`
  // that delegates to autopilot-lock's shared `readProcessCommand`
  // (Get-CimInstance over powershell, #4563) WITHOUT touching the existing
  // non-Windows `ps`-then-`/proc` order at all — every non-win32 platform
  // keeps its exact prior probe sequence and prior (case-sensitive, `/`-only)
  // token comparison unchanged; only the win32 branch and the win32-scoped
  // comparison hardening below are new. These tests inject `platform:
  // 'win32'` via DI so they exercise the real win32 code path on any host
  // OS, instead of being skipped like the `canProbe`-gated spawn-based tests
  // above (real `ps`/`/proc` don't exist on Windows, so those tests can
  // never run there).
  //
  // Guaranteed distinct from process.pid (the same-process PID short-circuit
  // is a separate branch, tested below) — a hardcoded literal like 4242 could
  // coincidentally collide with the test runner's own PID.
  const FAKE_PID = process.pid > 1 ? process.pid - 1 : process.pid + 1;

  test('recycled PID is detected via Get-CimInstance and the lock is classified as reusable', () => {
    const calls: Array<[string, string[]]> = [];
    // Tracked (not just made to throw) so an unintended /proc attempt on
    // win32 is caught by the call-count assertion below, not silently
    // swallowed by the probe's own try/catch around that branch.
    const cmdlineCalls: string[] = [];
    const reused = isPidReusedByOtherProgram(
      FAKE_PID,
      '/home/user/.bun/bin/gbrain serve --http',
      null,
      null,
      {
        platform: 'win32',
        readCmdlineFile: (path) => {
          cmdlineCalls.push(path);
          throw new Error('should not read /proc on win32');
        },
        execFile: (file, args) => {
          calls.push([file, args]);
          // Command-aware, like a real Windows host: only `powershell.exe`
          // (the CIM query) succeeds — `ps` is not an installed binary on
          // Windows, so a probe that (wrongly) tried it would fail here too,
          // exactly as it would on a real machine.
          if (file !== 'powershell.exe') {
            throw new Error(`ENOENT: spawn ${file} ENOENT (not installed on Windows)`);
          }
          // The dead gbrain holder's PID was recycled by an unrelated
          // Windows service — no "gbrain" and no token overlap with the
          // recorded command.
          return 'C:\\Windows\\System32\\svchost.exe -k netsvcs\r\n';
        },
      },
    );
    expect(reused).toBe(true);
    expect(cmdlineCalls).toHaveLength(0);
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe('powershell.exe');
    expect(calls[0][1].join(' ')).toContain('Get-CimInstance Win32_Process');
    expect(calls[0][1].join(' ')).toContain(`ProcessId=${FAKE_PID}`);
  });

  test('control: the exact same scenario, WITHOUT a win32 branch, reproduces the pre-fix false negative', () => {
    // This is the behavioral control for the test above. pglite-lock's own
    // `readProcessArgs`, on any non-win32 platform, has exactly this shape —
    // try `ps`, then `/proc/<pid>/cmdline`, nothing else — same as it did
    // before this fix (unchanged by this PR). Neither API exists on a real
    // Windows host (`ps` is not an installed binary; `/proc` is not a
    // filesystem), so pre-fix, `readProcessArgs` had no win32 branch at all
    // and hit exactly this same both-throw shape on every real Windows
    // machine, for every PID, regardless of whether that PID had actually
    // been recycled by an unrelated process. Simulating that failure shape
    // here (both probes throw, platform pinned away from 'win32' so the
    // Get-CimInstance branch is never reached — this
    // must be explicit: omitting `platform` would default to the actual host
    // OS, and running this suite ON a real win32 CI runner would then select
    // the CIM branch instead, which fails for an unrelated reason —
    // PowerShell erroring — rather than reproducing the pre-fix probe shape)
    // — for the IDENTICAL pid/recordedCommand/live-process-holder scenario
    // that the test above shows the fix correctly classifying as reused —
    // proves the regression this PR closes: pre-fix, this exact recycled-PID
    // case read as "not reused" (never reaped) on Windows; post-fix (test
    // above), it correctly reads as "reused" (reapable).
    //
    // Pinned to 'darwin', NOT 'linux': isPidReusedByOtherProgram has its own
    // pre-existing (pre-this-PR) Linux-specific pid_ns/boot_id gate above the
    // command-line probe — with a null recordedPidNs/recordedBootId (as
    // above) that gate returns false immediately on a real Linux CI runner,
    // WITHOUT ever calling readCmdlineFile/execFile below. A `platform:
    // 'linux'` value here would make this test pass for the wrong reason —
    // the fail-safe fires from the unrelated namespace gate, not from the
    // ps/proc-both-throw shape this control exists to prove — silently on
    // Linux CI while still exercising the intended path on non-Linux
    // machines. Verified via a red/green control on this repo's own tooling:
    // forcing process.platform to 'linux' while this test used `platform:
    // 'linux'` left the injected probes uncalled (cmdlineCalls/execCalls
    // both 0) even though the assertion below still passed. 'darwin' clears
    // BOTH the win32 CIM branch and the Linux namespace gate, landing
    // unconditionally in the /proc-then-ps fallback on every host OS the
    // suite runs on. The two `toHaveLength(1)` assertions below are the
    // actual regression guard: they fail loudly if a future change
    // reintroduces a bypass of this path.
    const cmdlineCalls: string[] = [];
    const execCalls: Array<[string, string[]]> = [];
    const reused = isPidReusedByOtherProgram(
      FAKE_PID,
      '/home/user/.bun/bin/gbrain serve --http',
      null,
      null,
      {
        platform: 'darwin',
        readCmdlineFile: (path) => {
          cmdlineCalls.push(path);
          throw new Error("ENOENT: no such file or directory, open '/proc/.../cmdline'");
        },
        execFile: (file, args) => {
          execCalls.push([file, args]);
          throw new Error('ENOENT: spawn ps ENOENT (ps is not installed on Windows)');
        },
      },
    );
    expect(reused).toBe(false); // null cmdline -> fail-safe -> "not reused" -> never reaped
    // Prove the fail-safe fired from the probes actually throwing, not from
    // an earlier unrelated gate short-circuiting before they ran.
    expect(cmdlineCalls).toHaveLength(1);
    expect(execCalls).toHaveLength(1);
  });

  test('a live win32 gbrain holder (CommandLine quoted by CIM) is never classified as recycled', () => {
    const reused = isPidReusedByOtherProgram(
      FAKE_PID,
      '"C:\\Users\\u\\.bun\\bin\\gbrain.exe" serve --http',
      null,
      null,
      {
        platform: 'win32',
        // Win32_Process.CommandLine quotes the executable when its path
        // contains spaces (e.g. "C:\Program Files\...").
        execFile: () => '"C:\\Users\\u\\.bun\\bin\\gbrain.exe" serve --http\r\n',
      },
    );
    expect(reused).toBe(false);
  });

  test('powershell failure on win32 is unknowable, not proof of reuse (fail-safe)', () => {
    const reused = isPidReusedByOtherProgram(
      FAKE_PID,
      '/home/user/.bun/bin/gbrain serve --http',
      null,
      null,
      {
        platform: 'win32',
        execFile: () => {
          throw new Error('powershell.exe not found');
        },
      },
    );
    expect(reused).toBe(false);
  });

  test('empty CIM output (process already gone) is unknowable, not proof of reuse (fail-safe)', () => {
    const reused = isPidReusedByOtherProgram(
      FAKE_PID,
      '/home/user/.bun/bin/gbrain serve --http',
      null,
      null,
      { platform: 'win32', execFile: () => '' },
    );
    expect(reused).toBe(false);
  });

  test('same-process PID short-circuits before any win32 probe runs', () => {
    // The probe internally catches exceptions, so a thrown execFile alone
    // would not fail this test if it were (wrongly) invoked — assert zero
    // calls to actually prove the win32 probe was never reached.
    const calls: Array<[string, string[]]> = [];
    const reused = isPidReusedByOtherProgram(
      process.pid,
      'anything',
      null,
      null,
      {
        platform: 'win32',
        execFile: (file, args) => {
          calls.push([file, args]);
          throw new Error('must not be called for a same-process PID');
        },
      },
    );
    expect(reused).toBe(false);
    expect(calls).toHaveLength(0);
  });

  // False-steal hardening (maintainer-lens round 2 finding): before this PR,
  // Windows ALWAYS hit `cmdline === null` and never reached the token
  // comparison below at all (see the header comment above) — so the
  // comparison's case-sensitive, `/`-only logic was never exercised against
  // real Windows command lines. This PR is the first time it runs there.
  // Windows paths use `\` as well as `/`, and NTFS is case-insensitive, so a
  // live legitimate holder's recorded command and its live CIM-reported
  // command line can differ in case or separator style while still being
  // the SAME process. The exact same class of bug (write-time vs read-time
  // command-line drift) already caused a real false-steal once on
  // non-Windows — see the "False-steal hardening" comment on
  // `isPidReusedByOtherProgram` above.
  test('false-steal hardening: a live win32 holder reported in a different CASE is not classified as recycled', () => {
    // CIM reports the executable in a different case than it was recorded
    // (e.g. an OS/filesystem-driven casing difference) — same live process,
    // same path, only the case differs. A case-sensitive comparison would
    // fail every check (the blanket "gbrain" substring check, the full-token
    // check, and the basename check) and misclassify this live holder as "a
    // different program", staging its lock for reaping while it is still
    // running.
    const reused = isPidReusedByOtherProgram(
      FAKE_PID,
      'C:\\Users\\u\\.bun\\bin\\gbrain.exe serve --http',
      null,
      null,
      {
        platform: 'win32',
        execFile: () => '"C:\\Users\\u\\.bun\\bin\\GBRAIN.EXE" serve --http\r\n',
      },
    );
    expect(reused).toBe(false);
  });

  test('false-steal hardening: a live win32 holder with a backslash-only recorded path is not classified as recycled', () => {
    // Mirrors the real non-Windows false-steal this repo already hit once
    // (recorded ABSOLUTE script path vs a DIFFERENT absolute path reported
    // live — see the comment on the basename fallback above): neither side
    // contains the literal substring "gbrain" (the invoking wrapper is
    // `cli.ts`, not `gbrain.exe`), so this exercises the basename fallback
    // specifically, not the blanket "gbrain" check. The recorded command is
    // an absolute WINDOWS path using ONLY backslashes (no `/` at all) — a
    // basename extractor that splits on `/` only (the pre-fix, non-Windows
    // behavior) would treat the ENTIRE path as the "basename" and never
    // match the live holder's differently-cased, differently-directoried
    // command line, misclassifying it as reused (a false steal).
    const reused = isPidReusedByOtherProgram(
      FAKE_PID,
      'C:\\Users\\u\\.bun\\bin\\cli.ts serve --http',
      null,
      null,
      {
        platform: 'win32',
        execFile: () => '"C:\\Users\\u\\AppData\\Local\\bun\\CLI.TS" serve --http\r\n',
      },
    );
    expect(reused).toBe(false);
  });

  test('a live win32 holder recorded and reported with the SAME case+path is still not classified as recycled (baseline)', () => {
    // Positive control for the two false-steal tests above: with no case or
    // separator drift at all, the pre-existing exact-match path already
    // handles this correctly. Confirms the hardening above is additive, not
    // a replacement of already-working exact matching.
    const reused = isPidReusedByOtherProgram(
      FAKE_PID,
      'C:\\Users\\u\\.bun\\bin\\cli.ts serve --http',
      null,
      null,
      {
        platform: 'win32',
        execFile: () => '"C:\\Users\\u\\.bun\\bin\\cli.ts" serve --http\r\n',
      },
    );
    expect(reused).toBe(false);
  });
});

describe('pglite-lock PID-reuse detection — non-Windows probe order (unchanged by #4563 fix)', () => {
  // The win32 fix above must not reorder or otherwise touch the probe
  // sequence on every platform this ran on before: `ps` first, `/proc` only
  // as a fallback when `ps` fails (cf. #4300 — minimal containers without
  // `ps`). These tests pin `platform: 'darwin'` (clears both the win32 CIM
  // branch and the Linux-only pid_ns/boot_id gate — see the 'control' test
  // above for why 'linux' would be the wrong pin here) and assert call
  // counts, not just return values, so a future change that silently
  // reorders or duplicates the probes fails loudly here.
  const FAKE_PID = process.pid > 1 ? process.pid - 1 : process.pid + 1;

  test('ps success means /proc is never read (probe order preserved)', () => {
    const execCalls: Array<[string, string[]]> = [];
    const cmdlineCalls: string[] = [];
    const reused = isPidReusedByOtherProgram(
      FAKE_PID,
      '/home/user/.bun/bin/gbrain serve --http',
      null,
      null,
      {
        platform: 'darwin',
        execFile: (file, args) => {
          execCalls.push([file, args]);
          return '/home/user/.bun/bin/gbrain serve --http';
        },
        readCmdlineFile: (path) => {
          cmdlineCalls.push(path);
          throw new Error('must not read /proc when ps succeeds');
        },
      },
    );
    expect(reused).toBe(false); // live gbrain holder, found via ps
    expect(execCalls).toHaveLength(1);
    expect(execCalls[0][0]).toBe('ps');
    expect(cmdlineCalls).toHaveLength(0);
  });

  test('ps failure falls back to /proc (probe order preserved)', () => {
    const execCalls: Array<[string, string[]]> = [];
    const cmdlineCalls: string[] = [];
    const reused = isPidReusedByOtherProgram(
      FAKE_PID,
      '/home/user/.bun/bin/gbrain serve --http',
      null,
      null,
      {
        platform: 'darwin',
        execFile: (file, args) => {
          execCalls.push([file, args]);
          throw new Error('ENOENT: spawn ps ENOENT');
        },
        readCmdlineFile: (path) => {
          cmdlineCalls.push(path);
          return '/home/user/.bun/bin/gbrain\0serve\0--http\0';
        },
      },
    );
    expect(reused).toBe(false); // live gbrain holder, found via the /proc fallback
    expect(execCalls).toHaveLength(1);
    expect(cmdlineCalls).toHaveLength(1);
    expect(cmdlineCalls[0]).toBe(`/proc/${FAKE_PID}/cmdline`);
  });
});

// Pure regression coverage also runs when the sandbox denies process inspection.
describe('structured lock argv comparison (#5072)', () => {
  test('keeps a live relative invocation with whitespace in its recorded absolute path', () => {
    for (const path of ['/home/example/Project Space/src/cli.ts', String.raw`C:\Users\Example Person\project\src\cli.ts`]) {
      expect(recordedArgvProvesPidReuse('bun run src/cli.ts serve', [path, 'serve'])).toBe(false);
      expect(recordedArgvProvesPidReuse(`bun "${path}" serve`, [path, 'serve'])).toBe(false);
    }
  });
  test('preserves whitespace in the script basename too', () => {
    expect(recordedArgvProvesPidReuse('bun "src/my cli.ts" serve', ['/some/Project Space/src/my cli.ts', 'serve'])).toBe(false);
  });
  test('rejects ambiguous identities but recognizes an unrelated command', () => {
    for (const argv of [undefined, null, [], [''], [123], ['script.ts', 123], ['/some/path/']]) {
      expect(recordedArgvProvesPidReuse('sleep 60', argv)).toBe(false);
    }
    expect(recordedArgvProvesPidReuse('sleep 60', ['/some/Project Space/src/cli.ts', 'serve'])).toBe(true);
  });

  // False-steal hardening (found during #5065 integration review, NOT covered
  // by the original #5072 patch): the legacy recordedCommand comparison in
  // isPidReusedByOtherProgram case-folds and accepts both path separators
  // ONLY on win32 (see the "False-steal hardening" comment on that function).
  // This argv-based comparison must apply the SAME win32 hardening —
  // otherwise a newly-written lock (which always carries `argv`) would
  // reintroduce the exact case-only/backslash-only false-steal that win32
  // hardening closed for legacy (command-string-only) locks.
  test('win32: a live holder reported in a different CASE is not classified as recycled', () => {
    expect(recordedArgvProvesPidReuse(
      '"C:\\Users\\u\\.bun\\bin\\GBRAIN.EXE" serve --http',
      ['C:\\Users\\u\\.bun\\bin\\gbrain.exe', 'serve', '--http'],
      true,
    )).toBe(false);
  });
  test('win32: a live holder with a backslash-only recorded path is not classified as recycled', () => {
    expect(recordedArgvProvesPidReuse(
      '"C:\\Users\\u\\AppData\\Local\\bun\\CLI.TS" serve --http',
      ['C:\\Users\\u\\.bun\\bin\\cli.ts', 'serve', '--http'],
      true,
    )).toBe(false);
  });
  test('win32: same-case, same-path baseline is still recognized as the same holder', () => {
    expect(recordedArgvProvesPidReuse(
      '"C:\\Users\\u\\.bun\\bin\\cli.ts" serve --http',
      ['C:\\Users\\u\\.bun\\bin\\cli.ts', 'serve', '--http'],
      true,
    )).toBe(false);
  });
  test('win32 hardening does not weaken precision: a genuinely different program is still reuse', () => {
    expect(recordedArgvProvesPidReuse(
      'C:\\Windows\\System32\\svchost.exe -k netsvcs',
      ['C:\\Users\\u\\.bun\\bin\\gbrain.exe', 'serve', '--http'],
      true,
    )).toBe(true);
  });
  test('non-win32 stays case-sensitive (no regression to the legacy comparison)', () => {
    // isWin32 defaults to false — a case-only difference on a NON-Windows
    // platform is NOT the same class of drift (case IS significant on
    // POSIX filesystems), so this must NOT be folded.
    expect(recordedArgvProvesPidReuse(
      '/home/user/.bun/bin/GBRAIN serve --http',
      ['/home/user/.bun/bin/gbrain', 'serve', '--http'],
    )).toBe(true);
  });
});
