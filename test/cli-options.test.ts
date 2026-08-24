import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { parseGlobalFlags, cliOptsToProgressOptions, DEFAULT_CLI_OPTIONS, setCliOptions, getCliOptions, _resetCliOptionsForTest } from '../src/core/cli-options.ts';

describe('parseGlobalFlags', () => {
  test('empty argv → defaults, empty rest', () => {
    const r = parseGlobalFlags([]);
    expect(r.cliOpts).toEqual(DEFAULT_CLI_OPTIONS);
    expect(r.rest).toEqual([]);
  });

  test('strips --quiet from argv and sets quiet=true', () => {
    // Per-command handlers that historically parsed their own --quiet
    // (skillpack-check) now read the resolved CliOptions singleton via
    // getCliOptions() — see src/core/cli-options.ts.
    const r = parseGlobalFlags(['--quiet', 'doctor', '--fast']);
    expect(r.cliOpts.quiet).toBe(true);
    expect(r.cliOpts.progressJson).toBe(false);
    expect(r.rest).toEqual(['doctor', '--fast']);
  });

  test('strips --progress-json from argv', () => {
    const r = parseGlobalFlags(['--progress-json', 'doctor']);
    expect(r.cliOpts.progressJson).toBe(true);
    expect(r.rest).toEqual(['doctor']);
  });

  test('--progress-interval=500 form', () => {
    const r = parseGlobalFlags(['--progress-interval=500', 'embed']);
    expect(r.cliOpts.progressInterval).toBe(500);
    expect(r.rest).toEqual(['embed']);
  });

  test('--progress-interval 500 space-separated form', () => {
    const r = parseGlobalFlags(['--progress-interval', '500', 'embed']);
    expect(r.cliOpts.progressInterval).toBe(500);
    expect(r.rest).toEqual(['embed']);
  });

  test('global flag interleaved mid-argv still stripped', () => {
    const r = parseGlobalFlags(['doctor', '--progress-json', '--fast']);
    expect(r.cliOpts.progressJson).toBe(true);
    expect(r.rest).toEqual(['doctor', '--fast']);
  });

  test('invalid --progress-interval value passes through (per-command parser can handle it)', () => {
    const r = parseGlobalFlags(['--progress-interval=abc', 'doctor']);
    // Unparseable value → leave the flag in rest, default interval kept.
    expect(r.cliOpts.progressInterval).toBe(DEFAULT_CLI_OPTIONS.progressInterval);
    expect(r.rest).toEqual(['--progress-interval=abc', 'doctor']);
  });

  test('negative --progress-interval rejected', () => {
    const r = parseGlobalFlags(['--progress-interval=-1', 'doctor']);
    expect(r.cliOpts.progressInterval).toBe(DEFAULT_CLI_OPTIONS.progressInterval);
    expect(r.rest).toContain('--progress-interval=-1');
  });

  test('unknown flags pass through unchanged', () => {
    const r = parseGlobalFlags(['doctor', '--fast', '--json', '--foo=bar']);
    expect(r.rest).toEqual(['doctor', '--fast', '--json', '--foo=bar']);
    expect(r.cliOpts).toEqual(DEFAULT_CLI_OPTIONS);
  });

  test('all global flags combined', () => {
    const r = parseGlobalFlags(['--quiet', '--progress-json', '--progress-interval=250', 'sync']);
    expect(r.cliOpts).toEqual({ quiet: true, progressJson: true, progressInterval: 250, timeoutMs: null, explain: false, brain: null });
    expect(r.rest).toEqual(['sync']);
  });

  // v0.40.4 — --explain flag
  test('--explain sets cliOpts.explain', () => {
    const r = parseGlobalFlags(['--explain', 'search', 'test query']);
    expect(r.cliOpts.explain).toBe(true);
    expect(r.rest).toEqual(['search', 'test query']);
  });

  test('--explain absent → false default', () => {
    const r = parseGlobalFlags(['search', 'test query']);
    expect(r.cliOpts.explain).toBe(false);
  });

  test('--explain works in any argv position', () => {
    const r = parseGlobalFlags(['search', '--explain', 'test query']);
    expect(r.cliOpts.explain).toBe(true);
    expect(r.rest).toEqual(['search', 'test query']);
  });
});

