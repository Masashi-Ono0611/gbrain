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
export function normalizeAIError(err: unknown, context?: string): AIServiceError {
  if (err instanceof AIServiceError) return err;

  const anyErr = err as { name?: string; status?: number; statusCode?: number; message?: string };
  const status = anyErr?.status ?? anyErr?.statusCode;
  const name = anyErr?.name ?? '';
  const msg = anyErr?.message ?? String(err);
  const ctxPrefix = context ? `[${context}] ` : '';

  // 4xx (except 429) = config-level, non-retryable
  if (typeof status === 'number' && status >= 400 && status < 500 && status !== 429) {
    return new AIConfigError(
      `${ctxPrefix}${msg}`,
      status === 401 || status === 403
        ? 'Check your API key is valid and has access to this model.'
        : 'Check your model id + provider options match the provider API.',
      err,
    );
  }

  // AI SDK named errors
  if (name === 'LoadAPIKeyError' || name === 'InvalidArgumentError') {
    return new AIConfigError(`${ctxPrefix}${msg}`, undefined, err);
  }

  // Everything else (5xx, timeouts, network) = transient
  return new AITransientError(`${ctxPrefix}${msg}`, err);
}

/** Whole-run LLM failure classes — see classifyGlobalLlmError. */
export type GlobalLlmErrorClass = 'auth' | 'billing' | 'rate_limit';

// Billing phrases are deliberately TIGHTER than sync-failure-ledger's
// EMBEDDING_QUOTA regex (which matches bare /billing/): a global-error hit
// halts an entire cycle phase, so a stray word inside a raw-output slice
// must not trip it. Only specific provider phrasings qualify.
const BILLING_MESSAGE_RE =
  /insufficient_quota|quota exceeded|exceeded your (?:current )?quota|credit balance is too low|spend limit|billing_not_active|billing hard limit|payment required/i;
const AUTH_MESSAGE_RE =
  /authentication_error|permission_error|invalid (?:x-)?api[-_ ]?key|api key (?:is )?(?:invalid|expired|missing)|unauthorized/i;
const RATE_MESSAGE_RE = /rate[-_ ]?limit(?:ed|_error)?\b|too many requests/i;
// Structured status forms only — `HTTP 429`, `status 429`, `status code: 429`,
// `"api_error_status":429` (the claude-cli JSON result blob). A bare number in
// prose ("processed 429 pages") never matches.
const STRUCTURED_STATUS_RE =
  /(?:"(?:api_error_status|status|statusCode)"\s*:\s*|\bHTTP[ /]|\bstatus(?:\s+code)?\s*[:= ]\s*)(401|402|403|429)\b/i;

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
 * page/take in a cycle phase would fail identically (#3044). Callers use a
 * non-null result to break their per-item loop and surface a phase-level
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

  if (BILLING_MESSAGE_RE.test(message)) return 'billing';
  if (status !== undefined) {
    const byStatus = statusToClass(status);
    if (byStatus) return byStatus;
  }
  const structured = STRUCTURED_STATUS_RE.exec(message);
  if (structured) {
    const byMessageStatus = statusToClass(Number(structured[1]));
    if (byMessageStatus) return byMessageStatus;
  }
  if (AUTH_MESSAGE_RE.test(message)) return 'auth';
  if (RATE_MESSAGE_RE.test(message)) return 'rate_limit';
  return null;
}
