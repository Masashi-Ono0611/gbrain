/**
 * chat-usage.ts — provider-boundary lifecycle ledger for chat LLM spend.
 *
 * gbrain#3392 / #3425. Replaces the first-cut instrumentation on PR #3399,
 * which recorded only inside `gateway.chat()` and therefore missed the
 * default subagent path entirely (`agent.use_gateway_loop` unset →
 * `handlers/subagent.ts` calls the Anthropic SDK directly): on a live brain
 * that path was 52% of real Anthropic spend.
 *
 * Design invariant: **record where the money leaves the building.** Every
 * chat API call crosses exactly one provider boundary exactly once — either
 * `gateway.chat()`'s dispatch or the legacy subagent `client.create()` call.
 * An attempt row is opened *before* the provider call and finalized in
 * `finally`, so failures, aborts and recorder crashes all land in the same
 * ledger instead of silently vanishing. Which boundaries exist (and which
 * spend paths are deliberately NOT metered) is asserted by
 * `test/provider-call-registry.test.ts` against
 * `src/core/ai/provider-call-registry.ts` — a new provider call site fails
 * that test until it is classified.
 *
 * Honesty rules (the parts the first cut got wrong):
 *  - Unknown usage is NULL, never 0. A timeout/abort may still have been
 *    billed server-side; writing 0 would be fabricated data, and writing the
 *    budget-tracker's worst-case ceiling (what v1 did) overstates spend.
 *    `request_status` (what happened to the call) and `usage_status` (what
 *    we know about tokens) are separate columns because "failed" does not
 *    imply "unbilled".
 *  - Costs are computed from a per-row rate snapshot taken at write time
 *    (`rate_snapshot`/`rate_source`/`rate_version`), so later edits to
 *    `model-pricing.ts` can never silently rewrite history. Rows whose rate
 *    or cache semantics we cannot verify store cost_usd NULL ("unpriced")
 *    rather than a guess. Token counts are the ground truth; cost is a
 *    derived, labeled estimate at published list rates — promo/negotiated
 *    pricing and invoice-level adjustments are out of scope (see
 *    `get_usage`'s coverage contract).
 *  - Telemetry must never fail or slow the user's call (house rule, see
 *    minion-spend.ts). All writes are best-effort and asynchronous; write
 *    failures increment an in-process counter surfaced via
 *    `chatUsageRecorderFailures()` so tests and `get_usage` can report the
 *    gap instead of pretending completeness.
 *
 * Cache pricing: Anthropic bills cache reads at 0.1× the input rate and
 * cache writes at 1.25× (5m TTL) or 2× (1h TTL). A single request carries
 * one TTL for all its breakpoints (gateway.chat derives one
 * `cacheControlValue` and reuses it; the subagent path hardcodes the 5m
 * default), so the boundary passes `cacheWriteTtl` per attempt and the
 * conflated cache_creation count prices exactly. Non-Anthropic providers
 * surface cache fields with different semantics (e.g. OpenAI's cached
 * tokens are a subset of input_tokens, not additional) — for those, rows
 * with nonzero cache counts are left unpriced rather than mispriced.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from './engine.ts';
import { sqlQueryForEngine } from './sql-query.ts';
import { canonicalLookup } from './model-pricing.ts';
import { registerBackgroundWorkDrainer } from './background-work.ts';
import { VERSION } from '../version.ts';

// ---------------------------------------------------------------------------
// Phase attribution (which high-level feature is spending)
// ---------------------------------------------------------------------------

const phaseStore = new AsyncLocalStorage<string>();

/**
 * Tag every chat call made while `fn` runs (including via awaited async
 * chains) with a phase label — 'think', 'dream.synthesize', etc. Purely
 * attributional; absence of a phase is fine (row stores NULL).
 */
export function withChatPhase<T>(phase: string, fn: () => T): T {
  return phaseStore.run(phase, fn);
}

/** Current ambient phase, if any. Exported for the subagent boundary. */
export function currentChatPhase(): string | undefined {
  return phaseStore.getStore();
}

// ---------------------------------------------------------------------------
// Engine wiring
// ---------------------------------------------------------------------------

let _engine: BrainEngine | null = null;

/**
 * Install the engine the ledger writes through. Called from
 * `reconfigureGatewayWithEngine()` (every DB-connected CLI/worker process
 * passes through it) — before that, attempts are dropped and counted as
 * recorder failures only if a provider call actually happens engine-less
 * (config-validation probes etc. don't reach the chat boundary).
 */
export function setChatUsageEngine(engine: BrainEngine | null): void {
  _engine = engine;
}

