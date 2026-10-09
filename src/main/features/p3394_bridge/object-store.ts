/**
 * P3394 resource plane — content-addressed object store (SDK design §5/§6).
 *
 * Large/sensitive payloads are referenced, not inlined: artifacts live
 * under Agent Home objects/sha256/<hex>, addressed by
 * p3394-object:sha256:<digest> URIs, and every read re-verifies the
 * digest (immutability + integrity). The http-channel exposes an
 * authenticated resource endpoint for cross-node transfer (§12).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createLogger } from '../../logger';
import { variantRoot } from './runtime-paths';
import { normalizeDigest, sha256Hex } from './artifact-parts';

const log = createLogger('p3394-bridge:object-store');

export const P3394_OBJECT_LIMITS = {
  /** Max bytes accepted into the store. */
  maxObjectBytes: 32 * 1024 * 1024,
  /** Inline threshold: parts above this prefer object references. */
  maxInlineBytes: 64 * 1024,
} as const;

export function p3394ObjectsRoot(): string {
  return path.join(variantRoot(), 'objects', 'sha256');
}

export function p3394ObjectPath(digest: string): string {
  const hex = normalizeDigest(digest);
  if (!hex) throw new Error('p3394_object_invalid_digest');
  return path.join(p3394ObjectsRoot(), hex.slice(0, 2), hex.slice(2));
}

export function p3394ObjectUri(digest: string): string {
  const hex = normalizeDigest(digest);
  if (!hex) throw new Error('p3394_object_invalid_digest');
  return 'p3394-object:sha256:' + hex;
}

export type P3394ObjectStoreResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** Writes content into the store (idempotent); returns digest + URI. */
export function p3394ObjectStorePut(content: Buffer | string): P3394ObjectStoreResult<{ digest: string; uri: string; bytes: number }> {
  const buffer = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
  if (buffer.length === 0) return { ok: false, error: 'p3394_object_empty' };
  if (buffer.length > P3394_OBJECT_LIMITS.maxObjectBytes) {
    return { ok: false, error: 'p3394_object_too_large' };
  }
  const digest = sha256Hex(buffer);
  const file = p3394ObjectPath(digest);
  try {
    if (!fs.existsSync(file)) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = file + '.tmp-' + Date.now().toString(36);
      fs.writeFileSync(tmp, buffer);
      fs.renameSync(tmp, file);
    }
    return { ok: true, value: { digest, uri: p3394ObjectUri(digest), bytes: buffer.length } };
  } catch (error) {
    log.warn('P3394 object put failed', { error: error instanceof Error ? error.message : String(error) });
    return { ok: false, error: 'p3394_object_put_failed' };
  }
}

/** Reads and re-verifies an object by digest or p3394-object URI. */
export function p3394ObjectStoreGet(ref: string): P3394ObjectStoreResult<Buffer> {
  const hex = p3394ObjectDigestFromRef(ref);
  if (!hex) return { ok: false, error: 'p3394_object_invalid_ref' };
  try {
    const file = p3394ObjectPath(hex);
    if (!fs.existsSync(file)) return { ok: false, error: 'p3394_object_not_found' };
    const content = fs.readFileSync(file);
    if (sha256Hex(content) !== hex) return { ok: false, error: 'p3394_object_corrupt' };
    return { ok: true, value: content };
  } catch (error) {
    log.warn('P3394 object get failed', { error: error instanceof Error ? error.message : String(error) });
    return { ok: false, error: 'p3394_object_get_failed' };
  }
}

/** Returns the verified local file path for an object reference. */
export function p3394ObjectStoreResolve(ref: string): P3394ObjectStoreResult<string> {
  const hex = p3394ObjectDigestFromRef(ref);
  if (!hex) return { ok: false, error: 'p3394_object_invalid_ref' };
  const file = p3394ObjectPath(hex);
  if (!fs.existsSync(file)) return { ok: false, error: 'p3394_object_not_found' };
  return { ok: true, value: file };
}

/** Parses `p3394-object:sha256:<hex>` or a bare `sha256:<hex>` / hex digest. */
export function p3394ObjectDigestFromRef(ref: string): string | null {
  const raw = String(ref || '').trim();
  if (raw.startsWith('p3394-object:sha256:')) return normalizeDigest(raw.slice('p3394-object:sha256:'.length));
  if (raw.startsWith('sha256:')) return normalizeDigest(raw);
  return normalizeDigest(raw);
}
