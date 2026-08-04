import * as fs from 'node:fs/promises';

import {
  isEphemeralSessionId,
  resolveSessionPath,
  sessionKindOf,
} from '../../model/core-agent/session-store';

const MAX_METADATA_BYTES = 16 * 1024;
const MAX_OWNER_ID_LENGTH = 128;
const OWNER_ID_RE = /^[A-Za-z0-9_-]+$/;

export interface ResolvedSession {
  sessionId: string;
  kind: string | null;
  region: 'cloud' | 'local';
  exists: boolean;
  resumable: boolean;
  ownerId?: string;
  source: 'session-store';
}

function boundedOwnerId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const candidate = value.trim();
  if (
    !candidate ||
    candidate.length > MAX_OWNER_ID_LENGTH ||
    !OWNER_ID_RE.test(candidate)
  ) return undefined;
  return candidate;
}

function ownerIdFromRecord(record: unknown): string | undefined {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return undefined;
  const row = record as Record<string, unknown>;
  const metadata = row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata)
    ? row.metadata as Record<string, unknown>
    : undefined;
  return boundedOwnerId(row.ownerId)
    ?? boundedOwnerId(row.owner_id)
    ?? boundedOwnerId(row.userId)
    ?? boundedOwnerId(row.user_id)
    ?? boundedOwnerId(metadata?.ownerId)
    ?? boundedOwnerId(metadata?.owner_id)
    ?? boundedOwnerId(metadata?.userId)
    ?? boundedOwnerId(metadata?.user_id);
}

async function readBoundedOwnerId(filePath: string): Promise<string | undefined> {
  const handle = await fs.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(MAX_METADATA_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const text = buffer.subarray(0, bytesRead).toString('utf8');
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const ownerId = ownerIdFromRecord(JSON.parse(trimmed));
        if (ownerId) return ownerId;
      } catch {
        // Session JSONL is recoverable. Never include the malformed line in logs/errors.
      }
    }
    return undefined;
  } finally {
    await handle.close();
  }
}

export async function resolveAuthoritativeSession(
  userId: string,
  sessionId: string,
): Promise<ResolvedSession> {
  const kind = sessionKindOf(sessionId);
  if (!kind) {
    return {
      sessionId,
      kind: null,
      region: 'cloud',
      exists: false,
      resumable: false,
      source: 'session-store',
    };
  }

  const ephemeral = isEphemeralSessionId(sessionId);
  const region = ephemeral ? 'local' : 'cloud';
  const filePath = resolveSessionPath(userId, sessionId);

  try {
    const ownerId = await readBoundedOwnerId(filePath);
    return {
      sessionId,
      kind,
      region,
      exists: true,
      resumable: !ephemeral,
      ...(ownerId ? { ownerId } : {}),
      source: 'session-store',
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return {
        sessionId,
        kind,
        region,
        exists: false,
        resumable: !ephemeral,
        source: 'session-store',
      };
    }
    throw err;
  }
}

export const authoritativeSessionSource = {
  async resolve(userId: string, sessionId: string) {
    const resolved = await resolveAuthoritativeSession(userId, sessionId);
    return {
      ...resolved,
      valid: resolved.kind !== null && resolved.exists,
    };
  },
};
