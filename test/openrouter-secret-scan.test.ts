import { patternSince, redactFindings, scanText } from '../src/core/secret-scan.ts';

describe('OpenRouter API key detection', () => {
  const key = `sk-or-v1-${'a'.repeat(64)}`;

  test('detects and redacts the bare key in prose', () => {
    expect(scanText(`router key ${key}`).map((finding) => finding.pattern)).toEqual(['openrouter']);
    expect(redactFindings(`router key ${key}`).text).toBe('router key <REDACTED:openrouter>');
    expect(patternSince('openrouter')).toBeDefined();
  });

  test('requires exactly 64 lowercase hex characters and a hard right edge', () => {
    for (const malformed of [
      `sk-or-v1-${'a'.repeat(63)}`,
      `sk-or-v1-${'a'.repeat(65)}`,
      `sk-or-v1-${'A'.repeat(64)}`,
    ]) {
      expect(scanText(malformed)).toEqual([]);
    }
  });
});