describe('getCliOptions / setCliOptions singleton', () => {
  test('defaults when never set', () => {
    _resetCliOptionsForTest();
    expect(getCliOptions()).toEqual(DEFAULT_CLI_OPTIONS);
  });

  test('setCliOptions applies + getCliOptions returns a copy', () => {
    _resetCliOptionsForTest();
    setCliOptions({ quiet: false, progressJson: true, progressInterval: 250, timeoutMs: null, explain: false, brain: null });
    expect(getCliOptions().progressJson).toBe(true);
    expect(getCliOptions().progressInterval).toBe(250);
  });
});

describe('cli.ts global-flag stripping (integration)', () => {
  const CLI = join(import.meta.dir, '..', 'src', 'cli.ts');

  test('gbrain --progress-json --version works (global flag stripped before dispatch)', () => {
    const res = spawnSync('bun', [CLI, '--progress-json', '--version'], {
      encoding: 'utf-8',
      env: { ...process.env, NO_COLOR: '1' },
    });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('gbrain ');
  });

  test('gbrain --quiet --progress-interval=500 version works (flags interleaved, all stripped)', () => {
    const res = spawnSync('bun', [CLI, '--quiet', '--progress-interval=500', 'version'], {
      encoding: 'utf-8',
      env: { ...process.env, NO_COLOR: '1' },
    });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('gbrain ');
  });
});

describe('CLI integration: progress streams to the right channel', () => {
  const CLI = join(import.meta.dir, '..', 'src', 'cli.ts');

  test('gbrain --progress-json --version emits only the version on stdout', () => {
    // `version` is a single-shot command that goes through the main()
    // dispatch path. We want to confirm --progress-json doesn't force
    // stray progress onto stdout for commands that don't use a reporter.
    const res = spawnSync('bun', [CLI, '--progress-json', '--version'], {
      encoding: 'utf-8',
      env: { ...process.env, NO_COLOR: '1' },
    });
    expect(res.status).toBe(0);
    expect(res.stdout.trim()).toMatch(/^gbrain /);
    // No JSON progress object should end up on stdout.
    expect(res.stdout).not.toContain('"event":"start"');
  });

  test('gbrain --quiet skillpack-check returns exit code with no stdout', () => {
    // Regression guard for the flag-collision that skillpack-check hit
    // when --quiet briefly passed through argv. Now it reads the singleton.
    const res = spawnSync('bun', [CLI, '--quiet', 'skillpack-check'], {
      encoding: 'utf-8',
      env: { ...process.env, NO_COLOR: '1' },
    });
    // Exit may be 0 or 1 depending on whether a brain is configured;
    // what matters is stdout stays empty.
    expect(res.stdout).toBe('');
  });
});

describe('cliOptsToProgressOptions', () => {
  test('--quiet → quiet mode', () => {
    const opts = cliOptsToProgressOptions({ quiet: true, progressJson: false, progressInterval: 1000, timeoutMs: null, explain: false, brain: null });
    expect(opts.mode).toBe('quiet');
  });

  test('--progress-json → json mode with interval', () => {
    const opts = cliOptsToProgressOptions({ quiet: false, progressJson: true, progressInterval: 500, timeoutMs: null, explain: false, brain: null });
    expect(opts.mode).toBe('json');
    expect(opts.minIntervalMs).toBe(500);
  });

  test('defaults → auto mode', () => {
    const opts = cliOptsToProgressOptions(DEFAULT_CLI_OPTIONS);
    expect(opts.mode).toBe('auto');
    expect(opts.minIntervalMs).toBe(1000);
  });

  test('quiet takes priority over progressJson', () => {
    const opts = cliOptsToProgressOptions({ quiet: true, progressJson: true, progressInterval: 1000, timeoutMs: null, explain: false, brain: null });
    expect(opts.mode).toBe('quiet');
  });
});

