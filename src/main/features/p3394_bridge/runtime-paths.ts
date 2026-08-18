/**
 * P3394 runtime variant paths (bridge state, session store, KSTAR episodes).
 *
 * Shared by app-wiring / session-store / kstar-episodes so every piece of the
 * bridge lands in the same per-variant directory. The variant name comes from
 * the app launcher (--orkas-runtime-variant) or the classic env fallback.
 */
import * as os from 'node:os';
import * as path from 'node:path';

export function variantRoot(): string {
  const variant = process.env.ORKAS_RUNTIME_VARIANT || process.env.COGSEED_SOURCE_RUNTIME_VARIANT || 'cogseed';
  return path.join(os.homedir(), '.cogseed', 'runtime-variants', variant);
}

/** Per-variant persistent P3394 state files. */
export function p3394StateFile(name: string): string {
  return path.join(variantRoot(), name);
}
