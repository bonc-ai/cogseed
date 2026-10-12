/**
 * 探针 r1（边界测试员）→ r1 收尾整理为混合回归文件（记账员，2026-09-30）：
 * - 已修项回归（active）：F-r1-2 超长文本截断代理对（下方 emoji 用例）、
 *   空串/纯空白守卫（通用正向边界，锁定现状校验）。
 * - 待议项（it.skip，拍板后按结论反转断言或删除）：P-r1-2 流水升格绕过
 *   去重门、P-r1-3 applied 计数虚高、P-r1-4 控制字符不滤、P-r1-5 asOf
 *   无未来上界、P-r1-6 删除幂等口径不一致（见 round-1-甄别.md toPending）。
 *
 * 覆盖：asOf 未来年月、控制字符/零宽字符、删除幂等口径不一致、
 * 流水升格绕过同文本去重门、导入 applied 计数虚高、超长文本截断劈开代理对。
 * 风格对齐 test/main/features/po/po-store.test.ts（临时工作区 + resetModules）。
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
const UID = 'probe-r1-boundary';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-probe-r1b-'));
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

/** 孤立代理项检测（高代理后不跟低代理 / 低代理前无高代理）。 */
const LONE_SURROGATE = /(?:[\uD800-\uDBFF](?![\uDC00-\uDFFF]))|((?:[^\uD800-\uDBFF])|^)[\uDC00-\uDFFF]/;

