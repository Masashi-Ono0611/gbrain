/**
 * Ollama library-tag dims — coverage for the pullable-tag catalog refresh.
 *
 * The ollama recipe gained the REAL Ollama library spellings
 * (`qwen3-embedding:8b`, `snowflake-arctic-embed2`) alongside the legacy
 * never-pullable spellings (`qwen3-embed-8b`, `snowflake-arctic-embed-l-v2`).
 * `qwen3-embedding:8b` is the first colon-bearing model tag in any recipe's
 * models list, which makes it the first tag to exercise
 * `embeddingDimsForModel()`'s strip-the-leading-`provider:`-prefix logic with
 * a colon INSIDE the model id.
 *
 * Contract pinned here (both forms now resolve to the true 4096):
 *   - Qualified form (`ollama:qwen3-embedding:8b`) strips only the FIRST
 *     colon, so the tag survives and resolves to its declared 4096.
 *   - Bare colon-bearing form (`qwen3-embedding:8b`) is tried as-given
 *     FIRST (an exact `model_dims` lookup) before any provider-prefix strip
 *     is attempted, so it also resolves to 4096 instead of the earlier
 *     naive first-colon strip eating the `qwen3-embedding` head and falling
 *     through to default_dims (768).
 *
 *   The bare form is not a purely theoretical input: `parseModelId('ollama:
 *   qwen3-embedding:8b')` (model-resolver.ts) splits on the FIRST colon
 *   only, so its `.modelId` is exactly the bare `qwen3-embedding:8b` — and
 *   `src/core/ai/gateway.ts`'s preflight dim-check (`~959`) passes that
 *   already-parsed `.modelId` straight into `embeddingDimsForModel()`. Today
 *   that one call site only branches on zero-vs-nonzero (both the old wrong
 *   768 and the correct 4096 are nonzero, so its outcome doesn't currently
 *   change), and the ollama recipe doesn't declare `supports_multimodal` so
 *   it never reaches the OTHER embeddingDimsForModel() call site
 *   (`~2384`, multimodal-only). So this fix is not closing an
 *   observed-broken production path today — it's closing the actual parse
 *   gap for the one real caller that already exists (proven below) and for
 *   any future caller (dim mismatch errors, migration planning, etc.) that
 *   depends on the correct declared width rather than a zero check.
 */

import { describe, expect, test } from 'bun:test';
import { getRecipe } from '../../src/core/ai/recipes/index.ts';
import { embeddingDimsForModel, resolveRecipe } from '../../src/core/ai/model-resolver.ts';
import { resolveMigrationTarget } from '../../src/core/embedding-migration.ts';

describe('ollama library-tag dims — new pullable tags', () => {
  const ollama = getRecipe('ollama')!;

  test('snowflake-arctic-embed2 resolves to 1024 (bare and qualified)', () => {
    expect(embeddingDimsForModel(ollama, 'snowflake-arctic-embed2')).toBe(1024);
    expect(embeddingDimsForModel(ollama, 'ollama:snowflake-arctic-embed2')).toBe(1024);
  });

  test('qualified ollama:qwen3-embedding:8b resolves to 4096 (colon tag survives the provider strip)', () => {
    expect(embeddingDimsForModel(ollama, 'ollama:qwen3-embedding:8b')).toBe(4096);
  });

  test('bare qwen3-embedding:8b resolves to its true 4096', () => {
    // embeddingDimsForModel() now tries the id exactly as given (an exact
    // model_dims lookup) before assuming a leading `provider:` separator,
    // so the bare colon-bearing form resolves correctly instead of silently
    // falling back to default_dims (768).
    expect(embeddingDimsForModel(ollama, 'qwen3-embedding:8b')).toBe(4096);
  });

  test('resolveRecipe("ollama:qwen3-embedding:8b").parsed.modelId is the bare colon-bearing form, and feeding it straight to embeddingDimsForModel() resolves correctly — the exact shape gateway.ts:959 passes', () => {
    const { parsed, recipe } = resolveRecipe('ollama:qwen3-embedding:8b');
    expect(parsed.modelId).toBe('qwen3-embedding:8b');
    expect(embeddingDimsForModel(recipe, parsed.modelId)).toBe(4096);
  });

  test('legacy spellings keep validating at their declared dims', () => {
    expect(embeddingDimsForModel(ollama, 'qwen3-embed-8b')).toBe(4096);
    expect(embeddingDimsForModel(ollama, 'snowflake-arctic-embed-l-v2')).toBe(1024);
  });

  test('both new tags are listed in the embedding touchpoint models', () => {
    const models = getRecipe('ollama')!.touchpoints.embedding!.models;
    expect(models).toContain('qwen3-embedding:8b');
    expect(models).toContain('snowflake-arctic-embed2');
  });

  test('SWEEP: every listed model with a declared dim resolves through the qualified form', () => {
    // Future colon-bearing tags stay safe: the qualified form (what init and
    // migration actually pass) must always reach the declared model_dims row.
    const tp = ollama.touchpoints.embedding!;
    for (const [model, dims] of Object.entries(tp.model_dims ?? {})) {
      expect(
        embeddingDimsForModel(ollama, `ollama:${model}`),
        `ollama:${model} must resolve to its declared ${dims}`,
      ).toBe(dims);
    }
  });
});

describe('embedding-migrate --to accepts the new tags at their native widths', () => {
  test('resolveMigrationTarget(ollama:qwen3-embedding:8b) → 4096', () => {
    expect(resolveMigrationTarget('ollama:qwen3-embedding:8b')).toEqual({
      toModel: 'ollama:qwen3-embedding:8b',
      toDims: 4096,
    });
  });

  test('resolveMigrationTarget(ollama:snowflake-arctic-embed2) → 1024', () => {
    expect(resolveMigrationTarget('ollama:snowflake-arctic-embed2')).toEqual({
      toModel: 'ollama:snowflake-arctic-embed2',
      toDims: 1024,
    });
  });

  test('bare colon tag fails loud, not silently at 768 [PIN]', () => {
    // 'qwen3-embedding:8b' PASSES the includes(':') qualification guard (it
    // contains a colon), so the fail-loud contract this file's header relies
    // on actually comes from resolveRecipe throwing on the unknown provider
    // 'qwen3-embedding'. Pin that: if recipe resolution ever became lenient,
    // a bare colon tag would silently plan a 768-wide migration.
    expect(() => resolveMigrationTarget('qwen3-embedding:8b')).toThrow();
  });
});
