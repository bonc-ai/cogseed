import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

describe('P3394 EpochStore', () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'epoch-'));
    process.env.ORKAS_WORKSPACE_ROOT = root;
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    delete process.env.ORKAS_WORKSPACE_ROOT;
  });

  it('current 初始为 0', async () => {
    const { EpochStore } = await import('../../../../src/main/features/p3394/epoch-store');
    const store = new EpochStore();
    expect(await store.current('u1', 'gconv-abc')).toBe(0);
  });

  it('nextEpoch 单调递增并持久化', async () => {
    const { EpochStore } = await import('../../../../src/main/features/p3394/epoch-store');
    const store = new EpochStore();
    expect(await store.nextEpoch('u1', 'gconv-abc')).toBe(1);
    expect(await store.nextEpoch('u1', 'gconv-abc')).toBe(2);
    expect(await store.current('u1', 'gconv-abc')).toBe(2);
    const p = path.join(root, 'u1', 'local', 'kstar', 'p3394-epochs.json');
    const disk = JSON.parse(fs.readFileSync(p, 'utf8'));
    expect(disk['gconv-abc']).toBe(2);
  });

  it('不同 session 各自独立', async () => {
    const { EpochStore } = await import('../../../../src/main/features/p3394/epoch-store');
    const store = new EpochStore();
    await store.nextEpoch('u1', 'gconv-a');
    expect(await store.current('u1', 'gconv-b')).toBe(0);
  });

  it('并发 nextEpoch 不丢更新(mutex)', async () => {
    const { EpochStore } = await import('../../../../src/main/features/p3394/epoch-store');
    const store = new EpochStore();
    await Promise.all(Array.from({ length: 10 }, () => store.nextEpoch('u1', 'gconv-x')));
    expect(await store.current('u1', 'gconv-x')).toBe(10);
  });

  it('磁盘坏 JSON 不崩,current 返回 0', async () => {
    const dir = path.join(root, 'u1', 'local', 'kstar');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'p3394-epochs.json'), 'not json{{{', 'utf8');
    const { EpochStore } = await import('../../../../src/main/features/p3394/epoch-store');
    const store = new EpochStore();
    expect(await store.current('u1', 'gconv-abc')).toBe(0);
  });
});
