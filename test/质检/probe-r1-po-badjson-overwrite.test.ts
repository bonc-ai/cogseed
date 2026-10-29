/**
 * 本体 JSON 损坏时的写入拒绝与原始字节保留边界（corrupt-guard）：
 * 坏档 → copy 备份 + 登记 + 拒写 latch；下一次写被拒，盘上坏字节不被
 * 「空文档+新增」静默替换。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('../../src/main/features/kb_indexer', () => ({
  enqueue: () => {},
  kbEvents: { on: () => {}, emit: () => {}, off: () => {} },
}));
vi.mock('../../src/main/features/search', () => ({
  upsertContext: () => {},
  dropContext: () => {},
}));

let tmpDir: string;
let prevWs: string | undefined;
const UID = 'probe-r1-user';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-probe-r1-'));
  prevWs = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  process.env.COGSEED_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function poDocFile(): string {
  return path.join(tmpDir, UID, 'cloud', 'cognition', 'personal-ontology.json');
}

async function loadGroups() {
  return import('../../src/main/features/personal_ontology_groups');
}

describe('坏 JSON 覆盖防护', () => {
  it('磁盘 JSON 损坏后：写被拒、坏档备份在场、原字节不被覆盖', async () => {
    // 1) seed：一个带字段值的真实组
    const groups = await loadGroups();
    const created = await groups.createGroup(UID, '珍藏组');
    expect(created.ok).toBe(true);
    const gid = created.group!.group_id;
    await groups.appendFieldValue(UID, gid, '重要事实', '不可丢的数据', '手动');
    expect(fs.readFileSync(poDocFile(), 'utf8')).toContain('不可丢的数据');

    // 2) 破坏：模拟云同步冲突 / 截断写（半截 JSON）
    const corruptBytes = '{"schemaVersion":2,"groups":[{"id":"g1","ti';
    fs.writeFileSync(poDocFile(), corruptBytes);

    // 3) 触发：一次最常见的写（新建组）——被坏档写侧门拒绝
    const second = await groups.createGroup(UID, '后来组');
    expect(second.ok).toBe(false);
    expect(String(second.error)).toContain('corrupt');

    // 4) 断言：盘上仍是坏档原字节（未被空文档+新组替换），可循备份抢救
    expect(fs.readFileSync(poDocFile(), 'utf8')).toBe(corruptBytes);

    // 5) 断言：坏档已有 copy 备份（原字节，非 move）
    const backups = fs.readdirSync(path.dirname(poDocFile()))
      .filter((n) => n.startsWith('personal-ontology.json.corrupt-'));
    expect(backups.length).toBe(1);
    expect(fs.readFileSync(path.join(path.dirname(poDocFile()), backups[0]), 'utf8')).toBe(corruptBytes);
  });
});