describe('regression r1 › po 写路径边界（待议项已 skip）', () => {
  // 待议 P-r1-5：asOf 无未来上界校验（2099-12 被接受）。拍板前保持 skip；
  // 断言锁定的是「现状接受」，拍板拒收后需反转为 ok:false。
  it.skip('asOf 未来年月 2099-12 被接受（1899-12 被拒）——时间锚无上界校验', async () => {
    const api = await loadApi();
    const g = await api.poCreateGroup(UID, '时间锚组');
    const gid = g.group!.group_id;
    const f = await api.poCreateField(UID, gid, '字段');
    const future = await api.poAddValue(UID, gid, f.field!.id, { text: 'v', asOf: '2099-12' });
    expect(future.ok).toBe(true);
    expect(api.getPoSnapshot(UID).groups[0].values[0].asOf).toBe('2099-12');
    // 反例：19 世纪被正则拒绝，证明校验只看格式不看合理范围
    const past = await api.poAddValue(UID, gid, f.field!.id, { text: 'v2', asOf: '1899-12' });
    expect(past.ok).toBe(false);
  });

  // 待议 P-r1-4：sanitizePoText 不滤控制字符/零宽字符。滤到什么程度（全 C0+DEL+
  // 零宽 vs 只滤 NUL+行分隔符 vs 出口拦）需拍板；断言锁定的是「现状原样落盘」。
  it.skip('控制字符/零宽字符原样写入单一事实源 JSON 与渲染副本（sanitize 只压换行制表）', async () => {
    const api = await loadApi();
    const g = await api.poCreateGroup(UID, '脏字符组');
    const gid = g.group!.group_id;
    const f = await api.poCreateField(UID, gid, '字段');
    // NUL、BEL、ESC、零宽空格、行分隔符 U+2028（用 fromCharCode 构造，避免文件本身带控制字节）
    const withCtrl = 'a' + String.fromCharCode(0) + 'b' + String.fromCharCode(7) + 'c'
      + String.fromCharCode(27) + 'd' + String.fromCharCode(0x200b) + 'e' + String.fromCharCode(0x2028) + 'f';
    const added = await api.poAddValue(UID, gid, f.field!.id, { text: withCtrl });
    expect(added.ok).toBe(true);
    const onDisk = fs.readFileSync(poDocFile(), 'utf8');
    expect(onDisk).toContain('\\u0000');
    // U+2028 是合法 JSON 字符串字符，V8 的 stringify 原样输出（不转义）——解析回读验证
    const parsedDoc = JSON.parse(onDisk);
    const storedText = parsedDoc.groups[0].values[0].text;
    expect(storedText).toContain(String.fromCharCode(0));
    expect(storedText).toContain(String.fromCharCode(0x2028));
    expect(storedText).toContain(String.fromCharCode(0x200b));
    // 渲染副本（kb 检索索引源）也带这些字符
    const renderDir = path.join(tmpDir, UID, 'cloud', 'contexts', '.personal_ontology_groups');
    const md = fs.readFileSync(path.join(renderDir, `${gid}.md`), 'utf8');
    expect(md).toContain(String.fromCharCode(0));
    expect(md).toContain(String.fromCharCode(0x2028));
  });

  // 待议 P-r1-6：po 删除族幂等口径不一致（值/字段静默 ok vs 流水报错）。
  // 统一幂等 vs 统一显式报错两方向互斥，拍板前 skip，断言锁定现状分歧本身。
  it.skip('删除幂等口径不一致：值/字段删不存在 id 静默 ok，流水删除报 entry not found', async () => {
    const api = await loadApi();
    const g = await api.poCreateGroup(UID, '幂等组');
    const gid = g.group!.group_id;
    const f = await api.poCreateField(UID, gid, '字段');
    expect(f.ok).toBe(true);
    const delValue = await api.poDeleteValue(UID, gid, 'no-such-value');
    expect(delValue.ok).toBe(true); // 静默成功
    const delField = await api.poDeleteField(UID, gid, 'no-such-field');
    expect(delField.ok).toBe(true); // 静默成功
    const delEntry = await api.poDeleteEntry(UID, gid, 'no-such-entry');
    expect(delEntry.ok).toBe(false);
    expect(delEntry.error).toBe('entry not found');
  });

  // 待议 P-r1-2：poPromoteEntry 绕过同文本去重门。显式拒 vs 幂等升格是产品
  // 语义分叉，拍板前 skip；断言锁定的是「现状可落 3 条重复」。
  it.skip('流水升格绕过同文本去重门：同字段同文本可产生两条值（poAddValue 会拒）', async () => {
    const api = await loadApi();
    const g = await api.poCreateGroup(UID, '升格组');
    const gid = g.group!.group_id;
    // 两条同文水流（poAddEntry 不去重，允许）
    await api.poAddEntry(UID, gid, '每周三例会');
    await api.poAddEntry(UID, gid, '每周三例会');
    const snap0 = api.getPoSnapshot(UID);
    const [e1, e2] = snap0.groups[0].entries;
    expect(e1.text).toBe(e2.text);
    // 直接 addValue 第一次成功，第二次同文本被去重门拒绝
    const field = await api.poCreateField(UID, gid, '例会');
    expect((await api.poAddValue(UID, gid, field.field!.id, { text: '每周三例会' })).ok).toBe(true);
    const direct = await api.poAddValue(UID, gid, field.field!.id, { text: '每周三例会' });
    expect(direct.ok).toBe(false);
    expect(direct.error).toBe('duplicate value');
    // promote 两条同文水流：都绕过同一道门落成值
    expect((await api.poPromoteEntry(UID, gid, e1.id, '例会')).ok).toBe(true);
    expect((await api.poPromoteEntry(UID, gid, e2.id, '例会')).ok).toBe(true);
    const values = api.getPoSnapshot(UID).groups[0].values.filter((v) => v.text === '每周三例会');
    expect(values.length).toBe(3); // 1 条 addValue + 2 条 promote，去重门被绕过
  });

  // 待议 P-r1-3：poImportApply 的 applied 计数虚高（重复项跳过仍计入）。
  // A（applied=实际新增）vs B（另加 skipped 计数）需拍板；断言锁定现状虚高。
  it.skip('导入同一份导出两次：第二次零写入但 applied 计数照样虚高', async () => {
    const api = await loadApi();
    const g = await api.poCreateGroup(UID, '回灌组');
    const gid = g.group!.group_id;
    const f = await api.poCreateField(UID, gid, '字段');
    await api.poAddValue(UID, gid, f.field!.id, { text: 'A' });
    await api.poAddEntry(UID, gid, '一条流水');
    const exported = api.poExportMarkdown(UID);
    const preview = api.poImportPreview(UID, exported);
    expect(preview.items.length).toBe(1);

    const first = await api.poImportApply(UID, preview.items);
    expect(first.applied).toBe(2); // 1 值 + 1 流水
    const second = await api.poImportApply(UID, preview.items);
    // 实际写入 0 条（值与流水都已存在），但 applied 仍计 2
    expect(second.applied).toBe(2);
    const snap = api.getPoSnapshot(UID);
    const values = snap.groups[0].values.filter((v) => v.text === 'A');
    const entries = snap.groups[0].entries.filter((e) => e.text === '一条流水');
    expect(values.length).toBe(1);
    expect(entries.length).toBe(1); // 落盘确实没重复——只是计数虚高
  });

  // 2026-09-30 r1 修复反转（F-r1-2）：sanitizePoText 在 slice 截断后剔除末尾
  // 孤立高代理，孤立代理不再落入 JSON 单一事实源。探针转为回归测试。
  it('超长 emoji 文本截断不再劈开代理对：末位无孤立高代理、磁盘无 \\ud83d 转义', async () => {
    const api = await loadApi();
    const g = await api.poCreateGroup(UID, '超长组');
    const gid = g.group!.group_id;
    const f = await api.poCreateField(UID, gid, '字段');
    // 1997 个 x + 10 个 emoji：sanitize 的 slice(0,2000) 恰好劈开第 2 个 emoji
    const text = 'x'.repeat(1997) + '😀'.repeat(10);
    const added = await api.poAddValue(UID, gid, f.field!.id, { text });
    expect(added.ok).toBe(true);
    const stored = added.value!.text;
    // 1997 ASCII + 完整保留 1 个 emoji（2 码元）= 1999，被劈开的高代理已剔除
    expect(stored.length).toBe(1999);
    expect(LONE_SURROGATE.test(stored)).toBe(false); // 末尾不再是孤立高代理
    // 且已落盘（JSON 单源不再保留 \\ud83d 转义，UTF-8 往返无损）
    const onDisk = fs.readFileSync(poDocFile(), 'utf8');
    expect(onDisk).not.toContain('\\ud83d');
  });

  it('空串/纯空白边界：字段名与值文本的空值守卫生（应全拒）', async () => {
    const api = await loadApi();
    const g = await api.poCreateGroup(UID, '空值组');
    const gid = g.group!.group_id;
    expect((await api.poCreateField(UID, gid, '   ')).ok).toBe(false);
    expect((await api.poCreateGroup(UID, '')).ok).toBe(false);
    const f = await api.poCreateField(UID, gid, '字段');
    expect((await api.poAddValue(UID, gid, f.field!.id, { text: '\t\n  ' })).ok).toBe(false);
    expect((await api.poAddEntry(UID, gid, '   ')).ok).toBe(false);
  });
});
