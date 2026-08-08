/**
 * pglite-leftovers-check — detect abandoned PGLite stores after an engine
 * migration (#3856).
 *
 * A pglite -> postgres migration leaves BOTH `brain.pglite/` (the old engine's
 * store) and `brain.pglite.pre-migrate-<date>/` (the safety copy the migration
 * takes first) under the gbrain home, untouched, forever. Together they weigh
 * roughly 2x the live DB, nothing ever surfaces them, and they silently ride
 * along in any backup that archives the gbrain home — the reporting brain paid
 * to permanently archive a dead engine's corpse on Arweave for 2.5 months
 * (898 MB -> 459 MB snapshot, ~half the monthly cost, once excluded by hand).
 *
 * Pure assessment helpers (filesystem-only, no network, no shelling out) so
 * `gbrain doctor` can warn with receipts, in the same shape as
 * npm-squat-check.ts (#505). The caller supplies the configured engine kind
 * and the gbrain home path.
 *
 * Deliberately warn-only with a MANUAL remediation: deciding when a
 * pre-migration copy is safe to drop is a policy question (#3856 ask 2) — this
 * check only makes the corpse visible, it never deletes anything. The
 * remediation text names no CLI command that does not exist (#3697).
 */
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

export interface PgliteLeftoverDir {
  path: string;
  /** Bytes summed over a bounded recursive walk (see SIZE_WALK_MAX_ENTRIES). */
  approx_bytes: number;
  /** True when the walk hit its entry cap — approx_bytes is then a floor. */
  size_truncated: boolean;
  /** The directory's own mtime (ISO) — frozen at the migration minute in the wild. */
  last_modified: string | null;
}

export interface PgliteLeftoversAssessment {
  status: 'ok' | 'warn' | 'skip';
  message: string;
  leftovers: PgliteLeftoverDir[];
}

/**
 * Bound on how many filesystem entries the size walk visits per leftover dir.
 * A PGLite store is a modest number of large files, so real stores finish well
 * under this; the cap exists so a pathological tree cannot stall doctor.
 */
export const SIZE_WALK_MAX_ENTRIES = 20_000;

/** True for the old engine store itself and any `brain.pglite.<suffix>` sibling
 *  (the migration's pre-migrate safety copies are `brain.pglite.pre-migrate-<date>`). */
export function isPgliteStoreName(name: string): boolean {
  return name === 'brain.pglite' || name.startsWith('brain.pglite.');
}

function walkSize(dir: string, budget: { entries: number }): { bytes: number; truncated: boolean } {
  let bytes = 0;
  let truncated = false;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return { bytes: 0, truncated: false };
  }
  for (const name of names) {
    if (budget.entries <= 0) return { bytes, truncated: true };
    budget.entries--;
    const p = join(dir, name);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      const sub = walkSize(p, budget);
      bytes += sub.bytes;
      truncated = truncated || sub.truncated;
    } else if (st.isFile()) {
      bytes += st.size;
    }
  }
  return { bytes, truncated };
}

function humanBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(0)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${n} B`;
}

/**
 * Assess a gbrain home for abandoned PGLite stores.
 *
 * - engine `pglite` (or missing/unknown config) -> `skip`: `brain.pglite` is
 *   (or may be) the LIVE store; warning would be noise, and an unreadable
 *   config must fail open rather than accuse a healthy brain.
 * - any other engine, no `brain.pglite*` dirs -> `ok`.
 * - any other engine, one or more `brain.pglite*` dirs -> `warn`, naming each
 *   dir with its approximate size and frozen mtime.
 */
export function assessPgliteLeftovers(
  engineKind: string | null | undefined,
  gbrainHome: string,
): PgliteLeftoversAssessment {
  if (!engineKind || engineKind === 'pglite') {
    return { status: 'skip', message: '', leftovers: [] };
  }
  let names: string[];
  try {
    names = readdirSync(gbrainHome);
  } catch {
    return { status: 'skip', message: '', leftovers: [] };
  }
  const leftovers: PgliteLeftoverDir[] = [];
  for (const name of names.filter(isPgliteStoreName).sort()) {
    const p = join(gbrainHome, name);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    const { bytes, truncated } = walkSize(p, { entries: SIZE_WALK_MAX_ENTRIES });
    leftovers.push({
      path: p,
      approx_bytes: bytes,
      size_truncated: truncated,
      last_modified: st.mtime ? st.mtime.toISOString() : null,
    });
  }
  if (leftovers.length === 0) {
    return {
      status: 'ok',
      message: `No abandoned PGLite store under the gbrain home (engine: ${engineKind}).`,
      leftovers,
    };
  }
  const total = leftovers.reduce((s, l) => s + l.approx_bytes, 0);
  const anyTruncated = leftovers.some((l) => l.size_truncated);
  const listing = leftovers
    .map(
      (l) =>
        `${l.path} (${l.size_truncated ? '>=' : ''}${humanBytes(l.approx_bytes)}` +
        `${l.last_modified ? `, untouched since ${l.last_modified.slice(0, 10)}` : ''})`,
    )
    .join('; ');
  return {
    status: 'warn',
    message:
      `Engine is ${engineKind}, but ${leftovers.length} PGLite store dir(s) remain: ${listing} — ` +
      `${anyTruncated ? 'at least ' : ''}${humanBytes(total)} of reclaimable disk from before the migration. ` +
      `They also inflate any backup that archives the gbrain home. Your live data is in the ${engineKind} ` +
      `engine; once you have verified that (a recent restore or backup of it), these dirs are safe to ` +
      `delete by hand — gbrain never deletes them for you.`,
    leftovers,
  };
}
