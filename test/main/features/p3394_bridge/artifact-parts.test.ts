import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  filesToResourceParts,
  fileToResourcePart,
  normalizeDigest,
  resourcePartsToFiles,
  sha256Hex,
} from '../../../../src/main/features/p3394_bridge/artifact-parts';

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'p3394-artifact-test-'));

describe('p3394 artifact parts', () => {
  it('normalizes bare-hex and sha256:-prefixed digests', () => {
    const hex = 'a'.repeat(64);
    expect(normalizeDigest(hex)).toBe(hex);
    expect(normalizeDigest('sha256:' + hex)).toBe(hex);
    expect(normalizeDigest('SHA256:' + hex)).toBe(hex);
    expect(normalizeDigest('nope')).toBeNull();
  });

  it('round-trips local files into resource parts and back with digest verification', () => {
    const file = path.join(WORK, 'note.txt');
    fs.writeFileSync(file, 'hello artifact');
    const built = filesToResourceParts([{ path: file }], [WORK]);
    expect(built.ok).toBe(true);
    if (built.ok) {
      const part = built.parts[0];
      expect(part.type).toBe('resource');
      expect(part.uri).toContain('data:text/plain;base64,');
      expect(part.digest).toBe(sha256Hex('hello artifact'));
      expect(part.name).toBe('note.txt');

      const outDir = path.join(WORK, 'out');
      const decoded = resourcePartsToFiles(built.parts, outDir);
      expect(decoded.ok).toBe(true);
      if (decoded.ok) {
        expect(fs.readFileSync(decoded.files[0].absPath, 'utf8')).toBe('hello artifact');
        expect(decoded.files[0].name).toBe('note.txt');
      }
    }
  });

  it('rejects files outside the allowed roots (path sandbox)', () => {
    const outside = path.join(os.tmpdir(), 'outside-note.txt');
    fs.writeFileSync(outside, 'x');
    const built = filesToResourceParts([{ path: outside }], [WORK]);
    expect(built).toMatchObject({ ok: false });
    expect((built as { error: string }).error).toContain('not in an allowed workspace');
  });

  it('references files above the inline threshold by object URI, rejects only beyond the object store limit', () => {
    const big = path.join(WORK, 'big.bin');
    fs.writeFileSync(big, Buffer.alloc(2 * 1024 * 1024 + 1));
    const built = filesToResourceParts([{ path: big }], [WORK]);
    expect(built.ok).toBe(true);
    if (built.ok) {
      expect(built.parts[0].uri.startsWith('p3394-object:sha256:')).toBe(true);
      expect(built.parts[0].digest).toMatch(/^[a-f0-9]{64}$/);
    }
    // beyond the 32MB object-store cap → still rejected
    const huge = path.join(WORK, 'huge.bin');
    fs.writeFileSync(huge, Buffer.alloc(32 * 1024 * 1024 + 1));
    const builtHuge = filesToResourceParts([{ path: huge }], [WORK]);
    expect(builtHuge).toMatchObject({ ok: false });
  });

  it('rejects decoded artifacts whose digest does not match', () => {
    const parts = [{
      type: 'resource',
      uri: 'data:text/plain;base64,' + Buffer.from('tampered').toString('base64'),
      media_type: 'text/plain',
      name: 'x.txt',
      digest: sha256Hex('original'),
    }] as never;
    const decoded = resourcePartsToFiles(parts, path.join(WORK, 'out2'));
    expect(decoded).toMatchObject({ ok: false, error: 'artifact digest mismatch' });
  });

  it('sanitizes hostile artifact names (path traversal)', () => {
    const content = Buffer.from('ok');
    const parts = [{
      type: 'resource',
      uri: 'data:text/plain;base64,' + content.toString('base64'),
      media_type: 'text/plain',
      name: '../../etc/passwd',
      digest: sha256Hex(content),
    }] as never;
    const decoded = resourcePartsToFiles(parts, path.join(WORK, 'out3'));
    expect(decoded.ok).toBe(true);
    if (decoded.ok) {
      expect(decoded.files[0].name).not.toContain('/');
      expect(path.dirname(decoded.files[0].absPath)).toBe(path.join(WORK, 'out3'));
    }
  });

  it('builds a resource part from a produced file', () => {
    const produced = path.join(WORK, 'produced.md');
    fs.writeFileSync(produced, '# done');
    const built = fileToResourcePart(produced);
    expect(built.ok).toBe(true);
    if (built.ok) {
      expect(built.part.media_type).toBe('text/markdown');
      expect(built.part.digest).toBe(sha256Hex('# done'));
    }
  });
});
