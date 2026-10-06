import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('enrich person page template', () => {
  test('places Communication Style between What Motivates Them and Hobby Horses', () => {
    const skill = readFileSync(join(import.meta.dir, '../skills/enrich/SKILL.md'), 'utf8');
    const template = skill.match(/#### Person page template\s+```markdown\n([\s\S]*?)\n```/)?.[1];
    expect(template).toBeDefined();

    const headings: string[] = template!.match(/^## .+$/gm) ?? [];
    const motivate = headings.indexOf('## What Motivates Them');
    const communication = headings.indexOf('## Communication Style');
    const hobby = headings.indexOf('## Hobby Horses');

    expect(headings.filter((heading) => heading === '## Communication Style')).toHaveLength(1);
    expect(motivate).toBeGreaterThanOrEqual(0);
    expect(communication).toBe(motivate + 1);
    expect(hobby).toBe(communication + 1);
  });
});
