/**
 * Guardrail CLI boot-hook loader tests (#3688).
 *
 * Covers `loadGuardrailBootModule` (src/core/guardrail-boot.ts) in
 * isolation via the `_import` test seam — no real filesystem imports, no
 * subprocess. The genuine CLI-reachability proof (the module actually gets
 * imported by `main()` and its registered provider actually fires on a real
 * `gbrain import`) lives in test/e2e/guardrail-boot-cli.test.ts; this file
 * is the unit-level contract for the loader's own validation/fail-open
 * behavior.
 */

import { describe, test, expect, afterAll } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadGuardrailBootModule } from '../src/core/guardrail-boot.ts';

describe('loadGuardrailBootModule — unset env (default inert)', () => {
  test('no envPath -> loaded: false, no warning, importer never called', async () => {
    let called = false;
    const result = await loadGuardrailBootModule({
      envPath: '',
      _import: async () => { called = true; return {}; },
    });
    expect(result).toEqual({ loaded: false });
    expect(called).toBe(false);
  });

  test('whitespace-only envPath is treated as unset', async () => {
    const result = await loadGuardrailBootModule({ envPath: '   ' });
    expect(result).toEqual({ loaded: false });
  });
});

describe('loadGuardrailBootModule — validation (fail-open, never throws)', () => {
  test('relative path is rejected with a warning', async () => {
    const result = await loadGuardrailBootModule({ envPath: 'relative/path.ts' });
    expect(result.loaded).toBe(false);
    expect(result.warning).toContain('must be an absolute path');
  });

  test('~-prefixed path is rejected (not absolute, not expanded)', async () => {
    const result = await loadGuardrailBootModule({ envPath: '~/guardrails/my-firewall.ts' });
    expect(result.loaded).toBe(false);
    expect(result.warning).toContain('must be an absolute path');
  });

  test('absolute path that does not exist is rejected with a warning', async () => {
    const result = await loadGuardrailBootModule({
      envPath: '/definitely/does/not/exist/guardrail-module-3688.ts',
    });
    expect(result.loaded).toBe(false);
    expect(result.warning).toContain('does not exist');
  });
});

describe('loadGuardrailBootModule — import + default-export execution', () => {
  let dir: string;

  afterAll(() => {
    if (dir) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ } }
  });

  function makeTempFile(name: string, contents = 'export {};\n'): string {
    dir = dir ?? mkdtempSync(join(tmpdir(), 'gbrain-guardrail-boot-'));
    const p = join(dir, name);
    writeFileSync(p, contents);
    return p;
  }

  test('a real file with no default export loads cleanly', async () => {
    const p = makeTempFile('no-default.ts');
    const result = await loadGuardrailBootModule({ envPath: p });
    expect(result.loaded).toBe(true);
    expect(result.modulePath).toBe(p);
    expect(result.warning).toBeUndefined();
  });

  test('module import failure is caught and reported as a warning, not thrown', async () => {
    const p = makeTempFile('broken.ts');
    const result = await loadGuardrailBootModule({
      envPath: p,
      _import: async () => { throw new Error('boom'); },
    });
    expect(result.loaded).toBe(false);
    expect(result.warning).toContain('failed to import');
    expect(result.warning).toContain('boom');
  });

  test('default export function is awaited', async () => {
    const p = makeTempFile('with-default.ts');
    let ran = false;
    const result = await loadGuardrailBootModule({
      envPath: p,
      _import: async () => ({ default: async () => { ran = true; } }),
    });
    expect(ran).toBe(true);
    expect(result.loaded).toBe(true);
  });

  test('default export throwing is caught and reported as a warning, not thrown', async () => {
    const p = makeTempFile('default-throws.ts');
    const result = await loadGuardrailBootModule({
      envPath: p,
      _import: async () => ({ default: () => { throw new Error('setup failed'); } }),
    });
    expect(result.loaded).toBe(false);
    expect(result.warning).toContain('default export threw');
    expect(result.warning).toContain('setup failed');
  });

  test('a non-function default export is ignored, not called', async () => {
    const p = makeTempFile('default-not-fn.ts');
    const result = await loadGuardrailBootModule({
      envPath: p,
      _import: async () => ({ default: 'not-a-function' }),
    });
    expect(result.loaded).toBe(true);
  });
});
