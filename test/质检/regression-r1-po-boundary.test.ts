/**
 * 本体写入边界回归：时间锚窗口、控制字符剥除、删除幂等统一、
 * 升格去重门、导入 applied 只计实际写入，与 Unicode 安全截断。
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

describe('po 写路径边界', () => {
  it('asOf 时间锚窗口：远期 2099-12 与 1899-12 均被拒，次年年初被接受', async () => {
    const api = await loadApi();
    const g = await api.poCreateGroup(UID, '时间锚组');
    const gid = g.group!.group_id;
    const f = await api.poCreateField(UID, gid, '字段');
    const future = await api.poAddValue(UID, gid, f.field!.id, { text: 'v', asOf: '2099-12' });
    expect(future.ok).toBe(false);
    expect(future.error).toBe('invalid asof');
    const past = await api.poAddValue(UID, gid, f.field!.id, { text: 'v2', asOf: '1899-12' });
    expect(past.ok).toBe(false);
    // 窗口内（次年年初）照常接受——上界不误伤近期规划。
    const near = await api.poAddValue(UID, gid, f.field!.id, { text: 'v3', asOf: `${new Date().getUTCFullYear() + 1}-01` });
    expect(near.ok).toBe(true);
    expect(api.getPoSnapshot(UID).groups[0].values[0].asOf).toBe(`${new Date().getUTCFullYear() + 1}-01`);
  });

  it('控制字符/零宽/行分隔符写入即剥除：单一事实源 JSON 与渲染副本都不携带', async () => {
    const api = await loadApi();
    const g = await api.poCreateGroup(UID, '脏字符组');
    const gid = g.group!.group_id;
    const f = await api.poCreateField(UID, gid, '字段');
    // NUL、BEL、ESC、零宽空格、行分隔符 U+2028（用 fromCharCode 构造，避免文件本身带控制字节）
    const withCtrl = 'a' + String.fromCharCode(0) + 'b' + String.fromCharCode(7) + 'c'
      + String.fromCharCode(27) + 'd' + String.fromCharCode(0x200b) + 'e' + String.fromCharCode(0x2028) + 'f';
    const added = await api.poAddValue(UID, gid, f.field!.id, { text: withCtrl });
    expect(added.ok).toBe(true);
    // 存储文本 = 剥除后的净内容（控制/零宽/行分隔符一个不留）
    expect(added.value!.text).toBe('abcdef');
    const onDisk = fs.readFileSync(poDocFile(), 'utf8');
    expect(onDisk).not.toContain('\\u0000');
    const parsedDoc = JSON.parse(onDisk);
    const storedText = parsedDoc.groups[0].values[0].text;
    expect(storedText).toBe('abcdef');
    expect(storedText).not.toContain(String.fromCharCode(0));
    expect(storedText).not.toContain(String.fromCharCode(0x2028));
    expect(storedText).not.toContain(String.fromCharCode(0x200b));
    // 渲染副本（kb 检索索引源）同样干净
    const renderDir = path.join(tmpDir, UID, 'cloud', 'contexts', '.personal_ontology_groups');
    const md = fs.readFileSync(path.join(renderDir, `${gid}.md`), 'utf8');
    expect(md).not.toContain(String.fromCharCode(0));
    expect(md).not.toContain(String.fromCharCode(0x2028));
    expect(md).not.toContain(String.fromCharCode(0x200b));
  });

  it('删除幂等口径统一：值/字段/流水删不存在 id 一律显式 not found', async () => {
    const api = await loadApi();
    const g = await api.poCreateGroup(UID, '幂等组');
    const gid = g.group!.group_id;
    const f = await api.poCreateField(UID, gid, '字段');
    expect(f.ok).toBe(true);
    const delValue = await api.poDeleteValue(UID, gid, 'no-such-value');
    expect(delValue.ok).toBe(false);
    expect(delValue.error).toBe('value not found');
    const delField = await api.poDeleteField(UID, gid, 'no-such-field');
    expect(delField.ok).toBe(false);
    expect(delField.error).toBe('field not found');
    const delEntry = await api.poDeleteEntry(UID, gid, 'no-such-entry');
    expect(delEntry.ok).toBe(false);
    expect(delEntry.error).toBe('entry not found');
  });

  it('流水升格与直接添加同文本去重门：同字段同文本只落一条值', async () => {
    const api = await loadApi();
    const g = await api.poCreateGroup(UID, '升格组');
    const gid = g.group!.group_id;
    // 两条同文水流（poAddEntry 不去重，允许）
    await api.poAddEntry(UID, gid, '每周三例会');
    await api.poAddEntry(UID, gid, '每周三例会');
    const snap0 = api.getPoSnapshot(UID);
    const [e1, e2] = snap0.groups[0].entries;
    expect(e1.text).toBe(e2.text);
    // promote 第一条成功（该字段尚无同文值，升格即首值）
    expect((await api.poPromoteEntry(UID, gid, e1.id, '例会')).ok).toBe(true);
    // promote 第二条撞同一道同文本去重门被拒（流水保留不动）
    const second = await api.poPromoteEntry(UID, gid, e2.id, '例会');
    expect(second.ok).toBe(false);
    expect(second.error).toBe('duplicate value');
    // 直接 addValue 同文同样被同一道门拒绝——门只有一道，升格无旁路
    const fieldId = api.getPoSnapshot(UID).groups[0].fields.find((f: any) => f.name === '例会')!.id;
    const direct = await api.poAddValue(UID, gid, fieldId, { text: '每周三例会' });
    expect(direct.ok).toBe(false);
    expect(direct.error).toBe('duplicate value');
    const snap1 = api.getPoSnapshot(UID);
    const values = snap1.groups[0].values.filter((v: any) => v.text === '每周三例会');
    expect(values.length).toBe(1); // 只 promote 的那条，去重门无旁路
    // 被拒的第二条流水仍在
    expect(snap1.groups[0].entries.some((e: any) => e.id === e2.id)).toBe(true);
  });

  it('重复导入：第二次 applied 如实计 0（零写入零计数）', async () => {
    const api = await loadApi();
    const g = await api.poCreateGroup(UID, '回灌组');
    const gid = g.group!.group_id;
    const f = await api.poCreateField(UID, gid, '字段');
    await api.poAddValue(UID, gid, f.field!.id, { text: 'A' });
    await api.poAddEntry(UID, gid, '一条流水');
    const exported = api.poExportMarkdown(UID);
    const preview = api.poImportPreview(UID, exported);
    expect(preview.items.length).toBe(1);

    // 模拟换机：清掉文档，第一次导入真实写入。
    fs.rmSync(poDocFile(), { force: true });
    const first = await api.poImportApply(UID, preview.items);
    expect(first.applied).toBe(2); // 1 值 + 1 流水，计数 = 实际写入
    const second = await api.poImportApply(UID, preview.items);
    expect(second.applied).toBe(0); // 同文本去重全部跳过：零写入零计数，不再虚高
    const snap = api.getPoSnapshot(UID);
    const values = snap.groups[0].values.filter((v: any) => v.text === 'A');
    const entries = snap.groups[0].entries.filter((e: any) => e.text === '一条流水');
    expect(values.length).toBe(1);
    expect(entries.length).toBe(1);
  });

  // 截断后的末尾孤立高代理不得进入持久化 JSON。
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
