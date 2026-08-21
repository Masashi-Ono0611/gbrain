import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  AUTOPILOT_FOREIGN_PID_TAKEOVER_GRACE_MS,
  decideLockAcquisition,
  isPidAlive,
} from '../src/commands/autopilot.ts';
import {
  looksLikeGbrainAutopilotCommand,
  readProcessCommand,
} from '../src/core/autopilot-lock.ts';

let tmp: string;
let lockPath: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'gbrain-autopilot-lock-'));
  lockPath = join(tmp, 'autopilot.lock');
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('isPidAlive', () => {
  test('returns true for the current process', () => {
    expect(isPidAlive(process.pid)).toBe(true);
  });

  test('returns false for invalid process ids', () => {
    expect(isPidAlive(0)).toBe(false);
    expect(isPidAlive(-1)).toBe(false);
    expect(isPidAlive(Number.NaN)).toBe(false);
    expect(isPidAlive(Number.POSITIVE_INFINITY)).toBe(false);
  });
});

describe('decideLockAcquisition', () => {
  test('acquires when no lock exists', () => {
    expect(decideLockAcquisition(lockPath, process.pid)).toEqual({ action: 'acquire' });
  });

  test('takes over a lock whose holder is dead', () => {
    writeFileSync(lockPath, '4194303');
    expect(decideLockAcquisition(lockPath, process.pid)).toEqual({
      action: 'takeover',
      reason: 'dead pid 4194303',
    });
  });

  test('keeps a lock whose holder is a live gbrain autopilot process', () => {
    writeFileSync(lockPath, '1234');
    expect(decideLockAcquisition(lockPath, process.pid, {
      isPidAlive: (pid) => pid === 1234,
      readProcessCommand: () => 'gbrain autopilot --repo repo',
    })).toEqual({
      action: 'exit',
      holderPid: 1234,
    });
  });

  test('keeps a fresh lock when the live PID command is unrecognized', () => {
    writeFileSync(lockPath, '1234');
    expect(decideLockAcquisition(lockPath, process.pid, {
      isPidAlive: (pid) => pid === 1234,
      readProcessCommand: () => '/sbin/launchd',
    })).toEqual({
      action: 'exit',
      holderPid: 1234,
    });
  });

  test('takes over a stale lock when the PID was reused by a foreign process', () => {
    writeFileSync(lockPath, '1234');
    const stale = new Date(Date.now() - AUTOPILOT_FOREIGN_PID_TAKEOVER_GRACE_MS - 1000);
    utimesSync(lockPath, stale, stale);
    expect(decideLockAcquisition(lockPath, process.pid, {
      isPidAlive: (pid) => pid === 1234,
      readProcessCommand: () => '/sbin/launchd',
    })).toEqual({
      action: 'takeover',
      reason: 'foreign pid 1234 with stale lock',
    });
  });

  test('keeps a fresh live lock when process identity cannot be inspected', () => {
    writeFileSync(lockPath, '1234');
    expect(decideLockAcquisition(lockPath, process.pid, {
      isPidAlive: (pid) => pid === 1234,
      readProcessCommand: () => null,
    })).toEqual({
      action: 'exit',
      holderPid: 1234,
    });
  });

  test('takes over a stale lock when process identity cannot be inspected', () => {
    writeFileSync(lockPath, '1234');
    const stale = new Date(Date.now() - AUTOPILOT_FOREIGN_PID_TAKEOVER_GRACE_MS - 1000);
    utimesSync(lockPath, stale, stale);
    expect(decideLockAcquisition(lockPath, process.pid, {
      isPidAlive: (pid) => pid === 1234,
      readProcessCommand: () => null,
    })).toEqual({
      action: 'takeover',
      reason: 'unknown pid 1234 with stale lock',
    });
  });

  test('grace-period boundary: exits just before the threshold, takes over at/after it (unknown identity)', () => {
    writeFileSync(lockPath, '1234');
    const deps = {
      isPidAlive: (pid: number) => pid === 1234,
      readProcessCommand: () => null,
    };

    const justUnderGrace = new Date(Date.now() - AUTOPILOT_FOREIGN_PID_TAKEOVER_GRACE_MS + 1000);
    utimesSync(lockPath, justUnderGrace, justUnderGrace);
    expect(decideLockAcquisition(lockPath, process.pid, deps)).toEqual({
      action: 'exit',
      holderPid: 1234,
    });

    const atGrace = new Date(Date.now() - AUTOPILOT_FOREIGN_PID_TAKEOVER_GRACE_MS);
    utimesSync(lockPath, atGrace, atGrace);
    expect(decideLockAcquisition(lockPath, process.pid, deps).action).toBe('takeover');
  });

  test('takes over malformed and empty locks', () => {
    writeFileSync(lockPath, 'not-a-pid');
    expect(decideLockAcquisition(lockPath, process.pid).action).toBe('takeover');
    writeFileSync(lockPath, '');
    expect(decideLockAcquisition(lockPath, process.pid).action).toBe('takeover');
  });
});

describe('readProcessCommand', () => {
  test('reads Linux procfs cmdline without spawning ps', () => {
    let psCalls = 0;
    expect(readProcessCommand(1234, {
      platform: 'linux',
      readFileSync: (path, encoding) => {
        expect(path).toBe('/proc/1234/cmdline');
        expect(encoding).toBe('utf8');
        return 'bun\0/usr/local/bin/gbrain\0autopilot\0--repo\0repo\0';
      },
      execFileSync: () => {
        psCalls++;
        return 'unexpected';
      },
    })).toBe('bun /usr/local/bin/gbrain autopilot --repo repo');
    expect(psCalls).toBe(0);
  });

  test('falls back to ps on hosts without Linux procfs', () => {
    let procReads = 0;
    expect(readProcessCommand(1234, {
      platform: 'darwin',
      readFileSync: () => {
        procReads++;
        return 'unexpected';
      },
      execFileSync: (file, args, options) => {
        expect(file).toBe('ps');
        expect(args).toEqual(['-p', '1234', '-o', 'args=']);
        expect(options.timeout).toBe(1000);
        return 'gbrain autopilot --repo repo\n';
      },
    })).toBe('gbrain autopilot --repo repo');
    expect(procReads).toBe(0);
  });
});

describe('looksLikeGbrainAutopilotCommand', () => {
  test('matches packaged and source-tree autopilot invocations', () => {
    expect(looksLikeGbrainAutopilotCommand('gbrain autopilot --repo repo')).toBe(true);
    expect(looksLikeGbrainAutopilotCommand('./gbrain/src/cli.ts autopilot')).toBe(true);
    expect(looksLikeGbrainAutopilotCommand('bun src/cli.ts autopilot --repo repo')).toBe(true);
  });

  test('rejects unrelated live processes', () => {
    expect(looksLikeGbrainAutopilotCommand('/sbin/launchd')).toBe(false);
    expect(looksLikeGbrainAutopilotCommand('/usr/bin/python worker.py')).toBe(false);
  });
});
