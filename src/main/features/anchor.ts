/**
 * Anchor resolution feature (COGSEED-39 ② P1) — IPC-facing entry for
 * `cogseed.anchor.resolve`.
 *
 * Lives in the features layer (not cogseed_backend) because it calls the
 * in-process model layer (`model/core-agent/anchor-resolver`), which the
 * cogseed runtime backend must not import (separation boundary).
 *
 * Validates the payload here (bounded strings, integer chunk), then delegates
 * to the resolver. Read-only.
 */

import { createLogger } from '../logger';
import { resolveAnchor } from '../model/core-agent/anchor-resolver';

const log = createLogger('anchor');

function boundedString(value: unknown, field: string, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const s = value.trim();
  if (s.length === 0 || s.length > max) return undefined;
  return s;
}

export async function anchorResolveIpc(userId: string, payload: unknown): Promise<unknown> {
  const raw = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>;
  const scopeRaw = boundedString(raw.scope, 'scope', 32) ?? '';
  const scope = scopeRaw === 'space' ? 'space'
    : scopeRaw === 'conversation' ? 'conversation' : 'global';
  const source = raw.source === 'attachment' ? 'attachment' : 'library';

  const pathValue = boundedString(raw.path, 'path', 500);
  if (!pathValue) {
    log.warn('anchor.resolve: missing path', { user_id: String(userId).slice(0, 8) });
    return { resolved: false, reason: 'bad_input' };
  }

  const chunkNum = Number(raw.chunkIdx);
  if (!Number.isFinite(chunkNum) || chunkNum < 0) {
    return { resolved: false, reason: 'bad_input' };
  }

  try {
    return await resolveAnchor({
      userId,
      source,
      scope,
      path: pathValue,
      chunkIdx: Math.floor(chunkNum),
      ...(typeof raw.quote === 'string' && raw.quote.trim() ? { quote: boundedString(raw.quote, 'quote', 2000)! } : {}),
      ...(typeof raw.cid === 'string' && raw.cid.trim() ? { cid: boundedString(raw.cid, 'cid', 200)! } : {}),
      ...(typeof raw.spaceId === 'string' && raw.spaceId.trim() ? { spaceId: boundedString(raw.spaceId, 'spaceId', 200)! } : {}),
    });
  } catch (err) {
    log.warn('anchor.resolve failed', {
      user_id: String(userId).slice(0, 8),
      error: (err as Error).message,
    });
    return { resolved: false, reason: 'no_text' };
  }
}
