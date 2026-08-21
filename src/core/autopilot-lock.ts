import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

export type AutopilotLockHolder =
  | { state: 'dead' }
  | { state: 'self' }
  | { state: 'alive-autopilot' }
  | { state: 'alive-foreign' }
  | { state: 'alive-unknown' };

export interface AutopilotLockProbeDeps {
  isPidAlive?: (pid: number) => boolean;
  readProcessCommand?: (pid: number) => string | null;
}

export interface ReadProcessCommandDeps {
  platform?: NodeJS.Platform;
  readFileSync?: (path: string, encoding: 'utf8') => string;
  execFileSync?: (
    file: string,
    args: string[],
    options: {
      encoding: 'utf8';
      stdio: ['ignore', 'pipe', 'ignore'];
      timeout: number;
    },
  ) => string;
}

export function isPidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function readProcessCommand(
  pid: number,
  deps: ReadProcessCommandDeps = {},
): string | null {
  if (!Number.isFinite(pid) || pid <= 0) return null;

  if ((deps.platform ?? process.platform) === 'linux') {
    try {
      const read = deps.readFileSync ?? ((path: string, encoding: 'utf8') => readFileSync(path, encoding));
      const out = read(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ').trim();
      return out.length > 0 ? out : null;
    } catch {
      return null;
    }
  }

  try {
    const run = deps.execFileSync ?? ((file, args, options) => execFileSync(file, args, options));
    const out = run('ps', ['-p', String(pid), '-o', 'args='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1000,
    }).trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

export function looksLikeGbrainAutopilotCommand(command: string): boolean {
  const normalized = command.replace(/\\/g, '/').trim();
  if (!/(^|\s)autopilot(\s|$)/i.test(normalized)) return false;
  if (/(^|[\/\s])gbrain(?:\.exe)?(\s|$)/i.test(normalized)) return true;
  return /(^|\s)(?:\S+\/)?(?:\.{1,2}\/)?(?:src\/)?cli\.(?:ts|js|mjs)(\s|$)/i.test(normalized)
    || /(^|\s)\S*\/src\/cli\.(?:ts|js|mjs)(\s|$)/i.test(normalized);
}

export function classifyAutopilotLockHolder(
  pid: number,
  currentPid: number = process.pid,
  deps: AutopilotLockProbeDeps = {},
): AutopilotLockHolder {
  if (!Number.isFinite(pid) || pid <= 0) return { state: 'dead' };
  if (pid === currentPid) return { state: 'self' };

  const probeAlive = deps.isPidAlive ?? isPidAlive;
  if (!probeAlive(pid)) return { state: 'dead' };

  const probeCommand = deps.readProcessCommand ?? readProcessCommand;
  const command = probeCommand(pid);
  if (command === null) return { state: 'alive-unknown' };
  return looksLikeGbrainAutopilotCommand(command)
    ? { state: 'alive-autopilot' }
    : { state: 'alive-foreign' };
}
