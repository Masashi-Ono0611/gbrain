import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  __setGenerateTextTransportForTests,
  configureGateway,
  resetGateway,
} from '../../src/core/ai/gateway.ts';
import {
  __resetChatFallbackStateForTests,
  chatWithFallback,
} from '../../src/core/ai/chat-fallback.ts';
import { classifyGlobalLlmError } from '../../src/core/ai/errors.ts';

const PRIMARY = 'claude-cli:claude-sonnet-4-6';
const OPENAI_FALLBACK = 'openai:gpt-5.6-luna';
const ANTHROPIC_FALLBACK = 'anthropic:claude-haiku-4-5-20251001';

function response(text = 'ok'): any {
  return {
    content: [{ type: 'text', text }],
    finishReason: 'stop',
    usage: { inputTokens: 2, outputTokens: 1 },
  };
}

function statusError(status: number, detail = ''): Error & { status: number } {
  return Object.assign(new Error(`provider returned HTTP ${status}${detail}`), { status });
}

function targetOf(args: any): string {
  const provider = String(args.model.provider).split('.')[0];
  return `${provider}:${args.model.modelId}`;
}

function configure(chain: string[], env: Record<string, string> = {}): void {
  configureGateway({
    chat_model: PRIMARY,
    chat_fallback_chain: chain,
    env,
  });
}

const opts = {
  messages: [{ role: 'user' as const, content: 'hello' }],
};

beforeEach(() => {
  resetGateway();
  __setGenerateTextTransportForTests(null);
  __resetChatFallbackStateForTests();
});

afterEach(() => {
  __setGenerateTextTransportForTests(null);
  resetGateway();
  __resetChatFallbackStateForTests();
});

