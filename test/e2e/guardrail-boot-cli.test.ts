/**
 * #3688 E2E — proves the guardrail seam is actually reachable from the real
 * `gbrain` CLI process, not just from an in-process unit test of
 * `runGuardrails`/`registerGuardrailProvider` (test/guardrails.test.ts
 * already covers that half; it can't detect "nothing calls
 * registerGuardrailProvider in production").
 *
 * Subprocess-driven: spawns the actual `bun run src/cli.ts` binary with
 * `GBRAIN_GUARDRAIL_MODULE` pointed at a fixture file that registers a
 * provider whose `classify()` appends one JSON line per invocation to a
 * marker file. A real `gbrain import` then either does or doesn't produce
 * that marker output, which is the only way to observe whether the CLI
 * process actually imported the module and wired the provider in.
 *
 * Positive control (not just "silent when unset" — the CLAUDE.md
 * "positive-control-for-guards" reflex): the first test asserts the
 * fixture provider actually fires. The second test asserts the exact same
 * setup produces NOTHING when GBRAIN_GUARDRAIL_MODULE is unset, so the
 * marker-file mechanism itself is proven to only report real firings.
 *
 * Hermetic: GBRAIN_HOME is a fresh tmpdir per describe block; PGLite via
 * `gbrain init --pglite --no-embedding` (keyless — no provider API keys
 * required); `gbrain import --no-embed` so the import completes without a
 * real embedding call. The guardrail hook fires before embedding anyway
 * (see docs/guardrails.md's seam table), so this doesn't narrow what's
 * being proven.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawn } from 'child_process';

const REPO_ROOT = join(import.meta.dir, '..', '..');
const GUARDRAILS_MODULE_PATH = join(REPO_ROOT, 'src', 'core', 'guardrails.ts');

function runCli(
  args: string[],
  opts: { gbrainHome: string; env?: NodeJS.ProcessEnv },
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    const child = spawn('bun', ['run', join(REPO_ROOT, 'src', 'cli.ts'), ...args], {
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        GBRAIN_HOME: opts.gbrainHome,
        ...opts.env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: REPO_ROOT,
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (b) => { stdout += b.toString(); });
    child.stderr?.on('data', (b) => { stderr += b.toString(); });
    child.on('close', (code) => resolve({ stdout, stderr, exitCode: code ?? -1 }));
  });
}

/** Fixture guardrail module: registers a provider that appends one JSON
 *  line per classify() call to GUARDRAIL_TEST_MARKER. */
function writeFixtureModule(path: string): void {
  writeFileSync(
    path,
    [
      `import { registerGuardrailProvider } from ${JSON.stringify(GUARDRAILS_MODULE_PATH)};`,
      `import { appendFileSync } from 'node:fs';`,
      ``,
      `const marker = process.env.GUARDRAIL_TEST_MARKER;`,
      `if (!marker) throw new Error('GUARDRAIL_TEST_MARKER not set');`,
      ``,
      `registerGuardrailProvider({`,
      `  id: 'e2e-fixture-3688',`,
      `  classify(input) {`,
      `    const slug = input.metadata && typeof input.metadata === 'object'`,
      `      ? (input.metadata as Record<string, unknown>).slug`,
      `      : null;`,
      `    appendFileSync(marker, JSON.stringify({ hook: input.hook, slug }) + '\\n');`,
      `  },`,
      `});`,
      ``,
    ].join('\n'),
  );
}

describe('#3688 — GBRAIN_GUARDRAIL_MODULE actually reaches the CLI process', () => {
  let tmpHome: string;
  let repoDir: string;
  let fixtureDir: string;
  let fixtureModule: string;

  beforeAll(async () => {
    tmpHome = mkdtempSync(join(tmpdir(), 'gbrain-guardrail-boot-home-'));
    fixtureDir = mkdtempSync(join(tmpdir(), 'gbrain-guardrail-boot-fixture-'));
    fixtureModule = join(fixtureDir, 'my-firewall.ts');
    writeFixtureModule(fixtureModule);

    repoDir = join(tmpHome, 'sample-repo');
    // Each test imports its own subdirectory (`gbrain import <dir>` — a bare
    // file path isn't a supported target) so a content-hash dedup skip in
    // one test can never be mistaken for the guardrail (not) firing in
    // another.
    mkdirSync(join(repoDir, 'positive'), { recursive: true });
    mkdirSync(join(repoDir, 'negative'), { recursive: true });
    mkdirSync(join(repoDir, 'failopen'), { recursive: true });
    writeFileSync(join(repoDir, 'positive', 'note.md'), '# Note Positive\n\nhello world, positive control.\n');
    writeFileSync(join(repoDir, 'negative', 'note.md'), '# Note Negative\n\nhello world, negative control.\n');
    writeFileSync(join(repoDir, 'failopen', 'note.md'), '# Note Fail Open\n\nhello world, fail-open control.\n');

    // Keyless init: no provider API keys required, matches
    // test/e2e/init-fresh-pglite.test.ts's D9 --no-embedding pattern.
    const init = await runCli(['init', '--pglite', '--no-embedding'], { gbrainHome: tmpHome, env: {} });
    expect(init.exitCode).toBe(0);
  }, 60000);

  afterAll(() => {
    for (const d of [tmpHome, fixtureDir]) {
      try { rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  });

  test('positive control: a registered provider fires on a real `gbrain import`', async () => {
    const marker = join(fixtureDir, 'marker-positive.jsonl');
    expect(existsSync(marker)).toBe(false);

    const result = await runCli(['import', join(repoDir, 'positive'), '--no-embed'], {
      gbrainHome: tmpHome,
      env: { GBRAIN_GUARDRAIL_MODULE: fixtureModule, GUARDRAIL_TEST_MARKER: marker },
    });

    expect(result.exitCode).toBe(0);
    expect(existsSync(marker)).toBe(true);

    const lines = readFileSync(marker, 'utf8').trim().split('\n').filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);
    const events = lines.map((l) => JSON.parse(l));
    expect(events.some((e) => e.hook === 'file_storage.markdown' && e.slug === 'note')).toBe(true);
  }, 60000);

  test('negative control: same import with GBRAIN_GUARDRAIL_MODULE unset never touches the marker', async () => {
    const marker = join(fixtureDir, 'marker-negative.jsonl');
    expect(existsSync(marker)).toBe(false);

    const result = await runCli(['import', join(repoDir, 'negative'), '--no-embed'], {
      gbrainHome: tmpHome,
      env: { GUARDRAIL_TEST_MARKER: marker }, // GBRAIN_GUARDRAIL_MODULE intentionally unset
    });

    expect(result.exitCode).toBe(0);
    // The OSS distribution ships inert: proves the marker mechanism itself
    // only reports real firings, not test-harness noise.
    expect(existsSync(marker)).toBe(false);
  }, 60000);

  test('fail-open: a broken GBRAIN_GUARDRAIL_MODULE warns on stderr but the command still succeeds', async () => {
    const result = await runCli(['import', join(repoDir, 'failopen'), '--no-embed'], {
      gbrainHome: tmpHome,
      env: { GBRAIN_GUARDRAIL_MODULE: '/definitely/does/not/exist/guardrail-3688.ts' },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain('[guardrail-boot]');
    expect(result.stderr).toContain('does not exist');
  }, 60000);
});
