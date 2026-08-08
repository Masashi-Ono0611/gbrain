/**
 * Unit tests for src/core/pglite-leftovers-check.ts (#3856).
 *
 * Tmp-dir fixtures only — fake store dirs with real files, no engine, no
 * network. Mirrors npm-squat-check.test.ts's shape (#505).
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assessPgliteLeftovers,
  isPgliteStoreName,
  SIZE_WALK_MAX_ENTRIES,
} from '../src/core/pglite-leftovers-check.ts';

let root: string;

/** A gbrain-home fixture; returns its path. */
function makeHome(name: string): string {
  const home = join(root, name);
  mkdirSync(home, { recursive: true });
  return home;
}

/** Lay down a fake pglite store dir with a few sized files. */
function makeStore(home: string, dirName: string, fileBytes: number[]): string {
  const dir = join(home, dirName);
  mkdirSync(join(dir, 'nested'), { recursive: true });
  fileBytes.forEach((n, i) => {
    writeFileSync(join(dir, i === 0 ? 'base' : `nested/f${i}`), Buffer.alloc(n, 65));
  });
  return dir;
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'pglite-leftovers-'));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('isPgliteStoreName', () => {
  test('matches the store itself and dotted siblings, nothing else', () => {
    expect(isPgliteStoreName('brain.pglite')).toBe(true);
    expect(isPgliteStoreName('brain.pglite.pre-migrate-20260524')).toBe(true);
    expect(isPgliteStoreName('brain.pglite.bak')).toBe(true);
    expect(isPgliteStoreName('brain.pglite2')).toBe(false); // no separator — a different name
    expect(isPgliteStoreName('brain-pages')).toBe(false);
    expect(isPgliteStoreName('pglite')).toBe(false);
  });
});

describe('assessPgliteLeftovers', () => {
  test('skips on a pglite engine — the store is live, not a leftover', () => {
    const home = makeHome('live-pglite');
    makeStore(home, 'brain.pglite', [1024]);
    expect(assessPgliteLeftovers('pglite', home).status).toBe('skip');
  });

  test('skips when the engine is unknown/unreadable (fail open, never accuse)', () => {
    const home = makeHome('unknown-engine');
    makeStore(home, 'brain.pglite', [1024]);
    expect(assessPgliteLeftovers(undefined, home).status).toBe('skip');
    expect(assessPgliteLeftovers(null, home).status).toBe('skip');
    expect(assessPgliteLeftovers('', home).status).toBe('skip');
  });

  test('skips when the home itself is unreadable (fail open)', () => {
    expect(assessPgliteLeftovers('postgres', join(root, 'no-such-home')).status).toBe('skip');
  });

  test('ok on a postgres brain with no leftover dirs', () => {
    const home = makeHome('clean-postgres');
    mkdirSync(join(home, 'brain-pages'));
    const a = assessPgliteLeftovers('postgres', home);
    expect(a.status).toBe('ok');
    expect(a.leftovers).toHaveLength(0);
    expect(a.message).toContain('postgres');
  });

  test('a brain.pglite FILE (not dir) is ignored — only directories are stores', () => {
    const home = makeHome('file-not-dir');
    writeFileSync(join(home, 'brain.pglite'), 'not a directory');
    expect(assessPgliteLeftovers('postgres', home).status).toBe('ok');
  });

  test('warns on a postgres brain with both the store and its pre-migrate copy', () => {
    const home = makeHome('migrated');
    const live = makeStore(home, 'brain.pglite', [4096, 2048]);
    const pre = makeStore(home, 'brain.pglite.pre-migrate-20260524', [4096]);
    // Freeze mtimes at a known date — the in-the-wild signature (#3856).
    const frozen = new Date('2026-05-24T02:38:42Z');
    utimesSync(live, frozen, frozen);
    utimesSync(pre, frozen, frozen);

    const a = assessPgliteLeftovers('postgres', home);
    expect(a.status).toBe('warn');
    expect(a.leftovers).toHaveLength(2);
    // Deterministic order (sorted): the store first, then the dotted copy.
    expect(a.leftovers[0]?.path).toBe(live);
    expect(a.leftovers[1]?.path).toBe(pre);
    expect(a.leftovers[0]?.approx_bytes).toBe(4096 + 2048);
    expect(a.leftovers[1]?.approx_bytes).toBe(4096);
    // The message carries the receipts: paths, sizes, frozen date, manual remediation.
    expect(a.message).toContain(live);
    expect(a.message).toContain(pre);
    expect(a.message).toContain('untouched since 2026-05-24');
    expect(a.message).toContain('safe to delete by hand');
    expect(a.message).toContain('backup');
    // #3697 guard: the remediation must not invent a CLI surface.
    expect(a.message).not.toMatch(/gbrain (cleanup|migrate cleanup|prune)/);
  });

  test('warns for a pre-migrate copy alone (store already hand-deleted)', () => {
    const home = makeHome('half-cleaned');
    makeStore(home, 'brain.pglite.pre-migrate-20260101', [512]);
    const a = assessPgliteLeftovers('postgres', home);
    expect(a.status).toBe('warn');
    expect(a.leftovers).toHaveLength(1);
  });

  test('size walk is bounded: a huge tree reports a truncated floor, not a stall', () => {
    const home = makeHome('huge');
    const dir = join(home, 'brain.pglite');
    mkdirSync(dir, { recursive: true });
    // More entries than the walk budget — each 1 byte.
    for (let i = 0; i < SIZE_WALK_MAX_ENTRIES + 50; i++) {
      writeFileSync(join(dir, `f${i}`), 'x');
    }
    const a = assessPgliteLeftovers('postgres', home);
    expect(a.status).toBe('warn');
    expect(a.leftovers[0]?.size_truncated).toBe(true);
    expect(a.leftovers[0]?.approx_bytes).toBeGreaterThan(0);
    expect(a.leftovers[0]?.approx_bytes).toBeLessThanOrEqual(SIZE_WALK_MAX_ENTRIES);
    expect(a.message).toContain('at least ');
  });
});
