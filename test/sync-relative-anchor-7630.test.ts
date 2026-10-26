/** Protects relative-anchor ownership and stalled foreground recovery. Existing
 * suites cover absolute anchors and sync faults separately, missing this chain.
 * Reverting either guard breaks these behavioral assertions; no new test seam. */
import { expect, test } from 'bun:test';
import { isAnchorOwnedSyncPath } from '../src/core/sync-anchor.ts';
import { assessDefaultSourcePath } from '../src/core/default-source-path-check.ts';
import { classifyTerminal, type TerminalInput } from '../src/core/persistence/terminal-classify.ts';
import type { BrainEngine } from '../src/core/engine.ts';

test('relative anchors cannot authorize auto-init; absolute identity still can', async () => {
  for (const sourceId of [undefined, 'default']) {
    for (const anchor of ['.', './', process.cwd()]) {
      const engine = { getConfig: async () => anchor,
        executeRaw: async () => [{ value: anchor }] } as unknown as BrainEngine;
      expect(await isAnchorOwnedSyncPath(engine, { sourceId }, process.cwd()))
        .toBe(anchor === process.cwd());
    }
  }
});

test('doctor warns on relative default paths even without pages', () => {
  for (const local_path of ['.', './notes', '../notes']) {
    const verdict = assessDefaultSourcePath({ defaultSource: { local_path }, livePages: 0,
      fileBackedPages: 0, repoPath: null, repoPathIsDir: false, collidingSourceId: null });
    expect(verdict.status).toBe('warn');
    expect(verdict.message).toContain('absolute');
  }
});

test('stalled foreground receipts inspect the writer; sync receipts retain retry', () => {
  const base: TerminalInput = { source_id: 'default', slug: 'notes/example', operation: 'remember',
    state: 'failed', error_code: 'preparation_stalled', recovery: null, blocked_reason: null, compacted: false };
  for (const operation of ['remember', 'put_page']) {
    for (const compacted of [false, true]) {
      const action = classifyTerminal({ ...base, operation, compacted })!.action;
      expect(action.argv).toEqual(['gbrain', 'sources', 'writer', 'status', '--source', 'default', '--json']);
      expect(action.why).toContain('new request_id');
    }
  }
  const sync = classifyTerminal({ ...base, operation: 'submit_job', intent_kind: 'managed_sync_import' })!;
  expect(sync.action.argv.slice(0, 2)).toEqual(['gbrain', 'sync']);
});
