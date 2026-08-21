/**
 * Sync operation cluster — pure move from operations.ts (v0.46.x tranche 2).
 * Op consts stay module-private; `syncStatusOperations` below lists them in
 * EXACTLY the order they appear in the canonical `operations` array in
 * ../operations.ts. Never import from '../operations.ts' here (cycle).
 */

import type { Operation } from './contract.ts';

// --- Sync ---

const sync_brain: Operation = {
  name: 'sync_brain',
  description: 'Sync git repo to brain (incremental)',
  params: {
    repo: { type: 'string', description: 'Path to git repo (optional if configured)' },
    dry_run: { type: 'boolean', description: 'Preview changes without applying' },
    full: { type: 'boolean', description: 'Full re-sync (ignore checkpoint)' },
    no_pull: { type: 'boolean', description: 'Skip git pull' },
    no_embed: { type: 'boolean', description: 'Skip embedding generation' },
  },
  mutating: true,
  scope: 'admin',
  localOnly: true,
  handler: async (ctx, p) => {
    const { performSync } = await import('../../commands/sync.ts');
    // #2830: thread ctx.sourceId (D7 pattern, same as revert_version /
    // put_page) so a no-`repo` call resolves the CALLER's sync anchor.
    // Without it, performSync read the default source's repo_path/last_commit
    // and silently synced against the wrong repo on multi-source brains.
    let sourceId = ctx.sourceId;
    // #3765: ctx.sourceId is resolved by the TRANSPORT against ITS OWN cwd
    // (`gbrain call` resolves against process.cwd(); the stdio/HTTP MCP
    // server resolves against ITS cwd too) — never against the `repo`
    // param's directory. A worktree pinned to a non-default source via
    // `.gbrain-source`, or simply registered as a source's local_path, is
    // therefore invisible whenever the caller's own cwd carries no pin:
    // ctx.sourceId auto-fills to 'default' (dispatch.ts D4) and an explicit
    // `repo` argument then syncs INTO 'default' instead of the source the
    // repo is actually registered/pinned to.
    //
    // When sourceId is still at that generic 'default' fallback and an
    // explicit `repo` was given, re-run the dotfile/registered-local_path
    // tiers of the resolver ANCHORED AT THE REPO PATH instead of the
    // caller's cwd. Tiers that don't depend on cwd (env, brain default,
    // sole-non-default, the literal 'default' terminal) resolve identically
    // either way, so this is a no-op unless the repo path itself carries a
    // pin — it never overrides a caller who explicitly resolved a
    // non-default sourceId (their own --source flag / GBRAIN_SOURCE / cwd
    // dotfile already won upstream of this handler).
    if (sourceId === 'default' && typeof p.repo === 'string' && p.repo) {
      const { resolveSourceId } = await import('../source-resolver.ts');
      sourceId = await resolveSourceId(ctx.engine, null, p.repo);
    }
    const sourceOpts = sourceId ? { sourceId } : {};
    return performSync(ctx.engine, {
      repoPath: p.repo as string | undefined,
      dryRun: ctx.dryRun || (p.dry_run as boolean) || false,
      noEmbed: (p.no_embed as boolean) || false,
      noPull: (p.no_pull as boolean) || false,
      full: (p.full as boolean) || false,
      ...sourceOpts,
    });
  },
  cliHints: { name: 'sync', hidden: true },
};


// Ops in EXACTLY the canonical `operations` array order.
export const syncStatusOperations: Operation[] = [sync_brain];
