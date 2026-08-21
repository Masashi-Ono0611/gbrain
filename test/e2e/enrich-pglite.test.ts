/**
 * v0.41.39 (#1700) — hermetic PGLite e2e for `gbrain enrich`.
 *
 * Covers both layers: the source-aware `listEnrichCandidates` engine method,
 * and the `runEnrichCore` synthesis pipeline (via the `synthesizeFn` DI seam so
 * no API key / no mock.module → stays parallel-safe). Privacy: placeholder
 * names only (alice-example, widget-co, …).
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';
import {
  runEnrichCore,
  enrichFingerprint,
  CHECKPOINT_OP,
  type SynthesizeFn,
} from '../../src/commands/enrich.ts';
import { recordCompleted, loadOpCheckpoint } from '../../src/core/op-checkpoint.ts';
import { tryAcquireDbLock } from '../../src/core/db-lock.ts';
import { BudgetExhausted, BudgetTracker } from '../../src/core/budget/budget-tracker.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

// --- helpers ---------------------------------------------------------------

const STUB = 'Stub page.';
const RICH_CONTEXT =
  'Alice Example co-founded WidgetCo in 2025 and leads its product design team. ' +
  'She previously built the finance UI at a large company, presented the new design ' +
  'system at the 2026 summit, and recently closed the seed round led by Fund A.';

async function seedStub(slug: string, title: string, type: string, frontmatter: Record<string, unknown> = {}) {
  await engine.putPage(slug, {
    type: type as never,
    title,
    compiled_truth: STUB,
    timeline: '',
    frontmatter,
  });
}

/** Seed a linking page and an inbound link with rich context (drives grounding + inbound_count). */
async function seedLinkInto(toSlug: string, fromSlug: string, context: string) {
  await engine.putPage(fromSlug, {
    type: 'note' as never,
    title: fromSlug,
    compiled_truth: `Notes referencing ${toSlug}.`,
    timeline: '',
    frontmatter: {},
  });
  await engine.addLink(fromSlug, toSlug, context);
}

const goodSynth: SynthesizeFn = async () =>
  '## Overview\nAlice Example founded WidgetCo and leads design. [Source: meetings/2026-summit]\n\n## Role\nProduct design lead.';

// ---------------------------------------------------------------------------
// Engine method: listEnrichCandidates
// ---------------------------------------------------------------------------

