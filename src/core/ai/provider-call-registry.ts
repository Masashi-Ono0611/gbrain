/**
 * provider-call-registry.ts — the classified inventory of every place this
 * codebase can spend provider API money.
 *
 * gbrain#3392/#3425. The chat-usage ledger (src/core/chat-usage.ts) is only
 * trustworthy if every spend path is either metered or explicitly declared
 * unmetered — a silently-added provider call site is exactly how the first
 * cut of PR #3399 ended up reporting 48% of real spend as if it were the
 * total. `test/provider-call-registry.test.ts` enforces this file against
 * the source tree: it scans src/ for provider imports and provider-endpoint
 * literals, and fails when a hit isn't covered here. Adding a provider call
 * therefore forces the author (and reviewer) to make a conscious
 * metered/unmetered decision.
 *
 * This is deliberately a tripwire, not a guarantee: it detects new FILES
 * (or new endpoint literals) touching provider SDKs, not every new call
 * expression inside an already-registered file. Confining SDK client
 * construction to a single adapter layer would close that residual gap and
 * is left as a follow-up (#3392) — it is an architecture decision that
 * belongs to the maintainer, not a contributor patch.
 *
 * `get_usage` reads this registry to report which spend paths are outside
 * its measurement scope, so the entries below are user-visible coverage
 * documentation, not just test fixtures.
 */

export type SpendOperation =
  | 'chat'
  | 'embedding'
  | 'rerank'
  | 'transcription'
  | 'image_embedding'
  | 'benchmark';

export interface ProviderCallSite {
  /** Repo-relative file path. */
  file: string;
  /** Why this file trips the scanner (import, endpoint literal, or subprocess). */
  trigger: string;
  operation: SpendOperation;
  /**
   * metered            = this file calls beginChatUsageAttempt itself
   * metered_via_gateway = dispatches BELOW gateway.chat(); covered by the
   *                       gateway boundary row (no second attempt row)
   * unmetered          = declared out of measurement scope, with a reason
   */
  status: 'metered' | 'metered_via_gateway' | 'unmetered';
  /** Required for unmetered entries: why it is acceptable not to meter. */
  reason?: string;
}

export const PROVIDER_CALL_REGISTRY: ProviderCallSite[] = [
  // ── Metered chat boundaries ────────────────────────────────────────────
  {
    file: 'src/core/ai/gateway.ts',
    trigger: "import 'ai' (generateText dispatch)",
    operation: 'chat',
    status: 'metered',
  },
  {
    file: 'src/core/minions/handlers/subagent.ts',
    trigger: "import '@anthropic-ai/sdk' (legacy direct client.create loop)",
    operation: 'chat',
    status: 'metered',
  },
  {
    file: 'src/core/ai/providers/claude-cli-language-model.ts',
    trigger: 'claude CLI subprocess spawn (LanguageModelV2 adapter for the claude-cli recipe)',
    operation: 'chat',
    status: 'metered_via_gateway',
    reason:
      'Dispatches BELOW gateway.chat() as an ai-sdk model, so its calls are '
      + 'already covered by the gateway.chat boundary row. claude-cli:* has '
      + 'no CANONICAL_PRICING entry, so those rows are correctly unpriced — '
      + 'subscription spend must not be costed at API list rates.',
  },

  // ── Custom fetch transports living BELOW gateway.chat() ────────────────
  // These recipes install header/response-munging fetch wrappers into the
  // AI SDK client; the dispatch they wrap is the gateway.chat boundary, so
  // they carry no attempt row of their own (a second one would double-count).
  {
    file: 'src/core/ai/recipes/azure-openai.ts',
    trigger: 'custom fetch transport under gateway dispatch',
    operation: 'chat',
    status: 'metered_via_gateway',
  },
  {
    file: 'src/core/ai/recipes/deepseek.ts',
    trigger: 'custom fetch transport under gateway dispatch (+ base URL literal)',
    operation: 'chat',
    status: 'metered_via_gateway',
  },
  {
    file: 'src/core/ai/recipes/minimax.ts',
    trigger: 'custom fetch transport under gateway dispatch',
    operation: 'chat',
    status: 'metered_via_gateway',
  },
  {
    file: 'src/core/ai/recipes/openrouter.ts',
    trigger: 'custom fetch transport under gateway dispatch (+ base URL literal)',
    operation: 'chat',
    status: 'metered_via_gateway',
  },

  // ── Declared unmetered paths (visible in get_usage coverage) ───────────
  {
    file: 'src/core/ai/gateway.ts',
    trigger: 'embeddings / multimodalembeddings endpoint fetches',
    operation: 'embedding',
    status: 'unmetered',
    reason:
      'Non-chat spend; out of scope for chat_usage_log. Embedding spend is '
      + 'separately estimated by the embed pipeline (embedding-pricing.ts).',
  },
  {
    file: 'src/core/ai/gateway.ts',
    trigger: 'rerank endpoint fetch',
    operation: 'rerank',
    status: 'unmetered',
    reason: 'Non-chat spend; out of scope for chat_usage_log.',
  },
  {
    file: 'src/core/transcription.ts',
    trigger: 'audio/transcriptions endpoint fetch',
    operation: 'transcription',
    status: 'unmetered',
    reason: 'Non-chat spend; out of scope for chat_usage_log.',
  },
  {
    file: 'src/commands/eval-longmemeval.ts',
    trigger: "import '@anthropic-ai/sdk' (benchmark harness)",
    operation: 'benchmark',
    status: 'unmetered',
    reason:
      'Offline eval command run interactively against the operator\'s own '
      + 'key with direct billing visibility; never runs inside a brain '
      + 'workload.',
  },
];

/** Unmetered entries, grouped for the get_usage coverage contract. */
export function unmeteredSpendPaths(): Array<{
  operation: SpendOperation;
  file: string;
  reason: string;
}> {
  return PROVIDER_CALL_REGISTRY
    .filter((e): e is ProviderCallSite & { reason: string } => e.status === 'unmetered')
    .map(e => ({ operation: e.operation, file: e.file, reason: e.reason }));
}
