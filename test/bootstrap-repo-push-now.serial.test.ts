/**
 * `bootstrap repo --push-now` [local-only patch, not submitted upstream].
 *
 * Verifies the flag correctly wires a synchronous `workspacePush` call after
 * repo creation, gated on the literal `--push-now` token, and that it never
 * fails the repo phase when the push itself fails.
 *
 * `workspacePush` is dynamic-imported inside `runRepo` — mocked at module
 * level (Bun `mock.module`) rather than exercised against a real remote,
 * since that machinery is already covered end-to-end by
 * `workspace-push.serial.test.ts`. This file only pins the wiring.
 *
 * Serial: mutates GBRAIN_HOME and a module-level mock.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach, mock } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { GITHUB_URL_PLACEHOLDER, type ExecResult, type ExecRunner } from '../src/core/bootstrap/repo.ts';
import { writeManifest, type AgentManifest } from '../src/core/bootstrap/format.ts';
import type { WorkspacePushOpts, WorkspacePushResult } from '../src/core/workspace-push.ts';

let pushCalls: WorkspacePushOpts[] = [];
let pushResult: WorkspacePushResult = { ok: true, status: 'pushed', committed: true };

const realWorkspacePush = await import('../src/core/workspace-push.ts');

mock.module('../src/core/workspace-push.ts', () => ({
  ...realWorkspacePush,
  workspacePush: async (opts: WorkspacePushOpts): Promise<WorkspacePushResult> => {
    pushCalls.push(opts);
    return pushResult;
  },
}));

// runBootstrap must be imported AFTER the mock.module call above so the
// dynamic import inside runRepo picks up the mocked module.
const { runBootstrap } = await import('../src/commands/bootstrap.ts');

interface Rule {
  key: string;
  times?: number;
  code?: number;
  stdout?: string;
  stderr?: string;
}

function makeRunner(rules: Rule[]): ExecRunner {
  const state = rules.map((r) => ({ ...r, left: r.times ?? Infinity }));
  return async (argv: string[]): Promise<ExecResult> => {
    const joined = argv.join(' ');
    for (const r of state) {
      if (r.left > 0 && joined.includes(r.key)) {
        r.left--;
        return { code: r.code ?? 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
      }
    }
    return { code: 0, stdout: '', stderr: '' };
  };
}

/** Same happy-path fake gh/git dance as bootstrap-repo.test.ts. */
function happyRules(): Rule[] {
  return [
    { key: 'gh --version', code: 0 },
    { key: 'auth status', code: 0 },
    { key: 'remote get-url origin', times: 1, code: 2, stderr: 'error: No such remote' },
    { key: 'rev-parse --git-dir', code: 1, stderr: 'fatal: not a git repository' },
    { key: 'gh api user', stdout: '{"login":"alice","id":123}\n' },
    { key: 'repo view alice/test-agent-workspace', code: 1, stderr: 'Could not resolve to a Repository' },
    { key: 'repo create', code: 0 },
    { key: 'remote get-url origin', code: 0, stdout: 'https://github.com/alice/test-agent-workspace\n' },
    { key: '--jq .private', code: 0, stdout: 'true\n' },
  ];
}

const INITIALIZED_MANIFEST: AgentManifest = {
  format_version: 1,
  initialized: true,
  agent_name: 'Test Agent',
  created_by: '0.0.0-test',
  created_at: '2026-01-01T00:00:00.000Z',
  source_id: 'workspace',
};

let tmpParent: string;
let ws: string;
let prevHome: string | undefined;

beforeAll(() => {
  tmpParent = mkdtempSync(join(tmpdir(), 'gb-push-now-home-'));
  mkdirSync(join(tmpParent, 'bootstrap'), { recursive: true });
  prevHome = process.env.GBRAIN_HOME;
  process.env.GBRAIN_HOME = tmpParent;
});

afterAll(() => {
  if (prevHome === undefined) delete process.env.GBRAIN_HOME;
  else process.env.GBRAIN_HOME = prevHome;
  rmSync(tmpParent, { recursive: true, force: true });
});

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), 'gb-push-now-ws-'));
  writeManifest(ws, { ...INITIALIZED_MANIFEST });
  writeFileSync(join(ws, 'GITHUB.md'), `This workspace is durably backed up to **${GITHUB_URL_PLACEHOLDER}**.\n`, 'utf8');
  pushCalls = [];
  pushResult = { ok: true, status: 'pushed', committed: true };
});

describe('bootstrap repo --push-now', () => {
  test('flag present: workspacePush is called once with dir=ws, phase still returns 0', async () => {
    const runner = makeRunner(happyRules());
    const code = await runBootstrap(['repo', '--workspace', ws, '--push-now'], { runner });
    expect(code).toBe(0);
    expect(pushCalls.length).toBe(1);
    expect(pushCalls[0].dir).toBe(ws);
  });

  test('flag absent: workspacePush is never called (backward-compatible default)', async () => {
    const runner = makeRunner(happyRules());
    const code = await runBootstrap(['repo', '--workspace', ws], { runner });
    expect(code).toBe(0);
    expect(pushCalls.length).toBe(0);
  });

  test('push failure is best-effort: repo phase still returns 0, not thrown', async () => {
    pushResult = { ok: false, status: 'push_failed', reason: 'origin unreachable (simulated)' };
    const runner = makeRunner(happyRules());
    const code = await runBootstrap(['repo', '--workspace', ws, '--push-now'], { runner });
    expect(code).toBe(0);
    expect(pushCalls.length).toBe(1);
  });

  test('push throwing is caught: repo phase still returns 0', async () => {
    mock.module('../src/core/workspace-push.ts', () => ({
      ...realWorkspacePush,
      workspacePush: async () => {
        throw new Error('simulated crash');
      },
    }));
    const runner = makeRunner(happyRules());
    const code = await runBootstrap(['repo', '--workspace', ws, '--push-now'], { runner });
    expect(code).toBe(0);
    // Restore the recording mock for any tests that run after this one.
    mock.module('../src/core/workspace-push.ts', () => ({
      ...realWorkspacePush,
      workspacePush: async (opts: WorkspacePushOpts): Promise<WorkspacePushResult> => {
        pushCalls.push(opts);
        return pushResult;
      },
    }));
  });
});
