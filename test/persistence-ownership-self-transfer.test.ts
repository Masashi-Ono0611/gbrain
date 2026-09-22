import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { acceptWriterTransfer, acquireWorktree, claimWorktree, getWorktreeBinding, prepareWriterTransfer } from '../src/core/persistence/ownership.ts';
import { localHostId } from '../src/core/persistence/identity.ts';
import { PHYSICAL_ROOT_MARKER } from '../src/core/persistence/physical-root-record.ts';
import { withEnv } from './helpers/with-env.ts';

// Regression coverage for #5301/#5269: a physical-root device-id (st_dev) drift
// across a reboot leaves acquireWorktree/assertPhysicalRoot permanently refusing
// writes on an otherwise-intact checkout, and the normal writer-transfer path is
// itself gated behind that same assertion (a catch-22 — see the plan file). The
// selfTransfer option on prepareWriterTransfer/acceptWriterTransfer breaks that
// loop for the SAME host recovering its OWN worktree.

const directory = mkdtempSync(join(tmpdir(), 'gbrain-self-transfer-'));
let engine: PGLiteEngine;
beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 120_000);
afterAll(async () => { await engine.disconnect(); rmSync(directory, { recursive: true, force: true }); });

async function fixture() {
  const base = join(directory, randomUUID()); mkdirSync(base);
  const root = join(base, 'canonical'); mkdirSync(root); writeFileSync(join(root, 'page.md'), 'Canonical example');
  const home = join(base, 'user-a'); mkdirSync(home);
  const decoyRoot = join(base, 'decoy'); mkdirSync(decoyRoot); writeFileSync(join(decoyRoot, 'page.md'), 'Canonical example');
  const source = `self-transfer-${randomUUID()}`;
  await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [source, root]);
  const host = await withEnv({ GBRAIN_HOME: home }, () => localHostId());
  return { base, root, decoyRoot, home, source, host };
}

/** Simulate the exact real-world failure: only `device` drifted (as macOS does
 * across a reboot), inode and birth still match — see persistence-physical-root.test.ts's
 * device-drift test for the same shape. */
function driftDevice(root: string) {
  const markerPath = join(root, PHYSICAL_ROOT_MARKER);
  const stamp = JSON.parse(readFileSync(markerPath, 'utf8'));
  stamp.device = String(BigInt(stamp.device) + 1n);
  writeFileSync(markerPath, JSON.stringify(stamp));
}

test('self-transfer recovers a device-drifted worktree and acquireWorktree works again afterward', async () => {
  const f = await fixture();
  const binding = await withEnv({ GBRAIN_HOME: f.home }, () => claimWorktree(engine, f.source, f.root, f.host));
  driftDevice(f.root);

  // Confirm the catch-22: the checkout is unusable via the normal path.
  await expect(acquireWorktree(binding)).rejects.toMatchObject({ code: 'recovery_required' });

  const prepared = await withEnv({ GBRAIN_HOME: f.home },
    () => prepareWriterTransfer(engine, f.source, f.host, undefined, { selfTransfer: true }));
  expect(prepared.worktree_id).toBe(binding.worktree_id);

  await withEnv({ GBRAIN_HOME: f.home }, () => acceptWriterTransfer(
    engine, f.source, f.root, prepared.owner_epoch, prepared.manifest.digest, f.host, undefined, { selfTransfer: true }));

  const recovered = await getWorktreeBinding(engine, f.source, f.host);
  expect(recovered?.state).toBe('active');
  const lock = await acquireWorktree(recovered!);
  expect(lock).not.toBeNull();
  await lock?.release();
});

test('self-transfer accept refuses a same-content clone planted at a different path', async () => {
  const f = await fixture();
  const binding = await withEnv({ GBRAIN_HOME: f.home }, () => claimWorktree(engine, f.source, f.root, f.host));
  driftDevice(f.root);
  const prepared = await withEnv({ GBRAIN_HOME: f.home },
    () => prepareWriterTransfer(engine, f.source, f.host, undefined, { selfTransfer: true }));

  // f.decoyRoot has byte-identical content (same manifest digest) but is NOT the
  // DB-recorded canonical path — this is exactly the gap Codex's review flagged:
  // manifest equality alone would accept relocating ownership to a planted clone.
  await expect(withEnv({ GBRAIN_HOME: f.home }, () => acceptWriterTransfer(
    engine, f.source, f.decoyRoot, prepared.owner_epoch, prepared.manifest.digest, f.host, undefined, { selfTransfer: true }),
  )).rejects.toMatchObject({ code: 'source_changed' });

  // The original checkout's marker must be untouched by the refused attempt.
  await expect(acquireWorktree(binding)).rejects.toMatchObject({ code: 'recovery_required' });
});

test('self-transfer refuses a caller that is not the current owner host', async () => {
  const f = await fixture();
  await withEnv({ GBRAIN_HOME: f.home }, () => claimWorktree(engine, f.source, f.root, f.host));
  driftDevice(f.root);
  const otherHome = join(f.base, 'user-b'); mkdirSync(otherHome);
  const otherHost = await withEnv({ GBRAIN_HOME: otherHome }, () => localHostId());

  await expect(withEnv({ GBRAIN_HOME: otherHome },
    () => prepareWriterTransfer(engine, f.source, otherHost, undefined, { selfTransfer: true }),
  )).rejects.toMatchObject({ code: 'permission_denied' });
});

test('an ordinary (non-self) transfer still uses the physical-root check and is unaffected by device drift alone', async () => {
  const f = await fixture();
  const binding = await withEnv({ GBRAIN_HOME: f.home }, () => claimWorktree(engine, f.source, f.root, f.host));
  // No drift here: prove the default path (selfTransfer omitted) is unchanged —
  // an ordinary prepare from the true owner, on an intact checkout, still works.
  const prepared = await withEnv({ GBRAIN_HOME: f.home }, () => prepareWriterTransfer(engine, f.source, f.host));
  expect(prepared.worktree_id).toBe(binding.worktree_id);
  const rebound = await getWorktreeBinding(engine, f.source, f.host);
  expect(rebound?.state).toBe('draining');
});
