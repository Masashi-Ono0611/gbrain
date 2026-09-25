import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { submitWithAdmissionRetry } from '../scripts/persistence/producer-admission.ts';
import { retryWriteAdmission } from '../src/core/persistence/admission-retry.ts';

const exhaustedAdmission = Object.assign(new Error('contention'), {
  code: 'storage_error', writeError: 'storage_error', retryableAdmissionContention: true,
});

describe('persistence validation producer admission', () => {
  test('retries exhausted contention once with the same request ID and does not retry other errors', async () => {
    const requestId = 'same-request-id';
    const attempts: string[] = [];
    const accepted = { request_id: requestId, state: 'queued' };
    const row = await submitWithAdmissionRetry(async () => {
      attempts.push(requestId);
      if (attempts.length === 1) throw exhaustedAdmission;
      return accepted;
    });
    expect(row).toBe(accepted);
    expect(attempts).toEqual([requestId, requestId]);

    const otherError = Object.assign(new Error('unrelated'), { code: 'storage_error', writeError: 'storage_error' });
    let otherAttempts = 0;
    await expect(submitWithAdmissionRetry(async () => { otherAttempts++; throw otherError; })).rejects.toBe(otherError);
    expect(otherAttempts).toBe(1);

    // Keep this test coupled to the actual producer wiring for the discrimination check.
    expect(readFileSync(new URL('../scripts/persistence/worker.ts', import.meta.url), 'utf8'))
      .toContain('submitWithAdmissionRetry(() => admitWrite');
  });

  test('an admission that stays blocked by contention is marked retryable for the same request ID', async () => {
    const blocked = retryWriteAdmission('same-request-id', async () => { throw Object.assign(new Error('serialization failure'), { code: '40001' }); });
    await expect(blocked).rejects.toMatchObject({ code: 'storage_error', writeError: 'storage_error', retryableAdmissionContention: true });
  }, 15_000);
});
