import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

import { cogseedRuntimeSessionToolResultsDir } from '../../paths';

export interface CogSeedCapabilityArtifactScope {
  userId: string;
  runtimeSessionId: string;
}

export type CogSeedCapabilityArtifactKind = 'office-output' | 'office-preview' | 'browser-screenshot';

export interface CogSeedCapabilityArtifact {
  artifactId: string;
  userId: string;
  runtimeSessionId: string;
  kind: CogSeedCapabilityArtifactKind;
  path: string;
  mimeType?: string;
  owned: boolean;
  createdAt: string;
}

export interface CogSeedCapabilityArtifactRegistry {
  register(scope: CogSeedCapabilityArtifactScope, input: Omit<CogSeedCapabilityArtifact, 'artifactId' | 'userId' | 'runtimeSessionId' | 'createdAt'>): Promise<CogSeedCapabilityArtifact>;
  list(scope: CogSeedCapabilityArtifactScope): Promise<CogSeedCapabilityArtifact[]>;
  cleanup(scope: CogSeedCapabilityArtifactScope): Promise<void>;
}

function key(scope: CogSeedCapabilityArtifactScope): string {
  return `${scope.userId}\0${scope.runtimeSessionId}`;
}

function manifestPath(scope: CogSeedCapabilityArtifactScope): string {
  return path.join(cogseedRuntimeSessionToolResultsDir(scope.userId, scope.runtimeSessionId), 'artifacts.json');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

export function createCogSeedCapabilityArtifactRegistry(): CogSeedCapabilityArtifactRegistry {
  const entries = new Map<string, CogSeedCapabilityArtifact[]>();

  async function read(scope: CogSeedCapabilityArtifactScope): Promise<CogSeedCapabilityArtifact[]> {
    const existing = entries.get(key(scope));
    if (existing) return existing;
    try {
      const raw: unknown = JSON.parse(await fs.readFile(manifestPath(scope), 'utf8'));
      const loaded = Array.isArray(raw) ? raw.filter(isRecord).map((item) => item as unknown as CogSeedCapabilityArtifact) : [];
      entries.set(key(scope), loaded);
      return loaded;
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
        const empty: CogSeedCapabilityArtifact[] = [];
        entries.set(key(scope), empty);
        return empty;
      }
      throw error;
    }
  }

  async function persist(scope: CogSeedCapabilityArtifactScope, artifacts: CogSeedCapabilityArtifact[]): Promise<void> {
    const file = manifestPath(scope);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, `${JSON.stringify(artifacts, null, 2)}\n`, 'utf8');
  }

  return {
    async register(scope, input) {
      const artifacts = await read(scope);
      const artifact: CogSeedCapabilityArtifact = {
        ...input,
        artifactId: `${input.kind}-${randomUUID()}`,
        userId: scope.userId,
        runtimeSessionId: scope.runtimeSessionId,
        createdAt: new Date().toISOString(),
      };
      artifacts.push(artifact);
      await persist(scope, artifacts);
      return artifact;
    },

    async list(scope) {
      return [...await read(scope)];
    },

    async cleanup(scope) {
      const artifacts = await read(scope);
      for (const artifact of artifacts) {
        if (!artifact.owned) continue;
        await fs.rm(artifact.path, { force: true }).catch(() => undefined);
      }
      entries.delete(key(scope));
      await fs.rm(manifestPath(scope), { force: true }).catch(() => undefined);
      await fs.rm(cogseedRuntimeSessionToolResultsDir(scope.userId, scope.runtimeSessionId), { recursive: false, force: true }).catch(() => undefined);
    },
  };
}

export const cogseedCapabilityArtifactRegistry = createCogSeedCapabilityArtifactRegistry();
