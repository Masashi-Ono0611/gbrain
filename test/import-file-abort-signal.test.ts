import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { importFile, importFromContent, importCodeFile } from '../src/core/import-file.ts';
import type { BrainEngine } from '../src/core/engine.ts';

const TMP = join(import.meta.dir, '.tmp-import-abort-test');

// Same Proxy engine as import-file.test.ts (kept in sync with that file's
// pageStore-backed mock — see its comment for the override/store merge
// rationale): tracks calls, simulates a real DB index via an in-memory
// pageStore so the post-write verifyPageReadable guard in import-file.ts
// sees the page it just wrote instead of unconditionally missing it.
// transaction just invokes the callback; per-method overrides remain
// available for abort-mid-flight probes.
function mockEngine(overrides: Partial<Record<string, any>> = {}): BrainEngine {
  const calls: { method: string; args: any[] }[] = [];
  // In-memory page store: slug → page row (simulates a real DB index).
  const pageStore = new Map<string, { slug: string; content_hash: string; title: string; type: string; frontmatter: Record<string, unknown> }>();
  const track = (method: string) => (...args: any[]) => {
    calls.push({ method, args });
    if (overrides[method]) return overrides[method](...args);
    return Promise.resolve(null);
  };
  const engine = new Proxy({} as any, {
    get(_, prop: string) {
      if (prop === '_calls') return calls;
      if (prop === 'getTags') return overrides.getTags || (() => Promise.resolve([]));
      if (prop === 'getPage') {
        return async (slug: string, opts?: { sourceId?: string }) => {
          if (overrides.getPage) {
            const overrideResult = await overrides.getPage(slug, opts);
            if (overrideResult) {
              const stored = pageStore.get(slug);
              if (stored) {
                return { ...overrideResult, content_hash: stored.content_hash };
              }
              return overrideResult;
            }
          }
          return pageStore.get(slug) ?? null;
        };
      }
      if (prop === 'putPage') {
        return async (slug: string, page: { content_hash?: string; title?: string; type?: string; frontmatter?: Record<string, unknown> }, _opts?: { sourceId?: string }) => {
          calls.push({ method: 'putPage', args: [slug, page, _opts] });
          if (overrides.putPage) overrides.putPage(slug, page, _opts);
          pageStore.set(slug, {
            slug,
            content_hash: page.content_hash ?? '',
            title: page.title ?? '',
            type: page.type ?? '',
            frontmatter: page.frontmatter ?? {},
          });
          return Promise.resolve(undefined);
        };
      }
      if (prop === 'transaction') return async (fn: (tx: BrainEngine) => Promise<any>) => fn(engine);
      return track(prop);
    },
  });
  return engine;
}

const MD = `---
type: concept
title: Abort Test
---

Body content for the abort test page.
`;

function putPageCalls(engine: BrainEngine): number {
  return (engine as any)._calls.filter((c: { method: string }) => c.method === 'putPage').length;
}

beforeAll(() => {
  mkdirSync(TMP, { recursive: true });
});

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe('importFromContent — #1950 cooperative cancellation', () => {
  test('pre-aborted signal throws AbortError before any DB write', async () => {
    const engine = mockEngine();
    const controller = new AbortController();
    controller.abort();
    await expect(
      importFromContent(engine, 'concepts/abort-a', MD, { noEmbed: true, signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(putPageCalls(engine)).toBe(0);
  });

  test('signal firing mid-flight (during getPage) is caught at the pre-DB-write boundary', async () => {
    const controller = new AbortController();
    const engine = mockEngine({
      getPage: async () => {
        controller.abort(); // fires after the post-parse check has passed
        return null;
      },
    });
    await expect(
      importFromContent(engine, 'concepts/abort-b', MD, { noEmbed: true, signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(putPageCalls(engine)).toBe(0);
  });

  test('unset signal imports exactly as before', async () => {
    const engine = mockEngine();
    const result = await importFromContent(engine, 'concepts/no-signal', MD, { noEmbed: true });
    expect(result.status).toBe('imported');
    expect(putPageCalls(engine)).toBe(1);
  });

  test('non-aborted signal imports normally', async () => {
    const engine = mockEngine();
    const controller = new AbortController();
    const result = await importFromContent(engine, 'concepts/live-signal', MD, {
      noEmbed: true,
      signal: controller.signal,
    });
    expect(result.status).toBe('imported');
    expect(putPageCalls(engine)).toBe(1);
  });
});

describe('importFile — #1950 entry boundary', () => {
  test('pre-aborted signal refuses before reading the file', async () => {
    const filePath = join(TMP, 'abort-entry.md');
    writeFileSync(filePath, MD);
    const engine = mockEngine();
    const controller = new AbortController();
    controller.abort();
    await expect(
      importFile(engine, filePath, 'concepts/abort-entry.md', { noEmbed: true, signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(putPageCalls(engine)).toBe(0);
  });
});

describe('importCodeFile — #1950 cooperative cancellation', () => {
  const CODE = 'export function hello(): string {\n  return "world";\n}\n';

  test('pre-aborted signal throws before any DB write', async () => {
    const engine = mockEngine();
    const controller = new AbortController();
    controller.abort();
    await expect(
      importCodeFile(engine, 'src/hello.ts', CODE, { noEmbed: true, signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(putPageCalls(engine)).toBe(0);
  });

  test('abort firing during getPage does NOT fall through to the vectorless-landing path', async () => {
    // The embed try/catch swallows embed errors so code files land without
    // vectors on provider hiccups — an abort must escape that swallow, or a
    // cancelled sync would half-land the file. The pre-embed throwIfAborted
    // sits INSIDE the try, so this exercises the catch's signal-authority
    // re-raise (throwIfAborted, not exception-name matching).
    const controller = new AbortController();
    const engine = mockEngine({
      getPage: async () => {
        controller.abort();
        return null;
      },
    });
    await expect(
      importCodeFile(engine, 'src/hello.ts', CODE, { signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(putPageCalls(engine)).toBe(0);
  });

  test('unset signal keeps the vectorless-landing path for real embed failures', async () => {
    const engine = mockEngine();
    const result = await importCodeFile(engine, 'src/hello.ts', CODE, { noEmbed: true });
    expect(result.status).toBe('imported');
    expect(putPageCalls(engine)).toBe(1);
  });
});