// ---------------------------------------------------------------------------
// Rate snapshot
// ---------------------------------------------------------------------------

/**
 * Anthropic prompt-cache billing multipliers over the base input rate.
 * https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching#pricing
 */
const ANTHROPIC_CACHE_MULTIPLIERS = {
  read: 0.1,
  write_5m: 1.25,
  write_1h: 2.0,
} as const;

export type CacheWriteTtl = '5m' | '1h';

export interface RateSnapshot {
  /** USD per 1M input tokens. */
  input_per_mtok: number;
  /** USD per 1M output tokens. */
  output_per_mtok: number;
  /** USD per 1M cache-read tokens; null when cache semantics unverified for the provider. */
  cache_read_per_mtok: number | null;
  /** USD per 1M cache-write tokens at the request's TTL; null when unverified. */
  cache_write_per_mtok: number | null;
  cache_write_ttl: CacheWriteTtl | null;
}

/**
 * Build the applied-rate snapshot for a model id. Lookup goes through
 * `canonicalLookup`, which accepts colon (`anthropic:claude-…`), bare and
 * slash spellings — so a boundary that passes a bare id still prices instead
 * of silently landing every row in `pricing_missing`. Returns null when the
 * model has no pricing entry — the row is then stored unpriced (cost_usd
 * NULL) instead of guessed.
 *
 * The TTL is validated against the two billable values; anything else
 * (config injecting an unexpected string through cacheControl deep-merge)
 * yields cache_write_per_mtok null — fail closed, never a silent 5m default.
 */
export function buildRateSnapshot(
  model: string | null | undefined,
  cacheWriteTtl: string | null | undefined,
): RateSnapshot | null {
  if (!model) return null;
  const pricing = canonicalLookup(model);
  if (!pricing) return null;
  const isAnthropic = model.startsWith('anthropic:') || !model.includes(':');
  const ttl: CacheWriteTtl | null =
    cacheWriteTtl === '5m' || cacheWriteTtl === '1h' ? cacheWriteTtl : null;
  return {
    input_per_mtok: pricing.input,
    output_per_mtok: pricing.output,
    cache_read_per_mtok: isAnthropic
      ? pricing.input * ANTHROPIC_CACHE_MULTIPLIERS.read
      : null,
    cache_write_per_mtok: isAnthropic && ttl
      ? pricing.input * (ttl === '1h'
          ? ANTHROPIC_CACHE_MULTIPLIERS.write_1h
          : ANTHROPIC_CACHE_MULTIPLIERS.write_5m)
      : null,
    cache_write_ttl: isAnthropic ? ttl : null,
  };
}

/**
 * Per-attempt token observation. `null` means "the provider did not report
 * this field" — never coerce it to 0: absent is not the same as free, and
 * the first cut of this feature got exactly that wrong.
 */
export interface UsageCounts {
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_creation_tokens: number | null;
}

/** Finite non-negative number, else null. NaN/Infinity never reach the DB. */
export function sanitizeTokenCount(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
}

/**
 * Price a usage observation against a snapshot, as a LOWER BOUND: null
 * fields contribute nothing (they are unobserved, not free), and any
 * observed nonzero token class without a verified rate makes the whole
 * result null — fail closed, never silently drop a cost component.
 */
export function computeCostUsd(usage: UsageCounts, rate: RateSnapshot | null): number | null {
  if (!rate) return null;
  const M = 1_000_000;
  let cost = 0;
  if (usage.input_tokens !== null) cost += (usage.input_tokens / M) * rate.input_per_mtok;
  if (usage.output_tokens !== null) cost += (usage.output_tokens / M) * rate.output_per_mtok;
  if (usage.cache_read_tokens !== null && usage.cache_read_tokens > 0) {
    if (rate.cache_read_per_mtok === null) return null;
    cost += (usage.cache_read_tokens / M) * rate.cache_read_per_mtok;
  }
  if (usage.cache_creation_tokens !== null && usage.cache_creation_tokens > 0) {
    if (rate.cache_write_per_mtok === null) return null;
    cost += (usage.cache_creation_tokens / M) * rate.cache_write_per_mtok;
  }
  return Number.isFinite(cost) ? cost : null;
}

/**
 * Abort classification shared by both boundaries so the same user action
 * lands with the same request_status everywhere. Covers fetch/AI-SDK
 * 'AbortError', Anthropic SDK 'APIUserAbortError' and DOMException variants.
 */
export function isAbortError(err: unknown): boolean {
  const name = (err as { name?: unknown } | null)?.name;
  return typeof name === 'string' && name.includes('Abort');
}

