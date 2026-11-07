/**
 * patch 208 (local-only): the persisted terminal record of a minion job keeps
 * the producing gbrain build, the attempt disposition and (when surfaced) the
 * provider stop reason, without touching error_text or storing reply text.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { errorStopReason, terminalProvenance } from '../src/core/minions/terminal-provenance.ts';
import { VERSION } from '../src/version.ts';

let engine: PGLiteEngine;
let queue: MinionQueue;
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ database_url: '' });
  await engine.initSchema();
  queue = new MinionQueue(engine);
});
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => { await engine.executeRaw('DELETE FROM minion_jobs'); });

async function stack(id: number): Promise<string[]> {
  const r = await engine.executeRaw<{ stacktrace: unknown; error_text: string | null }>(
    `SELECT stacktrace, error_text FROM minion_jobs WHERE id = $1`, [id]);
  const s = r[0]!.stacktrace;
  return (typeof s === 'string' ? JSON.parse(s) : s) as string[];
}

describe('terminalProvenance', () => {
  test('carries build, status, attempt, disposition, error class and stop reason', () => {
    expect(terminalProvenance({ status: 'dead', attempt: 3, abortReason: 'timeout', errorName: 'Error', stopReason: 'max_tokens' }))
      .toBe(`[gbrain=${VERSION} status=dead attempt=3 disposition=aborted:timeout error=Error stop_reason=max_tokens]`);
  });
  test('drops values that are not short tokens (no reply text can leak)', () => {
    expect(errorStopReason({ stopReason: 'the model said: hello world' })).toBeNull();
    expect(errorStopReason({ stop_reason: 'refusal' })).toBe('refusal');
    expect(terminalProvenance({ status: 'dead', stopReason: 'x y z' })).not.toContain('stop_reason');
  });
});

describe('failJob / cancelJob persist provenance', () => {
  test('dead job: stacktrace entry has the tag, error_text is unchanged', async () => {
    const job = await queue.add('prov-test', {}, { max_attempts: 1 });
    const tok = 'tok-prov-1';
    expect((await queue.claim(tok, 30000, 'default', ['prov-test']))?.id).toBe(job.id);
    const prov = terminalProvenance({ status: 'dead', attempt: 1, errorName: 'Error', stopReason: 'refusal' });
    const failed = await queue.failJob(job.id, tok, 'boom', 'dead', 0, undefined, prov);
    expect(failed?.error_text).toBe('boom');
    const s = await stack(job.id);
    expect(s[s.length - 1]).toBe(`boom ${prov}`);
    expect(s[s.length - 1]).toContain(`gbrain=${VERSION}`);
  });
  test('failJob without provenance keeps the legacy entry', async () => {
    const job = await queue.add('prov-test', {}, { max_attempts: 1 });
    expect((await queue.claim('t2', 30000, 'default', ['prov-test']))?.id).toBe(job.id);
    await queue.failJob(job.id, 't2', 'boom', 'dead');
    expect((await stack(job.id)).pop()).toBe('boom');
  });
  test('cancelled job records the cancelling build, error_text untouched', async () => {
    const job = await queue.add('prov-test', {});
    const c = await queue.cancelJob(job.id);
    expect(c?.status).toBe('cancelled');
    const s = await stack(job.id);
    expect(s.pop()).toBe(`[gbrain=${VERSION} status=cancelled disposition=cancelled]`);
  });
});
