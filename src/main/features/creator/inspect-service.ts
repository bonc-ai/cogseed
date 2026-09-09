import { readCreatorFeatureFlags } from './flags';
import {
  buildCreatorCapabilityCatalog,
  sanitizeCreatorCapabilityCatalog,
  type CreatorCapabilityDescriptor,
} from './catalog';
import { getActiveUserId } from '../users';
import type { CreatorFeatureFlags } from './types';

export interface CreatorInspectSnapshot {
  schemaVersion: 1;
  flags: CreatorFeatureFlags;
  capabilities: CreatorCapabilityDescriptor[];
  sandboxProfiles: ['creator-read-only-v1'];
  limits: { maxCapabilities: number };
}

export interface CreatorInspectDependencies {
  getActiveUserId?: () => string;
  readFlags?: (userId: string) => CreatorFeatureFlags;
  buildCatalog?: (userId: string) => Promise<CreatorCapabilityDescriptor[]>;
}

class CreatorInspectError extends Error {
  constructor(code: 'creator_user_not_active' | 'creator_inspect_dependency_failed') {
    super(code);
    this.name = 'CreatorInspectError';
  }
}

export async function inspectCreatorRuntime(userId: string, deps: CreatorInspectDependencies = {}): Promise<CreatorInspectSnapshot> {
  try {
    const activeUserId = (deps.getActiveUserId ?? getActiveUserId)();
    if (!userId || activeUserId !== userId) throw new CreatorInspectError('creator_user_not_active');
    return {
      schemaVersion: 1,
      flags: (deps.readFlags ?? readCreatorFeatureFlags)(userId),
      capabilities: sanitizeCreatorCapabilityCatalog(
        await (deps.buildCatalog ?? buildCreatorCapabilityCatalog)(userId),
      ),
      sandboxProfiles: ['creator-read-only-v1'],
      limits: { maxCapabilities: 64 },
    };
  } catch (error) {
    if (error instanceof CreatorInspectError) throw error;
    throw new CreatorInspectError('creator_inspect_dependency_failed');
  }
}
