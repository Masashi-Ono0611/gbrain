/**
 * #3692 — `gbrain sources harden <id> --dry-run` ran step 1 (`divergenceSafePull`)
 * with no dryRun gate, so a flag documented as read-only performed a live
 * `git fetch` + `git pull --rebase` and could rewrite local history.
 *
 * Behavioral, subprocess-driven (source-text matching would stay green on an
 * unwired code path): a scratch bare remote is advanced behind the registered
 * source's back, then the real CLI is spawned against a throw-away brain. The
 * load-bearing assertions are git-state observations that only hold if no
 * network call happened — HEAD, the reflog, the remote-tracking ref, and
 * FETCH_HEAD. The non-dry-run case pins that the pull still happens.
 *
 * `.serial` because each CLI spawn cold-starts PGLite, matching the other
 * PGLite-spawning suites. Hooks and tests carry explicit 60s budgets: bun does
 * not read bunfig.toml's timeout and hooks otherwise get the 5000ms default
 * (#3566).
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFileSync, spawnSync } from 'child_process';

const CLI = join(import.meta.dir, '..', 'src', 'cli.ts');
const TIMEOUT_MS = 60_000;

let root: string;
let home: string;

/**
 * Global/system git config is neutralized on BOTH sides — the fixtures here and
 * the git processes the spawned CLI runs — so an operator's or the machine's
 * `commit.gpgsign` / `core.hooksPath` / `url.*.insteadOf` can't perturb either.
 */
const GIT_ISOLATION = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
} as const;

function gitRun(args: string[]): string {
  return execFileSync('git', args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf-8',
    timeout: TIMEOUT_MS,
    env: { PATH: process.env.PATH ?? '', HOME: root, ...GIT_ISOLATION },
  }).trim();
}

function git(cwd: string, ...args: string[]): string {
  return gitRun(['-C', cwd, '-c', 'protocol.file.allow=always', ...args]);
}

/** Run the real CLI against the scratch brain. Never inherits a live DATABASE_URL. */
function cli(args: string[]): { exitCode: number; stdout: string; stderr: string } {
  const r = spawnSync('bun', ['run', CLI, ...args], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: TIMEOUT_MS,
    // Run from the scratch root so no ancestor .gbrain-mount / .gbrain-source
    // dotfile in the checkout can reroute the CLI.
    cwd: root,
    env: {
      PATH: process.env.PATH,
      HOME: home,
      GBRAIN_HOME: join(home, '.gbrain'),
      // file:// remotes are refused by the SSRF guard without this.
      GBRAIN_GIT_ALLOW_FILE_TRANSPORT: '1',
      ...GIT_ISOLATION,
    } as Record<string, string>,
  });
  if (r.error) throw new Error(`gbrain ${args.join(' ')} failed to run: ${r.error.message}`);
  if (r.signal) throw new Error(`gbrain ${args.join(' ')} killed by ${r.signal} (timeout ${TIMEOUT_MS}ms)`);
  return { exitCode: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** A clone whose origin has been advanced by one commit it has not seen. */
function makeStaleClone(name: string): { work: string; originHead: string } {
  const bare = join(root, `${name}-origin.git`);
  const work = join(root, `${name}-work`);
  const other = join(root, `${name}-other`);
  gitRun(['init', '-q', '--bare', '-b', 'main', bare]);
  gitRun(['-c', 'protocol.file.allow=always', 'clone', '-q', bare, work]);
  git(work, 'config', 'user.email', 't@t.t');
  git(work, 'config', 'user.name', 'tester');
  writeFileSync(join(work, 'README.md'), 'init\n');
  git(work, 'add', 'README.md'); git(work, 'commit', '-qm', 'init'); git(work, 'push', '-q', 'origin', 'main');

  // Advance origin from a second clone — the work tree stays one commit behind.
  gitRun(['-c', 'protocol.file.allow=always', 'clone', '-q', bare, other]);
  git(other, 'config', 'user.email', 't@t.t');
  git(other, 'config', 'user.name', 'tester');
  writeFileSync(join(other, 'upstream.md'), 'upstream\n');
  git(other, 'add', 'upstream.md'); git(other, 'commit', '-qm', 'upstream'); git(other, 'push', '-q', 'origin', 'main');

  return { work, originHead: git(other, 'rev-parse', 'HEAD') };
}

let dry: { work: string; originHead: string };
let wet: { work: string; originHead: string };

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'harden-dryrun-3692-'));
  home = join(root, 'home');
  dry = makeStaleClone('dry');
  wet = makeStaleClone('wet');

  const init = cli(['init', '--pglite', '--embedding-model', 'openai:text-embedding-3-small']);
  expect(init.exitCode).toBe(0);
  for (const [id, repo] of [['drysource', dry.work], ['wetsource', wet.work]] as const) {
    const add = cli(['sources', 'add', id, '--path', repo]);
    expect(add.exitCode).toBe(0);
  }
}, TIMEOUT_MS);

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
}, TIMEOUT_MS);

describe('gbrain sources harden --dry-run (#3692)', () => {
  test('does not fetch, pull, or move the repo — and says what it WOULD do', () => {
    const headBefore = git(dry.work, 'rev-parse', 'HEAD');
    const reflogBefore = git(dry.work, 'reflog', 'show', 'HEAD');
    const trackingBefore = git(dry.work, 'rev-parse', 'refs/remotes/origin/main');
    // Precondition: origin really is ahead, so a live pull would be observable.
    expect(headBefore).not.toBe(dry.originHead);

    const r = cli(['sources', 'harden', 'drysource', '--dry-run', '--no-cron']);
    expect(r.exitCode).toBe(0);

    // No fetch: the remote-tracking ref never learned about the new commit,
    // and git never wrote a FETCH_HEAD.
    expect(git(dry.work, 'rev-parse', 'refs/remotes/origin/main')).toBe(trackingBefore);
    expect(existsSync(join(dry.work, '.git', 'FETCH_HEAD'))).toBe(false);

    // No pull/rebase: HEAD and the reflog are byte-identical, and the commit
    // that only exists on origin never materialized in the working tree.
    expect(git(dry.work, 'rev-parse', 'HEAD')).toBe(headBefore);
    expect(git(dry.work, 'reflog', 'show', 'HEAD')).toBe(reflogBefore);
    expect(existsSync(join(dry.work, 'upstream.md'))).toBe(false);

    // The plan still reports the pull it skipped.
    const out = r.stdout + r.stderr;
    expect(out).toContain('would fetch + pull --rebase origin/main');
  }, TIMEOUT_MS);

  test('regression: without --dry-run the pull still runs', () => {
    const headBefore = git(wet.work, 'rev-parse', 'HEAD');
    expect(headBefore).not.toBe(wet.originHead);

    const r = cli(['sources', 'harden', 'wetsource', '--no-cron', '--no-verify']);
    expect(r.exitCode).toBe(0);

    expect(git(wet.work, 'rev-parse', 'HEAD')).toBe(wet.originHead);
    expect(existsSync(join(wet.work, 'upstream.md'))).toBe(true);
  }, TIMEOUT_MS);
});
