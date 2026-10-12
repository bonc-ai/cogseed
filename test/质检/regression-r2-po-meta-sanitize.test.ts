/**
 * 探针 r2（边界测试员 · 并发与时序 + 修复复查）：
 *
 * A. 复查 r1 后落盘的两处修复（工作区未提交 diff）：
 *    1) po/model.ts sanitizePoText 代理对截断自愈——验证修复生效 + 边界（空串/存量脏数据）；
 *    2) po/api.ts poAddValueToFieldByName 导入通道 meta 校验——验证非法 asOf/ruleKind/verified
 *       被剥离、合法保留。
 * B. 新发现验证：同一批校验在兄弟通道漏修——
 *    3) poAddValue 的 draft.ruleKind 零枚举校验（poUpdateValue 有）；
 *    4) poUpdateValue 的 patch.verified 零取值校验（导入通道刚修了同类）。
 *    两者都是「写成功落非法值、读侧 normalize 静默剥掉」的写读不对称。
 *    （2026-09-30 r2 修复 F-r2-1/F-r2-2 后已堵，B 组两用例反转为回归。）
 *
 * 2026-09-30 r2 收尾（记账员）：由 probe- 改名 regression-，收编为 r1/r2
 * 已修项的回归测试（A 组复查 F-r1-1/F-r1-2、B 组回归 F-r2-1/F-r2-2）。
 * 唯一例外：A 组第 3 用例（存量脏数据）的后半断言锁定「中间孤立代理
 * 不自愈」现状，对应待议 P-r2-2 → it.skip，拍板后随结论启用或拆分。
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
const UID = 'probe-r2-meta';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-probe-r2a-'));
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

async function loadApi() {
  return import('../../src/main/features/po/api');
}

const LONE_SURROGATE = /(?:[\uD800-\uDBFF](?![\uDC00-\uDFFF]))|((?:[^\uD800-\uDBFF])|^)[\uDC00-\uDFFF]/;

describe('regression r2 › 修复复查：sanitizePoText 代理对', () => {
  it('截断不再劈开代理对：末尾无孤立高代理（r1 F5 修复生效）', async () => {
    const { sanitizePoText } = await import('../../src/main/features/po/model');
    const out = sanitizePoText('x'.repeat(1997) + '😀'.repeat(10));
    expect(out.length).toBeLessThanOrEqual(2000);
    expect(LONE_SURROGATE.test(out)).toBe(false);
  });

  it('边界：空串与恰好截在高代理处不炸（NaN 比较为 false）', async () => {
    const { sanitizePoText } = await import('../../src/main/features/po/model');
    expect(sanitizePoText('')).toBe('');
    expect(sanitizePoText('a😀', 2)).toBe('a'); // 截断点在高代理 → 砍 1 码元
    expect(sanitizePoText('😀', 1)).toBe(''); // 全是高代理开头 → 空串
  });

  // 待议 P-r2-2：本用例后半断言「中间孤立代理不在自愈范围」锁定的正是待议
  // 现状（A 只修注释 / B 扩大自愈 toWellFormed / C 对齐副本，拍板前不固化）。
  // 前半「末尾孤立代理读自愈」断言为 F-r1-2 行为，拍板后随结论一并启用或拆分。
  it.skip('存量脏数据（末尾孤立代理）load 自愈；中间孤立代理不在自愈范围（修复注释口径）', async () => {
    // 末尾孤立代理：读路径 normalize → sanitize 砍掉
    const api = await loadApi();
    fs.mkdirSync(path.dirname(poDocFile()), { recursive: true });
    fs.writeFileSync(poDocFile(), JSON.stringify({
      schemaVersion: 2,
      groups: [{
        id: 'g-dirty', title: '脏档', kind: 'user', createdAt: '2026-09-01', updatedAt: '2026-09-01',
        fields: [{ id: 'f1', name: 'F', origin: 'user', createdAt: '2026-09-01' }],
        values: [
          // v1：孤立高代理在**末尾**（截断场景的存量形态）——读路径应自愈砍掉
          { id: 'v1', fieldId: 'f1', text: 'x'.repeat(1999) + String.fromCharCode(0xd83d), source: '手动', createdAt: '', updatedAt: '' },
          // v2：孤立代理在**中间**——修复只砍末尾，中间保留（口径如此，记录行为）
          { id: 'v2', fieldId: 'f1', text: 'a' + String.fromCharCode(0xd83d) + 'b', source: '手动', createdAt: '', updatedAt: '' },
        ],
        entries: [],
      }],
      trash: [],
    }));
    const { loadPoDocSync } = await import('../../src/main/features/po/store');
    const doc = loadPoDocSync(UID);
    const texts = doc.groups[0].values.map((v) => v.text);
    // v1：末尾孤立高代理 → normalize 的 sanitize（末尾砍 1 码元逻辑）自愈
    expect(LONE_SURROGATE.test(texts[0])).toBe(false);
    // v2：孤立代理在中间——修复只砍末尾，中间保留（口径如此，记录行为）
    expect(LONE_SURROGATE.test(texts[1])).toBe(true);
    void api;
  });
});

describe('regression r2 › 修复复查：导入通道 meta 校验', () => {
  it('非法 asOf/ruleKind/verified 剥离，合法三件全保留（r1 修复生效）', async () => {
    const api = await loadApi();
    const applied = await api.poImportApply(UID, [{
      title: '注入组',
      mergeIntoExisting: false,
      fields: [{
        name: 'F',
        values: [
          { value: '坏meta', asOf: '2026-09\nBOGUS', ruleKind: 'bogus' as any, verified: 'yes' as any },
          { value: '好meta', asOf: '2026-09', ruleKind: 'constraint', verified: 'independent' },
        ],
      }],
      entries: [],
    }]);
    expect(applied.ok).toBe(true);
    const snap = api.getPoSnapshot(UID);
    const values = snap.groups[0].values;
    const bad = values.find((v) => v.text === '坏meta')!;
    expect(bad.asOf).toBeUndefined();
    expect(bad.ruleKind).toBeUndefined();
    expect(bad.verified).toBeUndefined();
    const good = values.find((v) => v.text === '好meta')!;
    expect(good.asOf).toBe('2026-09');
    expect(good.ruleKind).toBe('constraint');
    expect(good.verified).toBe('independent');
    // 磁盘单源同样干净（writeJson 为 2 空格缩进格式，用解析后断言）
    const onDisk = JSON.parse(fs.readFileSync(poDocFile(), 'utf8'));
    const diskValues = onDisk.groups[0].values;
    expect(diskValues.find((v: any) => v.text === '坏meta').ruleKind).toBeUndefined();
    expect(diskValues.find((v: any) => v.text === '坏meta').verified).toBeUndefined();
    expect(diskValues.find((v: any) => v.text === '坏meta').asOf).toBeUndefined();
  });
});

describe('regression r2 › 兄弟通道漏修（F-r2-1/F-r2-2 已修，转为回归）', () => {
  // r2 修复（F-r2-1/F-r2-2）：poAddValue 补 ruleKind 枚举门、poUpdateValue 补
  // verified 三态门——写读不对称幽灵写不再可能。
  it('poAddValue 的 draft.ruleKind 枚举门：非法值被拒不落盘（与 poUpdateValue 同口径）', async () => {
    const api = await loadApi();
    const g = await api.poCreateGroup(UID, '规则组');
    const gid = g.group!.group_id;
    const f = await api.poCreateField(UID, gid, 'F');
    const added = await api.poAddValue(UID, gid, f.field!.id, { text: 'v', ruleKind: 'bogus' as any });
    expect(added.ok).toBe(false); // 被拒
    expect(added.error).toBe('invalid rule kind');
    // 磁盘单源不落这条值（拒绝发生在写前）
    const onDisk = JSON.parse(fs.readFileSync(poDocFile(), 'utf8'));
    expect(onDisk.groups[0].values.find((v: any) => v.text === 'v')).toBeUndefined();
    // 快照同样没有
    const snap = api.getPoSnapshot(UID);
    expect(snap.groups[0].values.length).toBe(0);
  });

  it('poUpdateValue 的 patch.verified 三态门：非法值被拒不落盘（与 ruleKind 同风格）', async () => {
    const api = await loadApi();
    const g = await api.poCreateGroup(UID, '核实组');
    const gid = g.group!.group_id;
    const f = await api.poCreateField(UID, gid, 'F');
    const v = await api.poAddValue(UID, gid, f.field!.id, { text: 'v' });
    const vid = v.value!.id;
    // 对照：ruleKind 非法被拒
    const badKind = await api.poUpdateValue(UID, gid, vid, { ruleKind: 'bogus' as any });
    expect(badKind.ok).toBe(false);
    expect(badKind.error).toBe('invalid rule kind');
    // verified 非法：同样被拒、不落盘、无幽灵写
    const badVerified = await api.poUpdateValue(UID, gid, vid, { verified: 'yes' as any });
    expect(badVerified.ok).toBe(false);
    expect(badVerified.error).toBe('invalid verified');
    const onDisk = JSON.parse(fs.readFileSync(poDocFile(), 'utf8'));
    expect(onDisk.groups[0].values.find((x: any) => x.id === vid).verified).toBeUndefined();
    expect(api.getPoSnapshot(UID).groups[0].values[0].verified).toBeUndefined();
  });
});
