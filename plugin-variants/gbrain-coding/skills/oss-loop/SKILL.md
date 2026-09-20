---
name: oss-loop
description: |
  Run a focused open-source contribution loop: inspect the target repository,
  implement one independently reviewable change, validate it, and prepare an
  upstream pull request only after the target and CI policy are verified. Use
  for OSS fixes, candidate waves, PR follow-up, or requests to keep iterating
  until checks are green. Shared by Claude Code and Codex; it never assumes a
  personal fork is the publication target.
triggers:
  - "OSS loop"
  - "OSS contribution"
  - "open source PR"
  - "prepare an upstream PR"
  - "check OSS candidates"
  - "iterate until CI is green"
tools:
  - exec
mutating: true
brain_first: exempt
---

# OSS Contribution Loop

This is the shared contribution workflow for Claude Code and Codex. The
repository's `skills/` copy is canonical; generated plugin trees carry the
same skill to both harnesses.

## Non-negotiable target check

Before pushing or creating a PR, run the bundled target check from the current
repository:

```bash
bash skills/oss-loop/scripts/verify-target.sh --target garrytan/gbrain
```

Use the repository's documented canonical target when working on another OSS
project. If the target is not explicit or the check fails, stop before any
push or PR creation. A personal fork may be used for local validation, but it
is never the publication target unless the user explicitly asks for a fork PR.

The check must establish all of the following:

- the requested target is the canonical upstream repository;
- the current source repository is shown separately from that target;
- the GitHub CLI is authenticated for that target;
- the current branch and working tree are visible before mutation.

## Contract

- Keep the canonical upstream target explicit for every push and pull request.
- Keep each candidate isolated and independently reviewable.
- Treat CI as incomplete until every required check is Green; skipped or pending
  checks remain separate from passed checks.
- Preserve the user's worktree and report any blocked or unavailable step
  without silently treating it as success.

## Loop

1. Read `AGENTS.md`, `CLAUDE.md`, the relevant reference docs, and the
   repository's release/contribution rules before editing.
2. Inspect the target repository's current issues and PRs, then select one
   narrow candidate. Keep independent candidates in separate worktrees and
   branches.
3. Implement the smallest complete change with a regression test. Do not
   broaden a candidate merely because another candidate is available.
4. Run the focused checks, then the repository's required CI-equivalent gate
   when feasible. Report skipped or unavailable checks separately from passed
   checks.
5. Run the target check again immediately before pushing or creating the PR.
   Create the PR against the canonical upstream repository explicitly, normally
   as Draft. From a fork checkout, pass both `--repo garrytan/gbrain` and a
   fully qualified `--head OWNER:branch`; never let the current `origin` pick
   the publication repository implicitly.
6. Keep the PR Draft until all required checks are green. `pending`, `skipped`,
   or a stale result is not Green. Only then mark it ready when the user has
   authorized publication.
7. For a fork PR superseded by an upstream PR, close the fork PR with a clear
   supersession note; do not delete branches or force-push without a separate
   authorization.

## Anti-Patterns

- Do not let the current `origin` or checkout decide the publication target.
- Do not publish to a personal fork when the requested target is upstream.
- Do not mark a Draft ready because local tests pass while required CI is
  pending, skipped, stale, or failed.
- Do not combine unrelated candidate fixes into one PR or hide missing evidence
  behind a generic "passed" summary.

## Output Format

Report one candidate at a time with:

1. target repository and source branch;
2. change summary and focused validation;
3. CI counts split into passed, skipped, pending, and failed;
4. PR state and the next action.

Use `blocked` or `incomplete` when evidence is missing. Never claim Green until
all required checks are complete and successful.

## Reporting

For every candidate, report: target repository, branch, PR state, passed,
skipped, pending, and failed checks, plus the next action. Never claim Green
when any required check is pending or unavailable.