// v0.31.1: --timeout flag tests
describe('--timeout flag', () => {
  test('--timeout=30s → 30000ms', () => {
    const r = parseGlobalFlags(['--timeout=30s', 'search', 'X']);
    expect(r.cliOpts.timeoutMs).toBe(30_000);
    expect(r.rest).toEqual(['search', 'X']);
  });

  test('--timeout 1.5s → 1500ms', () => {
    const r = parseGlobalFlags(['--timeout', '1.5s', 'search']);
    expect(r.cliOpts.timeoutMs).toBe(1500);
    expect(r.rest).toEqual(['search']);
  });

  test('--timeout=2m → 120000ms', () => {
    const r = parseGlobalFlags(['--timeout=2m']);
    expect(r.cliOpts.timeoutMs).toBe(120_000);
  });

  test('--timeout=500ms → 500ms', () => {
    const r = parseGlobalFlags(['--timeout=500ms']);
    expect(r.cliOpts.timeoutMs).toBe(500);
  });

  test('--timeout=500 (bare number, default ms)', () => {
    const r = parseGlobalFlags(['--timeout=500']);
    expect(r.cliOpts.timeoutMs).toBe(500);
  });

  test('--timeout=garbage → falls through, timeoutMs stays null', () => {
    const r = parseGlobalFlags(['--timeout=garbage', 'search']);
    expect(r.cliOpts.timeoutMs).toBe(null);
    expect(r.rest).toContain('--timeout=garbage');
  });

  test('--timeout=0 rejected (must be positive)', () => {
    const r = parseGlobalFlags(['--timeout=0']);
    expect(r.cliOpts.timeoutMs).toBe(null);
    expect(r.rest).toContain('--timeout=0');
  });

  test('default timeoutMs is null (per-command default applies)', () => {
    const r = parseGlobalFlags(['search', 'X']);
    expect(r.cliOpts.timeoutMs).toBe(null);
  });
});

// #4541: extract/onboard/whoknows each parse their own `--explain` out of
// argv, but the global parser claimed it unconditionally for search/query's
// per-stage attribution view — so none of the three ever saw it (confirmed
// live: `gbrain extract --explain timeline` ran a full extraction, args
// reaching runExtract were `["timeline"]`). Mirrors the --timeout
// owning-command hand-back below.
describe('--explain flag (owning-command hand-back, #4541)', () => {
  for (const cmd of ['extract', 'onboard', 'whoknows']) {
    test(`'${cmd} --explain timeline' hands the flag back adjacent to its kind argument`, () => {
      // The reported bug's exact repro shape (extract) / same code path
      // (onboard, whoknows). Unlike --timeout's hand-back (appended at the
      // end), --explain's hand-back preserves original adjacency:
      // extract-explain.ts's own parser reads the token immediately after
      // --explain as the kind (with a positional fallback), so moving the
      // flag to the end would strand it away from "timeline" and break
      // that parser too.
      const r = parseGlobalFlags([cmd, '--explain', 'timeline']);
      expect(r.cliOpts.explain).toBe(false);
      expect(r.rest).toEqual([cmd, '--explain', 'timeline']);
    });

    test(`'--explain ${cmd} timeline' (global-flag-first style) still dispatches to '${cmd}', not '--explain'`, () => {
      // The CLI documents global-flag-first invocations as valid (this
      // file's own header: `gbrain --progress-json doctor`). --explain
      // starting BEFORE the command word must not end up at rest[0] — that
      // is where cli.ts reads the command name, so leaving it there would
      // make '--explain' itself the (unrecognized) command and break
      // dispatch entirely, which is worse than the original bug.
      const r = parseGlobalFlags(['--explain', cmd, 'timeline']);
      expect(r.cliOpts.explain).toBe(false);
      expect(r.rest).toEqual([cmd, '--explain', 'timeline']);
    });

    test(`duplicate --explain (one before, one after '${cmd}') is deduplicated to one`, () => {
      // A second handed-back --explain would land in extract-explain.ts's
      // args[explainIdx+1] slot instead of the real kind and misfire its
      // own usage error — at most one --explain survives, however many the
      // user typed, and it stays adjacent to the kind argument.
      const r = parseGlobalFlags(['--explain', cmd, '--explain', 'timeline']);
      expect(r.rest).toEqual([cmd, '--explain', 'timeline']);
    });

    test(`duplicate --explain (both after '${cmd}') is deduplicated to one`, () => {
      const r = parseGlobalFlags([cmd, '--explain', '--explain', 'timeline']);
      expect(r.rest).toEqual([cmd, '--explain', 'timeline']);
    });
  }

  test('--explain is still claimed globally for search (non-owning command)', () => {
    const r = parseGlobalFlags(['search', '--explain', 'test query']);
    expect(r.cliOpts.explain).toBe(true);
    expect(r.rest).not.toContain('--explain');
    expect(r.rest).toEqual(['search', 'test query']);
  });

  test('--explain is still claimed globally for query (non-owning command)', () => {
    const r = parseGlobalFlags(['--explain', 'query', 'test query']);
    expect(r.cliOpts.explain).toBe(true);
    expect(r.rest).not.toContain('--explain');
  });

});

