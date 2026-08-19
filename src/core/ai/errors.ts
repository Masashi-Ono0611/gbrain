/**
 * AI service error hierarchy. Three classes mapping to caller decisions:
 *
 *   AIConfigError     — user fixes: bad key, missing model, dim mismatch.
 *                       Abort + show recovery recipe.
 *   AITransientError  — retryable: SDK retries exhausted, rate limit sustained.
 *                       Propagate so job queue can retry later.
 *   AIServiceError    — base class for both.
 *
 * The `fix` field carries a human-readable recovery recipe agents and humans
 * can act on. The `cause` field preserves the underlying SDK error.
 */

export class AIServiceError extends Error {
  /**
   * HTTP status of the underlying API failure, carried through top-level by
   * `normalizeAIError` when the wrapped error exposes one (e.g. the claude-cli
   * provider's ClaudeCliProcessError.apiErrorStatus), so callers can branch on
   * it without digging into `cause`.
   */
  apiErrorStatus?: number;
  /** HTTP status carried through from a wrapped error's own `status` field. */
  status?: number;

  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'AIServiceError';
  }
}

export class AIConfigError extends AIServiceError {
  constructor(
    message: string,
    public readonly fix?: string,
    cause?: unknown,
  ) {
    super(message, cause);
    this.name = 'AIConfigError';
  }
}

export class AITransientError extends AIServiceError {
  constructor(message: string, cause?: unknown) {
    super(message, cause);
    this.name = 'AITransientError';
  }
}

/**
 * Normalize any thrown error into our hierarchy. AI SDK errors are inspected
 * by status code + name; unknown errors default to AITransientError so the
 * caller does not permanently abort on a transient network blip.
 */
/**
 * Copy status fields from the wrapped error onto the normalized error's top
 * level (same property names), so typed information like the claude-cli
 * provider's `apiErrorStatus` stays reachable without unwrapping `cause`.
 */
function carryStatusFields(from: unknown, to: AIServiceError): AIServiceError {
  const src = from as {
    apiErrorStatus?: unknown;
    api_error_status?: unknown;
    status?: unknown;
  } | null | undefined;
  if (src && typeof src === 'object') {
    const apiStatus = src.apiErrorStatus ?? src.api_error_status;
    if (typeof apiStatus === 'number') to.apiErrorStatus = apiStatus;
    if (typeof src.status === 'number') to.status = src.status;
  }
  return to;
}

export function normalizeAIError(err: unknown, context?: string): AIServiceError {
  if (err instanceof AIServiceError) return err;

  const anyErr = err as {
    name?: string;
    status?: number;
    statusCode?: number;
    apiErrorStatus?: number;
    api_error_status?: number;
    message?: string;
  };
  const status = anyErr?.status ?? anyErr?.statusCode ?? anyErr?.apiErrorStatus ?? anyErr?.api_error_status;
  const name = anyErr?.name ?? '';
  const msg = anyErr?.message ?? String(err);
  const ctxPrefix = context ? `[${context}] ` : '';

  // 4xx (except 429) = config-level, non-retryable
  if (typeof status === 'number' && status >= 400 && status < 500 && status !== 429) {
    return carryStatusFields(err, new AIConfigError(
      `${ctxPrefix}${msg}`,
      status === 401 || status === 403
        ? 'Check your API key is valid and has access to this model.'
        : 'Check your model id + provider options match the provider API.',
      err,
    ));
  }

  // AI SDK named errors
  if (name === 'LoadAPIKeyError' || name === 'InvalidArgumentError') {
    return carryStatusFields(err, new AIConfigError(`${ctxPrefix}${msg}`, undefined, err));
  }

  // Everything else (5xx, timeouts, network) = transient
  return carryStatusFields(err, new AITransientError(`${ctxPrefix}${msg}`, err));
}

/** Whole-run LLM failure classes — see classifyGlobalLlmError. */
export type GlobalLlmErrorClass = 'auth' | 'billing' | 'rate_limit';

/**
 * Consecutive rate_limit-classified failures a cycle phase tolerates before
 * halting. auth/billing halt on the FIRST hit — a revoked key or an exhausted
 * spend limit is deterministic — but a bare 429 can be a transient burst that
 * clears between calls, so phases only abort after this many in a row (the
 * same intuition as the #2894 transport streak, applied at this layer's
 * consumers). Any non-rate-limit result resets the streak.
 */
export const RATE_LIMIT_HALT_STREAK = 3;

