/**
 * Regression test for #3944 — `hasChatApiKey` read the DB plane in
 * `src/commands/autopilot.ts` but the file plane in
 * `src/core/remediation/context.ts` (the sibling embed-key probe in the
 * SAME autopilot.ts object literal already read the file plane). An
 * operator whose real Anthropic key lived only in `~/.gbrain/config.json`
 * (the plane the gateway actually resolves keys from) could have autopilot
 * report `hasChatApiKey: false` while doctor/remediation reported `true` —
 * or the inverse with a stale DB-only copy left behind by
 * `gbrain config unset anthropic_api_key`.
 *
 * Fix: both call sites now delegate to the single shared probe,
 * `hasAnthropicKey()` (src/core/ai/anthropic-key.ts) — the same
 * env → gateway-snapshot → file-plane resolution every other chat-key
 * consumer in the codebase already uses (think/index.ts,
 * cycle/synthesize.ts, conversation-parser/llm-base.ts, gateway.ts's
 * key-layer check, the subagent path). Neither call site queries the DB
 * plane (`engine.getConfig('anthropic_api_key')`) anymore.
 *
 * Two complementary guards:
 *  1. Source-parity: both files literally compute `hasChatApiKey` via the
 *     identical `hasAnthropicKey()` call, and neither references the DB-plane
 *     read anymore — so the two call sites cannot drift apart again the way
 *     they did pre-fix (this is the codebase's established pattern for
 *     cross-file consistency, e.g. `test/helpers/doctor-source.ts`).
 *  2. Behavioral: `loadRecommendationContext()` (context.ts) is exercised
 *     with a structurally-typed fake `BrainEngine` across the four plane
 *     states the issue calls out — key only in the file plane, key only in
 *     the (now-ignored) DB plane, in neither, and in both — proving the
 *     DB plane no longer influences the result at all.
 */

import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { loadRecommendationContext } from '../src/core/remediation/context.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { withEnv } from './helpers/with-env.ts';

const REPO_ROOT = join(import.meta.dir, '..');
const AUTOPILOT_SRC = readFileSync(join(REPO_ROOT, 'src', 'commands', 'autopilot.ts'), 'utf-8');
const CONTEXT_SRC = readFileSync(join(REPO_ROOT, 'src', 'core', 'remediation', 'context.ts'), 'utf-8');

