import { describe, expect, test } from 'bun:test';
import { extractPageLinks } from '../src/core/link-extraction.ts';

const resolver = { resolve: async () => null } as any;
const opts = {
  pack: null,
  targetType: (slug: string) => slug.startsWith('companies/') ? 'company' : 'concept',
} as any;

async function cafeLinkType(content: string): Promise<string | undefined> {
  const result = await extractPageLinks('people/alice-example', content, {}, 'person', resolver, opts);
  return result.candidates.find(candidate => candidate.targetSlug === 'companies/acme-cafe')?.linkType;
}

describe('page-role investor prior', () => {
  test('ignores machine sections and ordinary portfolio mentions as triggers', async () => {
    const prose = '# Alice Example\n\n## Dining\n\n- Alice likes the pasta at [[companies/acme-cafe]].\n';
    expect(await cafeLinkType(prose + '\n## Facts\n\n- Alice reviews her portfolio every Sunday.\n')).toBe('mentions');
    expect(await cafeLinkType(prose + '\n## Timeline\n\n- **2026-01-02** | Portfolio review completed.\n')).toBe('mentions');
    expect(await cafeLinkType(prose + '\n## Money\n\n- Alice keeps a small index-fund portfolio.\n')).toBe('mentions');
    expect(await cafeLinkType(prose + '\n## Work\n\n- Alice is an investor in early-stage companies.\n')).toBe('invested_in');
  });
});
