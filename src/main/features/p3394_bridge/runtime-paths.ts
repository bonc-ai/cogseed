/**
 * P3394 runtime variant paths (bridge state, session store).
 *
 * Shared by app-wiring / session-store so every piece of the
 * bridge lands in the same per-variant directory. The variant name comes from
 * the app launcher (--cogseed-runtime-variant) or the classic env fallback and
 * must pass the brand.ts whitelist; arbitrary names would mint junk containers
 * under the real ~/.cogseed (test scratch variants used to leak this way).
 * Tests redirect the whole variant tree to a tmp dir via
 * COGSEED_VARIANT_BASE_DIR instead of inventing variant names.
 */
import * as os from 'node:os';
import * as path from 'node:path';
import { parseRuntimeVariant } from '../../brand';

export function variantRoot(): string {
  const variant = parseRuntimeVariant(
    process.env.COGSEED_RUNTIME_VARIANT || process.env.COGSEED_SOURCE_RUNTIME_VARIANT || 'cogseed',
  );
  const base = process.env.COGSEED_VARIANT_BASE_DIR || path.join(os.homedir(), '.cogseed');
  return path.join(base, 'runtime-variants', variant);
}

/** Per-variant persistent P3394 state files. */
export function p3394StateFile(name: string): string {
  return path.join(variantRoot(), name);
}