describe('#3944 source-parity: hasChatApiKey computed identically in both call sites', () => {
  test('autopilot.ts imports the shared hasAnthropicKey probe', () => {
    expect(AUTOPILOT_SRC).toMatch(/import\s*\{\s*hasAnthropicKey\s*\}\s*from\s*['"]\.\.\/core\/ai\/anthropic-key\.ts['"]/);
  });

  test('remediation/context.ts imports the shared hasAnthropicKey probe', () => {
    expect(CONTEXT_SRC).toMatch(/import\s*\{\s*hasAnthropicKey\s*\}\s*from\s*['"]\.\.\/ai\/anthropic-key\.ts['"]/);
  });

  test('both files compute the hasChatApiKey field via the identical hasAnthropicKey() call', () => {
    // Pin the exact field assignment so a future edit that hand-rolls a new
    // probe at either site fails loudly instead of silently re-diverging.
    expect(AUTOPILOT_SRC).toMatch(/hasChatApiKey:\s*hasAnthropicKey\(\)\s*,/);
    expect(CONTEXT_SRC).toMatch(/hasChatApiKey:\s*hasAnthropicKey\(\)\s*,/);
  });

  test('neither call site reads the DB-plane anthropic_api_key anymore', () => {
    expect(AUTOPILOT_SRC).not.toContain("engine.getConfig('anthropic_api_key')");
    expect(CONTEXT_SRC).not.toContain("engine.getConfig('anthropic_api_key')");
  });
});

/**
 * Structurally-typed fake BrainEngine — loadRecommendationContext only
 * consumes `getConfig` and `countStaleChunks` (same pattern as
 * `test/doctor-source-config-shape.test.ts`). `getConfig('anthropic_api_key')`
 * throws: if the fix ever regresses and either call site starts reading the
 * DB plane for the chat key again, this fake surfaces it immediately instead
 * of silently returning a plausible-looking value.
 */
function makeFakeEngine(): BrainEngine {
  return {
    getConfig: async (key: string) => {
      if (key === 'anthropic_api_key') {
        throw new Error(
          '#3944 regression: loadRecommendationContext must not read the DB plane for anthropic_api_key',
        );
      }
      return null;
    },
    countStaleChunks: async () => 0,
  } as unknown as BrainEngine;
}

const tmpDirs: string[] = [];
function freshHome(withConfig?: Record<string, unknown>): string {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-3944-home-'));
  tmpDirs.push(home);
  if (withConfig) {
    const dir = join(home, '.gbrain');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'config.json'), JSON.stringify(withConfig), 'utf8');
  }
  return home;
}

describe('#3944 behavioral: loadRecommendationContext hasChatApiKey across plane states', () => {
  test('key only in the FILE plane (config.json) → true', async () => {
    const home = freshHome({ anthropic_api_key: 'sk-file-plane-only' });
    try {
      await withEnv(
        { ANTHROPIC_API_KEY: undefined, GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined },
        async () => {
          const ctx = await loadRecommendationContext(makeFakeEngine());
          expect(ctx.hasChatApiKey).toBe(true);
        },
      );
    } finally {
      const d = tmpDirs.pop();
      if (d) rmSync(d, { recursive: true, force: true });
    }
  });

  test('key present in NEITHER plane → false (fake engine never even asked for the DB copy)', async () => {
    const home = freshHome(); // no config.json written
    try {
      await withEnv(
        { ANTHROPIC_API_KEY: undefined, GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined },
        async () => {
          const ctx = await loadRecommendationContext(makeFakeEngine());
          expect(ctx.hasChatApiKey).toBe(false);
        },
      );
    } finally {
      const d = tmpDirs.pop();
      if (d) rmSync(d, { recursive: true, force: true });
    }
  });

  test('key present in BOTH the file plane and env → true (env wins, file still agrees)', async () => {
    const home = freshHome({ anthropic_api_key: 'sk-file-plane-copy' });
    try {
      await withEnv(
        { ANTHROPIC_API_KEY: 'sk-env-plane', GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined },
        async () => {
          const ctx = await loadRecommendationContext(makeFakeEngine());
          expect(ctx.hasChatApiKey).toBe(true);
        },
      );
    } finally {
      const d = tmpDirs.pop();
      if (d) rmSync(d, { recursive: true, force: true });
    }
  });

  // The fourth state the issue names — "key only in the DB plane" — is
  // covered by makeFakeEngine() itself: getConfig('anthropic_api_key')
  // throws if either call site ever asks for it again, so a DB-only key can
  // no longer make hasChatApiKey diverge between autopilot.ts and
  // context.ts. Pre-fix, autopilot.ts would have read that DB value and
  // reported `true` while context.ts (file-plane only, and now also this
  // shared probe) reported `false` for the same underlying state — exactly
  // the divergence #3944 reported.
  test('a DB-only key (no file, no env) cannot flip hasChatApiKey to true — this is the bug #3944 reported', async () => {
    const home = freshHome(); // no config.json — file plane is empty
    try {
      await withEnv(
        { ANTHROPIC_API_KEY: undefined, GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined },
        async () => {
          // A fake engine whose DB plane DOES hold a key — but the fix means
          // neither call site ever asks it, so it must never surface here.
          const engineWithDbKey = {
            getConfig: async (key: string) => (key === 'anthropic_api_key' ? 'sk-db-plane-only' : null),
            countStaleChunks: async () => 0,
          } as unknown as BrainEngine;
          const ctx = await loadRecommendationContext(engineWithDbKey);
          expect(ctx.hasChatApiKey).toBe(false);
        },
      );
    } finally {
      const d = tmpDirs.pop();
      if (d) rmSync(d, { recursive: true, force: true });
    }
  });
});
