/**
 * Regressions: file_upload fails closed without storage and uses the connected
 * OperationContext engine when storage is configured.
 *
 * A long-running `gbrain serve` owns the PGLite connection. The handler must not
 * reach for the module-global db singleton, which is intentionally uninitialized
 * in the MCP dispatch path and throws "connect() has not been called".
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveConfig } from '../src/core/config.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';

let engine: PGLiteEngine;
let fixtureDir: string;
let gbrainHome: string;
let storageDir: string;
let originalGbrainHome: string | undefined;

beforeAll(async () => {
  originalGbrainHome = process.env.GBRAIN_HOME;
  gbrainHome = mkdtempSync(join(tmpdir(), 'gbrain-file-upload-home-'));
  process.env.GBRAIN_HOME = gbrainHome;

  engine = new PGLiteEngine();
  await engine.connect({ engine: 'pglite' } as never);
  await engine.initSchema();

  // Remote MCP uploads are intentionally confined to the server working tree.
  fixtureDir = mkdtempSync(join(process.cwd(), '.file-upload-engine-context-'));
  storageDir = join(gbrainHome, 'storage');
});

afterAll(async () => {
  if (engine) await engine.disconnect();
  if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
  if (gbrainHome) rmSync(gbrainHome, { recursive: true, force: true });
  if (originalGbrainHome === undefined) delete process.env.GBRAIN_HOME;
  else process.env.GBRAIN_HOME = originalGbrainHome;
});

describe('file_upload storage contract and engine ownership', () => {
  test('returns storage_error and creates no row when storage is not configured', async () => {
    saveConfig({ engine: 'pglite' });
    const fixture = join(fixtureDir, 'no-storage.txt');
    writeFileSync(fixture, 'must not become metadata only');

    const result = await dispatchToolCall(engine, 'file_upload', {
      path: fixture,
      page_slug: 'concepts/no-storage',
    }, { remote: true, transport: 'stdio', sourceId: 'default' });

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text)).toEqual({
      error: 'storage_error',
      message: 'No storage backend configured. Run `gbrain init` with storage settings.',
    });

    const listed = await dispatchToolCall(engine, 'file_list', {
      slug: 'concepts/no-storage',
    }, { remote: true, transport: 'stdio', sourceId: 'default' });
    expect(listed.isError).toBeFalsy();
    expect(JSON.parse(listed.content[0].text)).toEqual([]);
  });

  test('uses the MCP context engine instead of the module-global DB singleton', async () => {
    saveConfig({
      engine: 'pglite',
      storage: { backend: 'local', bucket: 'test', localPath: storageDir },
    });
    const fixture = join(fixtureDir, 'capture.json');
    writeFileSync(fixture, '{"source":"camofox"}\n');

    // WP1/D7: file_upload is localOnly — the dispatch backstop only admits
    // the stdio local pipe. This test is about ENGINE ownership, so dispatch
    // as the local surface (transport policy is pinned in
    // test/dispatch-localonly.test.ts).
    const result = await dispatchToolCall(engine, 'file_upload', {
      path: fixture,
      page_slug: 'concepts/example-board',
    }, { remote: true, transport: 'stdio', sourceId: 'default' });

    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.content[0].text)).toEqual({
      status: 'uploaded',
      storage_path: 'concepts/example-board/capture.json',
      size_bytes: 21,
    });
    expect(readFileSync(join(storageDir, 'concepts/example-board/capture.json'), 'utf8'))
      .toBe('{"source":"camofox"}\n');

    const listed = await dispatchToolCall(engine, 'file_list', {
      slug: 'concepts/example-board',
    }, { remote: true, transport: 'stdio', sourceId: 'default' });
    expect(listed.isError).toBeFalsy();
    expect(JSON.parse(listed.content[0].text)).toEqual([
      expect.objectContaining({
        page_slug: 'concepts/example-board',
        storage_path: 'concepts/example-board/capture.json',
      }),
    ]);

    const url = await dispatchToolCall(engine, 'file_url', {
      storage_path: 'concepts/example-board/capture.json',
    }, { remote: true, transport: 'stdio', sourceId: 'default' });
    expect(url.isError).toBeFalsy();
    expect(JSON.parse(url.content[0].text)).toEqual({
      storage_path: 'concepts/example-board/capture.json',
      url: 'gbrain:files/concepts/example-board/capture.json',
    });
  });
});
