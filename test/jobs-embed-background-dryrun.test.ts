/**
 * `gbrain embed --stale --dry-run --background` ran for real.
 *
 * The CLI serializes the flag into the job payload (`dryRun:
 * cleanArgs.includes('--dry-run')` in embed.ts's job-args builder), but the
 * registered `embed` worker handler never read it back, so `runEmbedCore` was
 * invoked without `dryRun`. A backgrounded preview therefore called the
 * embedding provider and wrote vectors — API spend and NULL→vector mutation
 * from an invocation whose whole point was to do neither.
 *
 * Fourth instance of the class in #3594 ("fixing them one at a time will not
 * stop the fourth"), and a different shape from the three listed there: the
 * guard is neither late nor defaulted wrong, it is simply not wired to the
 * flag the CLI already sends. Same test shape as
 * jobs-unify-types-default-dryrun.test.ts (#1575).
 *
 * Behavioral pin: a job whose data carries dryRun must not embed or write.
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MinionWorker } from '../src/core/minions/worker.ts';
import { registerBuiltinHandlers } from '../src/commands/jobs.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

async function embedHandler() {
  const worker = new MinionWorker(engine, { concurrency: 1 });
  await registerBuiltinHandlers(worker, engine);
  const handler = (worker as unknown as {
    handlers: Map<string, (j: unknown) => Promise<unknown>>;
  }).handlers.get('embed');
  if (!handler) throw new Error('embed handler not registered');
  return handler;
}

/** Chunks that exist and carry no embedding — the input a real run consumes. */
async function seedStalePage(slug: string): Promise<void> {
  await engine.putPage(slug, {
    title: slug,
    type: 'note' as never,
    compiled_truth: 'body long enough to chunk and to survive any contentless backstop guard',
    timeline: '',
    frontmatter: {},
    source_path: `${slug}.md`,
  });
  // putPage alone leaves no chunks, and countStaleChunks would then return 0 —
  // the dry-run path would short-circuit and the write assertion below would
  // hold vacuously. Write the chunks directly, with no embedding, so the run
  // has real work to skip.
  await engine.upsertChunks(slug, [
    { chunk_index: 0, chunk_text: 'first chunk of the page', chunk_source: 'compiled_truth' },
    { chunk_index: 1, chunk_text: 'second chunk of the page', chunk_source: 'compiled_truth' },
  ]);
}

async function staleChunkCount(): Promise<number> {
  return await engine.countStaleChunks({});
}

async function embeddedChunkCount(): Promise<number> {
  const rows = (await engine.executeRaw(
    'SELECT count(*)::int AS n FROM content_chunks WHERE embedding IS NOT NULL',
  )) as Array<{ n: number }>;
  return rows[0]?.n ?? 0;
}

describe('embed worker honours dryRun from the job payload (#3594 class)', () => {
  it('a dryRun job embeds nothing', async () => {
    await seedStalePage('bg-dryrun-check');
    // Coverage: without real stale chunks the dry-run path short-circuits and
    // every assertion below would hold for the wrong reason.
    expect(await staleChunkCount()).toBeGreaterThan(0);
    const before = await embeddedChunkCount();

    const handler = await embedHandler();
    // Exactly what `embed --stale --dry-run --background` queues.
    await handler({
      id: 1,
      data: { stale: true, dryRun: true },
      updateProgress: async () => {},
    });

    // Two independent signals, so the guard bites in either environment:
    //
    // Without embedding credentials (CI), a real run cannot even start — it
    // throws EmbeddingCredentialError from the preflight. Reaching this line
    // at all proves the dry-run branch was taken, because a preview has no
    // business needing an API key.
    //
    // With credentials, the run would succeed and write vectors, so the count
    // is what catches it. A dry-run test that only checks the return value
    // still passes while the write happens underneath — #3594's explanation
    // for why this class escapes tests.
    expect(await embeddedChunkCount()).toBe(before);
  }, 60_000);
});
