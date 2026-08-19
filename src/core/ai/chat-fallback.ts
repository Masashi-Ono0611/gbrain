/**
 * Availability-only chat fallback with sticky demotions. The demotion cache is
 * process-local and keyed only by normalized model id, so gateway
 * reconfiguration within the same process inherits earlier demotions.
 */
import { classifyGlobalLlmError, type GlobalLlmErrorClass } from './errors.ts';
import {
  chat,
  getChatFallbackChain,
  getChatModel,
  isAvailable,
  type ChatOpts,
  type ChatResult,
} from './gateway.ts';
import { normalizeModelId } from '../model-id.ts';

const DEMOTION_TTL_MS = 10 * 60 * 1000;

type AvailabilityFailure = Extract<GlobalLlmErrorClass, 'billing' | 'rate_limit'>;

interface Demotion {
  until: number;
  classification: AvailabilityFailure;
}

interface Candidate {
  model: string;
  normalized: string;
}

interface TerminalError {
  error: unknown;
  classification: GlobalLlmErrorClass | null;
}

const demotedModels = new Map<string, Demotion>();
const TERMINAL_ERROR_PRIORITY: Record<GlobalLlmErrorClass, number> = {
  auth: 3,
  billing: 2,
  rate_limit: 1,
};

function normalizedModel(model: string): string {
  return normalizeModelId(model.trim());
}

function activeDemotion(model: string): Demotion | null {
  const demotion = demotedModels.get(model);
  if (!demotion) return null;
  if (demotion.until > Date.now()) return demotion;
  demotedModels.delete(model);
  return null;
}

function terminalErrorPriority(classification: GlobalLlmErrorClass | null): number {
  return classification === null ? 0 : TERMINAL_ERROR_PRIORITY[classification];
}

function sanitizeLogValue(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, '');
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  if (signal.reason !== undefined) throw signal.reason;
  throw new DOMException('This operation was aborted', 'AbortError');
}

function attachFirstError(lastError: unknown, firstError: unknown): void {
  if (lastError === firstError || !lastError || typeof lastError !== 'object') return;
  try {
    Object.defineProperty(lastError, 'fallbackFirstError', {
      configurable: true,
      value: firstError,
    });
  } catch {
    // A frozen/provider-owned error still wins as the terminal failure.
  }
}

function logHop(
  fromModel: string,
  toModel: string,
  classification: AvailabilityFailure,
  attemptIndex: number,
): void {
  const safeFromModel = sanitizeLogValue(fromModel);
  const safeToModel = sanitizeLogValue(toModel);
  process.stderr.write(
    `[chat-fallback] from=${safeFromModel} to=${safeToModel} ` +
    `classification=${classification} attempt=${attemptIndex}\n`,
  );
}

function logSkippedEntry(
  model: string,
  nextModel: string | undefined,
  classification: 'auth' | null,
  attemptIndex: number,
  error: unknown,
): void {
  let detail = '<unprintable>';
  try {
    detail = error instanceof Error ? error.message : String(error);
  } catch {
    // Logging must never replace the provider error or stop the chain.
  }
  const safeModel = sanitizeLogValue(model);
  const safeNextModel = nextModel === undefined
    ? '<exhausted>'
    : sanitizeLogValue(nextModel);
  const safeDetail = sanitizeLogValue(detail).slice(0, 200);
  process.stderr.write(
    `[chat-fallback] skip=${safeModel} next=${safeNextModel} ` +
    `classification=${classification ?? 'unclassified'} attempt=${attemptIndex} ` +
    `error=${JSON.stringify(safeDetail)}\n`,
  );
}

/**
 * Run a chat call and advance through the configured provider chain only for
 * availability failures. Primary auth/unclassified failures propagate; the
 * same failures from optional chain entries are reported and skipped.
 */
export async function chatWithFallback(opts: ChatOpts): Promise<ChatResult> {
  const primaryModel = opts.model ?? getChatModel();
  const primary: Candidate = {
    model: primaryModel,
    normalized: normalizedModel(primaryModel),
  };

  const seen = new Set([primary.normalized]);
  const fallbacks: Candidate[] = [];
  for (const entry of getChatFallbackChain()) {
    const normalized = normalizedModel(entry);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    if (!isAvailable('chat', entry)) continue;
    if (activeDemotion(normalized)) continue;
    fallbacks.push({ model: entry, normalized });
  }

  const primaryDemotion = activeDemotion(primary.normalized);
  // Demotion is best-effort: when no alternate is usable, preserve chat()'s
  // behavior by trying the primary instead of manufacturing a local failure.
  const attempts = primaryDemotion && fallbacks.length > 0
    ? fallbacks
    : [primary, ...fallbacks];

  let firstError: unknown;
  let lastError: unknown;
  let terminalError: TerminalError | null = null;
  let pendingHop: { from: string; classification: AvailabilityFailure } | null =
    primaryDemotion && attempts[0] !== primary
      ? { from: primary.model, classification: primaryDemotion.classification }
      : null;

  for (let index = 0; index < attempts.length; index++) {
    throwIfAborted(opts.abortSignal);
    const candidate = attempts[index]!;
    if (pendingHop) {
      logHop(pendingHop.from, candidate.model, pendingHop.classification, index + 1);
      pendingHop = null;
    }

    try {
      const result = await chat({ ...opts, model: candidate.model });
      demotedModels.delete(candidate.normalized);
      return result;
    } catch (err) {
      firstError ??= err;
      lastError = err;
      const classification = classifyGlobalLlmError(err);
      if (
        terminalError === null ||
        terminalErrorPriority(classification) >=
          terminalErrorPriority(terminalError.classification)
      ) {
        terminalError = { error: err, classification };
      }
      if (classification !== 'billing' && classification !== 'rate_limit') {
        if (candidate === primary) throw err;
        logSkippedEntry(
          candidate.model,
          attempts[index + 1]?.model,
          classification,
          index + 1,
          err,
        );
        continue;
      }

      const now = Date.now();
      for (const [model, demotion] of demotedModels) {
        if (demotion.until <= now) demotedModels.delete(model);
      }
      demotedModels.set(candidate.normalized, {
        until: now + DEMOTION_TTL_MS,
        classification,
      });
      if (index + 1 < attempts.length) {
        pendingHop = { from: candidate.model, classification };
      }
    }
  }

  const errorToThrow = terminalError?.error ?? lastError;
  attachFirstError(errorToThrow, firstError);
  throw errorToThrow;
}

/** @internal Test-only reset for the process-local sticky demotion cache. */
export function __resetChatFallbackStateForTests(): void {
  demotedModels.clear();
}