describe('listEnrichCandidates', () => {
  test('thin-filters, scopes to types, counts inbound source-correctly, orders + limits', async () => {
    await seedStub('people/alice-example', 'Alice Example', 'person');
    await seedStub('people/bob-example', 'Bob Example', 'person');
    await seedStub('companies/widget-co', 'Widget Co', 'company');
    // A long page (not thin) AND a non-target type — must be excluded twice over.
    await engine.putPage('wiki/long-essay', {
      type: 'note' as never,
      title: 'Long Essay',
      compiled_truth: 'x'.repeat(900),
      timeline: '',
      frontmatter: {},
    });

    // Inbound links: bob ← 2, alice ← 1, widget ← 0.
    await seedLinkInto('people/bob-example', 'meetings/m1', 'Bob context one.');
    await seedLinkInto('people/bob-example', 'meetings/m2', 'Bob context two.');
    await seedLinkInto('people/alice-example', 'meetings/m3', 'Alice context.');

    const cands = await engine.listEnrichCandidates({
      types: ['person', 'company'],
      thinThreshold: 400,
      order: 'inbound-links',
      limit: 10,
    });
    const slugs = cands.map((c) => c.slug);
    expect(slugs).toContain('people/alice-example');
    expect(slugs).toContain('people/bob-example');
    expect(slugs).toContain('companies/widget-co');
    expect(slugs).not.toContain('wiki/long-essay');

    // Ordering by inbound DESC: bob (2) before alice (1) before widget (0).
    expect(slugs.indexOf('people/bob-example')).toBeLessThan(slugs.indexOf('people/alice-example'));
    expect(slugs.indexOf('people/alice-example')).toBeLessThan(slugs.indexOf('companies/widget-co'));

    const bob = cands.find((c) => c.slug === 'people/bob-example')!;
    expect(bob.inbound_count).toBe(2);
    expect(bob.body_len).toBe(STUB.length);
    expect(bob.type).toBe('person');
  });

  test('types filter narrows to companies only', async () => {
    await seedStub('people/alice-example', 'Alice', 'person');
    await seedStub('companies/widget-co', 'Widget', 'company');
    const cands = await engine.listEnrichCandidates({
      types: ['company'],
      thinThreshold: 400,
      order: 'inbound-links',
      limit: 10,
    });
    expect(cands.map((c) => c.slug)).toEqual(['companies/widget-co']);
  });

  test('empty types → no rows, no SQL', async () => {
    await seedStub('people/alice-example', 'Alice', 'person');
    const cands = await engine.listEnrichCandidates({
      types: [],
      thinThreshold: 400,
      order: 'inbound-links',
      limit: 10,
    });
    expect(cands).toEqual([]);
  });

  test('limit caps the result set', async () => {
    await seedStub('people/alice-example', 'Alice', 'person');
    await seedStub('people/bob-example', 'Bob', 'person');
    await seedLinkInto('people/bob-example', 'meetings/m1', 'ctx');
    const cands = await engine.listEnrichCandidates({
      types: ['person'],
      thinThreshold: 400,
      order: 'inbound-links',
      limit: 1,
    });
    expect(cands.length).toBe(1);
    expect(cands[0].slug).toBe('people/bob-example'); // highest inbound
  });

  test('recency guard excludes recently-enriched pages', async () => {
    await seedStub('people/fresh', 'Fresh', 'person', {
      enriched_at: new Date().toISOString(),
    });
    await seedStub('people/stale', 'Stale', 'person', {
      enriched_at: new Date(Date.now() - 90 * 86_400_000).toISOString(),
    });
    await seedStub('people/never', 'Never', 'person'); // no enriched_at
    const cands = await engine.listEnrichCandidates({
      types: ['person'],
      thinThreshold: 400,
      order: 'inbound-links',
      limit: 10,
      reenrichAfterMs: 30 * 86_400_000, // 30d window
    });
    const slugs = cands.map((c) => c.slug);
    expect(slugs).toContain('people/stale');   // enriched 90d ago → eligible
    expect(slugs).toContain('people/never');   // never enriched → eligible
    expect(slugs).not.toContain('people/fresh'); // enriched today → guarded out
  });

  test('source scope excludes other sources', async () => {
    await seedStub('people/alice-example', 'Alice', 'person');
    // Register the second source (FK target) before seeding a page into it.
    await engine.executeRaw(
      `INSERT INTO sources (id, name) VALUES ('other', 'Other') ON CONFLICT (id) DO NOTHING`,
      [],
    );
    await engine.putPage('people/remote-only', {
      type: 'person' as never, title: 'Remote', compiled_truth: STUB, timeline: '', frontmatter: {},
    }, { sourceId: 'other' });
    const cands = await engine.listEnrichCandidates({
      types: ['person'],
      thinThreshold: 400,
      order: 'inbound-links',
      limit: 10,
      sourceId: 'default',
    });
    const slugs = cands.map((c) => c.slug);
    expect(slugs).toContain('people/alice-example');
    expect(slugs).not.toContain('people/remote-only');
  });
});

// ---------------------------------------------------------------------------
// runEnrichCore: synthesis pipeline (stubbed synthesizeFn)
// ---------------------------------------------------------------------------

