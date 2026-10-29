import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * `migrate-kb-to-local` 把向量库（`<uid>/cloud/contexts/.kb/`，会被多设备同步）
 * 搬到机器私有的 `<uid>/local/contexts/.kb/`。此前零测试（2026-10-08 迁移审计 P1）。
 * 这里锁住文件头写明的全部边界：
 *   - 只有旧路径 → 搬走并打标
 *   - 只有新路径 → 无事可做，但仍打标（迁移后基线）
 *   - 新旧都在 → **保留新、旧的重命名旁置**（绝不自动删用户数据，也不把派生 KB 留在云同步树里）
 *   - 旧路径是文件（损坏状态）→ 不动，仍打标
 *   - 已打标 → 幂等，不做任何改动
 *   - 老构建留在云侧的 `.kb.legacy-*` 备份 → 第二个一次性迁移搬到本地
 */

let tmpDir: string;
let prevWs: string | undefined;

const UID = 'u1';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-kb-to-local-'));
  prevWs = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  process.env.COGSEED_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function load() {
  const p = await import('../../../src/main/paths');
  const m = await import('../../../src/main/util/migrate-kb-to-local');
  return { p, ...m };
}

const stampFile = (p: any) => path.join(path.dirname(p.userLocalConfigDir(UID)), '.migrations');
const readStamp = (p: any) => (fs.existsSync(stampFile(p)) ? fs.readFileSync(stampFile(p), 'utf8') : '');
const write = (file: string, text: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, 'utf8');
};

describe('migrateKbToLocalContexts', () => {
  it('moves the legacy cloud .kb into machine-local contexts and stamps', async () => {
    const { p, migrateKbToLocalContexts } = await load();
    const legacyKb = path.join(p.userContextsDir(UID), '.kb');
    write(path.join(legacyKb, 'vectors', 'index.bin'), 'index');
    write(path.join(legacyKb, 'meta.json'), '{"v":1}');

    migrateKbToLocalContexts(UID);

    expect(fs.existsSync(legacyKb)).toBe(false); // 不再留在云同步树里
    expect(fs.readFileSync(path.join(p.userKbDir(UID), 'vectors', 'index.bin'), 'utf8')).toBe('index');
    expect(fs.readFileSync(path.join(p.userKbDir(UID), 'meta.json'), 'utf8')).toBe('{"v":1}');
    expect(readStamp(p)).toContain('kb-to-local-contexts-v1');
  });

  it('is a no-op when only the new path exists, but still stamps the baseline', async () => {
    const { p, migrateKbToLocalContexts } = await load();
    write(path.join(p.userKbDir(UID), 'meta.json'), '{"v":2}');

    migrateKbToLocalContexts(UID);

    expect(fs.readFileSync(path.join(p.userKbDir(UID), 'meta.json'), 'utf8')).toBe('{"v":2}');
    expect(readStamp(p)).toContain('kb-to-local-contexts-v1');
  });

  it('keeps the new store and sidelines the legacy one instead of deleting data', async () => {
    const { p, migrateKbToLocalContexts } = await load();
    const legacyKb = path.join(p.userContextsDir(UID), '.kb');
    write(path.join(legacyKb, 'old.txt'), 'legacy store');
    write(path.join(p.userKbDir(UID), 'new.txt'), 'current store');

    migrateKbToLocalContexts(UID);

    // 新的原样保留
    expect(fs.readFileSync(path.join(p.userKbDir(UID), 'new.txt'), 'utf8')).toBe('current store');
    // 旧的被旁置（不删），且不再待在云同步树里
    expect(fs.existsSync(legacyKb)).toBe(false);
    const localContexts = p.userLocalContextsDir(UID);
    const sidelined = fs.readdirSync(localContexts).filter((n) => n.startsWith('.kb.legacy-'));
    expect(sidelined).toHaveLength(1);
    expect(fs.readFileSync(path.join(localContexts, sidelined[0], 'old.txt'), 'utf8')).toBe('legacy store');
  });

  it('leaves a corrupt legacy path that is a file untouched and stamps anyway', async () => {
    const { p, migrateKbToLocalContexts } = await load();
    const legacyKb = path.join(p.userContextsDir(UID), '.kb');
    write(legacyKb, 'not a directory');

    migrateKbToLocalContexts(UID);

    expect(fs.readFileSync(legacyKb, 'utf8')).toBe('not a directory');
    expect(readStamp(p)).toContain('kb-to-local-contexts-v1');
  });

  it('is idempotent once stamped', async () => {
    const { p, migrateKbToLocalContexts } = await load();
    const legacyKb = path.join(p.userContextsDir(UID), '.kb');
    write(path.join(legacyKb, 'a.txt'), 'first');
    migrateKbToLocalContexts(UID);
    const before = fs.readFileSync(path.join(p.userKbDir(UID), 'a.txt'), 'utf8');
    const stampBefore = readStamp(p);

    // 第二次：即使云侧又冒出一个 .kb，也不动（标记优先）
    write(path.join(legacyKb, 'b.txt'), 'late');
    migrateKbToLocalContexts(UID);

    expect(fs.readFileSync(path.join(p.userKbDir(UID), 'a.txt'), 'utf8')).toBe(before);
    expect(fs.existsSync(path.join(p.userKbDir(UID), 'b.txt'))).toBe(false);
    expect(readStamp(p)).toBe(stampBefore);
  });

  it('moves older-build cloud-side .kb.legacy-* backups into local contexts', async () => {
    const { p, migrateKbToLocalContexts } = await load();
    const backup = path.join(p.userContextsDir(UID), '.kb.legacy-2026-08-01');
    write(path.join(backup, 'old.txt'), 'backup payload');

    migrateKbToLocalContexts(UID);

    expect(fs.existsSync(backup)).toBe(false);
    expect(fs.readFileSync(path.join(p.userLocalContextsDir(UID), '.kb.legacy-2026-08-01', 'old.txt'), 'utf8'))
      .toBe('backup payload');
    expect(readStamp(p)).toContain('kb-legacy-backups-to-local-v1');
  });
});
