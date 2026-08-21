/**
 * Tests for src/core/zombie-reap.ts — the SIGCHLD installer that lets
 * Bun/Node reap exited child processes, plus the #2443 PID-1 warning.
 *
 * Background: without a SIGCHLD listener, child processes spawned by the
 * worker (shell jobs, embed batches, sub-agents) become zombies on exit.
 * The runtime only calls waitpid() internally when at least one SIGCHLD
 * listener is registered. A no-op handler is sufficient.
 *
 * Cross-file leak guard (codex review #6): mutating global `process` signal
 * listeners in the parallel test pool can leak across files in the same
 * shard process. `afterAll` MUST call `_uninstallSigchldHandlerForTests()`
 * so the next file in the shard sees a clean listener set.
 *
 * #2443 scope note: `pid1ZombieReapWarning` is tested here as a pure
 * function only (injected pid/platform args) — this test suite does NOT
 * prove that gbrain reaps a reparented grandchild when it is really PID 1.
 * bun:test doesn't run this process as PID 1 in its own PID namespace, and
 * mocking `process.pid` (a non-configurable runtime value) wouldn't be a
 * safe or meaningful substitute — that real-PID-1 scenario would need a
 * container/Linux-PID-namespace integration test, which is out of scope
 * here. See test/e2e/zombie-reaping.test.ts for the real-binary coverage
 * that DOES exist: it proves the SIGCHLD handler reaps a DIRECTLY spawned
 * (tracked) child, which is the only reaping claim this codebase can make
 * good on without a native waitpid(-1, ...) binding — see the module doc
 * comment in zombie-reap.ts for why a reparented, untracked grandchild is
 * a different, currently-undischargeable case.
 */

import { describe, test, expect, afterAll } from 'bun:test';
import {
  installSigchldHandler,
  _uninstallSigchldHandlerForTests,
  pid1ZombieReapWarning,
} from '../src/core/zombie-reap.ts';

afterAll(() => {
  _uninstallSigchldHandlerForTests();
});

describe('installSigchldHandler', () => {
  test('registers a SIGCHLD listener after first call', () => {
    const before = process.listeners('SIGCHLD').length;
    installSigchldHandler();
    const after = process.listeners('SIGCHLD').length;
    expect(after).toBeGreaterThanOrEqual(before + (before === 0 ? 1 : 0));
    expect(process.listeners('SIGCHLD').length).toBeGreaterThanOrEqual(1);
  });

  test('idempotent: two calls leave exactly one of our listeners', () => {
    // Start clean — remove any handler from the previous test (this file's
    // own only — afterAll handles the global cleanup).
    _uninstallSigchldHandlerForTests();
    installSigchldHandler();
    const afterFirst = process.listeners('SIGCHLD').length;
    installSigchldHandler();
    const afterSecond = process.listeners('SIGCHLD').length;
    // The includes() guard in installSigchldHandler must prevent the
    // second call from adding a duplicate. EventEmitter does NOT dedupe.
    expect(afterSecond).toBe(afterFirst);
  });
});

describe('pid1ZombieReapWarning', () => {
  test('returns null when pid is not 1 (normal, non-PID-1 process)', () => {
    // Fully synthetic inputs only — this suite intentionally never reads
    // live process.pid/process.platform (codex review round 1 caught an
    // earlier draft doing exactly that here, which would have flipped
    // this assertion's expected value to non-null if this test file were
    // ever itself run as pid 1, e.g. inside a minimal container).
    expect(pid1ZombieReapWarning(1234, 'linux')).toBeNull();
    expect(pid1ZombieReapWarning(2, 'linux')).toBeNull();
  });

  test('returns null on win32 even when pid is 1 (SIGCHLD is POSIX-only)', () => {
    expect(pid1ZombieReapWarning(1, 'win32')).toBeNull();
  });

  test('returns null on darwin/other non-Linux POSIX platforms even when pid is 1', () => {
    // #2443 is a Linux container/cgroup phenomenon (codex review round 1:
    // an earlier draft warned on darwin too, describing Linux-specific
    // cgroup/tini guidance that doesn't apply there — platform-inaccurate).
    expect(pid1ZombieReapWarning(1, 'darwin')).toBeNull();
    expect(pid1ZombieReapWarning(1, 'sunos')).toBeNull();
  });

  test('returns a warning when pid is 1 on linux', () => {
    expect(pid1ZombieReapWarning(1, 'linux')).not.toBeNull();
  });

  test('warning names the issue, the symptom, and the fix', () => {
    const msg = pid1ZombieReapWarning(1, 'linux') as string;
    // Findable: an operator grepping logs for the crash symptom should hit
    // this line.
    expect(msg).toContain('#2443');
    expect(msg).toContain('zombie');
    // Actionable: names at least one concrete fix, not just "this is broken".
    expect(msg).toMatch(/tini|dumb-init|--init/);
  });

  test('is honest about what it does NOT cover (no reap claim)', () => {
    // This function only WARNS — it must explicitly disclaim reaping
    // capability, never claim gbrain itself will reap the orphans.
    // Guards against a future edit accidentally overclaiming (the same
    // scope-honesty this PR was reviewed against). Wording is "no safe
    // ... wait binding to reap it" per codex round 1 (Warning 3):
    // user-space code CAN call waitpid() in principle, gbrain just has no
    // binding for it — "cannot reap ... from user-space" overclaimed that.
    const msg = pid1ZombieReapWarning(1, 'linux') as string;
    expect(msg).toContain('no safe arbitrary-child wait binding');
    expect(msg).not.toMatch(/gbrain (will|now) reap/i);
  });
});