describe('runEnrichCore', () => {
  test('thin page with scattered context → grown + cited + provenance stamped', async () => {
    await seedStub('people/alice-example', 'Alice Example', 'person');
    await seedLinkInto('people/alice-example', 'meetings/2026-summit', RICH_CONTEXT);

    const r = await runEnrichCore(engine, {
      sourceId: 'default',
      types: ['person'],
      model: 'test:model',
      synthesizeFn: goodSynth,
    });
    expect(r.pages_enriched).toBe(1);
    expect(r.pages_skipped_insufficient).toBe(0);

    const page = await engine.getPage('people/alice-example', { sourceId: 'default' });
    expect(page).toBeTruthy();
    expect(page!.compiled_truth).toContain('## Overview');
    expect(page!.compiled_truth).toContain('[Source: meetings/2026-summit]');
    expect(page!.frontmatter.enriched_by).toBe('cli:enrich');
    expect(typeof page!.frontmatter.enriched_at).toBe('string');
  }, 30000);

  test('no context → skipped_insufficient, no write, no LLM call', async () => {
    await seedStub('people/zxqwv-unique', 'Zxqwv Unique-Token', 'person');
    let called = false;
    const synth: SynthesizeFn = async () => { called = true; return 'should not run'; };

    const r = await runEnrichCore(engine, {
      sourceId: 'default',
      types: ['person'],
      model: 'test:model',
      synthesizeFn: synth,
    });
    expect(called).toBe(false);
    expect(r.pages_enriched).toBe(0);
    expect(r.pages_skipped_insufficient).toBe(1);

    const page = await engine.getPage('people/zxqwv-unique', { sourceId: 'default' });
    expect(page!.compiled_truth.trim()).toBe(STUB);
  }, 30000);

  test('#3629: relaxing --min-context after a durable pre-LLM skip re-evaluates the page', async () => {
    // A durable skip marker (see enrichFingerprint's minContextChars doc
    // comment) must not outlive the very knob that produced it. A page
    // rejected by assessGrounding under a strict threshold, then re-run with
    // a relaxed threshold and no --force, must be evaluated fresh — because
    // minContextChars is part of enrichFingerprint, the relaxed run computes
    // a DIFFERENT checkpoint fingerprint, so it never even sees the strict
    // run's durable marker.
    await seedStub('people/thin-context', 'Thin Context', 'person');
    await seedLinkInto('people/thin-context', 'meetings/tc1', RICH_CONTEXT);
    let calls = 0;
    const synth: SynthesizeFn = async () => { calls++; return goodSynth({ system: '', user: '', model: 'test:model' }); };

    const strict = await runEnrichCore(engine, {
      sourceId: 'default',
      types: ['person'],
      order: 'inbound-links',
      thinThreshold: 400,
      model: 'test:model',
      minContextChars: 100_000, // impossibly strict — pre-LLM gate always rejects
      synthesizeFn: synth,
    });
    expect(strict.pages_skipped_insufficient).toBe(1);
    expect(strict.pages_skipped_pre_llm).toBe(1);
    expect(calls).toBe(0); // pre-LLM gate — no billing either way

    const relaxed = await runEnrichCore(engine, {
      sourceId: 'default',
      types: ['person'],
      order: 'inbound-links',
      thinThreshold: 400,
      model: 'test:model',
      minContextChars: 1, // relaxed — same page now passes grounding
      synthesizeFn: synth,
    });
    expect(calls).toBe(1); // re-evaluated under the new threshold, not suppressed
    expect(relaxed.pages_enriched).toBe(1);

    const page = await engine.getPage('people/thin-context', { sourceId: 'default' });
    expect(page!.compiled_truth).toContain('## Overview');
  }, 30000);

  test('model returns SKIP → skipped, no write', async () => {
    await seedStub('people/erin-example', 'Erin Example', 'person');
    await seedLinkInto('people/erin-example', 'meetings/sync', RICH_CONTEXT);
    const skipSynth: SynthesizeFn = async () => 'SKIP';

    const r = await runEnrichCore(engine, {
      sourceId: 'default',
      types: ['person'],
      model: 'test:model',
      synthesizeFn: skipSynth,
    });
    expect(r.pages_enriched).toBe(0);
    expect(r.pages_skipped_insufficient).toBe(1);
    const page = await engine.getPage('people/erin-example', { sourceId: 'default' });
    expect(page!.compiled_truth.trim()).toBe(STUB);
  }, 30000);

  test('#3629: model SKIP verdict is durable across clean ticks — no re-billing', async () => {
    // Reproduces the autopilot's enrich_thin tick loop: same source/fingerprint,
    // called repeatedly (every 600s in production). A page with rich enough
    // context to pass the pre-LLM assessGrounding gate, but whose model call
    // ALWAYS answers SKIP, must be billed exactly once — not once per tick.
    await seedStub('people/permanently-thin', 'Permanently Thin', 'person');
    await seedLinkInto('people/permanently-thin', 'meetings/sync', RICH_CONTEXT);
    let calls = 0;
    const alwaysSkip: SynthesizeFn = async () => { calls++; return 'SKIP'; };

    const runOpts = {
      sourceId: 'default',
      types: ['person'],
      order: 'inbound-links' as const,
      thinThreshold: 400,
      model: 'test:model',
      synthesizeFn: alwaysSkip,
    };

    const tick1 = await runEnrichCore(engine, runOpts);
    expect(calls).toBe(1); // billed once — grounding gate passed, model call made
    expect(tick1.pages_skipped_insufficient).toBe(1);
    expect(tick1.pages_enriched).toBe(0);

    const tick2 = await runEnrichCore(engine, runOpts);
    // Pre-fix: clearOpCheckpoint wiped the SKIP verdict on tick 1's clean exit,
    // so tick 2 re-selected + re-billed the same permanently-insufficient page.
    expect(calls).toBe(1); // NOT re-billed
    expect(tick2.pages_enriched).toBe(0);
    expect(tick2.pages_skipped_insufficient).toBe(0); // nothing processed — filtered by checkpoint

    const tick3 = await runEnrichCore(engine, runOpts);
    expect(calls).toBe(1); // still not re-billed on a third tick

    const page = await engine.getPage('people/permanently-thin', { sourceId: 'default' });
    expect(page!.compiled_truth.trim()).toBe(STUB); // never written
  }, 30000);

  test('#3629: a clean run with no skips still clears the checkpoint (no regression)', async () => {
    // The old "immediate re-run starts fresh" behavior must survive for the
    // ordinary happy path: a run that enriches everything with zero
    // insufficient-context skips clears its checkpoint exactly as before.
    await seedStub('people/alice-example', 'Alice Example', 'person');
    await seedLinkInto('people/alice-example', 'meetings/2026-summit', RICH_CONTEXT);

    const fpOpts = {
      sourceId: 'default',
      types: ['person'],
      order: 'inbound-links' as const,
      thinThreshold: 400,
      model: 'test:model',
    };
    const r = await runEnrichCore(engine, { ...fpOpts, synthesizeFn: goodSynth });
    expect(r.pages_enriched).toBe(1);
    expect(r.pages_skipped_insufficient).toBe(0);

    const fp = enrichFingerprint(fpOpts);
    const done = await loadOpCheckpoint(engine, { op: CHECKPOINT_OP, fingerprint: fp });
    expect(done).toEqual([]); // cleared on clean, all-enriched completion
  }, 30000);

  test('#3629: a permanently-SKIP page outside this tick\'s LIMIT window is still not re-billed', async () => {
    // Deeper regression than the "durable across ticks" test above: here the
    // permanently-insufficient page falls OUTSIDE the current tick's ranked +
    // LIMITed candidate window (a higher-priority page occupies the one slot
    // instead), so `pages_skipped_insufficient` reads 0 and the page is absent
    // from BOTH `candidates` and `pending` for that tick. A fix that infers
    // "any carried-forward skip?" from `candidates.length > pending.length`
    // (bounded by this tick's LIMIT) misses this — the checkpoint gets
    // cleared anyway and the page is re-billed once it re-enters the window.
    // The fix must key off the FULL persisted checkpoint instead.
    await seedStub('people/never-grounds', 'Never Grounds', 'person');
    await seedLinkInto('people/never-grounds', 'meetings/ng1', RICH_CONTEXT); // 1 inbound
    await seedStub('people/late-riser', 'Late Riser', 'person'); // 0 inbound — ranks below

    const calls: Record<string, number> = { 'never-grounds': 0, 'late-riser': 0 };
    const synth: SynthesizeFn = async ({ user }) => {
      if (user.includes('Never Grounds')) { calls['never-grounds']++; return 'SKIP'; }
      calls['late-riser']++;
      return '## Overview\nLate Riser joined the team. [Source: meetings/lr1]';
    };

    const runOpts = {
      sourceId: 'default',
      types: ['person'],
      order: 'inbound-links' as const,
      thinThreshold: 400,
      limit: 1, // forces the LIMIT-window race: only the top-ranked candidate is queried
      model: 'test:model',
      synthesizeFn: synth,
    };

    // Tick 1: never-grounds (1 inbound) outranks late-riser (0 inbound) → the
    // only candidate this tick. It gets a model SKIP verdict — billed once.
    const tick1 = await runEnrichCore(engine, runOpts);
    expect(tick1.candidates_considered).toBe(1);
    expect(calls['never-grounds']).toBe(1);
    expect(calls['late-riser']).toBe(0);

    // Promote late-riser above never-grounds (2 inbound > 1) and give it
    // enough context to pass grounding, so it wins the LIMIT=1 slot next tick
    // and never-grounds isn't even returned by listEnrichCandidates.
    await seedLinkInto('people/late-riser', 'meetings/lr1', RICH_CONTEXT);
    await seedLinkInto('people/late-riser', 'meetings/lr2', RICH_CONTEXT);

    // Tick 2: late-riser occupies the single slot and enriches successfully.
    // never-grounds is outside this tick's candidate window entirely.
    const tick2 = await runEnrichCore(engine, runOpts);
    expect(tick2.candidates_considered).toBe(1);
    expect(calls['never-grounds']).toBe(1); // not queried this tick — can't be re-billed here
    expect(calls['late-riser']).toBe(1);
    expect(tick2.pages_enriched).toBe(1);

    // Tick 3: late-riser is no longer thin (enriched) and drops out of the
    // candidate query entirely, so never-grounds is the only candidate again.
    // The money assertion: it must NOT be re-billed — the durable skip marker
    // from tick 1 must have survived tick 2's clean, all-enriched completion.
    const tick3 = await runEnrichCore(engine, runOpts);
    expect(tick3.candidates_considered).toBe(1);
    expect(calls['never-grounds']).toBe(1); // still exactly once across 3 ticks
    expect(tick3.pages_enriched).toBe(0);

    const page = await engine.getPage('people/never-grounds', { sourceId: 'default' });
    expect(page!.compiled_truth.trim()).toBe(STUB); // never written
  }, 30000);

  test('#3629: a durable skip elsewhere in the checkpoint does not permanently suppress an unrelated blank-output page', async () => {
    // A blank/unparseable synthesis response is a synthesis-FAILURE shape
    // (#2085 splits it from an explicit model SKIP — see pages_empty_output
    // vs pages_model_skip), not a grounding verdict, so it must stay eligible
    // for retry next tick. An earlier version of this fix made the
    // clear-vs-keep decision checkpoint-WIDE (all-or-nothing): as soon as ANY
    // page in the run got a durable skip marker, the entire checkpoint
    // stopped clearing — which accidentally made every OTHER page's plain
    // completedKey permanent too, including blank-output pages that were
    // never meant to be durably suppressed.
    await seedStub('people/never-grounds', 'Never Grounds', 'person');
    await seedLinkInto('people/never-grounds', 'meetings/ng1', RICH_CONTEXT);
    await seedStub('people/flaky-output', 'Flaky Output', 'person');
    await seedLinkInto('people/flaky-output', 'meetings/fo1', RICH_CONTEXT);

    let flakyCalls = 0;
    const synth: SynthesizeFn = async ({ user }) => {
      if (user.includes('Never Grounds')) return 'SKIP'; // durable
      flakyCalls++;
      return flakyCalls === 1 ? '' : goodSynth({ system: '', user: '', model: 'test:model' }); // blank once, then recovers
    };

    const runOpts = {
      sourceId: 'default',
      types: ['person'],
      order: 'inbound-links' as const,
      thinThreshold: 400,
      model: 'test:model',
      synthesizeFn: synth,
    };

    const tick1 = await runEnrichCore(engine, runOpts);
    expect(tick1.pages_model_skip).toBe(1); // never-grounds — durable
    expect(tick1.pages_empty_output).toBe(1); // flaky-output — NOT durable
    expect(flakyCalls).toBe(1);

    // Tick 2: flaky-output must be retried (its blank-output completedKey was
    // dropped, not carried forward with never-grounds's durable skip marker)
    // and this time succeeds.
    const tick2 = await runEnrichCore(engine, runOpts);
    expect(flakyCalls).toBe(2); // retried
    expect(tick2.pages_enriched).toBe(1);
    const flaky = await engine.getPage('people/flaky-output', { sourceId: 'default' });
    expect(flaky!.compiled_truth).toContain('## Overview');

    // never-grounds must still be untouched by all of this — its own skip
    // marker survived tick 1 → tick 2 unaffected by flaky-output's retry.
    const never = await engine.getPage('people/never-grounds', { sourceId: 'default' });
    expect(never!.compiled_truth.trim()).toBe(STUB);
  }, 30000);

  test('#3629: dry-run + force must not clear a real checkpoint (no destructive preview)', async () => {
    // EnrichCoreOpts.dryRun is documented as "no checkpoint advance". Before
    // this fix, `if (opts.force) await clearOpCheckpoint(...)` ran BEFORE the
    // dryRun check — a `--dry-run --force` preview silently destroyed a REAL
    // checkpoint (including durable skip markers), re-exposing an already-
    // resolved permanently-insufficient page to billing on the next real run.
    await seedStub('people/never-grounds', 'Never Grounds', 'person');
    await seedLinkInto('people/never-grounds', 'meetings/ng1', RICH_CONTEXT);
    const skipSynth: SynthesizeFn = async () => 'SKIP';

    const fpOpts = {
      sourceId: 'default',
      types: ['person'],
      order: 'inbound-links' as const,
      thinThreshold: 400,
      model: 'test:model',
    };
    await runEnrichCore(engine, { ...fpOpts, synthesizeFn: skipSynth });
    const fp = enrichFingerprint(fpOpts);
    const beforeDryRun = await loadOpCheckpoint(engine, { op: CHECKPOINT_OP, fingerprint: fp });
    expect(beforeDryRun.length).toBeGreaterThan(0); // the real run's skip marker is persisted

    let dryRunCalled = false;
    await runEnrichCore(engine, {
      ...fpOpts,
      dryRun: true,
      force: true,
      synthesizeFn: async () => { dryRunCalled = true; return 'should not run'; },
    });
    expect(dryRunCalled).toBe(false); // dryRun's "no LLM call" contract holds even under --force

    const afterDryRun = await loadOpCheckpoint(engine, { op: CHECKPOINT_OP, fingerprint: fp });
    expect(afterDryRun).toEqual(beforeDryRun); // untouched by the dry-run + force preview
  }, 30000);

  test('resume: pre-seeded checkpoint skips an already-completed page', async () => {
    await seedStub('people/alice-example', 'Alice Example', 'person');
    await seedStub('people/bob-example', 'Bob Example', 'person');
    await seedLinkInto('people/alice-example', 'meetings/a', RICH_CONTEXT);
    await seedLinkInto('people/bob-example', 'meetings/b', RICH_CONTEXT);

    const fp = enrichFingerprint({
      sourceId: 'default',
      types: ['person'],
      order: 'inbound-links',
      thinThreshold: 400,
      model: 'test:model',
    });
    await recordCompleted(engine, { op: 'enrich', fingerprint: fp }, ['default|people/alice-example']);

    const r = await runEnrichCore(engine, {
      sourceId: 'default',
      types: ['person'],
      order: 'inbound-links',
      thinThreshold: 400,
      model: 'test:model',
      synthesizeFn: goodSynth,
    });
    // alice was checkpointed → skipped; only bob enriched.
    expect(r.pages_enriched).toBe(1);
    const alice = await engine.getPage('people/alice-example', { sourceId: 'default' });
    expect(alice!.compiled_truth.trim()).toBe(STUB); // untouched
    const bob = await engine.getPage('people/bob-example', { sourceId: 'default' });
    expect(bob!.compiled_truth).toContain('## Overview');
  }, 30000);

  test('budget exhausted mid-run → partial, budget_exhausted flag', async () => {
    await seedStub('people/p1', 'P1 Example', 'person');
    await seedStub('people/p2', 'P2 Example', 'person');
    await seedStub('people/p3', 'P3 Example', 'person');
    await seedLinkInto('people/p1', 'meetings/m1', RICH_CONTEXT);
    await seedLinkInto('people/p2', 'meetings/m2', RICH_CONTEXT);
    await seedLinkInto('people/p3', 'meetings/m3', RICH_CONTEXT);

    let n = 0;
    const budgetSynth: SynthesizeFn = async () => {
      n++;
      if (n >= 2) {
        throw new BudgetExhausted('cap hit', { reason: 'cost', spent: 10, cap: 5 });
      }
      return goodSynth({ system: '', user: '', model: 'test:model' });
    };

    const r = await runEnrichCore(engine, {
      sourceId: 'default',
      types: ['person'],
      order: 'inbound-links',
      thinThreshold: 400,
      model: 'test:model',
      workers: 1, // deterministic abort point
      synthesizeFn: budgetSynth,
    });
    expect(r.budget_exhausted).toBe(true);
    expect(r.pages_enriched).toBe(1); // only the first synthesized before the cap
    // cost abort → reason surfaces so the CLI prints the raise-the-cap advice.
    expect(r.budget_exhausted_reason).toBe('cost');
  }, 30000);

  test('no_pricing abort surfaces reason + model (#4032)', async () => {
    await seedStub('people/p1', 'P1 Example', 'person');
    await seedLinkInto('people/p1', 'meetings/m1', RICH_CONTEXT);

    // TX2 shape: an unpriced model hard-fails reserve() on the FIRST call of a
    // capped run. Pre-fix the CLI collapsed this into "Budget cap reached" —
    // the reason/model never reached the result.
    const noPricingSynth: SynthesizeFn = async () => {
      throw new BudgetExhausted('no pricing for model', {
        reason: 'no_pricing',
        spent: 0,
        cap: 5,
        modelId: 'azure-openai:text-embedding-3-large',
      });
    };
    const r = await runEnrichCore(engine, {
      sourceId: 'default',
      types: ['person'],
      order: 'inbound-links',
      thinThreshold: 400,
      model: 'test:model',
      workers: 1,
      synthesizeFn: noPricingSynth,
    });
    expect(r.budget_exhausted).toBe(true);
    expect(r.budget_exhausted_reason).toBe('no_pricing');
    expect(r.budget_exhausted_model).toBe('azure-openai:text-embedding-3-large');
  }, 30000);

  test('budget abort flushes checkpoint so resume skips completed (P2#1)', async () => {
    await seedStub('people/p1', 'P1 Example', 'person');
    await seedStub('people/p2', 'P2 Example', 'person');
    await seedLinkInto('people/p1', 'meetings/m1', RICH_CONTEXT);
    await seedLinkInto('people/p2', 'meetings/m2', RICH_CONTEXT);

    let n = 0;
    const budgetSynth: SynthesizeFn = async () => {
      n++;
      if (n >= 2) throw new BudgetExhausted('cap hit', { reason: 'cost', spent: 10, cap: 5 });
      return goodSynth({ system: '', user: '', model: 'test:model' });
    };

    const fpOpts = {
      sourceId: 'default',
      types: ['person'] as const,
      order: 'inbound-links' as const,
      thinThreshold: 400,
      model: 'test:model',
    };
    const r = await runEnrichCore(engine, { ...fpOpts, types: ['person'], workers: 1, synthesizeFn: budgetSynth });
    expect(r.budget_exhausted).toBe(true);
    expect(r.pages_enriched).toBe(1);

    // Fix D: the page completed before the abort (< the 25-item periodic flush)
    // was flushed to the checkpoint in the BudgetExhausted catch, so a resume
    // would skip it instead of re-charging. Pre-fix this set was empty.
    const fp = enrichFingerprint({ ...fpOpts, types: ['person'] });
    const done = await loadOpCheckpoint(engine, { op: CHECKPOINT_OP, fingerprint: fp });
    expect(done).toContain('default|people/p1');
  }, 30000);

  test('final-call budget overage is flagged post-hoc (P1#3)', async () => {
    await seedStub('people/alice-example', 'Alice Example', 'person');
    await seedLinkInto('people/alice-example', 'meetings/x', RICH_CONTEXT);

    // Simulate the gateway swallowing a final-call BudgetExhausted: an external
    // tracker whose cumulative spend already exceeds its cap, with no throw
    // reaching runEnrichCore. record() updates cumulative THEN throws (TX1), so
    // catching the throw leaves totalSpent > cap.
    const tracker = new BudgetTracker({ maxCostUsd: 0.01, label: 'test' });
    try {
      tracker.record({ modelId: 'anthropic:claude-sonnet-4-6', inputTokens: 100_000_000, outputTokens: 0, kind: 'chat' });
    } catch { /* TX1 cost throw expected */ }
    expect(tracker.totalSpent).toBeGreaterThan(0.01); // precondition: pricing resolved

    // body() returns normally (SKIP → no further spend), but the tracker is over
    // cap → Fix C's post-hoc guard sets budget_exhausted. Pre-fix it was unset.
    const r = await runEnrichCore(engine, {
      sourceId: 'default',
      types: ['person'],
      model: 'test:model',
      synthesizeFn: async () => 'SKIP',
      budgetTracker: tracker,
    });
    expect(r.budget_exhausted).toBe(true);
  }, 30000);

  test('per-page lock busy → pages_skipped_lock, no write', async () => {
    await seedStub('people/alice-example', 'Alice Example', 'person');
    await seedLinkInto('people/alice-example', 'meetings/x', RICH_CONTEXT);

    // Pre-acquire the per-page lock so the enricher's withRefreshingLock fails.
    const handle = await tryAcquireDbLock(engine, 'enrich:default:people/alice-example', 5);
    expect(handle).toBeTruthy();
    try {
      const r = await runEnrichCore(engine, {
        sourceId: 'default',
        types: ['person'],
        model: 'test:model',
        synthesizeFn: goodSynth,
      });
      expect(r.pages_skipped_lock).toBe(1);
      expect(r.pages_enriched).toBe(0);
    } finally {
      await handle!.release();
    }
    const page = await engine.getPage('people/alice-example', { sourceId: 'default' });
    expect(page!.compiled_truth.trim()).toBe(STUB);
  }, 30000);

  test('empty candidate set → no-op result', async () => {
    const r = await runEnrichCore(engine, {
      sourceId: 'default',
      types: ['person'],
      model: 'test:model',
      synthesizeFn: goodSynth,
    });
    expect(r.candidates_considered).toBe(0);
    expect(r.pages_enriched).toBe(0);
  });
});
