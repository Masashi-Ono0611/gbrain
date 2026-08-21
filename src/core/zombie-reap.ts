/**
 * Reap zombie child processes.
 *
 * Bun (like Node) only auto-reaps child processes when a SIGCHLD handler is
 * installed. Without this, child processes spawned by the worker (embed
 * batches, shell jobs, sub-agents) become zombies when they exit,
 * accumulating in the PID table and (in the original production cascade)
 * holding phantom DB connection slots.
 *
 * A no-op handler is sufficient — the runtime calls waitpid() internally as
 * long as a listener is registered. EventEmitter does NOT dedupe listeners by
 * reference; the includes() check below is what prevents duplicate listeners
 * across hot-import scenarios (test harnesses re-importing modules in the
 * same process).
 *
 * #2443 scope note: this ONLY reaps children the runtime is itself tracking
 * — i.e. processes this gbrain process spawned directly via `Bun.spawn` /
 * `child_process` and is still holding a handle for. It does NOT reap a
 * REPARENTED grandchild (e.g. a `git` subprocess whose original parent
 * exited or was force-evicted, or a helper process `git` itself spawned and
 * outlived): the runtime's internal SIGCHLD handling only calls `waitpid()`
 * for PIDs in its own handle table, never a blind `waitpid(-1, ...)` sweep
 * of every child this OS process happens to have.
 *
 * A full in-process fix needs an arbitrary-child `waitpid(-1, ...)` loop —
 * a syscall gbrain currently has no safe binding for (no `bun:ffi` or other
 * native binding anywhere in this codebase; a codebase-wide grep for
 * `bun:ffi`/`dlopen`/`FFIType` at the time of #2443 found zero hits).
 * `PR_SET_CHILD_SUBREAPER` (Linux `prctl(2)`) is a DIFFERENT, complementary
 * mechanism — it only controls WHERE the kernel reparents an orphan (to the
 * nearest ancestor that registered as a subreaper, instead of walking all
 * the way up to the PID namespace's real PID 1); it does not itself reap
 * anything, and whoever it names still has to call `waitpid()`. It's also
 * irrelevant to the PID-1 case specifically: PID 1 is already the kernel's
 * adopter of last resort for orphans, no subreaper opt-in required. When
 * gbrain IS PID 1 (no init process ahead of it in this PID namespace),
 * those reparented orphans have nothing left to reap them and can
 * accumulate as zombies until the container's `pids.max` cgroup ceiling is
 * hit. See `pid1ZombieReapWarning` below — the honest scoped fix here is a
 * loud startup warning steering operators at a real init (tini / `--init`),
 * not a claim that this module is a full PID-1 subreaper.
 *
 * (Separately, `src/core/minions/spawn-helpers.ts` wraps SPAWNED WORKER
 * processes in `tini` when one is on PATH — a different mechanism for a
 * different subtree, not a fix for `gbrain serve`'s own top-level PID-1
 * case, and out of scope for #2443.)
 */

const reapHandler = () => {};

export function installSigchldHandler(): void {
  // SIGCHLD is POSIX-only. On Windows, `process.on('SIGCHLD', ...)` throws
  // "ENOTSUP" because Windows doesn't have signals. Guard by platform so a
  // future Windows port of any gbrain CLI doesn't crash at boot.
  if (process.platform === 'win32') return;
  if (!process.listeners('SIGCHLD').includes(reapHandler)) {
    process.on('SIGCHLD', reapHandler);
  }
}

/**
 * Test-only: removes the handler so other test files in the same shard
 * process don't observe a pre-installed listener. Call from `afterAll` in
 * `test/zombie-reap.test.ts`.
 */
export function _uninstallSigchldHandlerForTests(): void {
  process.removeListener('SIGCHLD', reapHandler);
}

/**
 * #2443 — startup diagnostic for `gbrain serve`.
 *
 * `pid === 1` is a reliable, zero-cost signal that NO init process is
 * wrapping gbrain: an init (tini, dumb-init, Docker `--init`) always
 * occupies pid 1 itself, so if gbrain IS pid 1 there is, by construction,
 * nothing upstream of it reaping orphans. In that configuration a process
 * left behind by an aborted or timed-out subprocess (e.g. a `git` helper
 * orphaned by a force-evicted worker) reparents to PID 1 and can
 * accumulate as a zombie — gbrain has no safe arbitrary-child wait binding
 * to reap it (see the module doc comment above). Returns a one-time
 * warning string, or `null` when not applicable, so the caller can log it
 * however it likes (and tests can assert on the message without mocking
 * global `process` state) — the same injectable-pid/platform seam
 * `readLiveParentPid` and `probeWatchdogAvailable` use in
 * `src/commands/serve.ts`.
 *
 * Restricted to Linux (not win32, not darwin/other POSIX): #2443 is a
 * container/cgroup phenomenon, and every deployed instance of "gbrain
 * literally running as PID 1" in practice is a Linux container. The
 * guidance in the message itself (cgroup `pids.max`, `tini`, `--init`) is
 * Linux-specific; warning on macOS/Windows just because `pid === 1` (an
 * essentially-never-happens edge case there outside of contrived setups)
 * would be a platform-inaccurate false signal, not a real diagnosis.
 */
export function pid1ZombieReapWarning(
  pid: number = process.pid,
  platform: NodeJS.Platform = process.platform,
): string | null {
  if (platform !== 'linux' || pid !== 1) return null;
  return (
    '[gbrain serve] WARNING: running as PID 1 with no separate init process in this ' +
    'PID namespace. A process left behind by an aborted or timed-out subprocess ' +
    '(e.g. a `git` helper orphaned by a force-evicted worker) reparents to PID 1, and ' +
    'gbrain has no safe arbitrary-child wait binding to reap it — it can accumulate as ' +
    "a zombie. On a cgroup v2 host this can exhaust pids.max and make fork() fail with " +
    'EAGAIN (#2443; check `pids.current` / `pids.max` and for `Z`-state processes to ' +
    'confirm). Fix: run gbrain under a real init that reaps orphans, e.g. ' +
    '`docker run --init`, `ENTRYPOINT ["tini", "--", ...]`, or dumb-init.'
  );
}
