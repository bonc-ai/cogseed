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

  it('sender-scoped stream key is collision-safe', async () => {
    const { p3394EpochStreamKey } = await import('../../../../src/main/features/p3394/epoch-store');
    expect(p3394EpochStreamKey('a:b', 'c')).not.toBe(p3394EpochStreamKey('a', 'b:c'));
    expect(JSON.parse(p3394EpochStreamKey('agent-a', 'gmember-c1-a1'))).toEqual([
      'agent-a',
      'gmember-c1-a1',
    ]);
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

  it('admit 无 incoming → 水位 +1', async () => {
    const { EpochStore } = await import('../../../../src/main/features/p3394/epoch-store');
    const store = new EpochStore();
    expect(await store.admit('u1', 'gconv-a')).toEqual({ replay: false, epoch: 1 });
    expect(await store.admit('u1', 'gconv-a')).toEqual({ replay: false, epoch: 2 });
    expect(await store.current('u1', 'gconv-a')).toBe(2);
  });

  it('admit incoming > 水位 → 跳到 incoming(取 max,非 +1)', async () => {
    const { EpochStore } = await import('../../../../src/main/features/p3394/epoch-store');
    const store = new EpochStore();
    // 从 0 收到 incoming=5,水位应直接跳到 5,而非 +1 只到 1(否则同条 5 重放仍绕过)。
    expect(await store.admit('u1', 'gconv-a', 5)).toEqual({ replay: false, epoch: 5 });
    expect(await store.current('u1', 'gconv-a')).toBe(5);
    const p = path.join(root, 'u1', 'local', 'kstar', 'p3394-epochs.json');
    expect(JSON.parse(fs.readFileSync(p, 'utf8'))['gconv-a']).toBe(5);
  });

  it('admit incoming <= 水位 → replay:true 且水位不变/不落盘', async () => {
    const { EpochStore } = await import('../../../../src/main/features/p3394/epoch-store');
    const store = new EpochStore();
    await store.admit('u1', 'gconv-a', 5);
    expect(await store.admit('u1', 'gconv-a', 5)).toEqual({ replay: true, epoch: 5 });
    expect(await store.admit('u1', 'gconv-a', 3)).toEqual({ replay: true, epoch: 5 });
    expect(await store.current('u1', 'gconv-a')).toBe(5);
  });

  it('admit incoming=NaN/Infinity/非整 → 按 +1 处理,不视为重放', async () => {
    const { EpochStore } = await import('../../../../src/main/features/p3394/epoch-store');
    const store = new EpochStore();
    expect(await store.admit('u1', 'gconv-a', NaN)).toEqual({ replay: false, epoch: 1 });
    expect(await store.admit('u1', 'gconv-a', Infinity)).toEqual({ replay: false, epoch: 2 });
    expect(await store.admit('u1', 'gconv-a', 1.5)).toEqual({ replay: false, epoch: 3 });
    expect(await store.current('u1', 'gconv-a')).toBe(3);
  });

  it('并发 admit 同 session 不丢更新(mutex)', async () => {
    const { EpochStore } = await import('../../../../src/main/features/p3394/epoch-store');
    const store = new EpochStore();
    await Promise.all(Array.from({ length: 10 }, () => store.admit('u1', 'gconv-x')));
    expect(await store.current('u1', 'gconv-x')).toBe(10);
  });
});
