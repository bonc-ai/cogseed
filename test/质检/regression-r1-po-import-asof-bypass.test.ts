/**
 * 红队探针 r1：po.data.importApply 通道绕过值列校验（asOf/ruleKind/verified）。
 *
 * 原推演（r1 甄别时漏洞成立）：poImportApply → poAddValueToFieldByName 对
 * meta 的 asOf / ruleKind / verified 一律不校验直接展开落盘（对比 po.values.add
 * /update 有正则+枚举），IPC 层只查 Array.isArray，渲染层可直传任意 items。
 *
 * 2026-09-30 r1 修复（F-r1-1）：poAddValueToFieldByName 写入前对 meta 校验
 * 并剥离非法字段（合法部分照常落盘）。本探针已反转为回归测试：断言非法
 * asOf/ruleKind 在导入时即被剥离，verified='independent'（合法值）照常保留。
 *
 * 2026-09-30 r1 收尾（记账员）：由 probe- 改名 regression-，正式收编为
 * F-r1-1 的回归测试（本文件全部用例对应该已修项，无待议用例）。
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
const UID = 'probe-user-003';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-probe-r1c-'));
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

describe('regression r1（F-r1-1 已修）: importApply 绕过 asOf / ruleKind 校验（已堵）', () => {
  it('非法 asOf 经 importApply 被剥离不落盘；对照组 add 拒绝同值（两通道同口径）', async () => {
    const api = await loadApi();

    // 对照：正规通道拒绝非法 asOf。
    const created = await (await import('../../src/main/features/personal_ontology_groups'))
      .createGroup(UID, '导入探针');
    expect(created.ok).toBe(true);
    const groupId = created.group!.group_id;
    const field = await api.poCreateField(UID, groupId, '字段A');
    expect(field.ok).toBe(true);
    const fieldId = field.field!.id;

    const badAdd = await api.poAddValue(UID, groupId, fieldId, { text: 'v1', asOf: '2026-99-99!!' });
    expect(badAdd.ok).toBe(false);
    expect(badAdd.error).toBe('invalid asof');

    // 攻击面：importApply 直传 items（渲染层可构造，无需经过 importPreview）。
    // 2026-09-30 r1 修复（F-r1-1）后：非法 asOf 被剥离（导入通道与手写通道同口径）。
    const applied = await api.poImportApply(UID, [{
      title: '导入探针组B',
      fields: [{
        name: '字段B',
        values: [
          { value: '带非法时间锚的值', asOf: '2026-99-99!!' },
          { value: '自带独立核实的值', verified: 'independent' },
        ],
      }],
      entries: [],
      mergeIntoExisting: false,
    }]);
    expect(applied.ok).toBe(true);
    expect(applied.applied).toBe(2);

    // 落盘检查：非法 asOf 剥离不落盘（值本身照常导入）。
    const doc = JSON.parse(fs.readFileSync(poDocFile(), 'utf8'));
    const groupB = doc.groups.find((g: any) => g.title === '导入探针组B');
    expect(groupB).toBeTruthy();
    const values = groupB.values;
    expect(values.find((v: any) => v.text === '带非法时间锚的值').asOf).toBeUndefined();
    // verified=independent（独立核实）本身合法，照常保留（导出导入回灌依赖）：
    expect(values.find((v: any) => v.text === '自带独立核实的值').verified).toBe('independent');

    // 追加一次无关写入（加个流水）：剥离后的状态稳定，无「先落盘后变形」。
    await api.poAddEntry(UID, groupB.id, '后续流水');
    const doc2 = JSON.parse(fs.readFileSync(poDocFile(), 'utf8'));
    const groupB2 = doc2.groups.find((g: any) => g.id === groupB.id);
    expect(groupB2.values.find((v: any) => v.text === '带非法时间锚的值').asOf).toBeUndefined();
  });

  it('任意 ruleKind 字符串在导入时即被剥离（PoRuleKind 白名单不再被绕过，无落盘窗口）', async () => {
    const api = await loadApi();
    // 单值导入 → 立即读盘（中间没有其他写入）。
    const applied = await api.poImportApply(UID, [{
      title: '导入探针组C',
      fields: [{ name: '字段C', values: [{ value: '带任意规则分类的值', ruleKind: '任意串' as never }] }],
      entries: [],
      mergeIntoExisting: false,
    }]);
    expect(applied.ok).toBe(true);
    const doc1 = JSON.parse(fs.readFileSync(poDocFile(), 'utf8'));
    const c1 = doc1.groups.find((g: any) => g.title === '导入探针组C');
    expect(c1.values[0].ruleKind).toBeUndefined();

    // 再写一笔无关流水：仍为缺省（不存在「先落盘、后被 normalize 清掉」的
    // 写读不对称窗口）。
    await api.poAddEntry(UID, c1.id, '再写一笔');
    const doc2 = JSON.parse(fs.readFileSync(poDocFile(), 'utf8'));
    const c2 = doc2.groups.find((g: any) => g.id === c1.id);
    expect(c2.values[0].ruleKind).toBeUndefined();
  });
});
