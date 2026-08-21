/**
 * Regression tests for `gbrain files upload-raw` on small (< 100 MB, non-media)
 * files (#2297).
 *
 * The `!needsCloud` branch used to print `{ success: true, storage: 'git', ... }`
 * and return WITHOUT ever copying the file into the brain repo or inserting a
 * row into the `files` table — every small "raw" upload silently vanished
 * while the command reported success. This pins the fix: the file now lands
 * on disk as a `.raw/` sidecar next to the page, and a `files` row is
 * recorded, for both the `--page` and no-`--page` cases; and a genuinely
 * unpersistable upload (no repo configured) now reports failure instead of a
 * false success.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, spyOn } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createHash } from 'node:crypto';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { resetGateway } from '../src/core/ai/gateway.ts';
import { runFiles } from '../src/commands/files.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { resolvePageFilePath } from '../src/core/markdown.ts';

let engine: PGLiteEngine;
let tmpRoot: string;
let brainDir: string;
let uploadDir: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
  resetGateway();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  resetGateway();
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gbrain-upload-raw-'));
  brainDir = path.join(tmpRoot, 'brain');
  uploadDir = path.join(tmpRoot, 'upload');
  fs.mkdirSync(brainDir, { recursive: true });
  fs.mkdirSync(uploadDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

async function seedPage(slug: string): Promise<void> {
  await importFromContent(engine, slug, `---\ntitle: T\ntype: note\n---\n\n# Body ${slug}\n`, {
    noEmbed: true,
    sourceId: 'default',
    sourcePath: `${slug}.md`,
  });
}

/** Runs runFiles(['upload-raw', ...]) with console.log/error captured. */
async function runUploadRaw(args: string[]): Promise<{ logs: string[]; errs: string[] }> {
  const logs: string[] = [];
  const errs: string[] = [];
  const logSpy = spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(' ')); });
  const errSpy = spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errs.push(a.map(String).join(' ')); });
  try {
    await runFiles(engine, ['upload-raw', ...args]);
  } finally {
    logSpy.mockRestore();
    errSpy.mockRestore();
  }
  return { logs, errs };
}

/** Same as runUploadRaw, but also traps process.exit instead of letting it kill the test runner. */
async function runUploadRawExpectingExit(args: string[]): Promise<{ logs: string[]; errs: string[]; exit: number | null }> {
  const logs: string[] = [];
  const errs: string[] = [];
  let exit: number | null = null;
  const logSpy = spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(' ')); });
  const errSpy = spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errs.push(a.map(String).join(' ')); });
  const exitSpy = spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exit = code ?? 0;
    throw new Error(`EXIT:${code}`);
  }) as never);
  try {
    await runFiles(engine, ['upload-raw', ...args]);
  } catch (e) {
    if (!(e as Error).message.startsWith('EXIT:')) throw e;
  } finally {
    logSpy.mockRestore();
    errSpy.mockRestore();
    exitSpy.mockRestore();
  }
  return { logs, errs, exit };
}

