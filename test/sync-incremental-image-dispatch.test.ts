/**
 * #2683 — incremental `gbrain sync` never dispatched changed image files to
 * `importImageFile`; only `sync --full`'s walker did. Two independent bugs
 * combined to strand images:
 *
 *   1. `isAllowedByStrategy` in `src/core/sync.ts` admitted images under the
 *      'auto' strategy's multimodal gate, but NOT under 'markdown' (the
 *      DEFAULT strategy for a bare `gbrain sync`) — so a changed image was
 *      silently excluded from the git-diff manifest before dispatch was even
 *      reached. No failure, no log line: the source anchor (last_commit)
 *      still advanced past the commit, so the image could never be picked up
 *      by a later sync either.
 *   2. Even when an image WAS admitted (e.g. under 'auto'), both incremental
 *      call sites in `src/commands/sync.ts` (the add/modify loop
 *      `importOnePath` and the rename-reimport loop) called `importFile()`
 *      unconditionally — the text/markdown importer — instead of routing to
 *      `importImageFile()` the way `sync --full`'s walker-driven import
 *      already did. PNG/JPEG bytes handed to the text importer misbehave.
 *
 * This test pins the DEFAULT-strategy incremental path end to end: seed a
 * brain with `performSync` (first_sync), commit a new markdown file AND a
 * new image file in the same commit, run `performSync` again (incremental),
 * and assert the resulting page/chunk set includes the image — not just the
 * markdown. Matches issue #2683's own "Suggested fix direction".
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import { tmpdir } from 'os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;
let repoPath: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  repoPath = mkdtempSync(join(tmpdir(), 'gbrain-sync-img-dispatch-'));
  execSync('git init', { cwd: repoPath, stdio: 'pipe' });
  execSync('git config user.email "test@test.com"', { cwd: repoPath, stdio: 'pipe' });
  execSync('git config user.name "Test"', { cwd: repoPath, stdio: 'pipe' });
  mkdirSync(join(repoPath, 'people'), { recursive: true });
  writeFileSync(join(repoPath, 'people/alice-example.md'), [
    '---',
    'type: person',
    'title: Alice Example',
    '---',
    '',
    'Alice is the seed page for the first_sync baseline.',
  ].join('\n'));
  execSync('git add -A && git commit -m "initial"', { cwd: repoPath, stdio: 'pipe' });
});

afterEach(() => {
  if (repoPath) rmSync(repoPath, { recursive: true, force: true });
});

describe('incremental sync image dispatch (#2683)', () => {
  test('a markdown file + an image added in the same commit both land via incremental sync', async () => {
    const { performSync } = await import('../src/commands/sync.ts');

    // Seed: first sync (--no-embed, no multimodal) imports alice and sets
    // the bookmark. This exercises the FULL-sync walker path, not the bug —
    // the regression is specifically in the incremental (diff-based) path
    // exercised by the second performSync call below.
    const first = await performSync(engine, { repoPath, noPull: true, noEmbed: true });
    expect(first.status).toBe('first_sync');
    expect(await engine.getPage('people/alice-example')).not.toBeNull();

    // Commit a new markdown page AND a new image in the SAME commit, so the
    // git diff manifest carries both as 'added' paths for the incremental
    // sync to classify and dispatch.
    writeFileSync(join(repoPath, 'people/bob-example.md'), [
      '---',
      'type: person',
      'title: Bob Example',
      '---',
      '',
      'Bob is a second person page added alongside an image.',
    ].join('\n'));
    mkdirSync(join(repoPath, 'photos'), { recursive: true });
    // Arbitrary bytes are fine: noEmbed:true skips OCR/embed, and the .png
    // extension routes through the pass-through (non-HEIC/AVIF) decode
    // branch of importImageFile, which doesn't validate real PNG structure
    // (test/import-image-file.test.ts's happy-path test does the same).
    writeFileSync(join(repoPath, 'photos/dog.png'), Buffer.from('fake-png-bytes-for-2683-regression-test'));
    execSync('git add -A && git commit -m "add bob and a photo"', { cwd: repoPath, stdio: 'pipe' });

    // No --strategy override — this is the DEFAULT ('markdown') strategy a
    // bare `gbrain sync` uses. Multimodal must be on for images to be
    // syncable at all (matches sync --full's gate); noEmbed avoids needing
    // real embedding credentials.
    let result: Awaited<ReturnType<typeof performSync>>;
    await withEnv({ GBRAIN_EMBEDDING_MULTIMODAL: 'true' }, async () => {
      result = await performSync(engine, { repoPath, noPull: true, noEmbed: true });
    });

    expect(result!.status).toBe('synced');
    expect(result!.added).toBe(2);
    expect(result!.failedFiles ?? 0).toBe(0);

    // The regression: pre-fix, the image was silently excluded from the
    // manifest under the default strategy (bug 1) or, if admitted, handed to
    // the text importer instead of importImageFile (bug 2). Either way the
    // image page would be MISSING here while bob's markdown page (unaffected
    // by the bug) would be present — the exact "included the image, not just
    // the markdown" assertion issue #2683 asked for.
    expect(result!.pagesAffected).toContain('people/bob-example');
    expect(result!.pagesAffected).toContain('photos/dog.png');

    const bobPage = await engine.getPage('people/bob-example');
    expect(bobPage).not.toBeNull();

    const imagePage = await engine.getPage('photos/dog.png');
    expect(imagePage).not.toBeNull();
    expect(imagePage!.type).toBe('image');

    const imageChunks = await engine.getChunks('photos/dog.png');
    expect(imageChunks.length).toBe(1);
    expect((imageChunks[0] as { chunk_source: string }).chunk_source).toBe('image_asset');

    // last_commit (the sync anchor) advanced past the image-bearing commit —
    // confirming the image isn't merely "stranded but retryable" behind an
    // anchor that never moved.
    expect(result!.toCommit).not.toBe(result!.fromCommit);
  });
});
