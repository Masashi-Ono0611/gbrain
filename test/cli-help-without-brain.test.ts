/**
 * `--help` must be answerable with no brain configured.
 *
 * A reader runs `--help` most often right after install, before `gbrain init`.
 * CLI_ONLY_SELF_HELP members skip the dispatcher's generic usage stub (that is
 * the point — they print their own), but they were then reached through the
 * normal dispatch, which connects the engine first. So on a machine with no
 * brain they exited 1 with "No brain configured" and their own help block was
 * unreachable code.
 *
 * The oracle here is behaviour, not a declaration: each command is actually
 * run with an empty GBRAIN_HOME.
 */
import { describe, test, expect } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO = new URL('..', import.meta.url).pathname;

/** Answer `--help` before touching the engine. */
const HELP_WITHOUT_BRAIN = [
  'models',
  'watch',
  'skillopt',
  'maintain',
  'extract-conversation-facts',
];

/**
 * Self-help members that still need a brain for `--help`, because their handler
 * has no `--help` branch to reach. Pinned rather than omitted so the list can
 * only shrink deliberately: writing help for one of these, or dropping it from
 * CLI_ONLY_SELF_HELP so the generic stub answers, fails this test until the
 * entry moves.
 */
const STILL_NEEDS_A_BRAIN = [
  'brainstorm',
  'config',
  'embed',
  'lsd',
  'migrate',
  'pages',
  'retrieval-upgrade',
];

async function runHelp(command: string): Promise<{ code: number; out: string }> {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-nobrain-'));
  const proc = Bun.spawn(['bun', 'run', 'src/cli.ts', command, '--help'], {
    cwd: REPO,
    env: { ...process.env, GBRAIN_HOME: home },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  return { code, out: stdout + stderr };
}

describe('--help without a configured brain', () => {
  for (const command of HELP_WITHOUT_BRAIN) {
    test(`${command} --help answers`, async () => {
      const { code, out } = await runHelp(command);
      expect(code).toBe(0);
      expect(out).not.toContain('No brain configured');
      // Real help, not a one-line stub or an empty exit.
      expect(out.split('\n').filter(l => l.trim()).length).toBeGreaterThan(3);
      expect(out.toLowerCase()).toContain(command.split('-')[0]);
    }, 30_000);
  }

  test('the known-unfixed set is exactly what it claims', async () => {
    const unexpectedlyWorking: string[] = [];
    for (const command of STILL_NEEDS_A_BRAIN) {
      const { out } = await runHelp(command);
      if (!out.includes('No brain configured')) unexpectedlyWorking.push(command);
    }
    // Not a wish that they stay broken — a tripwire. Fixing one is good and
    // should move it to HELP_WITHOUT_BRAIN in the same change, so the coverage
    // list never drifts away from reality in either direction.
    expect(unexpectedlyWorking).toEqual([]);
  }, 90_000);
});
