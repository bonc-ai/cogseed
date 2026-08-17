/**
 * P3394 artifact parts — inline file transfer over UMF resource parts.
 *
 * Local files travel as data-URI resource parts with a sha256 content digest
 * (guide §6/§16: "Artifact 通过 URI 与 Digest 传递"). Both sides of the
 * bridge use this module; the standalone gateway keeps its own minimal
 * JS copy so the npm package stays dependency-free.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { isPathAllowed } from '../../util/path-sandbox';
import type { P3394PayloadPart } from './envelope';
import { P3394_OBJECT_LIMITS, p3394ObjectStoreGet, p3394ObjectStorePut, p3394ObjectUri } from './object-store';

export const P3394_ARTIFACT_LIMITS = {
  /** Max files attached per envelope. */
  maxFiles: 3,
  /** Max bytes per file (inline base64 in the envelope). */
  maxFileBytes: 2 * 1024 * 1024,
  /** Max bytes for inbound decoding (defense in depth). */
  maxDecodeBytes: 4 * 1024 * 1024,
} as const;

const DIGEST_PREFIX = 'sha256:';

export function sha256Hex(content: Buffer | string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

/** Normalize a digest: accepts both bare hex and the guide's sha256: form. */
export function normalizeDigest(digest: string): string | null {
  const raw = String(digest || '').trim().toLowerCase();
  const hex = raw.startsWith(DIGEST_PREFIX) ? raw.slice(DIGEST_PREFIX.length) : raw;
  return /^[a-f0-9]{64}$/.test(hex) ? hex : null;
}

function mimeFor(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const map: Record<string, string> = {
    '.txt': 'text/plain', '.md': 'text/markdown', '.json': 'application/json',
    '.pdf': 'application/pdf', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
    '.csv': 'text/csv', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.py': 'text/x-python', '.ts': 'text/x-typescript', '.js': 'text/javascript', '.html': 'text/html',
  };
  return map[ext] || 'application/octet-stream';
}

export interface P3394FileInput {
  path: string;
  /** Human-friendly name carried on the wire (defaults to basename). */
  name?: string;
}

/** Read local files (workspace-scoped) into resource parts. With
 *  useObjectStore (default true), files above maxInlineBytes are content-
 *  addressed instead of inlined: the part carries a p3394-object URI and the
 *  receiver fetches the object from the sender's resource endpoint (§12). */
export function filesToResourceParts(
  files: P3394FileInput[],
  allowedRoots: readonly string[],
  opts: { useObjectStore?: boolean } = {},
): { ok: true; parts: P3394PayloadPart[] } | { ok: false; error: string } {
  const useObjectStore = opts.useObjectStore !== false;
  const parts: P3394PayloadPart[] = [];
  for (const input of files.slice(0, P3394_ARTIFACT_LIMITS.maxFiles)) {
    const filePath = String(input.path || '');
    if (!filePath || !path.isAbsolute(filePath) || !isPathAllowed(filePath, allowedRoots)) {
      return { ok: false, error: 'file not in an allowed workspace: ' + filePath };
    }
    let stat: fs.Stats;
    try { stat = fs.statSync(filePath); } catch { return { ok: false, error: 'file not found: ' + filePath }; }
    if (!stat.isFile()) return { ok: false, error: 'not a regular file: ' + filePath };
    if (stat.size === 0) return { ok: false, error: 'empty file: ' + filePath };
    const maxBytes = useObjectStore ? P3394_OBJECT_LIMITS.maxObjectBytes : P3394_ARTIFACT_LIMITS.maxFileBytes;
    if (stat.size > maxBytes) {
      return { ok: false, error: 'file too large (' + stat.size + ' bytes): ' + filePath };
    }
    const content = fs.readFileSync(filePath);
    const mediaType = mimeFor(filePath);
    const digest = sha256Hex(content);
    const name = (input.name || path.basename(filePath)).slice(0, 200);
    if (useObjectStore && content.length > P3394_OBJECT_LIMITS.maxInlineBytes) {
      // Content-addressed reference: the object lives in the local store and
      // the receiver pulls it from our authenticated resource endpoint.
      const stored = p3394ObjectStorePut(content);
      if (stored.ok === false) return { ok: false, error: stored.error };
      parts.push({ type: 'resource', uri: p3394ObjectUri(digest), media_type: mediaType, name, digest });
    } else {
      parts.push({
        type: 'resource',
        uri: 'data:' + mediaType + ';base64,' + content.toString('base64'),
        media_type: mediaType,
        name,
        digest,
      });
    }
  }
  return { ok: true, parts };
}

export interface P3394DecodedFile {
  name: string;
  absPath: string;
  bytes: number;
  digest: string;
}

/** Decode inline resource/artifact parts into files under outDir, verifying
 *  digests when present. Sanitizes names (no path separators / traversal). */
export function resourcePartsToFiles(
  parts: readonly P3394PayloadPart[],
  outDir: string,
): { ok: true; files: P3394DecodedFile[] } | { ok: false; error: string } {
  fs.mkdirSync(outDir, { recursive: true });
  const files: P3394DecodedFile[] = [];
  let index = 0;
  for (const part of parts) {
    if (part.type !== 'resource' && part.type !== 'artifact') continue;
    if (typeof part.uri !== 'string' || !part.uri.startsWith('data:')) continue;
    const comma = part.uri.indexOf(',');
    if (comma < 0) return { ok: false, error: 'malformed data uri' };
    const meta = part.uri.slice(5, comma);
    const isB64 = /;base64$/i.test(meta);
    const payload = part.uri.slice(comma + 1);
    const content = isB64 ? Buffer.from(payload, 'base64') : Buffer.from(decodeURIComponent(payload), 'utf8');
    if (content.length === 0) continue;
    if (content.length > P3394_ARTIFACT_LIMITS.maxDecodeBytes) {
      return { ok: false, error: 'artifact too large (' + content.length + ' bytes)' };
    }
    if (part.digest) {
      const expected = normalizeDigest(part.digest);
      if (!expected) return { ok: false, error: 'invalid digest format' };
      if (sha256Hex(content) !== expected) return { ok: false, error: 'artifact digest mismatch' };
    }
    const declaredName = typeof part.name === 'string' && part.name.trim() ? part.name.trim() : '';
    const safeName = (declaredName || 'p3394-artifact-' + (index + 1)).replace(/[\\/]+/g, '_').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || 'p3394-artifact-' + (index + 1);
    const absPath = path.join(outDir, safeName);
    fs.writeFileSync(absPath, content);
    files.push({ name: safeName, absPath, bytes: content.length, digest: sha256Hex(content) });
    index += 1;
  }
  return { ok: true, files };
}

/** Fetches p3394-object resource parts (via an injected fetcher, e.g. the
 *  sender's resource endpoint) and writes them into outDir, verifying the
 *  digest. data-URI parts are skipped (callers use resourcePartsToFiles). */
export async function objectPartsToFiles(
  parts: readonly P3394PayloadPart[],
  outDir: string,
  fetchObject: (digest: string, part: P3394PayloadPart) => Promise<Buffer | null>,
): Promise<{ ok: true; files: P3394DecodedFile[] } | { ok: false; error: string }> {
  fs.mkdirSync(outDir, { recursive: true });
  const files: P3394DecodedFile[] = [];
  let index = 0;
  for (const part of parts) {
    if (part.type !== 'resource' && part.type !== 'artifact') continue;
    if (typeof part.uri !== 'string' || !part.uri.startsWith('p3394-object:')) continue;
    const digestRef = part.digest || part.uri;
    let content: Buffer | null = null;
    try {
      content = await fetchObject(digestRef, part);
    } catch {
      content = null;
    }
    if (!content) return { ok: false, error: 'object fetch failed for ' + (part.name || digestRef) };
    if (content.length === 0) continue;
    if (content.length > P3394_OBJECT_LIMITS.maxObjectBytes) {
      return { ok: false, error: 'artifact too large (' + content.length + ' bytes)' };
    }
    const digest = normalizeDigest(digestRef);
    if (!digest) return { ok: false, error: 'invalid digest format' };
    if (sha256Hex(content) !== digest) return { ok: false, error: 'artifact digest mismatch' };
    const declaredName = typeof part.name === 'string' && part.name.trim() ? part.name.trim() : '';
    const safeName = (declaredName || 'p3394-artifact-' + (index + 1)).replace(/[\\/]+/g, '_').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || 'p3394-artifact-' + (index + 1);
    const absPath = path.join(outDir, safeName);
    fs.writeFileSync(absPath, content);
    files.push({ name: safeName, absPath, bytes: content.length, digest });
    index += 1;
  }
  return { ok: true, files };
}

/** Build an inline resource part from a produced file (gateway reply side). */
export function fileToResourcePart(
  filePath: string,
  opts: { name?: string; maxBytes?: number } = {},
): { ok: true; part: P3394PayloadPart } | { ok: false; error: string } {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return { ok: false, error: 'not a file' };
    if (stat.size === 0) return { ok: false, error: 'empty file' };
    const maxBytes = opts.maxBytes ?? P3394_ARTIFACT_LIMITS.maxFileBytes;
    if (stat.size > maxBytes) return { ok: false, error: 'file too large' };
    const content = fs.readFileSync(filePath);
    const mediaType = mimeFor(filePath);
    return {
      ok: true,
      part: {
        type: 'resource',
        uri: 'data:' + mediaType + ';base64,' + content.toString('base64'),
        media_type: mediaType,
        name: (opts.name || path.basename(filePath)).slice(0, 200),
        digest: sha256Hex(content),
      },
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
