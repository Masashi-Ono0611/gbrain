import type { BrainEngine } from '../../../core/engine.ts';
import { hasPostgresCancellationCapability, type PostgresEngine } from '../../../core/postgres-engine.ts';
import type { Check } from '../../doctor.ts';

const MISSING_PATCH_MESSAGE =
  'The postgres driver lacks discard(): cancellation/write admission will fail and /health returns 503. Reinstall from a checkout per INSTALL_FOR_AGENTS.md, or for a global Bun install place the patches/*.patch files of the installed commit under ~/.bun/install/global/patches/ and reinstall (#5466).';

export async function checkPostgresCancellationDriver(engine: BrainEngine): Promise<Check | null> {
  if (engine.kind !== 'postgres') return null;

  let owner: { discard?: unknown; release?: () => void } | undefined;
  try {
    const sql = (engine as PostgresEngine).sql;
    owner = await sql.reserve() as typeof owner;
    if (!hasPostgresCancellationCapability(owner)) {
      return { name: 'postgres_cancellation_driver', status: 'fail', message: MISSING_PATCH_MESSAGE };
    }
    return { name: 'postgres_cancellation_driver', status: 'ok', message: 'Postgres driver supports safe query cancellation.' };
  } catch {
    return {
      name: 'postgres_cancellation_driver',
      status: 'warn',
      message: 'Could not inspect the reserved Postgres connection for cancellation support.',
    };
  } finally {
    owner?.release?.();
  }
}
