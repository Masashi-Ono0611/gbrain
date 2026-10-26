import type { Migration } from './types.ts';
import { buildIndexOnline, migrationNotice } from './helpers.ts';
import { PERSISTENCE_FOREGROUND_COMMITTED_INDEX } from '../persistence/schema.ts';

// The claim fairness probe starts at sequence zero after a consumer restart.
// Build online so a large existing journal remains writable during upgrade;
// buildIndexOnline also retries invalid remnants of an interrupted build.
export const v276: Migration = {
  version: 276,
  name: 'persistence_foreground_committed_index',
  idempotent: true,
  transaction: false,
  sql: '',
  handler: async engine => {
    await buildIndexOnline(engine, 276, PERSISTENCE_FOREGROUND_COMMITTED_INDEX, {
      notice: migrationNotice, rebuild: 'gbrain apply-migrations --yes',
    });
  },
};
