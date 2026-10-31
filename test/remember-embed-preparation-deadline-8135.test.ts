import { afterAll, expect, test } from 'bun:test';
import { __setEmbedTransportForTests, configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { prepareFactEmbedding } from '../src/core/facts/single-prepare.ts';
import { LEGACY_EMBEDDING_CONFIG } from './helpers/legacy-embedding-config.ts';

afterAll(() => {
  __setEmbedTransportForTests(null);
  resetGateway();
});

test('a fact embed timeout degrades before the caller preparation deadline', async () => {
  configureGateway({ ...LEGACY_EMBEDDING_CONFIG, env: { OPENAI_API_KEY: 'fixture-key' } });
  __setEmbedTransportForTests(async ({ abortSignal }: { abortSignal: AbortSignal }) =>
    await new Promise((_resolve, reject) => {
      const abort = () => reject(abortSignal.reason);
      if (abortSignal.aborted) abort();
      else abortSignal.addEventListener('abort', abort, { once: true });
    }) as never);

  const preparation = new AbortController();
  const outerDeadline = setTimeout(() => preparation.abort({ code: 'preparation_deadline' }), 50);
  const outcome = await prepareFactEmbedding('Synthetic remembered fact', preparation.signal, false, 5).then(
    value => ({ kind: 'resolved' as const, value }),
    error => ({ kind: 'rejected' as const, error }),
  );
  clearTimeout(outerDeadline);

  expect(outcome).toEqual({ kind: 'resolved', value: { embedding: null, embedding_model: null, degraded: true } });
});
