import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * `migrate-connectors-to-cloud` 此前零测试（2026-10-08 迁移审计 P1）。
 *
 * 可达性说明：开源构建里 `_oauthUserId()` 恒为 null，因此**写入路径不可达**——
 * 本套件覆盖的是真正会跑到的分支，并把"未登录就推迟、且**不打标**（下次启动重试）"
 * 这条关键语义锁死。畸形载荷（legacy 整文件加密）与原子写在有账号的构建里才可达，
 * 已由代码注释与 `writeFileSync(tmp) + renameSync` 保证，本套件不假装覆盖它们。
 */

let tmpDir: string;
let prevWs: string | undefined;

const UID = 'u1';
const STAMP = '.migrate-connectors-to-cloud.done';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-connectors-cloud-'));
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
  const m = await import('../../../src/main/util/migrate-connectors-to-cloud');
  return { p, ...m };
}

const write = (file: string, text: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, 'utf8');
};

describe('migrateConnectorsToCloud', () => {
  it('rejects an invalid uid without touching the disk', async () => {
    const { p, migrateConnectorsToCloud } = await load();
    expect(migrateConnectorsToCloud('')).toBe(false);
    expect(migrateConnectorsToCloud('../evil')).toBe(false);
    expect(fs.existsSync(path.join(p.userCloudConfigDir(UID), STAMP))).toBe(false);
  });

  it('short-circuits on the completion stamp', async () => {
    const { p, migrateConnectorsToCloud } = await load();
    const cloudDir = p.userCloudConfigDir(UID);
    write(path.join(cloudDir, STAMP), '');
    write(path.join(p.userLocalConfigDir(UID), 'connectors.json'), '{"connectors":[]}');

    expect(migrateConnectorsToCloud(UID)).toBe(false);
    // 本地文件仍在（迁移被标记挡下，不做任何搬动）
    expect(fs.existsSync(path.join(p.userLocalConfigDir(UID), 'connectors.json'))).toBe(true);
  });

  it('drops the stamp when the cloud file already exists', async () => {
    const { p, migrateConnectorsToCloud } = await load();
    const cloudDir = p.userCloudConfigDir(UID);
    write(path.join(cloudDir, 'connectors.json'), '{"connectors":[{"id":"c1"}]}');
    write(path.join(p.userLocalConfigDir(UID), 'connectors.json'), '{"connectors":[]}');

    expect(migrateConnectorsToCloud(UID)).toBe(false);

    // 云端既有文件不被覆盖，本地旧文件不被删除（留给用户重新连接）
    expect(JSON.parse(fs.readFileSync(path.join(cloudDir, 'connectors.json'), 'utf8')).connectors).toHaveLength(1);
    expect(fs.existsSync(path.join(p.userLocalConfigDir(UID), 'connectors.json'))).toBe(true);
    expect(fs.existsSync(path.join(cloudDir, STAMP))).toBe(true);
  });

  it('stamps when there is nothing to migrate', async () => {
    const { p, migrateConnectorsToCloud } = await load();
    expect(migrateConnectorsToCloud(UID)).toBe(false);
    expect(fs.existsSync(path.join(p.userCloudConfigDir(UID), STAMP))).toBe(true);
  });

  it('defers without stamping while no account is bound, so the next launch retries', async () => {
    const { p, migrateConnectorsToCloud } = await load();
    const localFile = path.join(p.userLocalConfigDir(UID), 'connectors.json');
    write(localFile, '{"connectors":[{"id":"legacy"}]}');

    expect(migrateConnectorsToCloud(UID)).toBe(false);

    // 关键语义：没登录 → 推迟，且**不能**打标（否则登录后就再也不会迁移）
    expect(fs.existsSync(path.join(p.userCloudConfigDir(UID), STAMP))).toBe(false);
    expect(fs.existsSync(path.join(p.userCloudConfigDir(UID), 'connectors.json'))).toBe(false);
    expect(fs.readFileSync(localFile, 'utf8')).toBe('{"connectors":[{"id":"legacy"}]}');
  });
});
