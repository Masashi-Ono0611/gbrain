/**
 * Tripwire for unclassified provider spend paths (gbrain#3392).
 *
 * The chat-usage ledger's coverage contract is only honest if every place
 * the codebase can spend provider API money is either metered or explicitly
 * declared unmetered in src/core/ai/provider-call-registry.ts. This test
 * scans src/ for the signals that a file talks to a provider —
 * runtime SDK imports and provider-endpoint literals — and fails when a hit
 * is neither in the registry nor in the infra allowlist below.
 *
 * Coverage statement (what this can and cannot catch): it detects new FILES
 * importing provider SDKs and new endpoint literals. It does NOT detect a
 * new call expression added inside an already-registered file, and it
 * cannot see dynamic URL construction. Those residual gaps are why the
 * registry is called a tripwire, not a guarantee.
 */
import { describe, test, expect } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { PROVIDER_CALL_REGISTRY, unmeteredSpendPaths } from '../src/core/ai/provider-call-registry.ts';

const SRC_ROOT = join(import.meta.dir, '..', 'src');

/**
 * Files that trip a pattern without being able to spend: comments, config
 * strings (recipe base URLs), or the registry itself. Every entry carries
 * the reason it is safe so a reviewer can re-verify.
 */
const SCAN_INFRA_ALLOWLIST: Record<string, string> = {
  'src/core/ai/provider-call-registry.ts': 'the registry itself (doc strings)',
  'src/core/ai/recipes/voyage.ts': 'base_url_default config string; dispatch happens in gateway.ts',
  'src/core/ai/recipes/zeroentropyai.ts': 'base_url_default config string; dispatch happens in gateway.ts',
  'src/core/ai/recipes/groq.ts': 'base_url_default config string; dispatch happens in gateway.ts',
  'src/core/ai/recipes/together.ts': 'base_url_default config string; dispatch happens in gateway.ts',
  'src/core/retrieval-upgrade-prompt.ts': 'user-facing prompt text mentions the endpoint; no dispatch',
};

/** Runtime provider-SDK import specifiers (import type is excluded by the regex). */
const SDK_IMPORT_RE = /^import\s+(?!type\s)[^;]*from\s+['"](@anthropic-ai\/sdk|openai|ai|@ai-sdk\/[^'"]+)['"]/m;

/** Endpoint literals that mark direct provider HTTP dispatch. */
const ENDPOINT_LITERALS = [
  'api.anthropic.com',
  'api.openai.com',
  'api.voyageai.com',
  'api.zeroentropy.dev',
  'api.deepseek.com',
  'api.groq.com',
  'api.together.xyz',
  'openrouter.ai',
  'api.minimax',
  'cognitiveservices.azure.com',
  'audio/transcriptions',
  '/multimodalembeddings',
];

/**
 * LLM dispatch that never touches an SDK or endpoint: subprocess spawn of the
 * claude CLI. `claudeBin(` is the adapter's binary-resolution helper — any
 * file calling it is driving the CLI. (A hypothetical new file spawning the
 * binary through a different helper would evade this — see the coverage
 * statement in the header.)
 */
const SUBPROCESS_SIGNALS = ['claudeBin('];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (name === 'assets') continue; // wasm grammars etc.
      walk(p, out);
    } else if (name.endsWith('.ts')) {
      out.push(p);
    }
  }
  return out;
}

function relPath(abs: string): string {
  return 'src' + abs.slice(SRC_ROOT.length).replace(/\\/g, '/');
}

function scanHits(): Map<string, string[]> {
  const hits = new Map<string, string[]>();
  for (const abs of walk(SRC_ROOT)) {
    const rel = relPath(abs);
    const content = readFileSync(abs, 'utf-8');
    const triggers: string[] = [];
    const m = content.match(SDK_IMPORT_RE);
    if (m) triggers.push(`sdk-import:${m[1]}`);
    // Endpoint literals: ignore pure comment lines so documentation can
    // mention a host without tripping (allowlist covers the rest).
    const codeLines = content
      .split('\n')
      .filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l));
    for (const lit of ENDPOINT_LITERALS) {
      if (codeLines.some(l => l.includes(lit))) triggers.push(`endpoint:${lit}`);
    }
    for (const sig of SUBPROCESS_SIGNALS) {
      if (codeLines.some(l => l.includes(sig))) triggers.push(`subprocess:${sig}`);
    }
    if (triggers.length > 0) hits.set(rel, triggers);
  }
  return hits;
}

describe('provider-call registry tripwire', () => {
  const hits = scanHits();
  const registryFiles = new Set(PROVIDER_CALL_REGISTRY.map(e => e.file));

  test('scanner sanity: it sees the known boundaries (not a silent no-op)', () => {
    // Negative-control for the scanner itself: if these ever stop matching,
    // the scan regexes broke and every other assertion is vacuous.
    expect(hits.has('src/core/ai/gateway.ts')).toBe(true);
    expect(hits.has('src/core/minions/handlers/subagent.ts')).toBe(true);
    expect(hits.has('src/core/transcription.ts')).toBe(true);
  });

  test('every provider hit is classified (registry or infra allowlist)', () => {
    const unclassified: string[] = [];
    for (const [file, triggers] of hits) {
      if (registryFiles.has(file)) continue;
      if (SCAN_INFRA_ALLOWLIST[file]) continue;
      unclassified.push(`${file} (${triggers.join(', ')})`);
    }
    expect(
      unclassified,
      'New provider call site(s) detected. Classify each in '
      + 'src/core/ai/provider-call-registry.ts as metered (wire it through '
      + 'beginChatUsageAttempt) or unmetered (with a reason), or add to the '
      + 'infra allowlist in this test with a reason.',
    ).toEqual([]);
  });

  test('registry entries are not stale (every entry still matches a scan hit)', () => {
    const stale = PROVIDER_CALL_REGISTRY
      .filter(e => !hits.has(e.file))
      .map(e => e.file);
    expect(stale).toEqual([]);
  });

  test('infra allowlist entries are not stale', () => {
    const stale = Object.keys(SCAN_INFRA_ALLOWLIST).filter(f => !hits.has(f));
    expect(stale).toEqual([]);
  });

  test('metered files actually contain the recorder call (not just a claim)', () => {
    // A registry row saying 'metered' is a claim; this checks the file
    // really invokes the ledger. metered_via_gateway files are excluded —
    // their coverage comes from gateway.ts, which this loop does include.
    for (const e of PROVIDER_CALL_REGISTRY) {
      if (e.status !== 'metered') continue;
      const content = readFileSync(join(SRC_ROOT, '..', e.file), 'utf-8');
      expect(
        content.includes('beginChatUsageAttempt'),
        `${e.file} is registered as metered but never calls beginChatUsageAttempt`,
      ).toBe(true);
    }
  });

  test('unmetered entries always carry a reason', () => {
    for (const e of PROVIDER_CALL_REGISTRY) {
      if (e.status === 'unmetered') {
        expect(e.reason, `${e.file} is unmetered without a reason`).toBeTruthy();
      }
    }
    // And the coverage-contract projection exposes exactly those entries.
    expect(unmeteredSpendPaths().length).toBe(
      PROVIDER_CALL_REGISTRY.filter(e => e.status === 'unmetered').length,
    );
  });
});
