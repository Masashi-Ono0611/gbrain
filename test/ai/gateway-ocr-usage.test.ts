/**
 * gbrain#3392 follow-up — proves generateOcrText() writes to chat_usage_log
 * on both the success and error paths, closing the same blind-spot class as
 * test/ai/gateway-expand-usage.test.ts (raw AI-SDK call, never went through
 * chat()). Codex review finding on the first pass of this fix: the error
 * path needs to log AND rethrow (importImageFile's ocr_failed_other routing
 * depends on the throw), not just log-and-swallow.
 *
 * Uses the existing __setGenerateTextTransportForTests seam (shared with
 * chat()'s own tests) since generateOcrText() is routed through the same
 * _generateTextTransport variable.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';
import {
  generateOcrText,
  configureGateway,
  resetGateway,
  __setChatEngineForTests,
  __setGenerateTextTransportForTests,
  __flushChatUsageForTests,
} from '../../src/core/ai/gateway.ts';

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
  __setChatEngineForTests(engine);
});

afterEach(() => {
  __setGenerateTextTransportForTests(null);
  __setChatEngineForTests(null);
  resetGateway();
});

async function latestUsageRows(): Promise<Array<{
  model: string;
  tokens_in: number;
  tokens_out: number;
  succeeded: boolean;
}>> {
  return engine.executeRaw(
    `SELECT model, tokens_in, tokens_out, succeeded FROM chat_usage_log ORDER BY id ASC`,
  );
}

const FAKE_IMAGE = Buffer.from('fake-png-bytes');

describe('generateOcrText() writes chat_usage_log (gbrain#3392 follow-up)', () => {
  test('a successful OCR call records exactly one succeeded=true row', async () => {
    configureGateway({
      expansion_model: 'anthropic:claude-haiku-4-5',
      env: { ANTHROPIC_API_KEY: 'fake' },
    });
    __setGenerateTextTransportForTests(async (): Promise<any> => ({
      text: 'extracted text',
      usage: { inputTokens: 500, outputTokens: 30 },
      providerMetadata: {
        anthropic: { cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
      },
    }));

    const text = await generateOcrText(FAKE_IMAGE, 'image/png');
    expect(text).toBe('extracted text');
    await __flushChatUsageForTests();

    const rows = await latestUsageRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.model).toBe('anthropic:claude-haiku-4-5-20251001');
    expect(rows[0]!.tokens_in).toBe(500);
    expect(rows[0]!.tokens_out).toBe(30);
    expect(rows[0]!.succeeded).toBe(true);
  });

  test('a throwing OCR call records a succeeded=false row AND rethrows (ocr_failed_other routing depends on this)', async () => {
    configureGateway({
      expansion_model: 'anthropic:claude-haiku-4-5',
      env: { ANTHROPIC_API_KEY: 'fake' },
    });
    __setGenerateTextTransportForTests(async (): Promise<any> => {
      throw new Error('simulated OCR failure');
    });

    await expect(generateOcrText(FAKE_IMAGE, 'image/png')).rejects.toThrow('simulated OCR failure');
    await __flushChatUsageForTests();

    const rows = await latestUsageRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.succeeded).toBe(false);
    expect(rows[0]!.model).toBe('anthropic:claude-haiku-4-5-20251001');
    expect(rows[0]!.tokens_in).toBeGreaterThan(0);
  });

  test('no engine on hand — generateOcrText() still succeeds, just records nothing', async () => {
    __setChatEngineForTests(null);
    configureGateway({
      expansion_model: 'anthropic:claude-haiku-4-5',
      env: { ANTHROPIC_API_KEY: 'fake' },
    });
    __setGenerateTextTransportForTests(async (): Promise<any> => ({
      text: 'ok',
      usage: { inputTokens: 10, outputTokens: 2 },
    }));

    const text = await generateOcrText(FAKE_IMAGE, 'image/png');
    expect(text).toBe('ok');
    await __flushChatUsageForTests();

    expect(await latestUsageRows()).toHaveLength(0);
  });
});
