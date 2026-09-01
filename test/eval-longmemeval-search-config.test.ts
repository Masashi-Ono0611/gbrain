import { describe, test, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { runEvalLongMemEval } from '../src/commands/eval-longmemeval.ts';
import { createBenchmarkBrain } from '../src/eval/longmemeval/harness.ts';

const FIXTURE_PATH = join(import.meta.dir, 'fixtures', 'longmemeval-mini.jsonl');

async function withTmpDir<T>(fn: (tmp: string) => Promise<T>): Promise<T> {
  const tmp = mkdtempSync(join(tmpdir(), 'lme-search-config-cli-'));
  try {
    return await fn(tmp);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

describe('runEvalLongMemEval — injected search config snapshot', () => {
  test('copies live search-mode/reranker config into the isolated benchmark brain', async () => {
    const engine = await createBenchmarkBrain();
    const tmp = mkdtempSync(join(tmpdir(), 'lme-search-config-'));
    try {
      await runEvalLongMemEval(
        [
          FIXTURE_PATH,
          '--keyword-only',
          '--retrieval-only',
          '--no-trajectory',
          '--limit',
          '1',
          '--output',
          join(tmp, 'out.jsonl'),
          '--mode',
          'tokenmax',
        ],
        {
          engine,
          searchConfigSnapshot: {
            'search.mode': 'balanced',
            'search.reranker.enabled': 'false',
            'search.reranker.model': 'llama-server-reranker:qwen3-reranker-4b',
            'search.reranker.timeout_ms': '30000',
          },
        },
      );

      expect(await engine.getConfig('search.mode')).toBe('tokenmax');
      expect(await engine.getConfig('search.reranker.enabled')).toBe('false');
      expect(await engine.getConfig('search.reranker.model'))
        .toBe('llama-server-reranker:qwen3-reranker-4b');
      expect(await engine.getConfig('search.reranker.timeout_ms')).toBe('30000');
    } finally {
      await engine.disconnect();
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 60_000);
});

describe('runEvalLongMemEval — --search-config CLI flag', () => {
  test('repeatable --search-config KEY=VAL pairs reach the isolated benchmark brain', async () => {
    const engine = await createBenchmarkBrain();
    await withTmpDir(async (tmp) => {
      await runEvalLongMemEval(
        [
          FIXTURE_PATH,
          '--keyword-only',
          '--retrieval-only',
          '--no-trajectory',
          '--limit',
          '1',
          '--output',
          join(tmp, 'out.jsonl'),
          '--search-config',
          'search.reranker.enabled=true',
          '--search-config',
          'search.reranker.model=llama-server-reranker:qwen3-reranker-4b',
        ],
        { engine },
      );

      expect(await engine.getConfig('search.reranker.enabled')).toBe('true');
      expect(await engine.getConfig('search.reranker.model'))
        .toBe('llama-server-reranker:qwen3-reranker-4b');
    });
    await engine.disconnect();
  }, 60_000);

  test('--search-config wins over an injected runOpts.searchConfigSnapshot for the same key', async () => {
    const engine = await createBenchmarkBrain();
    await withTmpDir(async (tmp) => {
      await runEvalLongMemEval(
        [
          FIXTURE_PATH,
          '--keyword-only',
          '--retrieval-only',
          '--no-trajectory',
          '--limit',
          '1',
          '--output',
          join(tmp, 'out.jsonl'),
          '--search-config',
          'search.reranker.enabled=true',
        ],
        {
          engine,
          searchConfigSnapshot: {
            'search.reranker.enabled': 'false',
            // Key with no --search-config counterpart: the snapshot value
            // must still land untouched.
            'search.reranker.timeout_ms': '30000',
          },
        },
      );

      // Explicit CLI flag wins over the programmatic snapshot for the
      // overlapping key...
      expect(await engine.getConfig('search.reranker.enabled')).toBe('true');
      // ...while a snapshot key with no CLI counterpart is untouched.
      expect(await engine.getConfig('search.reranker.timeout_ms')).toBe('30000');
    });
    await engine.disconnect();
  }, 60_000);

  test('--search-config VALUE-with-no-equals throws a clear usage error', () => {
    expect(runEvalLongMemEval([FIXTURE_PATH, '--search-config', 'noequalssign'], {}))
      .rejects.toThrow(/--search-config must be KEY=VAL/);
  });
});