describe('--brain flag (brain axis routing)', () => {
  test('--brain <id> space form: parsed + stripped from rest', () => {
    const r = parseGlobalFlags(['query', 'X', '--brain', 'media-team']);
    expect(r.cliOpts.brain).toBe('media-team');
    expect(r.rest).toEqual(['query', 'X']);
  });

  test('--brain=<id> equals form: parsed + stripped from rest', () => {
    const r = parseGlobalFlags(['--brain=media-team', 'query', 'X']);
    expect(r.cliOpts.brain).toBe('media-team');
    expect(r.rest).toEqual(['query', 'X']);
  });

  test('--brain host is a valid explicit value', () => {
    const r = parseGlobalFlags(['stats', '--brain', 'host']);
    expect(r.cliOpts.brain).toBe('host');
  });

  test('missing value throws (loud, never a silent host fallback)', () => {
    expect(() => parseGlobalFlags(['query', 'X', '--brain'])).toThrow(/--brain requires a value/);
    expect(() => parseGlobalFlags(['--brain=', 'query'])).toThrow(/--brain requires a value/);
    // A following flag is not a value.
    expect(() => parseGlobalFlags(['--brain', '--quiet'])).toThrow(/--brain requires a value/);
  });

  test('malformed id throws (validated at parse time)', () => {
    expect(() => parseGlobalFlags(['--brain', 'Bad_Id!'])).toThrow(/Invalid --brain value/);
    expect(() => parseGlobalFlags(['--brain=$(rm -rf /)'])).toThrow(/Invalid --brain value/);
  });

  test('--brain-* per-command flags pass through untouched (skillopt collision guard)', () => {
    const r = parseGlobalFlags(['skillopt', '--brain-wide-max-cost-usd', '5']);
    expect(r.cliOpts.brain).toBe(null);
    expect(r.rest).toEqual(['skillopt', '--brain-wide-max-cost-usd', '5']);
  });

  test('default brain is null (ambient resolution applies)', () => {
    const r = parseGlobalFlags(['query', 'X']);
    expect(r.cliOpts.brain).toBe(null);
  });
});

describe('childGlobalFlags propagates --brain', () => {
  test('explicit brain rides into child gbrain subprocess commands', async () => {
    const { childGlobalFlags } = await import('../src/core/cli-options.ts');
    expect(childGlobalFlags({ ...DEFAULT_CLI_OPTIONS, brain: 'media-team' }))
      .toContain('--brain=media-team');
    expect(childGlobalFlags({ ...DEFAULT_CLI_OPTIONS })).not.toContain('--brain');
  });
});