describe('chatWithFallback', () => {
  test('switches to the first configured fallback after a 429', async () => {
    const called: string[] = [];
    __setGenerateTextTransportForTests(async (args: any) => {
      called.push(targetOf(args));
      if (called.length === 1) throw statusError(429);
      return response('fallback answer');
    });
    configure([OPENAI_FALLBACK], { OPENAI_API_KEY: 'fake' });

    const result = await chatWithFallback(opts);

    expect(called).toEqual([PRIMARY, OPENAI_FALLBACK]);
    expect(result.model).toBe(OPENAI_FALLBACK);
    expect(result.text).toBe('fallback answer');
  });

  test('switches providers after a billing failure', async () => {
    let calls = 0;
    __setGenerateTextTransportForTests(async () => {
      calls++;
      if (calls === 1) throw statusError(402);
      return response();
    });
    configure([OPENAI_FALLBACK], { OPENAI_API_KEY: 'fake' });

    const result = await chatWithFallback(opts);

    expect(calls).toBe(2);
    expect(result.model).toBe(OPENAI_FALLBACK);
  });

  test.each([401, 403])('does not fall back after HTTP %i', async status => {
    let calls = 0;
    __setGenerateTextTransportForTests(async () => {
      calls++;
      throw statusError(status);
    });
    configure([OPENAI_FALLBACK], { OPENAI_API_KEY: 'fake' });

    let caught: unknown;
    try {
      await chatWithFallback(opts);
    } catch (err) {
      caught = err;
    }

    expect(calls).toBe(1);
    expect(classifyGlobalLlmError(caught)).toBe('auth');
  });

  test('does not fall back after an unclassifiable error', async () => {
    const original = new Error('unexpected provider failure');
    let calls = 0;
    __setGenerateTextTransportForTests(async () => {
      calls++;
      throw original;
    });
    configure([OPENAI_FALLBACK], { OPENAI_API_KEY: 'fake' });

    let caught: unknown;
    try {
      await chatWithFallback(opts);
    } catch (err) {
      caught = err;
    }

    expect(calls).toBe(1);
    expect(classifyGlobalLlmError(caught)).toBeNull();
  });

  test('throws a rate-limit-classified last error when the chain is exhausted', async () => {
    let calls = 0;
    __setGenerateTextTransportForTests(async () => {
      calls++;
      throw statusError(429, ` on attempt ${calls}`);
    });
    configure(
      [OPENAI_FALLBACK, ANTHROPIC_FALLBACK],
      { OPENAI_API_KEY: 'fake', ANTHROPIC_API_KEY: 'fake' },
    );

    let caught: unknown;
    try {
      await chatWithFallback(opts);
    } catch (err) {
      caught = err;
    }

    expect(classifyGlobalLlmError(caught)).toBe('rate_limit');
    expect((caught as Error).message).toContain('attempt 3');
    const first = (caught as { fallbackFirstError?: Error }).fallbackFirstError;
    expect(first?.message).toContain('attempt 1');
  });

  test('a later rate limit outranks an earlier unclassified chain error', async () => {
    const called: string[] = [];
    __setGenerateTextTransportForTests(async (args: any) => {
      const target = targetOf(args);
      called.push(target);
      // 400 is a PER_ITEM_HTTP_STATUSES member (errors.ts) — normalizeAIError
      // still wraps it as AIConfigError, but classifyGlobalLlmError's
      // per-item exclusion keeps it OUT of the auth bucket, so it falls
      // through every check to null (genuinely unclassified). A non-per-item
      // 4xx like 418 does NOT get that exclusion and classifies as 'auth'
      // (rank 3, the HIGHEST terminal-error priority) — the opposite of what
      // this test needs to exercise, and what an earlier version of this
      // test used by mistake (caught by the patch-stack rebase's full-suite
      // run: it deterministically failed, not a flake).
      if (target === OPENAI_FALLBACK) throw statusError(400);
      throw statusError(429, ` from ${target}`);
    });
    configure(
      [OPENAI_FALLBACK, ANTHROPIC_FALLBACK],
      { OPENAI_API_KEY: 'fake', ANTHROPIC_API_KEY: 'fake' },
    );

    let caught: unknown;
    try {
      await chatWithFallback(opts);
    } catch (err) {
      caught = err;
    }

    expect(called).toEqual([PRIMARY, OPENAI_FALLBACK, ANTHROPIC_FALLBACK]);
    expect(classifyGlobalLlmError(caught)).toBe('rate_limit');
    expect((caught as Error).message).toContain(ANTHROPIC_FALLBACK);
    expect(
      (caught as { fallbackFirstError?: Error }).fallbackFirstError?.message,
    ).toContain(PRIMARY);
  });

  test('an empty chain makes exactly the primary chat attempt', async () => {
    const called: string[] = [];
    __setGenerateTextTransportForTests(async (args: any) => {
      called.push(targetOf(args));
      return response('primary answer');
    });
    configure([]);

    const result = await chatWithFallback(opts);

    expect(called).toEqual([PRIMARY]);
    expect(result.model).toBe(PRIMARY);
    expect(result.text).toBe('primary answer');
  });

  test('an already-aborted signal burns no attempts', async () => {
    let calls = 0;
    __setGenerateTextTransportForTests(async () => {
      calls++;
      return response();
    });
    configure([OPENAI_FALLBACK], { OPENAI_API_KEY: 'fake' });
    const controller = new AbortController();
    controller.abort();

    let caught: unknown;
    try {
      await chatWithFallback({ ...opts, abortSignal: controller.signal });
    } catch (err) {
      caught = err;
    }

    expect(calls).toBe(0);
    expect((caught as Error).name).toBe('AbortError');
  });

  test('skips a fallback provider that has no configured credentials', async () => {
    const called: string[] = [];
    __setGenerateTextTransportForTests(async (args: any) => {
      called.push(targetOf(args));
      if (called.length === 1) throw statusError(429);
      return response();
    });
    configure(
      [OPENAI_FALLBACK, ANTHROPIC_FALLBACK],
      { ANTHROPIC_API_KEY: 'fake' },
    );

    const result = await chatWithFallback(opts);

    expect(called).toEqual([PRIMARY, ANTHROPIC_FALLBACK]);
    expect(result.model).toBe(ANTHROPIC_FALLBACK);
  });

  test('sticky demotion skips the failed primary and a later success clears it', async () => {
    let primaryFails = true;
    let called: string[] = [];
    __setGenerateTextTransportForTests(async (args: any) => {
      const target = targetOf(args);
      called.push(target);
      if (target === PRIMARY && primaryFails) throw statusError(429);
      return response();
    });
    configure([OPENAI_FALLBACK], { OPENAI_API_KEY: 'fake' });

    await chatWithFallback(opts);
    expect(called).toEqual([PRIMARY, OPENAI_FALLBACK]);

    called = [];
    await chatWithFallback(opts);
    expect(called).toEqual([OPENAI_FALLBACK]);

    // With no usable alternate, demotion is best-effort: retry the primary.
    // Its success clears the sticky state for the next chained call.
    primaryFails = false;
    configure([]);
    called = [];
    await chatWithFallback(opts);
    expect(called).toEqual([PRIMARY]);

    configure([OPENAI_FALLBACK], { OPENAI_API_KEY: 'fake' });
    called = [];
    await chatWithFallback(opts);
    expect(called).toEqual([PRIMARY]);
  });

  test('sticky demotion skips a failed fallback entry on the next call', async () => {
    let called: string[] = [];
    __setGenerateTextTransportForTests(async (args: any) => {
      const target = targetOf(args);
      called.push(target);
      if (target !== ANTHROPIC_FALLBACK) throw statusError(429);
      return response();
    });
    configure(
      [OPENAI_FALLBACK, ANTHROPIC_FALLBACK],
      { OPENAI_API_KEY: 'fake', ANTHROPIC_API_KEY: 'fake' },
    );

    await chatWithFallback(opts);
    expect(called).toEqual([PRIMARY, OPENAI_FALLBACK, ANTHROPIC_FALLBACK]);

    called = [];
    await chatWithFallback(opts);
    expect(called).toEqual([ANTHROPIC_FALLBACK]);
  });

  test.each([
    { status: 401, classification: 'auth' },
    { status: 418, classification: null },
  ])(
    'skips a $classification failure from a fallback entry',
    async ({ status }) => {
      const called: string[] = [];
      __setGenerateTextTransportForTests(async (args: any) => {
        const target = targetOf(args);
        called.push(target);
        if (target === PRIMARY) throw statusError(429);
        if (target === OPENAI_FALLBACK) throw statusError(status);
        return response('second fallback answer');
      });
      configure(
        [OPENAI_FALLBACK, ANTHROPIC_FALLBACK],
        { OPENAI_API_KEY: 'fake', ANTHROPIC_API_KEY: 'fake' },
      );

      const result = await chatWithFallback(opts);

      expect(called).toEqual([PRIMARY, OPENAI_FALLBACK, ANTHROPIC_FALLBACK]);
      expect(result.model).toBe(ANTHROPIC_FALLBACK);
    },
  );

  test('chain exhaustion surfaces an actionable fallback auth error', async () => {
    const called: string[] = [];
    __setGenerateTextTransportForTests(async (args: any) => {
      const target = targetOf(args);
      called.push(target);
      if (target === OPENAI_FALLBACK) throw statusError(401);
      throw statusError(429);
    });
    configure(
      [OPENAI_FALLBACK, ANTHROPIC_FALLBACK],
      { OPENAI_API_KEY: 'fake', ANTHROPIC_API_KEY: 'fake' },
    );

    let caught: unknown;
    try {
      await chatWithFallback(opts);
    } catch (err) {
      caught = err;
    }

    expect(called).toEqual([PRIMARY, OPENAI_FALLBACK, ANTHROPIC_FALLBACK]);
    expect(classifyGlobalLlmError(caught)).toBe('auth');
    expect((caught as Error).message).toContain('401');
    expect(
      (caught as { fallbackFirstError?: Error }).fallbackFirstError?.message,
    ).toContain('429');
  });
});

