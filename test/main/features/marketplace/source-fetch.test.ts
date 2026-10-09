import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../src/main/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  logFromRenderer: vi.fn(),
}));
vi.mock('../../../../src/main/features/api_base', () => ({
  requireCogSeedApiBase: () => 'https://hub.test',
}));
vi.mock('../../../../src/main/features/api_common', () => ({
  withCommonHeaders: (h: Record<string, string>) => h,
}));
vi.mock('../../../../src/main/features/config', () => ({ getLanguage: () => 'zh-CN' }));

const { fetchImmutableSource } = await import('../../../../src/main/features/marketplace/source-fetch');

let tmpDir: string;
let destPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-source-fetch-'));
  destPath = path.join(tmpDir, 'bundle.zip');
});

afterEach(() => {
  vi.unstubAllGlobals();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function sha256(b: Buffer): string {
  return crypto.createHash('sha256').update(b).digest('hex');
}

/** 合成字节响应。默认声明为不可变字节流。 */
function bytesResponse(body: Buffer, over: { contentType?: string; status?: number } = {}): Response {
  return new Response(body, {
    status: over.status ?? 200,
    headers: { 'Content-Type': over.contentType ?? 'application/octet-stream' },
  });
}

function reqFor(body: Buffer, over: Record<string, unknown> = {}) {
  return {
    contentId: 'a1b2c3d4e5f6',
    version: '1.2.0',
    artifact: { sha256: sha256(body), size_bytes: body.length },
    destPath,
    ...over,
  };
}

describe('marketplace/source-fetch', () => {
  it('请求体必含 content_id 与 version，且打的是 Hub 源站（FR-008 / FR-009）', async () => {
    const body = Buffer.from('synthetic-bytes');
    const fetchMock = vi.fn(async () => bytesResponse(body));
    vi.stubGlobal('fetch', fetchMock);

    await fetchImmutableSource(reqFor(body));

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://hub.test/marketplace/skills/bundle');
    expect(JSON.parse(String(init.body))).toEqual({ content_id: 'a1b2c3d4e5f6', version: '1.2.0' });
  });

  it('version 缺席即拒，不退化为「取最新」（FR-008）', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchImmutableSource(reqFor(Buffer.from('x'), { version: '' })))
      .rejects.toMatchObject({ code: 'CONTENT_NOT_FOUND' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('Content-Type 不是 application/octet-stream 时拒绝，且不落盘（FR-010）', async () => {
    const meta = Buffer.from(JSON.stringify({ bundle_url: 'https://cos.example/x.zip' }));
    vi.stubGlobal('fetch', vi.fn(async () => bytesResponse(meta, { contentType: 'application/json' })));

    await expect(fetchImmutableSource(reqFor(meta)))
      .rejects.toMatchObject({ code: 'UNEXPECTED_CONTENT_TYPE' });
    expect(fs.existsSync(destPath)).toBe(false);
  });

  it('带参数的 octet-stream 仍然接受（charset 之类不影响判定）', async () => {
    const body = Buffer.from('synthetic-bytes');
    vi.stubGlobal('fetch', vi.fn(async () => bytesResponse(body, { contentType: 'application/octet-stream; charset=binary' })));

    await expect(fetchImmutableSource(reqFor(body))).resolves.toMatchObject({ sizeBytes: body.length });
  });

  it('摘要不匹配时不返回字节、不留盘（FR-011）', async () => {
    const body = Buffer.from('synthetic-bytes');
    vi.stubGlobal('fetch', vi.fn(async () => bytesResponse(body)));

    await expect(fetchImmutableSource(reqFor(body, { artifact: { sha256: 'f'.repeat(64), size_bytes: body.length } })))
      .rejects.toMatchObject({ code: 'DIGEST_MISMATCH' });
    expect(fs.existsSync(destPath)).toBe(false);
  });

  it('大小不匹配时不返回字节、不留盘（FR-011）', async () => {
    const body = Buffer.from('synthetic-bytes');
    vi.stubGlobal('fetch', vi.fn(async () => bytesResponse(body)));

    await expect(fetchImmutableSource(reqFor(body, { artifact: { sha256: sha256(body), size_bytes: body.length + 1 } })))
      .rejects.toMatchObject({ code: 'SIZE_MISMATCH' });
    expect(fs.existsSync(destPath)).toBe(false);
  });

  it('下载中断时不留残片', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(Buffer.from('partial-')));
        controller.error(new Error('connection reset'));
      },
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(stream, {
      status: 200, headers: { 'Content-Type': 'application/octet-stream' },
    })));

    await expect(fetchImmutableSource(reqFor(Buffer.from('partial-complete'), { timeoutMs: 2_000 })))
      .rejects.toBeTruthy();
    expect(fs.existsSync(destPath)).toBe(false);
  });

  it('成功时返回临时区落点与实测摘要/大小', async () => {
    const body = Buffer.from('synthetic-bytes-for-success');
    vi.stubGlobal('fetch', vi.fn(async () => bytesResponse(body)));

    const out = await fetchImmutableSource(reqFor(body));

    expect(out).toEqual({ path: destPath, sha256: sha256(body), sizeBytes: body.length });
    expect(fs.readFileSync(destPath)).toEqual(body);
  });

  it('整包不得读入内存：字节在流未结束前就已到达磁盘（FR-012）', async () => {
    // 32 个 64 KiB 分片，总计 2 MiB。每次发片前记录临时文件的当前大小。
    const CHUNK = Buffer.alloc(64 * 1024, 0x5a);
    const CHUNKS = 32;
    const full = Buffer.concat(Array.from({ length: CHUNKS }, () => CHUNK));
    const observedSizes: number[] = [];

    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        observedSizes.push(fs.existsSync(destPath) ? fs.statSync(destPath).size : -1);
        if (sent >= CHUNKS) { controller.close(); return; }
        sent += 1;
        controller.enqueue(new Uint8Array(CHUNK));
      },
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(stream, {
      status: 200, headers: { 'Content-Type': 'application/octet-stream' },
    })));

    await fetchImmutableSource(reqFor(full));

    // 整包缓冲的实现下，流结束前磁盘上一直是 0 字节；流式实现则中途就在涨。
    const midStream = observedSizes.slice(0, -1);
    expect(midStream.some((size) => size > 0)).toBe(true);
    expect(Math.max(...midStream)).toBeLessThan(full.length);
    expect(fs.statSync(destPath).size).toBe(full.length);
  });
});