describe('files upload-raw — small file persistence (#2297)', () => {
  test('reproduces the reported repro: small .txt with --page actually persists', async () => {
    await engine.setConfig('sync.repo_path', brainDir);
    await seedPage('people/example');

    const srcFile = path.join(uploadDir, 'r.txt');
    fs.writeFileSync(srcFile, 'hello\n');

    const { logs } = await runUploadRaw([srcFile, '--page', 'people/example']);

    // Prior behavior: success:true with NOTHING written anywhere. Assert the
    // command now BOTH reports success AND actually persisted the file.
    expect(logs.length).toBe(1);
    const out = JSON.parse(logs[0]);
    expect(out.success).toBe(true);
    expect(out.storage).toBe('git');

    // The file must exist on disk as a `.raw/` sidecar alongside the page,
    // per skills/_brain-filing-rules.md's documented convention.
    const pageMd = resolvePageFilePath(brainDir, 'people/example', 'default');
    const expectedSidecar = path.join(path.dirname(pageMd), '.raw', 'example', 'r.txt');
    expect(out.path).toBe(expectedSidecar);
    expect(fs.existsSync(expectedSidecar)).toBe(true);
    expect(fs.readFileSync(expectedSidecar, 'utf8')).toBe('hello\n');

    // The `files` row is what the issue's repro checked directly and found
    // missing — pin that it now exists with the right shape.
    const rows = await engine.executeRaw<{
      page_slug: string; filename: string; storage_path: string;
      mime_type: string | null; size_bytes: number; content_hash: string;
    }>(`SELECT page_slug, filename, storage_path, mime_type, size_bytes, content_hash FROM files WHERE page_slug = $1`, ['people/example']);
    expect(rows.length).toBe(1);
    expect(rows[0].filename).toBe('r.txt');
    expect(rows[0].size_bytes).toBe(6);
    const expectedHash = 'sha256:' + createHash('sha256').update('hello\n').digest('hex');
    expect(rows[0].content_hash).toBe(expectedHash);
    expect(rows[0].storage_path).toBe(path.relative(brainDir, expectedSidecar));
  });

  test('a second upload for the same page+filename upserts (no duplicate row)', async () => {
    await engine.setConfig('sync.repo_path', brainDir);
    await seedPage('people/example');
    const srcFile = path.join(uploadDir, 'r.txt');

    fs.writeFileSync(srcFile, 'v1\n');
    await runUploadRaw([srcFile, '--page', 'people/example']);
    fs.writeFileSync(srcFile, 'v2-longer\n');
    await runUploadRaw([srcFile, '--page', 'people/example']);

    const rows = await engine.executeRaw<{ n: number; size_bytes: number }>(
      `SELECT count(*)::int AS n, max(size_bytes) AS size_bytes FROM files WHERE page_slug = $1`,
      ['people/example'],
    );
    expect(rows[0].n).toBe(1);
    expect(Number(rows[0].size_bytes)).toBe(Buffer.byteLength('v2-longer\n'));

    const pageMd = resolvePageFilePath(brainDir, 'people/example', 'default');
    const sidecar = path.join(path.dirname(pageMd), '.raw', 'example', 'r.txt');
    expect(fs.readFileSync(sidecar, 'utf8')).toBe('v2-longer\n');
  });

  test('no --page: persists under unsorted/.raw/ with a hash-prefixed name', async () => {
    await engine.setConfig('sync.repo_path', brainDir);
    const srcFile = path.join(uploadDir, 'orphan.txt');
    fs.writeFileSync(srcFile, 'no page here');

    const { logs } = await runUploadRaw([srcFile]);
    const out = JSON.parse(logs[0]);
    expect(out.success).toBe(true);
    expect(fs.existsSync(out.path)).toBe(true);

    const hash = createHash('sha256').update('no page here').digest('hex');
    const expectedPath = path.join(brainDir, 'unsorted', '.raw', `${hash.slice(0, 8)}-orphan.txt`);
    expect(out.path).toBe(expectedPath);
    expect(fs.readFileSync(expectedPath, 'utf8')).toBe('no page here');

    const rows = await engine.executeRaw<{ n: number }>(
      `SELECT count(*)::int AS n FROM files WHERE page_slug IS NULL AND filename = 'orphan.txt'`,
    );
    expect(rows[0].n).toBe(1);
  });

  test('no repo configured: reports failure instead of a false success', async () => {
    // sync.repo_path intentionally left unset.
    const srcFile = path.join(uploadDir, 'orphan.txt');
    fs.writeFileSync(srcFile, 'x');

    const { errs, exit } = await runUploadRawExpectingExit([srcFile]);

    expect(exit).toBe(1);
    expect(errs.length).toBeGreaterThan(0);
    const reported = JSON.parse(errs[errs.length - 1]);
    expect(reported.success).toBe(false);
    expect(reported.reason).toBe('no_repo_configured');
  });
});