// ---------------------------------------------------------------------------
// Lifecycle ledger
// ---------------------------------------------------------------------------

export type ChatUsageBoundary = 'gateway.chat' | 'subagent.legacy_anthropic';

export type RequestStatus = 'started' | 'succeeded' | 'failed' | 'aborted';
/**
 * What we know about billed tokens, independent of request outcome:
 *  - pending: attempt opened, provider call in flight
 *  - final:   provider returned its authoritative usage for the call
 *  - partial: an error object carried usage (billed at least this much)
 *  - unknown: call terminated without any provider-reported usage
 */
export type UsageStatus = 'pending' | 'final' | 'partial' | 'unknown';

export interface AttemptStart {
  boundary: ChatUsageBoundary;
  /** Model id as the caller supplied it (pre-resolution). */
  modelRaw: string;
  /** Normalized `provider:model` when already known at start. */
  model?: string;
  providerId?: string;
  cacheWriteTtl?: CacheWriteTtl | null;
  jobId?: number | null;
  /** Overrides the ambient AsyncLocalStorage phase when provided. */
  phase?: string | null;
}

export interface AttemptFinish {
  requestStatus: Exclude<RequestStatus, 'started'>;
  usageStatus: Exclude<UsageStatus, 'pending'>;
  /**
   * Per-field observation; null = provider did not report that field.
   * finish() enforces the invariants: all-null (or absent) usage forces
   * usageStatus 'unknown'; a 'final' claim with any null field is
   * downgraded to 'partial'. NaN/Infinity are sanitized to null.
   */
  usage?: UsageCounts;
  /** Normalized model/provider learned during the call (post-resolution). */
  model?: string;
  providerId?: string;
  errorClass?: string;
}

export interface ChatUsageAttempt {
  readonly attemptId: string;
  /** Finalize the row. Best-effort, never throws, safe to call without await. */
  finish(outcome: AttemptFinish): Promise<void>;
}

let _recorderFailures = 0;
/** In-process count of ledger writes that failed (surfaced as a coverage gap). */
export function chatUsageRecorderFailures(): number {
  return _recorderFailures;
}

/** Pending write chains — awaited by tests and drained before CLI exit. */
const _pending = new Set<Promise<unknown>>();
export function flushChatUsage(): Promise<void> {
  return Promise.allSettled([..._pending]).then(() => undefined);
}

// Fire-and-forget sinks must drain before engine.disconnect() (the #1762
// PGLite busy-loop class). Registration lives here — the enqueue-owning
// module — per the background-work registry contract.
registerBackgroundWorkDrainer({
  name: 'chat-usage-log',
  order: 4,
  async drain(timeoutMs: number): Promise<{ unfinished: number }> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const bound = new Promise<void>(resolve => {
      timer = setTimeout(resolve, timeoutMs);
      (timer as { unref?: () => void }).unref?.();
    });
    await Promise.race([flushChatUsage(), bound]);
    if (timer) clearTimeout(timer);
    return { unfinished: _pending.size };
  },
});

function track<T>(p: Promise<T>): Promise<T> {
  _pending.add(p);
  p.finally(() => _pending.delete(p)).catch(() => {});
  return p;
}

const NOOP_ATTEMPT: ChatUsageAttempt = {
  attemptId: 'noop',
  finish: async () => {},
};

/**
 * Open a ledger row for one provider attempt. Call immediately before the
 * provider call; call `finish()` from both the success path and the
 * catch/finally path. Never throws; with no engine installed it returns a
 * no-op handle (and counts a recorder failure so the gap is visible).
 */
