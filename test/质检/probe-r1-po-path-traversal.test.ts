/**
 * 红队探针 r1：恶意组 id / templateId 路径穿越（personal-ontology.json
 * 参与云同步，另一设备的恶意或损坏文档可同步进来）。
 *
 * 推演链：normalizeGroup（po/model.ts:188/202）对 id / templateId 只要求
 * 非空字符串（sanitize 成单行、限长），**无字符集校验**（safeId 的
 * [A-Za-z0-9_-] 只在 IPC 参数侧用）。落盘后两个写路径直接拼路径：
 * - syncGroupRender（po/store.ts:106-117）：path.join(userOntologyGroupsDir,
 *   relPath.replace('.personal_ontology_groups/', '')) + writeTextAtomicSync；
 * - writePoGroupSnapshot（po/store.ts:263-275）：poHistoryDir(uid, groupId)
 *   = path.join(userCognitionDir, 'po-history', groupId) + mkdirSync +
 *   writeFileSync——对比同文件 appendPoAudit(:382) / listPoGroupHistory(:295)
 *   都有 safeId(groupId) 检查，唯独快照写路径没有。
 *
 * id 含 `../` 即可逃出各自沙箱写任意路径。本探针只写到 os.tmpdir() 下的
 * 预期越界位置并清理，不触碰真实数据。
 *
 * 2026-09-30 r1 收尾（记账员）：对应待议 P-r1-9（high，safeId 缺位致路径
 * 穿越；A normalizeGroup 施加 safeId / B 写入侧校验兜底 / C=A+B 纵深待拍板）
 * → it.skip。断言锁定的是「现状可逃逸」，拍板修复后反转为「逃逸路径不存在
 * 且正常路径不回归」。见 round-1-甄别.md toPending。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('../../src/main/features/kb_indexer', () => ({
  enqueue: () => {},
  kbEvents: { on: () => {}, off: () => {}, emit: () => {} },
}));
vi.mock('../../src/main/features/search', () => ({
  upsertContext: () => {},
  dropContext: () => {},
}));

let tmpDir: string;
let prevWs: string | undefined;
const UID = 'probe-r1-trav';
/** 逃出 WS_ROOT（tmpDir）落到 os.tmpdir() 根：渲染副本起点是
 * …/cloud/contexts/.personal_ontology_groups（5 级 `..` 到 tmpDir 之外）；
 * 快照起点是 …/cloud/cognition/po-history（4 级 `..` 即到 tmpDir，
 * 同一 id 串对两处都越界）。 */
const ESCAPE_NAME = `po-probe-r1-escape-${Date.now()}`;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-probe-r1-trav-'));
  prevWs = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  process.env.COGSEED_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
  // 清理越界产物（os.tmpdir() 下的探针文件）
  fs.rmSync(path.join(os.tmpdir(), `${ESCAPE_NAME}.md`), { force: true });
  fs.rmSync(path.join(os.tmpdir(), `${ESCAPE_NAME}.json`), { force: true });
});

function poDocFile(): string {
  return path.join(tmpDir, UID, 'cloud', 'cognition', 'personal-ontology.json');
}

async function loadStore() {
  return import('../../src/main/features/po/store');
}

describe('probe r1 › 恶意 id 路径穿越（待议 P-r1-9，拍板前 skip）', () => {
  it.skip('组 id 含 ../ 时，渲染副本与写前快照都写出各自沙箱与 WS_ROOT 之外', async () => {
    const maliciousId = `../../../../../${ESCAPE_NAME}`;
    // 直接落一个被篡改/恶意同步的文档（normalizeGroup 不拒绝该 id）
    fs.mkdirSync(path.dirname(poDocFile()), { recursive: true });
    fs.writeFileSync(poDocFile(), JSON.stringify({
      schemaVersion: 2,
      groups: [{
        id: maliciousId,
        title: '逃逸组',
        kind: 'user',
        fields: [{ id: 'f1', name: 'F', origin: 'user', createdAt: '2026-09-01T00:00:00Z' }],
        values: [{ id: 'v1', fieldId: 'f1', text: 'x', source: '手动', createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z' }],
        entries: [],
        createdAt: '2026-09-01T00:00:00Z',
        updatedAt: '2026-09-01T00:00:00Z',
      }],
      trash: [],
    }, null, 2), 'utf8');

    const store = await loadStore();
    // 常规成功写：touch 该组并改内容（走 editPoDoc → snapshotPoGroup + syncGroupRender）
    const result = await store.editPoDoc(UID, (ctx) => {
      const group = ctx.touch(maliciousId);
      if (!group) return ctx.fail('group not found');
      group.entries.push({ id: 'e1', text: 'probe', createdAt: '2026-09-30T00:00:00Z' });
      group.updatedAt = '2026-09-30T00:00:00Z';
    });
    expect(result.ok).toBe(true);

    // 越界断言 1：渲染副本写在 os.tmpdir() 根（WS_ROOT 之外）
    const escapedMd = path.join(os.tmpdir(), `${ESCAPE_NAME}.md`);
    expect(fs.existsSync(escapedMd)).toBe(true);
    const mdText = fs.readFileSync(escapedMd, 'utf8');
    // 普通组渲染副本只含字段区/流水区（无标题行），断言组正文确实写出
    expect(mdText).toContain('## 字段区');
    expect(mdText).toContain('probe');

    // 越界断言 2：写前快照目录同样越界（writePoGroupSnapshot 无 safeId 检查）
    // po-history 起 5 级 `..` → os.tmpdir()（WS_ROOT 之外，与 md 同级）
    const escapedSnapshotDir = path.join(os.tmpdir(), ESCAPE_NAME);
    const snapshotFiles = fs.existsSync(escapedSnapshotDir)
      ? fs.readdirSync(escapedSnapshotDir).filter((n) => n.endsWith('.json'))
      : [];
    expect(snapshotFiles.length).toBeGreaterThanOrEqual(1);
    // 快照内容含改前整组状态（含 values 正文）
    const snapText = fs.readFileSync(path.join(escapedSnapshotDir, snapshotFiles[0]), 'utf8');
    expect(snapText).toContain('逃逸组');
  });
});
