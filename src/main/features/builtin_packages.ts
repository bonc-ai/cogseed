/**
 * Builtin packages — product-bundled external packages seeded into the
 * per-user packages tree at startup. The EduSeed course client
 * (`eduseed-course-client`) is the first consumer.
 *
 * Contract (mirrors the builtin marketplace seed):
 *  - `bin/cogseed-pkg.cjs` stays the SINGLE writer of `_registry.json`:
 *    seeding only invokes its install/remove subcommands out-of-process,
 *    so scan gates, symlink refusal and registry lifecycle stay intact.
 *  - Bundled content ships under `resources/builtin-packages/` (an
 *    electron-builder extraResources tree) and is versioned by the app
 *    release. A sidecar file next to the registry records the seeded
 *    source_version so a new app release upgrades a stale install.
 *  - Everything is fail-soft: a failed seed never blocks boot and is
 *    retried on the next launch (or the next user activation).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { createLogger } from '../logger';
import { maskId } from '../util/log-redact';
import {
  packagedBuiltinPackagesDir,
  userPackagesDir,
} from '../paths';
import {
  readPackagesRegistry,
  runPackageInstall,
  runPackageCommand,
} from './packages';

const log = createLogger('builtin-packages');

export const BUILTIN_PACKAGES_MANIFEST = '_builtin.json';
export const BUILTIN_SEED_STATE_FILE = '.builtin_seed.json';

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface BuiltinPackageEntry {
  name: string;
  source_version: string;
  rel_dir: string;
}

export interface BuiltinPackagesManifest {
  version: number;
  packages: BuiltinPackageEntry[];
}

export interface BuiltinPackageSeedResult {
  installed: string[];
  upgraded: string[];
  skipped: string[];
  failed: Array<{ name: string; error: string }>;
}

/** Validate + sanitise the bundled manifest. Anything unsafe is dropped
 *  (fail-closed: a malformed row simply never seeds). */
export function sanitiseBuiltinManifest(raw: unknown): BuiltinPackagesManifest {
  if (!raw || typeof raw !== 'object') return { version: 1, packages: [] };
  const m = raw as Record<string, unknown>;
  const rows = Array.isArray(m.packages) ? m.packages : [];
  const packages: BuiltinPackageEntry[] = [];
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue;
    const row = r as Record<string, unknown>;
    const name = typeof row.name === 'string' ? row.name.trim() : '';
    const rel = typeof row.rel_dir === 'string' ? row.rel_dir.trim() : name;
    const version = typeof row.source_version === 'string' ? row.source_version.trim() : '';
    if (!name || !SAFE_NAME.test(name) || name.includes('..')) continue;
    if (!version || version.length > 64) continue;
    if (!rel || path.isAbsolute(rel) || rel.split(/[\\/]/).includes('..')) continue;
    packages.push({ name, source_version: version, rel_dir: rel });
  }
  return { version: 1, packages };
}

export function readBuiltinPackagesManifest(): BuiltinPackagesManifest {
  try {
    const file = path.join(packagedBuiltinPackagesDir(), BUILTIN_PACKAGES_MANIFEST);
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return sanitiseBuiltinManifest(parsed);
  } catch (err) {
    log.warn('builtin packages manifest unavailable', { error: (err as Error).message });
    return { version: 1, packages: [] };
  }
}

export function builtinSeedStateFile(uid: string): string {
  return path.join(userPackagesDir(uid), BUILTIN_SEED_STATE_FILE);
}

export function readBuiltinSeedState(uid: string): Record<string, string> {
  try {
    const parsed = JSON.parse(fs.readFileSync(builtinSeedStateFile(uid), 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    // Envelope written by writeBuiltinSeedState: { version, seeded: {name: ver} }.
    const table = parsed.seeded && typeof parsed.seeded === 'object' && !Array.isArray(parsed.seeded)
      ? parsed.seeded
      : parsed;
    const out: Record<string, string> = {};
    for (const [name, version] of Object.entries(table as Record<string, unknown>)) {
      if (SAFE_NAME.test(name) && typeof version === 'string' && version) out[name] = version;
    }
    return out;
  } catch {
    return {};
  }
}

function writeBuiltinSeedState(uid: string, state: Record<string, string>): void {
  try {
    const file = builtinSeedStateFile(uid);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify({ version: 1, seeded: state }, null, 2)}\n`);
  } catch (err) {
    log.warn('builtin seed state write failed', { uid: maskId(uid), error: (err as Error).message });
  }
}

export type SeedDecision = 'install' | 'upgrade' | 'skip';

export function decideSeedAction(
  installed: boolean,
  stateVersion: string | undefined,
  sourceVersion: string,
): SeedDecision {
  if (!installed) return 'install';
  return stateVersion === sourceVersion ? 'skip' : 'upgrade';
}

export interface SeedBuiltinPackagesOptions {
  shouldContinue?: () => boolean;
}

/**
 * Seed every bundled package for one user. Idempotent; per-package failures
 * are recorded and never thrown. `shouldContinue` is checked between
 * packages so boot/user-switch cancellation is cooperative.
 */
export async function seedBuiltinPackagesForUser(
  uid: string,
  opts: SeedBuiltinPackagesOptions = {},
): Promise<BuiltinPackageSeedResult> {
  const result: BuiltinPackageSeedResult = { installed: [], upgraded: [], skipped: [], failed: [] };
  const manifest = readBuiltinPackagesManifest();
  if (!manifest.packages.length) return result;

  const shouldContinue = opts.shouldContinue ?? (() => true);
  const registry = readPackagesRegistry(uid);
  const state = readBuiltinSeedState(uid);
  let stateDirty = false;

  for (const entry of manifest.packages) {
    if (!shouldContinue()) break;
    const installed = registry.packages.some((p) => p.name === entry.name);
    const decision = decideSeedAction(installed, state[entry.name], entry.source_version);
    if (decision === 'skip') {
      result.skipped.push(entry.name);
      continue;
    }

    const sourceDir = path.join(packagedBuiltinPackagesDir(), entry.rel_dir);
    let sourceOk = false;
    try { sourceOk = fs.statSync(sourceDir).isDirectory(); } catch { /* missing */ }
    if (!sourceOk) {
      result.failed.push({ name: entry.name, error: 'bundled source directory missing' });
      log.warn('builtin package source missing', { package_name: entry.name });
      continue;
    }
    // 防呆：内置 manifest 必须是合法 JSON。主进程按它解析 UI/命令白名单，
    // 一旦损坏授权徽章会静默变成「检查失败」——种子阶段就拦下来。
    try {
      JSON.parse(fs.readFileSync(path.join(sourceDir, 'manifest.json'), 'utf8'));
    } catch (err) {
      result.failed.push({ name: entry.name, error: `bundled manifest.json invalid: ${(err as Error).message}` });
      log.warn('builtin package manifest invalid, skipping seed', { package_name: entry.name });
      continue;
    }

    if (decision === 'upgrade') {
      const removed = await runPackageCommand(uid, 'remove', entry.name);
      if (!removed.ok) {
        result.failed.push({ name: entry.name, error: `remove failed: ${removed.error || 'unknown'}` });
        continue;
      }
    }

    const inst = await runPackageInstall(uid, { source: sourceDir, name: entry.name });
    if (!inst.ok) {
      result.failed.push({ name: entry.name, error: inst.error || 'install failed' });
      continue;
    }

    state[entry.name] = entry.source_version;
    stateDirty = true;
    if (decision === 'upgrade') result.upgraded.push(entry.name);
    else result.installed.push(entry.name);
  }

  if (stateDirty) writeBuiltinSeedState(uid, state);
  return result;
}
