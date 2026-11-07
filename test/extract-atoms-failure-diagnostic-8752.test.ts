/**
 * #8752 — a deterministic extract_atoms failure keeps a reply-free diagnostic
 * (stop reason, output tokens, reply length, bracket presence, model, version).
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runPhaseWithStoredPageFixtures as runPhaseExtractAtoms } from './helpers/extract-atoms-page-fixtures.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import type { ChatResult, ChatOpts } from '../src/core/ai/gateway.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

describe('extract_atoms failure diagnostic (#8752)', () => {
  test('malformed reply failure carries stop reason, tokens, length and model, not reply text', async () => {
    await engine.putPage('note/diag', { title: 'diag', type: 'note', compiled_truth: 'seed body prose' } as never, { sourceId: 'default' });
    const reply = 'secret prose reply';
    const result = await runPhaseExtractAtoms(engine, {
      sourceId: 'default',
      _transcripts: [],
      _pages: [{ slug: 'note/diag', content: 'prose', contentHash: 'a'.repeat(16) }],
      _chat: async (_o: ChatOpts) => ({
        text: reply,
        blocks: [{ type: 'text', text: reply }],
        stopReason: 'end',
        usage: { input_tokens: 100, output_tokens: 50, cache_read_tokens: 0, cache_creation_tokens: 0 },
        model: 'anthropic:claude-haiku-4-5',
        providerId: 'anthropic',
      } as ChatResult),
    });
    const error = (result.details.failures as Array<{ error: string }>)[0]?.error ?? '';
    expect(error).toContain('malformed model output: no JSON array in response');
    expect(error).toContain('stop_reason=end');
    expect(error).toContain('output_tokens=50');
    expect(error).toContain(`reply_chars=${reply.length}`);
    expect(error).toContain('has_open_bracket=false');
    expect(error).toContain('model=anthropic:claude-haiku-4-5');
    expect(error).not.toContain(reply);
  });
});
