import * as http from 'node:http';
import { describe, expect, it } from 'vitest';
import { P3394HttpChannel } from '../../../../src/main/features/p3394_bridge/http-channel';
import { p3394ObjectStoreGet, p3394ObjectStorePut, p3394ObjectUri, p3394ObjectDigestFromRef } from '../../../../src/main/features/p3394_bridge/object-store';
import { filesToResourceParts, objectPartsToFiles } from '../../../../src/main/features/p3394_bridge/artifact-parts';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

describe('P3394 content-addressed object store (§5/§6/§12)', () => {
  it('puts, addresses and re-verifies content by digest', () => {
    const put = p3394ObjectStorePut('hello p3394 objects');
    expect(put.ok).toBe(true);
    if (!put.ok) throw new Error(put.error);
    expect(put.value.uri).toBe('p3394-object:sha256:' + put.value.digest);
    const got = p3394ObjectStoreGet(put.value.uri);
    expect(got.ok).toBe(true);
    if (got.ok) expect(got.value.toString('utf8')).toBe('hello p3394 objects');
    const again = p3394ObjectStorePut('hello p3394 objects');
    expect(again.ok && again.value.digest).toBe(put.value.digest);
    expect(p3394ObjectDigestFromRef('sha256:' + put.value.digest)).toBe(put.value.digest);
    expect(p3394ObjectDigestFromRef(put.value.digest)).toBe(put.value.digest);
    expect(p3394ObjectDigestFromRef('not-a-ref')).toBeNull();
    expect(p3394ObjectStoreGet('p3394-object:sha256:' + '0'.repeat(64)).ok).toBe(false);
  });

  it('references large files by object URI instead of inlining', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p3394-objtest-'));
    const file = path.join(dir, 'big.bin');
    fs.writeFileSync(file, Buffer.alloc(70 * 1024, 7)); // > 64KB inline threshold
    const built = filesToResourceParts([{ path: file }], [dir]);
    expect(built.ok).toBe(true);
    if (!built.ok) throw new Error(built.error);
    const isObjectUri = built.parts[0].uri.startsWith('p3394-object:sha256:');
    expect(isObjectUri).toBe(true);
    expect(built.parts[0].digest).toMatch(/^[a-f0-9]{64}$/);
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p3394-objout-'));
    let fetched = false;
    const resolved = await objectPartsToFiles(built.parts, outDir, async (digest) => {
      fetched = true;
      const r = p3394ObjectStoreGet(digest);
      return r.ok ? r.value : null;
    });
    expect(fetched).toBe(true);
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.files).toHaveLength(1);
      expect(fs.statSync(resolved.files[0].absPath).size).toBe(70 * 1024);
    }
  });

  it('serves objects over the authenticated resource endpoint', async () => {
    const put = p3394ObjectStorePut('endpoint payload');
    if (!put.ok) throw new Error(put.error);
    const channel = new P3394HttpChannel('obj-http', { listen: { host: '127.0.0.1', port: 0 }, authToken: 'res-token' });
    await channel.listen();
    const server = (channel as unknown as { server: http.Server }).server;
    const port = (server.address() as { port: number }).port;
    try {
      const unauth = await httpGet('http://127.0.0.1:' + port + '/p3394/objects/' + put.value.digest, '');
      expect(unauth.status).toBe(401);
      const ok = await httpGet('http://127.0.0.1:' + port + '/p3394/objects/' + put.value.digest, 'Bearer res-token');
      expect(ok.status).toBe(200);
      expect(ok.body.toString('utf8')).toBe('endpoint payload');
      const missing = await httpGet('http://127.0.0.1:' + port + '/p3394/objects/' + 'a'.repeat(64), 'Bearer res-token');
      expect(missing.status).toBe(404);
    } finally {
      await channel.close();
    }
  });
});

function httpGet(url: string, auth: string): Promise<{ status: number; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: 'GET', ...(auth ? { headers: { Authorization: auth } } : {}) }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}
