import { expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import type { GBrainConfig } from '../src/core/config.ts';
import { OperationError } from '../src/core/ops/contract.ts';
import { resolveManagedFactsEmbedding } from '../src/core/persistence/facts-maintenance.ts';

// Protect the job-visible error's DB provenance, invalid keys, and supported repair.
// Removing the appended diagnostic must fail: existing managed-facts tests use
// valid DB config and do not cover this message. No production test seam is needed.
const runtimeConfig: GBrainConfig = {
  engine: 'pglite', embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: 1536,
};

function configEngine(values: Record<string, string>): BrainEngine {
  return { executeRaw: async () => Object.entries(values).map(([key, value]) => ({ key, value })) } as unknown as BrainEngine;
}

test.each([undefined, ''])('unset/empty DB model (%j) still disables facts embedding', async model => {
  const values: Record<string, string> = model === undefined ? {} : { embedding_model: model };
  expect(await resolveManagedFactsEmbedding(configEngine(values), runtimeConfig)).toBeNull();
});

const cases = [
  { label: 'unset dimensions', model: 'openai:text-embedding-3-small', dim: undefined, invalid: 'embedding_dimensions' },
  { label: 'malformed model', model: 'text-embedding-3-small', dim: '1536', invalid: 'embedding_model' },
  { label: 'both invalid', model: 'openai:', dim: undefined, invalid: 'embedding_model, embedding_dimensions' },
  ...['', '0', '-1', '1.5', '1536junk', '9007199254740992'].map(dim => ({
    label: `bad dimensions ${JSON.stringify(dim)}`, model: 'openai:text-embedding-3-small', dim, invalid: 'embedding_dimensions',
  })),
];

for (const { label, model, dim, invalid } of cases) {
  test(`facts embedding error explains DB config: ${label}`, async () => {
    const values: Record<string, string> = { embedding_model: model };
    if (dim !== undefined) values.embedding_dimensions = dim;
    const error = await resolveManagedFactsEmbedding(configEngine(values), runtimeConfig).catch(error => error);
    expect(error).toBeInstanceOf(OperationError);
    expect(error.code).toBe('embedding_configuration');
    expect(error.message).toStartWith('The selected brain has no verifiable facts embedding model and dimensions.');
    expect(error.message).toContain(`Invalid DB-plane config key(s): ${invalid}.`);
    expect(error.message).toContain(`embedding_model=${JSON.stringify(model)}`);
    expect(error.message).toContain(`embedding_dimensions=${dim === undefined ? 'unset' : JSON.stringify(dim)}`);
    expect(error.fix.argv).toEqual(['gbrain', 'doctor', '--only', 'embeddings', '--json']);
  });
}
