import { describe, expect, test } from 'bun:test';
import { listPages } from '../src/core/engine-sql/pages.ts';
import { renderFragment, type SqlFragment } from '../src/core/engine-sql/fragment.ts';
import type { ScopedRead } from '../src/core/engine-sql/brands.ts';
import { privatePagesFilterFragment } from '../src/core/search/private-visibility.ts';
import { buildVisibilityClause } from '../src/core/search/sql-ranking.ts';
import type { PageFilters } from '../src/core/types.ts';

describe('listPages visibility SQL', () => {
  test.each([
    { requireLiveVisibility: true },
    { requireSafeChunks: true, excludePrivate: true },
    { requireLiveVisibility: true, excludePrivate: true, requireSafeChunks: false },
    { excludePrivate: true },
  ] satisfies PageFilters[])('matches the shared visibility predicate for %p', async filters => {
    let statement = '';
    const exec = {
      run: async (fragment: SqlFragment) => {
        statement = renderFragment(fragment).text;
        return { rows: [], affectedRows: 0 };
      },
    } as unknown as ScopedRead;

    await listPages(exec, filters);

    const visible = filters.requireLiveVisibility === true || filters.requireSafeChunks === true;
    const privateCondition = filters.excludePrivate ? `AND ${privatePagesFilterFragment('p')}` : '';
    const visibilityCondition = visible
      ? ` ${buildVisibilityClause('p', 's', {
          excludePrivate: filters.excludePrivate,
          requireSafeChunks: filters.requireSafeChunks === true,
        })}`
      : '';
    expect(statement).toContain(`${privateCondition}${visibilityCondition}`);
    expect(statement.includes('JOIN sources s ON s.id = p.source_id')).toBe(visible);
  });
});
