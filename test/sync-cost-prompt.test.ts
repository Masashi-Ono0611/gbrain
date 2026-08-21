import { describe, expect, test } from 'bun:test';
import { promptYesNo } from '../src/core/sync-cost-gate.ts';

class FakeReadline {
  private closeListeners: Array<() => void> = [];
  private answerListener?: (answer: string) => void;

  question(_question: string, callback: (answer: string) => void): void {
    this.answerListener = callback;
  }

  on(event: 'close', listener: () => void): void {
    if (event === 'close') this.closeListeners.push(listener);
  }

  close(): void {
    for (const listener of this.closeListeners) listener();
  }

  answer(value: string): void {
    this.answerListener?.(value);
  }
}

function startPrompt(): { prompt: Promise<boolean>; readline: FakeReadline } {
  const readline = new FakeReadline();
  return {
    prompt: promptYesNo('Proceed? [y/N] ', () => readline),
    readline,
  };
}

describe('sync cost-gate promptYesNo', () => {
  for (const answer of ['y', 'yes', ' Y ', 'YES']) {
    test(`accepts ${JSON.stringify(answer)} before synchronous close`, async () => {
      const { prompt, readline } = startPrompt();

      readline.answer(answer);

      expect(await prompt).toBe(true);
    });
  }

  for (const answer of ['n', 'no', '', 'anything else']) {
    test(`rejects ${JSON.stringify(answer)}`, async () => {
      const { prompt, readline } = startPrompt();

      readline.answer(answer);

      expect(await prompt).toBe(false);
    });
  }

  test('closing without input resolves false', async () => {
    const { prompt, readline } = startPrompt();

    readline.close();

    expect(await prompt).toBe(false);
  });
});
