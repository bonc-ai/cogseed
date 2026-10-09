import * as users from './users';
import * as builtinPackages from './builtin_packages';
import { createLogger } from '../logger';
import { maskId } from '../util/log-redact';
import type { BuiltinPackageSeedResult } from './builtin_packages';

const log = createLogger('builtin-packages');

let inFlightUid = '';
let inFlight: Promise<BuiltinPackageSeedResult | null> | null = null;

export interface SeedBuiltinPackagesForActiveUserOptions {
  reason: string;
  shouldContinue?: () => boolean;
}

function _activeUidOrNull(): string | null {
  try {
    return users.getActiveUserId();
  } catch {
    return null;
  }
}

function _hasSeedChanges(result: BuiltinPackageSeedResult): boolean {
  return result.installed.length > 0 || result.upgraded.length > 0;
}

export async function seedBuiltinPackagesForActiveUser(
  opts: SeedBuiltinPackagesForActiveUserOptions,
): Promise<BuiltinPackageSeedResult | null> {
  const uid = _activeUidOrNull();
  if (!uid) {
    log.warn('skip builtin packages seed: no active user', { reason: opts.reason });
    return null;
  }

  if (inFlight && inFlightUid === uid) return inFlight;

  const shouldContinue = (): boolean => {
    if (opts.shouldContinue && !opts.shouldContinue()) return false;
    return _activeUidOrNull() === uid;
  };

  inFlightUid = uid;
  inFlight = (async () => {
    const result = await builtinPackages.seedBuiltinPackagesForUser(uid, { shouldContinue });
    if (_hasSeedChanges(result)) {
      log.info('seeded builtin packages for active user', {
        reason: opts.reason,
        uid: maskId(uid),
        ...result,
      });
    }
    return result;
  })().catch((err) => {
    log.warn('builtin packages seed for active user failed', {
      reason: opts.reason,
      uid: maskId(uid),
      error: (err as Error).message,
    });
    return null;
  }).finally(() => {
    if (inFlightUid === uid) {
      inFlightUid = '';
      inFlight = null;
    }
  });

  return inFlight;
}