export function beginChatUsageAttempt(start: AttemptStart): ChatUsageAttempt {
  const engine = _engine;
  if (!engine) {
    _recorderFailures++;
    return NOOP_ATTEMPT;
  }
  const attemptId = randomUUID();
  const startedAt = new Date().toISOString();
  const phase = start.phase !== undefined ? start.phase : (currentChatPhase() ?? null);
  const cacheWriteTtl = start.cacheWriteTtl ?? null;

  const insertPromise = track((async () => {
    const sql = sqlQueryForEngine(engine);
    await sql`
      INSERT INTO chat_usage_log (
        attempt_id, boundary, phase, job_id, model_raw, model, provider_id,
        request_status, usage_status, cache_write_ttl, started_at
      ) VALUES (
        ${attemptId}, ${start.boundary}, ${phase}, ${start.jobId ?? null},
        ${start.modelRaw}, ${start.model ?? null}, ${start.providerId ?? null},
        'started', 'pending', ${cacheWriteTtl}, ${startedAt}
      )
    `;
  })().then(() => true, () => { _recorderFailures++; return false; }));

  let finished = false;
  return {
    attemptId,
    finish(outcome: AttemptFinish): Promise<void> {
      if (finished) return Promise.resolve();
      finished = true;
      return track((async () => {
        const inserted = await insertPromise;
        const model = outcome.model ?? start.model ?? null;
        const providerId = outcome.providerId ?? start.providerId ?? null;

        // Sanitize and enforce the status/usage invariants HERE, not at the
        // call sites: 'final' requires a complete, finite observation. A
        // provider that returned HTTP 200 with missing usage fields must not
        // produce "final, 0 tokens, $0" — that window would then claim
        // completeness at a fabricated total.
        let usage: UsageCounts | null = outcome.usage
          ? {
              input_tokens: sanitizeTokenCount(outcome.usage.input_tokens),
              output_tokens: sanitizeTokenCount(outcome.usage.output_tokens),
              cache_read_tokens: sanitizeTokenCount(outcome.usage.cache_read_tokens),
              cache_creation_tokens: sanitizeTokenCount(outcome.usage.cache_creation_tokens),
            }
          : null;
        let usageStatus: Exclude<UsageStatus, 'pending'> = outcome.usageStatus;
        const fields = usage
          ? [usage.input_tokens, usage.output_tokens, usage.cache_read_tokens, usage.cache_creation_tokens]
          : [];
        const allNull = fields.every(f => f === null);
        if (!usage || allNull) {
          usage = null;
          usageStatus = 'unknown';
        } else if (usageStatus === 'final' && fields.some(f => f === null)) {
          usageStatus = 'partial';
        }

        const rate = usage ? buildRateSnapshot(model, cacheWriteTtl) : null;
        const cost = usage ? computeCostUsd(usage, rate) : null;
        const completedAt = new Date().toISOString();
        const sql = sqlQueryForEngine(engine);
        // rate_snapshot binds as text and parses through an explicit
        // ::text::jsonb cast — the sanctioned form from docs/ENGINES.md
        // (#2339: a bare jsonb bind double-encodes under postgres.js and
        // PGLite hides it).
        const rateJson = rate ? JSON.stringify(rate) : null;
        if (inserted) {
          await sql`
            UPDATE chat_usage_log SET
              request_status = ${outcome.requestStatus},
              usage_status = ${usageStatus},
              model = ${model},
              provider_id = ${providerId},
              input_tokens = ${usage ? usage.input_tokens : null},
              output_tokens = ${usage ? usage.output_tokens : null},
              cache_read_tokens = ${usage ? usage.cache_read_tokens : null},
              cache_creation_tokens = ${usage ? usage.cache_creation_tokens : null},
              rate_source = ${rate ? 'model-pricing.ts:CANONICAL_PRICING' : null},
              rate_version = ${rate ? VERSION : null},
              rate_snapshot = ${rateJson}::text::jsonb,
              cost_usd = ${cost},
              error_class = ${outcome.errorClass ?? null},
              completed_at = ${completedAt}
            WHERE attempt_id = ${attemptId}
          `;
        } else {
          // The started INSERT failed (transient DB error) — try once to land
          // the terminal state as a single self-contained row.
          await sql`
            INSERT INTO chat_usage_log (
              attempt_id, boundary, phase, job_id, model_raw, model, provider_id,
              request_status, usage_status, cache_write_ttl,
              input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
              rate_source, rate_version, rate_snapshot, cost_usd, error_class,
              started_at, completed_at
            ) VALUES (
              ${attemptId}, ${start.boundary}, ${phase}, ${start.jobId ?? null},
              ${start.modelRaw}, ${model}, ${providerId},
              ${outcome.requestStatus}, ${usageStatus}, ${cacheWriteTtl},
              ${usage ? usage.input_tokens : null}, ${usage ? usage.output_tokens : null},
              ${usage ? usage.cache_read_tokens : null}, ${usage ? usage.cache_creation_tokens : null},
              ${rate ? 'model-pricing.ts:CANONICAL_PRICING' : null},
              ${rate ? VERSION : null},
              ${rateJson}::text::jsonb,
              ${cost}, ${outcome.errorClass ?? null},
              ${startedAt}, ${completedAt}
            )
          `;
        }
      })().catch(() => { _recorderFailures++; }));
    },
  };
}

/** Test seam: reset module state between tests. */
export function __resetChatUsageForTests(): void {
  _engine = null;
  _recorderFailures = 0;
  _pending.clear();
}
