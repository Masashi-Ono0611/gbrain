/**
 * terminal-provenance (patch 208, local-only) — a reply-free provenance tag for
 * the persisted terminal record of a minion job, so a later investigator can
 * tell WHICH gbrain build produced a failed/dead/cancelled job, how the
 * attempt ended (thrown error, abort reason such as timeout/cancel/watchdog,
 * or a cancel) and, when the failing handler surfaced one, the provider stop
 * reason. It carries only short tokens: never the error message, model reply
 * text, prompts or secrets. It is appended to the per-attempt `stacktrace`
 * entry (a jsonb array already written on every failure), so error_text, the
 * child_done payload and every reason-prefix stat stay byte-identical and no
 * schema migration is needed.
 */
import { VERSION } from '../../version.ts';

const TOKEN = /^[A-Za-z0-9_.:-]{1,40}$/;
// The build string also reaches a cancelJobs SQL literal: anything outside a plain version shape becomes 'unknown'.
const BUILD = /^[0-9A-Za-z.+-]{1,40}$/.test(VERSION) ? VERSION : 'unknown';

function token(v: unknown): string | null {
  return typeof v === 'string' && TOKEN.test(v) ? v : null;
}

/** Provider stop reason the failing handler attached to its error, if any. */
export function errorStopReason(err: unknown): string | null {
  if (typeof err !== 'object' || err === null) return null;
  const e = err as { stopReason?: unknown; stop_reason?: unknown };
  return token(e.stopReason) ?? token(e.stop_reason);
}

export interface TerminalProvenanceInput {
  /** 'failed' | 'dead' | 'delayed' | 'cancelled'. */
  status: string;
  /** Attempt number that just ended (1-based), when known. */
  attempt?: number;
  /** Per-job abort reason ('timeout' | 'cancel' | 'lock-lost' | ...), when aborted. */
  abortReason?: string | null;
  /** Error class name (constructor name), never the message. */
  errorName?: string | null;
  stopReason?: string | null;
}

/** `[gbrain=<VERSION> status=… attempt=… disposition=… error=… stop_reason=…]`. */
export function terminalProvenance(i: TerminalProvenanceInput): string {
  const parts = [`gbrain=${BUILD}`, `status=${token(i.status) ?? 'unknown'}`];
  if (typeof i.attempt === 'number' && Number.isInteger(i.attempt)) parts.push(`attempt=${i.attempt}`);
  const abort = token(i.abortReason);
  parts.push(`disposition=${abort ? `aborted:${abort}` : i.status === 'cancelled' ? 'cancelled' : 'thrown'}`);
  const en = token(i.errorName);
  if (en) parts.push(`error=${en}`);
  const sr = token(i.stopReason);
  if (sr) parts.push(`stop_reason=${sr}`);
  return `[${parts.join(' ')}]`;
}