describe('chatWithFallback — chainKey (patch 96)', () => {
  const CHAIN_KEY = 'models.dream.patterns';

  test('a chainKey-specific chain is used when configured, in preference to the global chain', async () => {
    const called: string[] = [];
    __setGenerateTextTransportForTests(async (args: any) => {
      called.push(targetOf(args));
      if (called.length === 1) throw statusError(429);
      return response('chainKey fallback answer');
    });
    configureGateway({
      chat_model: PRIMARY,
      chat_fallback_chain: [ANTHROPIC_FALLBACK], // global — must be ignored
      chat_fallback_chains: { [CHAIN_KEY]: [OPENAI_FALLBACK] },
      env: { OPENAI_API_KEY: 'fake', ANTHROPIC_API_KEY: 'fake' },
    });

    const result = await chatWithFallback(opts, { chainKey: CHAIN_KEY });

    expect(called).toEqual([PRIMARY, OPENAI_FALLBACK]);
    expect(result.model).toBe(OPENAI_FALLBACK);
    expect(result.text).toBe('chainKey fallback answer');
  });

  test('falls through to the global chain when chainKey has no override', async () => {
    const called: string[] = [];
    __setGenerateTextTransportForTests(async (args: any) => {
      called.push(targetOf(args));
      if (called.length === 1) throw statusError(429);
      return response('global fallback answer');
    });
    configureGateway({
      chat_model: PRIMARY,
      chat_fallback_chain: [ANTHROPIC_FALLBACK],
      chat_fallback_chains: { 'models.dream.synthesize': [OPENAI_FALLBACK] }, // different key
      env: { OPENAI_API_KEY: 'fake', ANTHROPIC_API_KEY: 'fake' },
    });

    const result = await chatWithFallback(opts, { chainKey: CHAIN_KEY });

    expect(called).toEqual([PRIMARY, ANTHROPIC_FALLBACK]);
    expect(result.model).toBe(ANTHROPIC_FALLBACK);
  });

  test('omitting chainKey (every pre-patch-96 caller) is unaffected by chat_fallback_chains', async () => {
    const called: string[] = [];
    __setGenerateTextTransportForTests(async (args: any) => {
      called.push(targetOf(args));
      if (called.length === 1) throw statusError(429);
      return response('unkeyed fallback answer');
    });
    configureGateway({
      chat_model: PRIMARY,
      chat_fallback_chain: [ANTHROPIC_FALLBACK],
      chat_fallback_chains: { [CHAIN_KEY]: [OPENAI_FALLBACK] },
      env: { OPENAI_API_KEY: 'fake', ANTHROPIC_API_KEY: 'fake' },
    });

    const result = await chatWithFallback(opts);

    expect(called).toEqual([PRIMARY, ANTHROPIC_FALLBACK]);
    expect(result.model).toBe(ANTHROPIC_FALLBACK);
  });
});
