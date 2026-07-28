/**
 * #2657 — stdio MCP takes-holder allow-list operator override.
 *
 * The stdio transport hardcoded takesHoldersAllowList to ['world'] with no
 * escape hatch, making non-world takes unreachable for stdio MCP agents.
 * GBRAIN_MCP_TAKES_HOLDERS (comma-separated) is the opt-in widening; the
 * fail-closed ['world'] default is preserved when unset/empty/garbage.
 */
import { describe, test, expect } from 'bun:test';
import { resolveStdioTakesHolders } from '../src/mcp/server.ts';

describe('resolveStdioTakesHolders (#2657)', () => {
  test('unset → fail-closed default ["world"]', () => {
    // `undefined` activates the parameter default, which reads
    // process.env.GBRAIN_MCP_TAKES_HOLDERS — isolate from whatever the
    // ambient shell happens to have set so this test is deterministic.
    const saved = process.env.GBRAIN_MCP_TAKES_HOLDERS;
    delete process.env.GBRAIN_MCP_TAKES_HOLDERS;
    try {
      expect(resolveStdioTakesHolders(undefined)).toEqual(['world']);
    } finally {
      if (saved !== undefined) process.env.GBRAIN_MCP_TAKES_HOLDERS = saved;
    }
  });

  test('empty / whitespace-only → default, never an empty allow-list', () => {
    expect(resolveStdioTakesHolders('')).toEqual(['world']);
    expect(resolveStdioTakesHolders('  ')).toEqual(['world']);
    expect(resolveStdioTakesHolders(', ,')).toEqual(['world']);
  });

  test('comma-split with trimming', () => {
    expect(resolveStdioTakesHolders('world, brain , people/alice-example')).toEqual([
      'world',
      'brain',
      'people/alice-example',
    ]);
  });

  test('single non-world holder is honored (the unreachable-takes case)', () => {
    expect(resolveStdioTakesHolders('brain')).toEqual(['brain']);
  });
});
