import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let tmpDir: string;
let prevWs: string | undefined;
const TEST_UID = 'u1';

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-wsmeta-'));
  prevWs = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  const meta = await import('../../../src/main/features/workspace_meta');
  meta._resetForTests();
});

afterEach(() => {
  process.env.COGSEED_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('workspace_meta › 持久化元数据表', () => {
  it('put/get/drop 单节条目', async () => {
    const meta = await import('../../../src/main/features/workspace_meta');
    await meta.putEntry(TEST_UID, 'artifacts', 'sp_1', 'stamp-a', [{ name: 'a.pdf' }]);
    const entry = await meta.getEntry<Array<{ name: string }>>(TEST_UID, 'artifacts', 'sp_1');
    expect(entry?.stamp).toBe('stamp-a');
    expect(entry?.data).toEqual([{ name: 'a.pdf' }]);
    await meta.dropEntry(TEST_UID, 'artifacts', 'sp_1');
    expect(await meta.getEntry(TEST_UID, 'artifacts', 'sp_1')).toBeNull();
  });

  it('flush 落盘后重启（内存表清空）仍可读到', async () => {
    const meta = await import('../../../src/main/features/workspace_meta');
    await meta.putEntry(TEST_UID, 'spaces', 'sp_1', 's1', { name: '空间一' });
    await meta.flush(TEST_UID);

    // 模拟进程重启：清内存表再读（load 按 mtime 重新加载）
    meta._resetForTests();
    const entry = await meta.getEntry<{ name: string }>(TEST_UID, 'spaces', 'sp_1');
    expect(entry?.data).toEqual({ name: '空间一' });
  });

  it('损坏的 meta.json 容错为空表', async () => {
    const pathsMod = await import('../../../src/main/paths');
    const file = pathsMod.workspaceMetaSectionFile(TEST_UID, 'spaces');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{not json');

    const meta = await import('../../../src/main/features/workspace_meta');
    const entry = await meta.getEntry(TEST_UID, 'spaces', 'sp_1');
    expect(entry).toBeNull();
    // 修复：写入后应能正常落盘
    await meta.putEntry(TEST_UID, 'spaces', 'sp_1', 's1', { name: 'ok' });
    await meta.flush(TEST_UID);
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(raw.entries.sp_1.data).toEqual({ name: 'ok' });
  });

  it('dropSection 清空整个分区', async () => {
    const meta = await import('../../../src/main/features/workspace_meta');
    await meta.putEntry(TEST_UID, 'conversations', 'sp_1', 'a', [1]);
    await meta.putEntry(TEST_UID, 'conversations', 'sp_2', 'b', [2]);
    await meta.dropSection(TEST_UID, 'conversations');
    expect(await meta.getEntry(TEST_UID, 'conversations', 'sp_1')).toBeNull();
    expect(await meta.getEntry(TEST_UID, 'conversations', 'sp_2')).toBeNull();
  });
});