// Billing phrases are deliberately TIGHTER than sync-failure-ledger's
// EMBEDDING_QUOTA regex (which matches bare /billing/): a global-error hit
// halts an entire cycle phase, so a stray word inside a raw-output slice
// must not trip it. Only specific provider phrasings qualify.
const BILLING_MESSAGE_RE =
  /insufficient_quota|quota exceeded|exceeded your (?:current )?quota|credit balance is too low|spend limit|billing_not_active|billing hard limit|payment required/i;
const AUTH_MESSAGE_RE =
  /authentication_error|permission_error|invalid (?:x-)?api[-_ ]?key|api key (?:is )?(?:invalid|expired|missing)|unauthorized|\brequires\s+[A-Z0-9_]*(?:API_KEY|AUTH_TOKEN|ACCESS_TOKEN)\b/i;
const RATE_MESSAGE_RE = /rate[-_ ]?limit(?:ed|_error)?\b|too many requests/i;
// Generic structured status forms are trusted only before a raw-output marker.
// After that boundary, model-generated text may contain arbitrary JSON, so the
// only accepted status field is claude-cli's exact `api_error_status` envelope.
const STRUCTURED_STATUS_RE =
  /(?:"(?:api_error_status|status|statusCode)"\s*:\s*|\bHTTP[ /]|\bstatus(?:\s+code)?\s*[:= ]\s*)(401|402|403|429)\b/i;
const CLI_API_ERROR_STATUS_RE = /"api_error_status"\s*:\s*(401|402|403|429)\b/i;

function numericStatusOf(e: unknown): number | undefined {
  const anyErr = e as Record<string, unknown> | null | undefined;
  for (const key of ['status', 'statusCode', 'apiErrorStatus', 'api_error_status']) {
    const v = anyErr?.[key];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return undefined;
}

function statusToClass(status: number): GlobalLlmErrorClass | null {
  if (status === 401 || status === 403) return 'auth';
  if (status === 402) return 'billing';
  if (status === 429) return 'rate_limit';
  return null;
}

/**
 * Detect whole-run LLM failure conditions — auth, billing, rate limit — that
 * make retrying the SAME call on the next item pointless: every remaining
 * page/take in a cycle phase would fail identically (#3044). Callers halt
 * their per-item loop on 'auth'/'billing' immediately and on 'rate_limit'
 * after RATE_LIMIT_HALT_STREAK consecutive hits, surfacing a phase-level
 * halt instead of accumulating one swallowed warning per item.
 *
 * Matching is conservative by design: numeric status properties on the error
 * (or its `cause` chain), STRUCTURED status forms in the message, or specific
 * provider phrases. Plain 400s (context length, malformed request) stay
 * per-item — they can genuinely differ page to page. Billing phrases outrank
 * a 429 status because a monthly spend limit surfaces as 429 but is a billing
 * condition, not a transient rate limit.
 */
export function classifyGlobalLlmError(err: unknown): GlobalLlmErrorClass | null {
  try {
    const messages: string[] = [];
    let status: number | undefined;
    let cur: unknown = err;
    for (let depth = 0; depth < 3 && cur != null; depth++) {
      if (status === undefined) status = numericStatusOf(cur);
      if (typeof cur === 'string') messages.push(cur);
      else if (typeof (cur as { message?: unknown }).message === 'string') {
        messages.push((cur as { message: string }).message);
      }
      cur = (cur as { cause?: unknown }).cause;
    }
    const message = messages.join('\n');
    // Phrase regexes and generic status text only see content BEFORE the raw
    // marker. The exact claude-cli envelope field remains trusted across the
    // boundary because the adapter emits it as structured process metadata.
    const rawIdx = message.indexOf('--- raw ---');
    const phraseText = rawIdx === -1 ? message : message.slice(0, rawIdx);
    const rawText = rawIdx === -1 ? '' : message.slice(rawIdx);

    if (BILLING_MESSAGE_RE.test(phraseText)) return 'billing';
    if (status !== undefined) {
      const byStatus = statusToClass(status);
      if (byStatus) return byStatus;
    }
    const structured = STRUCTURED_STATUS_RE.exec(phraseText) ?? CLI_API_ERROR_STATUS_RE.exec(rawText);
    if (structured) {
      const byMessageStatus = statusToClass(Number(structured[1]));
      if (byMessageStatus) return byMessageStatus;
    }
    if (AUTH_MESSAGE_RE.test(phraseText)) return 'auth';
    if (RATE_MESSAGE_RE.test(phraseText)) return 'rate_limit';
    return null;
  } catch {
    // This classifier runs from catch/logging paths. Hostile getters and
    // Proxies must never replace the original failure with a classifier error.
    return null;
  }
}
