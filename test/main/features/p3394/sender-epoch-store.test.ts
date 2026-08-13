import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

describe('P3394 SenderEpochStore', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'sender-epoch-'));
    process.env.ORKAS_WORKSPACE_ROOT = root;
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    delete process.env.ORKAS_WORKSPACE_ROOT;
  });

  it('starts at one, increments, and persists', async () => {
    const { SenderEpochStore, p3394SenderEpochStreamKey } = await import(
      '../../../../src/main/features/p3394/sender-epoch-store'
    );
    const store = new SenderEpochStore();

    expect(await store.next('u1', 'commander', 'gmember-c1-a1')).toBe(1);
    expect(await store.next('u1', 'commander', 'gmember-c1-a1')).toBe(2);

    const file = path.join(root, 'u1', 'local', 'kstar', 'p3394-sender-epochs.json');
    const disk = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(disk[p3394SenderEpochStreamKey('commander', 'gmember-c1-a1')]).toBe(2);
  });

  it('isolates sender and recipient session streams', async () => {
    const { SenderEpochStore } = await import('../../../../src/main/features/p3394/sender-epoch-store');
    const store = new SenderEpochStore();

    expect(await store.next('u1', 'commander', 'gmember-c1-a1')).toBe(1);
    expect(await store.next('u1', 'user', 'gmember-c1-a1')).toBe(1);
    expect(await store.next('u1', 'commander', 'gmember-c1-a2')).toBe(1);
  });

  it('serializes concurrent increments without losing updates', async () => {
    const { SenderEpochStore } = await import('../../../../src/main/features/p3394/sender-epoch-store');
    const store = new SenderEpochStore();

    const values = await Promise.all(
      Array.from({ length: 10 }, () => store.next('u1', 'commander', 'gmember-c1-a1')),
    );
    expect([...values].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it('treats malformed JSON as an empty store', async () => {
    const dir = path.join(root, 'u1', 'local', 'kstar');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'p3394-sender-epochs.json'), '{bad json', 'utf8');
    const { SenderEpochStore } = await import('../../../../src/main/features/p3394/sender-epoch-store');

    expect(await new SenderEpochStore().next('u1', 'commander', 'gmember-c1-a1')).toBe(1);
  });

  it('propagates non-ENOENT read failures', async () => {
    const file = path.join(root, 'u1', 'local', 'kstar', 'p3394-sender-epochs.json');
    fs.mkdirSync(file, { recursive: true });
    const { SenderEpochStore } = await import('../../../../src/main/features/p3394/sender-epoch-store');

    await expect(new SenderEpochStore().next('u1', 'commander', 'gmember-c1-a1')).rejects.toMatchObject({
      code: expect.stringMatching(/EISDIR|EACCES|EPERM/),
    });
  });
});
