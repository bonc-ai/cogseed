import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

import { mateRuntimeSessionToolResultsDir } from '../../paths';

export interface MateCapabilityArtifactScope {
  userId: string;
  runtimeSessionId: string;
}

export type MateCapabilityArtifactKind = 'office-output' | 'office-preview' | 'browser-screenshot';

export interface MateCapabilityArtifact {
  artifactId: string;
  userId: string;
  runtimeSessionId: string;
  kind: MateCapabilityArtifactKind;
  path: string;
  mimeType?: string;
  owned: boolean;
  createdAt: string;
}

export interface MateCapabilityArtifactRegistry {
  register(scope: MateCapabilityArtifactScope, input: Omit<MateCapabilityArtifact, 'artifactId' | 'userId' | 'runtimeSessionId' | 'createdAt'>): Promise<MateCapabilityArtifact>;
  list(scope: MateCapabilityArtifactScope): Promise<MateCapabilityArtifact[]>;
  cleanup(scope: MateCapabilityArtifactScope): Promise<void>;
}

function key(scope: MateCapabilityArtifactScope): string {
  return `${scope.userId}\0${scope.runtimeSessionId}`;
}

function manifestPath(scope: MateCapabilityArtifactScope): string {
  return path.join(mateRuntimeSessionToolResultsDir(scope.userId, scope.runtimeSessionId), 'artifacts.json');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

export function createMateCapabilityArtifactRegistry(): MateCapabilityArtifactRegistry {
  const entries = new Map<string, MateCapabilityArtifact[]>();

  async function read(scope: MateCapabilityArtifactScope): Promise<MateCapabilityArtifact[]> {
    const existing = entries.get(key(scope));
    if (existing) return existing;
    try {
      const raw: unknown = JSON.parse(await fs.readFile(manifestPath(scope), 'utf8'));
      const loaded = Array.isArray(raw) ? raw.filter(isRecord).map((item) => item as unknown as MateCapabilityArtifact) : [];
      entries.set(key(scope), loaded);
      return loaded;
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
        const empty: MateCapabilityArtifact[] = [];
        entries.set(key(scope), empty);
        return empty;
      }
      throw error;
    }
  }

  async function persist(scope: MateCapabilityArtifactScope, artifacts: MateCapabilityArtifact[]): Promise<void> {
    const file = manifestPath(scope);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, `${JSON.stringify(artifacts, null, 2)}\n`, 'utf8');
  }

  return {
    async register(scope, input) {
      const artifacts = await read(scope);
      const artifact: MateCapabilityArtifact = {
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
      await fs.rm(mateRuntimeSessionToolResultsDir(scope.userId, scope.runtimeSessionId), { recursive: false, force: true }).catch(() => undefined);
    },
  };
}

export const mateCapabilityArtifactRegistry = createMateCapabilityArtifactRegistry();
