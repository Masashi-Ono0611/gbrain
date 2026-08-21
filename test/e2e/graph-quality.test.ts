/**
 * E2E test for the v0.10.1 knowledge graph layer.
 *
 * Runs the full pipeline against in-memory PGLite (no API keys, no external DB).
 *   1. Seed pages with entity refs and timeline content
 *   2. Run link-extract + timeline-extract
 *   3. Verify graph populated
 *   4. Test auto-link via put_page operation handler
 *   5. Test reconciliation (edit page, stale links removed)
 *   6. Test graph-query traversal
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { runExtract } from '../../src/commands/extract.ts';
import { operationsByName } from '../../src/core/operations.ts';
import type { OperationContext } from '../../src/core/operations.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
});

async function truncateAll() {
  for (const t of ['content_chunks', 'links', 'tags', 'raw_data', 'timeline_entries', 'page_versions', 'ingest_log', 'config', 'pages']) {
    await (engine as any).db.exec(`DELETE FROM ${t}`);
  }
  // Re-seed the two config keys this file touches back to their documented
  // defaults (both default to ON). This makes every test deterministic even if
  // an earlier test threw before its finally restored auto_link/auto_timeline,
  // and even though absent-key already resolves truthy via isAuto*Enabled.
  await engine.setConfig('auto_link', 'true');
  await engine.setConfig('auto_timeline', 'true');
}

function makeContext(): OperationContext {
  return {
    engine,
    config: { engine: 'pglite' } as any,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    dryRun: false,
    // E2E graph quality simulates local-CLI writes (auto-link / timeline run).
    // After F7b made `remote` required this needs to be explicit.
    remote: false,
    sourceId: 'default',
  };
}

describe('E2E graph quality (v0.10.1 pipeline)', () => {
  beforeEach(truncateAll, 15_000);

  test('full pipeline: seed -> link-extract -> timeline-extract -> verify', async () => {
    // Seed 5 pages with entity refs and timeline content.
    await engine.putPage('people/alice', {
      type: 'person', title: 'Alice',
      compiled_truth: 'Alice is the CEO of [Acme](companies/acme).',
      timeline: '- **2026-01-15** | Joined as CEO\n- **2026-02-20** | Closed Series A',
    });
    await engine.putPage('people/bob', {
      type: 'person', title: 'Bob',
      compiled_truth: 'Bob is a YC partner who invested in [Acme](companies/acme).',
      timeline: '- **2026-03-01** | Wrote check to Acme',
    });
    await engine.putPage('companies/acme', {
      type: 'company', title: 'Acme',
      compiled_truth: '',
      timeline: '- **2026-01-01** | Founded',
    });
    await engine.putPage('meetings/standup', {
      type: 'meeting', title: 'Standup',
      compiled_truth: 'Attendees: [Alice](people/alice), [Bob](people/bob).',
      timeline: '- **2026-04-01** | Met at YC office',
    });

    // Run extractions.
    await runExtract(engine, ['links', '--source', 'db']);
    await runExtract(engine, ['timeline', '--source', 'db']);

    // Verify graph populated. Concrete floors derived from the seeded fixtures:
    //   resolvable entity refs: alice->acme, bob->acme, standup->alice, standup->bob = 4
    //   timeline lines: alice(2) + bob(1) + acme(1) + standup(1) = 5
    const stats = await engine.getStats();
    expect(stats.link_count).toBeGreaterThanOrEqual(4);
    expect(stats.timeline_entry_count).toBeGreaterThanOrEqual(5);

    // Verify typed link inference.
    const aliceLinks = await engine.getLinks('people/alice');
    const acmeLink = aliceLinks.find(l => l.to_slug === 'companies/acme');
    expect(acmeLink?.link_type).toBe('works_at');

    const bobLinks = await engine.getLinks('people/bob');
    const bobAcme = bobLinks.find(l => l.to_slug === 'companies/acme');
    expect(bobAcme?.link_type).toBe('invested_in');

    // The standup meeting references both Alice and Bob as attendees. Assert the
    // exact attendee edges are present and typed 'attended' (a plain .every()
    // would silently pass if a meeting->company edge were misclassified or if the
    // attendee edges were missing entirely).
    const meetingLinks = await engine.getLinks('meetings/standup');
    const attended = new Set(
      meetingLinks.filter(l => l.link_type === 'attended').map(l => l.to_slug),
    );
    expect(attended.has('people/alice')).toBe(true);
    expect(attended.has('people/bob')).toBe(true);
    expect(meetingLinks.every(l => l.link_type === 'attended')).toBe(true);
  });

  test('auto-link via put_page operation handler', async () => {
    // Seed target pages first.
    await engine.putPage('people/alice', { type: 'person', title: 'Alice', compiled_truth: '', timeline: '' });
    await engine.putPage('companies/acme', { type: 'company', title: 'Acme', compiled_truth: '', timeline: '' });

    // Use put_page operation (not engine.putPage directly) so the auto-link
    // post-hook fires.
    const putOp = operationsByName['put_page'];
    expect(putOp).toBeDefined();
    const result = await putOp.handler(makeContext(), {
      slug: 'meetings/auto',
      content: `---
type: meeting
title: Auto Meeting
---

Attendees: [Alice](people/alice). Discussed [Acme](companies/acme).
`,
    });

    // The response should include auto_links results.
    expect((result as any).auto_links).toBeDefined();
    const autoLinks = (result as any).auto_links;
    // The page references exactly two seeded, resolvable targets (Alice + Acme),
    // so exactly two links are created.
    expect(autoLinks.created).toBe(2);
    expect(autoLinks.errors).toBe(0);

    // Verify links actually exist in DB.
    const links = await engine.getLinks('meetings/auto');
    expect(links.length).toBe(2);
    expect(new Set(links.map(l => l.to_slug))).toEqual(new Set(['people/alice', 'companies/acme']));
  });

  test('auto-link reconciliation: edit page removes stale links', async () => {
    await engine.putPage('people/alice', { type: 'person', title: 'Alice', compiled_truth: '', timeline: '' });
    await engine.putPage('people/bob', { type: 'person', title: 'Bob', compiled_truth: '', timeline: '' });

    const putOp = operationsByName['put_page'];

    // First write: links to Alice.
    await putOp.handler(makeContext(), {
      slug: 'notes/test',
      content: `---
type: concept
title: Test Note
---

I met [Alice](people/alice) today.
`,
    });

    let links = await engine.getLinks('notes/test');
    expect(links.length).toBe(1);
    expect(links[0].to_slug).toBe('people/alice');

    // Second write: removes Alice ref, adds Bob ref.
    const result = await putOp.handler(makeContext(), {
      slug: 'notes/test',
      content: `---
type: concept
title: Test Note
---

Now I'm meeting with [Bob](people/bob).
`,
    });

    expect((result as any).auto_links.removed).toBe(1);
    expect((result as any).auto_links.created).toBe(1);

    links = await engine.getLinks('notes/test');
    expect(links.length).toBe(1);
    expect(links[0].to_slug).toBe('people/bob');
  });

  test('auto-timeline: put_page extracts + inserts timeline entries', async () => {
    const putOp = operationsByName['put_page'];
    const result = await putOp.handler(makeContext(), {
      slug: 'people/dana',
      content: `---
type: person
title: Dana
---

Dana is a founder.

## Timeline

- **2026-03-15** | Shipped v1.0
- **2026-04-02** | Closed seed round
`,
    });

    expect((result as any).auto_timeline).toBeDefined();
    expect((result as any).auto_timeline.created).toBe(2);

    const entries = await engine.getTimeline('people/dana');
    expect(entries.length).toBe(2);
    const dates = entries.map((e: any) => {
      const d = e.date instanceof Date ? e.date.toISOString().slice(0, 10) : String(e.date).slice(0, 10);
      return d;
    }).sort();
    expect(dates).toEqual(['2026-03-15', '2026-04-02']);
  });

  test('auto-timeline is idempotent: re-write does not duplicate entries', async () => {
    const putOp = operationsByName['put_page'];
    const content = `---
type: person
title: Eve
---

## Timeline

- **2026-03-15** | Shipped
`;
    await putOp.handler(makeContext(), { slug: 'people/eve', content });
    await putOp.handler(makeContext(), { slug: 'people/eve', content });

    const entries = await engine.getTimeline('people/eve');
    expect(entries.length).toBe(1);
  });

  test('auto-timeline respects auto_timeline=false config', async () => {
    await engine.setConfig('auto_timeline', 'false');
    try {
      const putOp = operationsByName['put_page'];
      const result = await putOp.handler(makeContext(), {
        slug: 'people/frank',
        content: `---
type: person
title: Frank
---

## Timeline

- **2026-03-15** | Something happened
`,
      });
      expect((result as any).auto_timeline).toBeUndefined();
      const entries = await engine.getTimeline('people/frank');
      expect(entries.length).toBe(0);
    } finally {
      await engine.setConfig('auto_timeline', 'true');
    }
  });

  test('auto-link respects auto_link=false config', async () => {
    await engine.setConfig('auto_link', 'false');
    try {
      await engine.putPage('people/alice', { type: 'person', title: 'Alice', compiled_truth: '', timeline: '' });
      const putOp = operationsByName['put_page'];
      const result = await putOp.handler(makeContext(), {
        slug: 'notes/disabled',
        content: `---
type: concept
title: Disabled Auto Link
---

Mention of [Alice](people/alice).
`,
      });

      // No auto_links field when disabled (we skip the helper entirely).
      expect((result as any).auto_links).toBeUndefined();

      const links = await engine.getLinks('notes/disabled');
      expect(links.length).toBe(0);
    } finally {
      await engine.setConfig('auto_link', 'true');
    }
  });

  test('auto-link via put_page uses targeted slugsExist, not a brain-wide getAllSlugs scan (#2544)', async () => {
    // Seed a batch of unrelated "noise" pages plus the two pages this test's
    // put_page will actually wikilink. Before the fix, runAutoLink called
    // engine.getAllSlugs() unconditionally on every put_page — a full
    // `SELECT slug FROM pages` scan whose row count grows with N_pages
    // regardless of how many links the written page actually has. The fix
    // (engine.slugsExist) queries only the page's own candidate slugs.
    for (let i = 0; i < 20; i++) {
      await engine.putPage(`noise/page-${i}`, {
        type: 'note', title: `Noise ${i}`, compiled_truth: '', timeline: '',
      });
    }
    await engine.putPage('people/alice', { type: 'person', title: 'Alice', compiled_truth: '', timeline: '' });
    await engine.putPage('companies/acme', { type: 'company', title: 'Acme', compiled_truth: '', timeline: '' });

    let getAllSlugsCalls = 0;
    let slugsExistCalls = 0;
    const slugsExistArgs: string[][] = [];
    const origGetAllSlugs = engine.getAllSlugs.bind(engine);
    const origSlugsExist = engine.slugsExist.bind(engine);
    (engine as any).getAllSlugs = async (...args: Parameters<typeof origGetAllSlugs>) => {
      getAllSlugsCalls++;
      return origGetAllSlugs(...args);
    };
    (engine as any).slugsExist = async (...args: Parameters<typeof origSlugsExist>) => {
      slugsExistCalls++;
      slugsExistArgs.push(args[0]);
      return origSlugsExist(...args);
    };

    try {
      const putOp = operationsByName['put_page'];
      const result = await putOp.handler(makeContext(), {
        slug: 'meetings/scan-check',
        content: `---
type: meeting
title: Scan Check
---

Attendees: [Alice](people/alice). Discussed [Acme](companies/acme).
`,
      });

      // Correctness: wikilink resolution is unchanged by the fix.
      expect((result as any).auto_links.created).toBe(2);
      const links = await engine.getLinks('meetings/scan-check');
      expect(new Set(links.map(l => l.to_slug))).toEqual(new Set(['people/alice', 'companies/acme']));

      // Egress fix: no brain-wide getAllSlugs scan on the auto-link path...
      expect(getAllSlugsCalls).toBe(0);
      // ...replaced by exactly ONE targeted slugsExist lookup (2 candidate
      // slugs fits in a single DELETE_BATCH_SIZE=500 chunk — pins the
      // intended single-batch behavior for the common small-page case)...
      expect(slugsExistCalls).toBe(1);
      // ...scoped to THIS page's own 2 candidate slugs, not the 22 pages
      // (20 noise + alice + acme) actually in the brain. Proves the fix
      // avoids the N_pages-wide scan quantitatively, not just structurally.
      const allQueried = new Set(slugsExistArgs.flat());
      expect(allQueried.size).toBe(2);
      expect(allQueried).toEqual(new Set(['people/alice', 'companies/acme']));
    } finally {
      (engine as any).getAllSlugs = origGetAllSlugs;
      (engine as any).slugsExist = origSlugsExist;
    }
  });

  test('auto-link via put_page still drops links to non-existent targets (slugsExist correctness)', async () => {
    await engine.putPage('people/alice', { type: 'person', title: 'Alice', compiled_truth: '', timeline: '' });

    const putOp = operationsByName['put_page'];
    const result = await putOp.handler(makeContext(), {
      slug: 'meetings/partial-resolve',
      content: `---
type: meeting
title: Partial Resolve
---

Attendees: [Alice](people/alice) and [Ghost](people/ghost-does-not-exist).
`,
    });

    // Only the resolvable target creates a link; the non-existent target is
    // silently skipped (matches pre-fix getAllSlugs-based filtering — the
    // existence check moved from a full scan to a targeted lookup, but the
    // filter semantics did not change).
    expect((result as any).auto_links.created).toBe(1);
    expect((result as any).auto_links.errors).toBe(0);
    const links = await engine.getLinks('meetings/partial-resolve');
    expect(links.length).toBe(1);
    expect(links[0].to_slug).toBe('people/alice');
  });

  test('auto-link via put_page includes candidate.fromSlug in the slugsExist query (incoming/frontmatter edges)', async () => {
    // `key_people` on a company page is an INCOMING mapping (person -> company):
    // fromSlug = the resolved person, targetSlug = the company page itself.
    // A regression that queried only candidate.targetSlug (dropping fromSlug)
    // would silently fail to resolve every incoming/frontmatter edge.
    await engine.putPage('people/dana', { type: 'person', title: 'Dana', compiled_truth: '', timeline: '' });

    let slugsExistArgs: string[][] = [];
    const origSlugsExist = engine.slugsExist.bind(engine);
    (engine as any).slugsExist = async (...args: Parameters<typeof origSlugsExist>) => {
      slugsExistArgs.push(args[0]);
      return origSlugsExist(...args);
    };

    try {
      const putOp = operationsByName['put_page'];
      const result = await putOp.handler(makeContext(), {
        slug: 'companies/incoming-check',
        content: `---
type: company
title: Incoming Check
key_people:
  - people/dana
---

An incoming-edge test company.
`,
      });

      expect((result as any).auto_links.created).toBe(1);
      // This is an INCOMING edge (people/dana -> companies/incoming-check),
      // so it shows up on the TARGET page's backlinks, not its own outgoing
      // getLinks (which only returns edges where the slug is the FROM side).
      const backlinks = await engine.getBacklinks('companies/incoming-check');
      expect(backlinks.length).toBe(1);
      expect(backlinks[0].from_slug).toBe('people/dana');
      expect(backlinks[0].to_slug).toBe('companies/incoming-check');
      expect(backlinks[0].link_type).toBe('works_at');

      // The fromSlug (people/dana) — NOT just the page's own targetSlug — was
      // actually included in the slugsExist query. Without this, the edge
      // above could not have resolved.
      const allQueried = new Set(slugsExistArgs.flat());
      expect(allQueried.has('people/dana')).toBe(true);
    } finally {
      (engine as any).slugsExist = origSlugsExist;
    }
  });

  test('auto-link via put_page chunks slugsExist at DELETE_BATCH_SIZE and merges results across chunks (#2544)', async () => {
    // Build a single page with 501 distinct candidate target slugs — one
    // more than DELETE_BATCH_SIZE (500) — so runAutoLink's chunking loop
    // must split into two engine.slugsExist calls and merge their results.
    // Only 2 of the 501 targets are real pages: one positioned to land in
    // the FIRST chunk (index 0) and one in the SECOND chunk (index 500),
    // proving both chunks are queried and unioned correctly (not just the
    // first / not just the last).
    await engine.putPage('concept/batch-target-first', {
      type: 'concept', title: 'Batch Target First', compiled_truth: '', timeline: '',
    });
    await engine.putPage('concept/batch-target-last', {
      type: 'concept', title: 'Batch Target Last', compiled_truth: '', timeline: '',
    });

    const NOISE_COUNT = 499; // 1 (first) + 499 (noise) + 1 (last) = 501 distinct targets
    const noiseLinks = Array.from(
      { length: NOISE_COUNT },
      (_, i) => `[N${i}](concept/batch-noise-${i})`,
    ).join(' ');
    const body =
      `[First](concept/batch-target-first) ${noiseLinks} [Last](concept/batch-target-last)`;

    let slugsExistArgs: string[][] = [];
    const origSlugsExist = engine.slugsExist.bind(engine);
    (engine as any).slugsExist = async (...args: Parameters<typeof origSlugsExist>) => {
      slugsExistArgs.push(args[0]);
      return origSlugsExist(...args);
    };

    try {
      const putOp = operationsByName['put_page'];
      const result = await putOp.handler(makeContext(), {
        slug: 'meetings/batch-chunk-check',
        content: `---
type: meeting
title: Batch Chunk Check
---

${body}
`,
      });

      // Only the 2 real targets create links — the 499 noise slugs don't exist.
      expect((result as any).auto_links.created).toBe(2);
      const links = await engine.getLinks('meetings/batch-chunk-check');
      expect(new Set(links.map(l => l.to_slug))).toEqual(
        new Set(['concept/batch-target-first', 'concept/batch-target-last']),
      );

      // Chunked into exactly 2 slugsExist calls (500 + 1), matching
      // DELETE_BATCH_SIZE, and the union of both calls' results found both
      // real targets — proving cross-chunk merging is correct.
      expect(slugsExistArgs.length).toBe(2);
      expect(slugsExistArgs.map(a => a.length).sort((a, b) => a - b)).toEqual([1, 500]);
      const allQueried = new Set(slugsExistArgs.flat());
      expect(allQueried.has('concept/batch-target-first')).toBe(true);
      expect(allQueried.has('concept/batch-target-last')).toBe(true);
    } finally {
      (engine as any).slugsExist = origSlugsExist;
    }
  }, 20_000);

  test('auto-link via put_page threads the real (non-default) sourceId into slugsExist, not "default"', async () => {
    // Same-slug trap: a DIFFERENT page lives at the same slug in 'default'.
    // If runAutoLink silently defaulted sourceId to 'default' instead of
    // threading ctx.sourceId through, this would resolve against the trap
    // page in 'default' rather than genuinely failing/succeeding against the
    // real target in 'other-src' — the two are distinguishable by title.
    await engine.executeRaw(
      `INSERT INTO sources (id, name) VALUES ('other-src', 'other-src') ON CONFLICT DO NOTHING`,
    );
    await engine.putPage('people/later', {
      type: 'person', title: 'Trap (default source)', compiled_truth: '', timeline: '',
    }, { sourceId: 'default' });
    await engine.putPage('people/later', {
      type: 'person', title: 'Real (other-src)', compiled_truth: '', timeline: '',
    }, { sourceId: 'other-src' });

    let slugsExistOpts: Array<{ sourceId: string }> = [];
    const origSlugsExist = engine.slugsExist.bind(engine);
    (engine as any).slugsExist = async (...args: Parameters<typeof origSlugsExist>) => {
      slugsExistOpts.push(args[1]);
      return origSlugsExist(...args);
    };

    try {
      const putOp = operationsByName['put_page'];
      const ctx = { ...makeContext(), sourceId: 'other-src' };
      const result = await putOp.handler(ctx, {
        slug: 'notes/source-thread-check',
        content: `---
type: concept
title: Source Thread Check
---

Mentions [Later](people/later).
`,
      });

      expect((result as any).auto_links.created).toBe(1);
      // Every slugsExist call was scoped to 'other-src' — never silently
      // defaulted to 'default'.
      expect(slugsExistOpts.length).toBeGreaterThan(0);
      expect(slugsExistOpts.every(o => o.sourceId === 'other-src')).toBe(true);

      // The edge landed in 'other-src', scoped correctly — not leaked into
      // or resolved against the 'default'-source trap page.
      const links = await engine.getLinks('notes/source-thread-check', { sourceId: 'other-src' });
      expect(links.length).toBe(1);
      expect(links[0].to_slug).toBe('people/later');
    } finally {
      (engine as any).slugsExist = origSlugsExist;
    }
  });

  test('graph-query end-to-end: traversePaths returns expected edges', async () => {
    await engine.putPage('people/alice', { type: 'person', title: 'Alice', compiled_truth: '', timeline: '' });
    await engine.putPage('people/bob', { type: 'person', title: 'Bob', compiled_truth: '', timeline: '' });
    await engine.putPage('companies/acme', { type: 'company', title: 'Acme', compiled_truth: '', timeline: '' });
    await engine.addLink('people/alice', 'companies/acme', '', 'works_at');
    await engine.addLink('people/bob', 'companies/acme', '', 'invested_in');

    // "Who works at Acme?" -> direction in, type works_at.
    const paths = await engine.traversePaths('companies/acme', {
      direction: 'in', linkType: 'works_at', depth: 1,
    });
    expect(paths.length).toBe(1);
    expect(paths[0].from_slug).toBe('people/alice');
    expect(paths[0].link_type).toBe('works_at');
  });

  test('graph-query traversal: direction out and both, plus depth:2 multi-hop', async () => {
    // Seed a 2-hop chain: alice -works_at-> acme -partnered_with-> beta.
    await engine.putPage('people/alice', { type: 'person', title: 'Alice', compiled_truth: '', timeline: '' });
    await engine.putPage('companies/acme', { type: 'company', title: 'Acme', compiled_truth: '', timeline: '' });
    await engine.putPage('companies/beta', { type: 'company', title: 'Beta', compiled_truth: '', timeline: '' });
    await engine.addLink('people/alice', 'companies/acme', '', 'works_at');
    await engine.addLink('companies/acme', 'companies/beta', '', 'partnered_with');

    // direction:'out' from alice, depth 1 -> only the first hop.
    const out1 = await engine.traversePaths('people/alice', { direction: 'out', depth: 1 });
    expect(out1.length).toBe(1);
    expect(out1[0].from_slug).toBe('people/alice');
    expect(out1[0].to_slug).toBe('companies/acme');
    expect(out1[0].depth).toBe(1);

    // depth:2 -> both hops, depths 1 and 2.
    const out2 = await engine.traversePaths('people/alice', { direction: 'out', depth: 2 });
    const out2Edges = new Set(out2.map(p => `${p.from_slug}->${p.to_slug}@${p.depth}`));
    expect(out2Edges.has('people/alice->companies/acme@1')).toBe(true);
    expect(out2Edges.has('companies/acme->companies/beta@2')).toBe(true);
    expect(out2.length).toBe(2);

    // direction:'both' from acme depth 1 -> sees the inbound edge from alice AND
    // the outbound edge to beta. Edges keep their natural from->to orientation.
    const both = await engine.traversePaths('companies/acme', { direction: 'both', depth: 1 });
    const bothEdges = new Set(both.map(p => `${p.from_slug}->${p.to_slug}`));
    expect(bothEdges.has('people/alice->companies/acme')).toBe(true);
    expect(bothEdges.has('companies/acme->companies/beta')).toBe(true);
  });

  test('graph-query cycle safety: A->B->A terminates and returns bounded results', async () => {
    await engine.putPage('people/alice', { type: 'person', title: 'Alice', compiled_truth: '', timeline: '' });
    await engine.putPage('people/bob', { type: 'person', title: 'Bob', compiled_truth: '', timeline: '' });
    // Create a 2-cycle: alice -> bob -> alice.
    await engine.addLink('people/alice', 'people/bob', '', 'knows');
    await engine.addLink('people/bob', 'people/alice', '', 'knows');

    // High depth must NOT loop forever; the visited-set guard bounds the walk.
    const paths = await engine.traversePaths('people/alice', { direction: 'out', depth: 100 });
    const edges = new Set(paths.map(p => `${p.from_slug}->${p.to_slug}`));
    // Both edges of the cycle are reachable exactly once.
    expect(edges.has('people/alice->people/bob')).toBe(true);
    expect(edges.has('people/bob->people/alice')).toBe(true);
    // Bounded: there are only two edges in the graph, so no path explosion.
    expect(paths.length).toBe(2);
  });

  test('search backlink boost: well-connected pages rank higher', async () => {
    // Create 3 pages all matching a search term, but with different inbound link counts.
    await engine.putPage('topic/popular', {
      type: 'concept', title: 'Popular Topic',
      compiled_truth: 'This is the popular topic about widgets.',
      timeline: '',
    });
    await engine.putPage('topic/medium', {
      type: 'concept', title: 'Medium Topic',
      compiled_truth: 'This is a medium topic about widgets.',
      timeline: '',
    });
    await engine.putPage('topic/obscure', {
      type: 'concept', title: 'Obscure Topic',
      compiled_truth: 'This is an obscure topic about widgets.',
      timeline: '',
    });
    // Create inbound link references so each topic gets a backlink count.
    for (let i = 0; i < 5; i++) {
      await engine.putPage(`ref/popular-${i}`, {
        type: 'concept', title: `Ref ${i}`, compiled_truth: '', timeline: '',
      });
      await engine.addLink(`ref/popular-${i}`, 'topic/popular', '', 'mentions');
    }
    await engine.addLink('ref/popular-0', 'topic/medium', '', 'mentions');

    // Verify backlink counts.
    const counts = await engine.getBacklinkCounts(['topic/popular', 'topic/medium', 'topic/obscure']);
    expect(counts.get('topic/popular')).toBe(5);
    expect(counts.get('topic/medium')).toBe(1);
    expect(counts.get('topic/obscure')).toBe(0);
  });
});
