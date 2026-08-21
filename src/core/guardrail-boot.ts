/**
 * CLI-process boot hook for guardrail providers (#3688).
 *
 * docs/guardrails.md tells operators to "register once at process init
 * (e.g. from a plugin entry or an operator boot hook)" — but before this
 * file, no such hook existed. `GBRAIN_PLUGIN_PATH` (plugin-loader.ts,
 * skillpack-load.ts) only loads markdown subagent definitions and
 * IngestionSource factories for the ingestion daemon; it never executes
 * arbitrary operator code inside the CLI process. `registerGuardrailProvider`
 * (guardrails.ts) had zero production call sites, so `runGuardrails` always
 * short-circuited on `providers.size === 0` for every CLI user.
 *
 * `GBRAIN_GUARDRAIL_MODULE` closes that gap: it points at operator-owned,
 * already-trusted code (a local file the operator wrote or vetted — not a
 * downloaded skillpack), so this loader is deliberately simpler than the
 * plugin/skillpack loaders: no manifest, no permission negotiation, no
 * `kind` collision handling. It resolves one absolute path, imports it once
 * per process, and — if the module also exports a zero-arg `default`
 * function — awaits it. The module itself owns calling
 * `registerGuardrailProvider`; this loader never touches the provider
 * registry directly.
 *
 * Fail-open, matching every other invariant in guardrails.ts: a missing
 * env var, a relative/missing path, or an import that throws produces a
 * warning string for the caller to log — never a thrown error that could
 * abort the CLI command the operator is actually trying to run.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export interface LoadGuardrailBootModuleOpts {
  /** Override the GBRAIN_GUARDRAIL_MODULE env (for tests). */
  envPath?: string;
  /** Test seam: alternative import() function for stubbing module loads. */
  _import?: (specifier: string) => Promise<unknown>;
}

export interface LoadGuardrailBootModuleResult {
  /** True only when the module imported (and any default export ran) cleanly. */
  loaded: boolean;
  /** The resolved path that was imported, when loaded is true. */
  modulePath?: string;
  /** Non-fatal problem description. Caller decides how/whether to surface it. */
  warning?: string;
}

/**
 * Load and run the operator-designated guardrail boot module, if
 * `GBRAIN_GUARDRAIL_MODULE` is set. No-op (`loaded: false`, no warning) when
 * unset — the OSS distribution ships inert by default, unchanged.
 */
export async function loadGuardrailBootModule(
  opts: LoadGuardrailBootModuleOpts = {},
): Promise<LoadGuardrailBootModuleResult> {
  const raw = (opts.envPath ?? process.env.GBRAIN_GUARDRAIL_MODULE ?? '').trim();
  if (!raw) return { loaded: false };

  if (!path.isAbsolute(raw)) {
    return {
      loaded: false,
      warning: `[guardrail-boot] GBRAIN_GUARDRAIL_MODULE must be an absolute path, got: ${raw}`,
    };
  }
  if (!fs.existsSync(raw)) {
    return {
      loaded: false,
      warning: `[guardrail-boot] GBRAIN_GUARDRAIL_MODULE path does not exist: ${raw}`,
    };
  }

  const importer = opts._import ?? ((spec: string) => import(spec));
  let mod: unknown;
  try {
    mod = await importer(raw);
  } catch (e) {
    return {
      loaded: false,
      warning: `[guardrail-boot] failed to import GBRAIN_GUARDRAIL_MODULE (${raw}): ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  // The common case: the module calls registerGuardrailProvider() as a
  // top-level side effect of import (exactly the docs/guardrails.md
  // example) — nothing further to do. A module MAY also export a default
  // function for setup that needs to be async; if present, await it.
  const m = mod as Record<string, unknown>;
  if (typeof m.default === 'function') {
    try {
      await (m.default as () => unknown)();
    } catch (e) {
      return {
        loaded: false,
        warning: `[guardrail-boot] GBRAIN_GUARDRAIL_MODULE default export threw (${raw}): ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  }

  return { loaded: true, modulePath: raw };
}
