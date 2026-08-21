/**
 * Regression test for #4318 — `promptYesNo`'s `rl.close()`-before-`resolve()`
 * race.
 *
 * `readline.Interface#close()` emits `'close'` synchronously. When the
 * `rl.question` callback called `rl.close()` before `resolve(answer)`, the
 * unguarded `rl.on('close', () => resolve(false))` fallback fired first and
 * won the race (a Promise only honors its first resolution) — so the
 * interactive `Proceed? [y/N]` gate discarded every typed answer, including
 * explicit `y`/`yes`, and always cancelled.
 *
 * Covers all three call sites that shared the exact buggy shape:
 *   - src/core/sync-cost-gate.ts (the reported `gbrain sync` cost gate)
 *   - src/commands/reindex-code.ts (flagged by the reporter as the same defect)
 *   - src/commands/pglite-repair.ts (found during the fix; identical shape)
 *
 * Drives the real exported functions against a fake stdin (no real TTY
 * needed), so this exercises the shipped ordering fix, not a reimplementation.
 */
import { describe, test, expect } from 'bun:test';
import { PassThrough } from 'node:stream';
import { promptYesNo as costGatePromptYesNo } from '../src/core/sync-cost-gate.ts';
import { promptYesNo as reindexPromptYesNo } from '../src/commands/reindex-code.ts';
import { promptYesNo as pgliteRepairPromptYesNo } from '../src/commands/pglite-repair.ts';

type FakeStdin = PassThrough & { isTTY?: boolean };

/**
 * Swap `process.stdin` for a fake, controllable stream for the duration of
 * `fn`, restoring the original afterward even if `fn` throws. `process.stdin`
 * is a configurable property on this runtime (verified locally before
 * relying on it here), so this is a safe temporary swap rather than a
 * permanent mutation.
 */
async function withFakeStdin<T>(
  fn: (stdin: FakeStdin) => Promise<T>,
  opts: { isTTY?: boolean } = {},
): Promise<T> {
  const origStdin = process.stdin;
  const fake = new PassThrough() as FakeStdin;
  fake.isTTY = opts.isTTY ?? true;
  Object.defineProperty(process, 'stdin', { value: fake, configurable: true, writable: true });
  try {
    return await fn(fake);
  } finally {
    Object.defineProperty(process, 'stdin', { value: origStdin, configurable: true, writable: true });
  }
}

/** `answer === null` simulates EOF/Ctrl-D (stdin ends with no line typed). */
async function typeAnswer(
  promptFn: (question: string) => Promise<boolean>,
  answer: string | null,
  opts: { isTTY?: boolean } = {},
): Promise<boolean> {
  return withFakeStdin(async (stdin) => {
    const pending = promptFn('Proceed? [y/N] ');
    if (answer === null) {
      stdin.end();
    } else {
      stdin.write(`${answer}\n`);
    }
    return pending;
  }, opts);
}

describe('#4318 — promptYesNo close()-before-resolve() race', () => {
  const impls: Array<[string, (question: string) => Promise<boolean>]> = [
    ['src/core/sync-cost-gate.ts', costGatePromptYesNo],
    ['src/commands/reindex-code.ts', reindexPromptYesNo],
    ['src/commands/pglite-repair.ts', pgliteRepairPromptYesNo],
  ];

  for (const [label, promptFn] of impls) {
    describe(label, () => {
      test('typing "y" resolves true (the #4318 bug made this resolve false)', async () => {
        expect(await typeAnswer(promptFn, 'y')).toBe(true);
      });

      test('typing "yes" resolves true (the #4318 bug made this resolve false)', async () => {
        expect(await typeAnswer(promptFn, 'yes')).toBe(true);
      });

      test('typing "Y" resolves true (case-insensitive)', async () => {
        expect(await typeAnswer(promptFn, 'Y')).toBe(true);
      });

      test('typing "n" resolves false', async () => {
        expect(await typeAnswer(promptFn, 'n')).toBe(false);
      });

      test('typing an empty line resolves false', async () => {
        expect(await typeAnswer(promptFn, '')).toBe(false);
      });

      test('typing an unrecognized answer resolves false', async () => {
        expect(await typeAnswer(promptFn, 'maybe')).toBe(false);
      });

      test('EOF / Ctrl-D with no answer resolves false (and does not hang)', async () => {
        expect(await typeAnswer(promptFn, null)).toBe(false);
      });
    });
  }

  test('src/commands/pglite-repair.ts still short-circuits to false on non-TTY stdin', async () => {
    // Pre-existing safeguard (W0 fix-wave Tier-1 #15), unrelated to #4318 —
    // asserted here only to confirm the ordering fix didn't regress it.
    expect(await typeAnswer(pgliteRepairPromptYesNo, 'y', { isTTY: false })).toBe(false);
  });
});
