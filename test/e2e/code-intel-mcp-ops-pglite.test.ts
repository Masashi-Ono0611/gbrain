/**
 * v0.34 W3 — MCP exposure of code-intel ops.
 *
 * Pre-v0.34 code-callers / code-callees / code-def / code-refs lived in
 * CLI_ONLY at cli.ts:30. Agents calling gbrain via MCP couldn't reach
 * them and fell through to text search.
 *
 * This E2E pins:
 *   - All four ops appear in the operations registry with scope:'read'.
 *   - Tool descriptions match the constants in operations-descriptions.ts
 *     so the LLM tool-selection prompt sees the right wording (D10 fix).
 *   - Each op routes to the right engine method / library function and
 *     returns the documented envelope shape.
 *   - Source scoping honors ctx.sourceId and the per-call source_id /
 *     all_sources params.
 *
 * PGLite in-memory.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { operations, operationsByName } from '../../src/core/operations.ts';
import {
  CODE_CALLERS_DESCRIPTION,
  CODE_CALLEES_DESCRIPTION,
  CODE_DEF_DESCRIPTION,
  CODE_REFS_DESCRIPTION,
} from '../../src/core/operations-descriptions.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';
import type { GBrainConfig } from '../../src/core/config.ts';
import type { Logger } from '../../src/core/operations.ts';

let engine: PGLiteEngine;

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
});

describe('v0.34 W3 — code-intel MCP ops registered', () => {
  test('code_callers exists with scope:read and v0.34 description', () => {
    expect(operationsByName.code_callers).toBeDefined();
    expect(operationsByName.code_callers!.scope).toBe('read');
    expect(operationsByName.code_callers!.description).toBe(CODE_CALLERS_DESCRIPTION);
  });

  test('code_callees exists with scope:read and v0.34 description', () => {
    expect(operationsByName.code_callees).toBeDefined();
    expect(operationsByName.code_callees!.scope).toBe('read');
    expect(operationsByName.code_callees!.description).toBe(CODE_CALLEES_DESCRIPTION);
  });

  test('code_def exists with scope:read and v0.34 description', () => {
    expect(operationsByName.code_def).toBeDefined();
    expect(operationsByName.code_def!.scope).toBe('read');
    expect(operationsByName.code_def!.description).toBe(CODE_DEF_DESCRIPTION);
  });

  test('code_refs exists with scope:read and v0.34 description', () => {
    expect(operationsByName.code_refs).toBeDefined();
    expect(operationsByName.code_refs!.scope).toBe('read');
    expect(operationsByName.code_refs!.description).toBe(CODE_REFS_DESCRIPTION);
  });

  test('all four code_* ops have a symbol param marked required', () => {
    for (const opName of ['code_callers', 'code_callees', 'code_def', 'code_refs']) {
      const op = operationsByName[opName];
      expect(op).toBeDefined();
      expect(op!.params.symbol).toBeDefined();
      expect(op!.params.symbol!.required).toBe(true);
    }
  });
});

describe('v0.34 W3 — code_callers / code_callees route to the engine', () => {
  test('code_callers finds direct callers', async () => {
    await seedTwoFileGraph(engine);
    const ctx = makeCtx(engine, 'source-a');
    const op = operationsByName.code_callers!;
    const result = (await op.handler(ctx, { symbol: 'parseMarkdown' })) as {
      symbol: string;
      count: number;
      callers: Array<{ from_symbol_qualified: string; to_symbol_qualified: string }>;
    };
    expect(result.symbol).toBe('parseMarkdown');
    expect(result.count).toBeGreaterThanOrEqual(1);
    const fromNames = result.callers.map((c) => c.from_symbol_qualified);
    expect(fromNames).toContain('callerInA');
  });

  test('code_callees finds direct callees', async () => {
    await seedTwoFileGraph(engine);
    const ctx = makeCtx(engine, 'source-a');
    const op = operationsByName.code_callees!;
    const result = (await op.handler(ctx, { symbol: 'callerInA' })) as {
      symbol: string;
      count: number;
      callees: Array<{ from_symbol_qualified: string; to_symbol_qualified: string }>;
    };
    expect(result.symbol).toBe('callerInA');
    expect(result.count).toBeGreaterThanOrEqual(1);
    const toNames = result.callees.map((c) => c.to_symbol_qualified);
    expect(toNames).toContain('parseMarkdown');
  });
});

describe('v0.34 W3 — code_callers source scoping', () => {
  test('honors ctx.sourceId by default', async () => {
    await seedCrossSourceGraph(engine);
    const ctx = makeCtx(engine, 'source-a');
    const op = operationsByName.code_callers!;
    const result = (await op.handler(ctx, { symbol: 'parseMarkdown' })) as {
      callers: Array<{ source_id: string | null }>;
    };
    // Should only see callers from source-a; source-b's caller MUST NOT leak
    for (const c of result.callers) {
      expect(c.source_id === 'source-a' || c.source_id === null).toBe(true);
    }
  });

  test('all_sources=true forces cross-source', async () => {
    await seedCrossSourceGraph(engine);
    const ctx = makeCtx(engine, 'source-a');
    const op = operationsByName.code_callers!;
    const result = (await op.handler(ctx, { symbol: 'parseMarkdown', all_sources: true })) as {
      callers: Array<{ source_id: string | null }>;
    };
    const sources = new Set(result.callers.map((c) => c.source_id));
    // Both sources represented when all_sources is set
    expect(sources.has('source-a')).toBe(true);
    expect(sources.has('source-b')).toBe(true);
  });

  test("source_id='__all__' is equivalent to all_sources=true", async () => {
    await seedCrossSourceGraph(engine);
    const ctx = makeCtx(engine, 'source-a');
    const op = operationsByName.code_callers!;
    const result = (await op.handler(ctx, { symbol: 'parseMarkdown', source_id: '__all__' })) as {
      callers: Array<{ source_id: string | null }>;
    };
    const sources = new Set(result.callers.map((c) => c.source_id));
    expect(sources.has('source-a')).toBe(true);
    expect(sources.has('source-b')).toBe(true);
  });
});

describe('v0.34 W3 — code_def finds definition sites', () => {
  test('returns a definition for a seeded function symbol', async () => {
    await seedDefSite(engine);
    const ctx = makeCtx(engine, 'source-a');
    const op = operationsByName.code_def!;
    const result = (await op.handler(ctx, { symbol: 'parseMarkdown' })) as {
      symbol: string;
      count: number;
      defs: Array<{ slug: string; symbol_type: string | null }>;
    };
    expect(result.symbol).toBe('parseMarkdown');
    expect(result.count).toBe(1);
    expect(result.defs[0]!.symbol_type).toBe('function');
  });
});

describe('#1780 Gap 1 — readiness envelope on code_* ops', () => {
  test('code_callers carries status:ready when callers are found', async () => {
    await seedTwoFileGraph(engine);
    const ctx = makeCtx(engine, 'source-a');
    const result = (await operationsByName.code_callers!.handler(ctx, { symbol: 'parseMarkdown' })) as {
      count: number; status: string; ready: boolean;
    };
    expect(result.count).toBeGreaterThanOrEqual(1);
    expect(result.status).toBe('ready');
    expect(result.ready).toBe(true);
  });

  test('code_callers → indexing when code exists but edges unresolved + no callers', async () => {
    // callerInA has no callers; seeded chunks have edges_backfilled_at = NULL.
    await seedTwoFileGraph(engine);
    const ctx = makeCtx(engine, 'source-a');
    const result = (await operationsByName.code_callers!.handler(ctx, { symbol: 'callerInA' })) as {
      count: number; status: string; ready: boolean;
    };
    expect(result.count).toBe(0);
    expect(result.status).toBe('indexing');
    expect(result.ready).toBe(false);
  });

  test('code_def → not_built on an empty brain', async () => {
    const ctx = makeCtx(engine, 'source-a');
    const result = (await operationsByName.code_def!.handler(ctx, { symbol: 'anything' })) as {
      count: number; status: string; ready: boolean;
    };
    expect(result.count).toBe(0);
    expect(result.status).toBe('not_built');
    expect(result.ready).toBe(false);
  });

  test('code_def → ready when a definition exists (brain-wide)', async () => {
    await seedDefSite(engine);
    const ctx = makeCtx(engine, 'source-a');
    const result = (await operationsByName.code_def!.handler(ctx, { symbol: 'parseMarkdown' })) as {
      count: number; status: string; ready: boolean;
    };
    expect(result.count).toBe(1);
    expect(result.status).toBe('ready');
    expect(result.ready).toBe(true);
  });

  test('code_refs → not_built on an empty brain', async () => {
    const ctx = makeCtx(engine, 'source-a');
    const result = (await operationsByName.code_refs!.handler(ctx, { symbol: 'anything' })) as {
      count: number; status: string; ready: boolean;
    };
    expect(result.status).toBe('not_built');
    expect(result.ready).toBe(false);
  });
});

describe('#3707 — out_of_scope must never cross a remote caller\'s grant', () => {
  // Adversarial regression guard (Codex review flagged this as a Critical
  // during #3707's review): resolveCodeReadiness's out_of_scope signal
  // reveals whether code exists OUTSIDE the caller's scope. That's fine for
  // trusted local CLI callers, but for a remote/grant-restricted caller it
  // would be a cross-grant existence leak if it ever reached the response.
  // Today it doesn't (code_callers/code_callees/code_def/code_refs in
  // ops/code-intel.ts spread only {status, ready} from the readiness
  // object, never the whole thing or readinessHint()'s text) — this test
  // pins that behavior so a future "helpful" `...readiness` refactor, or
  // an added `hint: readinessHint(readiness)` line, would fail loudly
  // instead of silently leaking. Asserts the FULL response key set (not
  // just "no out_of_scope key") so a leak via a differently-named field
  // (e.g. a nested `readiness` object, or `hint`) is caught too. Covers
  // both scoped handlers (code_callers AND code_callees) — code_def/
  // code_refs are brain-wide by design (see ops/code-intel.ts) and can't
  // reach this path at all: they call resolveCodeReadiness with no
  // sourceId, so the new probe structurally never fires for them.
  test.each(['code_callers', 'code_callees'] as const)(
    '%s response has no out_of_scope/readiness leak for a remote caller whose grant excludes the source with code',
    async (opName) => {
      await registerSource(engine, 'source-a'); // granted, empty of code
      await registerSource(engine, 'source-b'); // has code, NOT granted
      const pageB = await insertCodePage(engine, 'source-b', 'src/foo.ts');
      await insertChunk(engine, pageB, 0, 'parseMarkdown', 'function');

      const remoteCtx: any = {
        engine,
        config: { engine: 'pglite' as const },
        logger: { info: () => {}, warn: () => {}, error: () => {} },
        dryRun: false,
        remote: true,
        auth: { token: 't', clientId: 'c', scopes: ['read'], allowedSources: ['source-a'] },
      };
      const result = await operationsByName[opName]!.handler(remoteCtx, { symbol: 'parseMarkdown' });
      const edgesKey = opName === 'code_callers' ? 'callers' : 'callees';
      expect(Object.keys(result as object).sort()).toEqual(['count', 'ready', 'status', 'symbol', edgesKey].sort());
      expect((result as { status: string }).status).toBe('not_built');

      // Positive control: prove the HANDLER's own internal call to
      // resolveCodeReadiness genuinely computes out_of_scope: true for this
      // exact scenario (same engine state, same scope) — not just that the
      // bare helper can return true in isolation. Otherwise the assertion
      // above could pass vacuously because the dangerous state never got
      // computed on this code path in the first place.
      const { resolveCodeReadiness } = await import('../../src/core/code-graph-readiness.ts');
      const direct = await resolveCodeReadiness(engine, { kind: 'edge', count: 0, sourceId: 'source-a' });
      expect(direct.out_of_scope).toBe(true);
    },
  );
});

// ─────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────

async function seedTwoFileGraph(engine: PGLiteEngine): Promise<void> {
  await registerSource(engine, 'source-a');
  const pageA = await insertCodePage(engine, 'source-a', 'src/foo.ts');
  const pageA2 = await insertCodePage(engine, 'source-a', 'src/caller.ts');
  await insertChunk(engine, pageA, 0, 'parseMarkdown', 'function');
  const callerChunk = await insertChunk(engine, pageA2, 0, 'callerInA', 'function');
  await insertUnresolvedEdge(engine, callerChunk, 'callerInA', 'parseMarkdown', 'source-a');
}

async function seedCrossSourceGraph(engine: PGLiteEngine): Promise<void> {
  await registerSource(engine, 'source-a');
  await registerSource(engine, 'source-b');
  // Source A: callerInA → parseMarkdown
  const pageA = await insertCodePage(engine, 'source-a', 'src/foo.ts');
  const pageA2 = await insertCodePage(engine, 'source-a', 'src/caller.ts');
  await insertChunk(engine, pageA, 0, 'parseMarkdown', 'function');
  const callerA = await insertChunk(engine, pageA2, 0, 'callerInA', 'function');
  await insertUnresolvedEdge(engine, callerA, 'callerInA', 'parseMarkdown', 'source-a');
  // Source B: callerInB → parseMarkdown (same symbol name, different source)
  const pageB = await insertCodePage(engine, 'source-b', 'src/foo.ts');
  const pageB2 = await insertCodePage(engine, 'source-b', 'src/caller.ts');
  await insertChunk(engine, pageB, 0, 'parseMarkdown', 'function');
  const callerB = await insertChunk(engine, pageB2, 0, 'callerInB', 'function');
  await insertUnresolvedEdge(engine, callerB, 'callerInB', 'parseMarkdown', 'source-b');
}

async function seedDefSite(engine: PGLiteEngine): Promise<void> {
  await registerSource(engine, 'source-a');
  const pageA = await insertCodePage(engine, 'source-a', 'src/foo.ts');
  // code-def reads content_chunks.symbol_name (not symbol_name_qualified).
  // Set both to be safe.
  await engine.executeRaw(
    `INSERT INTO content_chunks (page_id, chunk_index, chunk_text, chunk_source, language, symbol_name, symbol_name_qualified, symbol_type, start_line, end_line)
     VALUES ($1, 0, 'export function parseMarkdown(s: string) { return s; }', 'compiled_truth', 'typescript', 'parseMarkdown', 'parseMarkdown', 'function', 1, 3)`,
    [pageA],
  );
}

async function registerSource(engine: PGLiteEngine, id: string): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO sources (id, name, local_path, config, created_at)
     VALUES ($1, $1, $2, '{}'::jsonb, NOW())
     ON CONFLICT (id) DO NOTHING`,
    [id, `/fake/${id}`],
  );
}

async function insertCodePage(engine: PGLiteEngine, sourceId: string, slug: string): Promise<number> {
  const rows = await engine.executeRaw<{ id: number }>(
    `INSERT INTO pages (slug, source_id, title, type, page_kind, compiled_truth, frontmatter, updated_at, created_at)
     VALUES ($1, $2, $3, 'code', 'code', '', '{}'::jsonb, NOW(), NOW())
     RETURNING id`,
    [slug, sourceId, slug],
  );
  return rows[0]!.id;
}

async function insertChunk(
  engine: PGLiteEngine,
  pageId: number,
  chunkIndex: number,
  symbolName: string,
  symbolType: string,
): Promise<number> {
  const rows = await engine.executeRaw<{ id: number }>(
    `INSERT INTO content_chunks (page_id, chunk_index, chunk_text, chunk_source, language, symbol_name, symbol_name_qualified, symbol_type)
     VALUES ($1, $2, $3, 'compiled_truth', 'typescript', $4, $4, $5)
     RETURNING id`,
    [pageId, chunkIndex, `// ${symbolName} body`, symbolName, symbolType],
  );
  return rows[0]!.id;
}

async function insertUnresolvedEdge(
  engine: PGLiteEngine,
  fromChunkId: number,
  fromSymbol: string,
  toSymbol: string,
  sourceId: string,
): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO code_edges_symbol (from_chunk_id, from_symbol_qualified, to_symbol_qualified, edge_type, source_id, edge_metadata)
     VALUES ($1, $2, $3, 'calls', $4, '{}'::jsonb)`,
    [fromChunkId, fromSymbol, toSymbol, sourceId],
  );
}

function makeCtx(engine: PGLiteEngine, sourceId: string): any {
  const logger: Logger = {
    info: () => {},
    warn: () => {},
    error: () => {},
  };
  return {
    engine,
    config: {} as GBrainConfig,
    logger,
    dryRun: false,
    remote: false,
    sourceId,
  };
}
