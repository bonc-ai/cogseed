/** 本体读写规范化：孤立代理、时间元数据、规则类型及验证状态的输入与读取一致性。 */
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

describe('修复复查：sanitizePoText 代理对', () => {
  it('截断不再劈开代理对：末尾无孤立高代理', async () => {
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

  // 存量脏数据的读取收敛：孤立代理无论在末尾（截断场景的存量
  // 形态）还是中间（撕裂/坏同步），读路径都自愈剥除。
  it('存量脏数据 load 自愈：末尾与中间的孤立代理都被剥除', async () => {
    const api = await loadApi();
    fs.mkdirSync(path.dirname(poDocFile()), { recursive: true });
    fs.writeFileSync(poDocFile(), JSON.stringify({
      schemaVersion: 2,
      groups: [{
        id: 'g-dirty', title: '脏档', kind: 'user', createdAt: '2026-09-01', updatedAt: '2026-09-01',
        fields: [{ id: 'f1', name: 'F', origin: 'user', createdAt: '2026-09-01' }],
        values: [
          // v1：孤立高代理在**末尾**（截断场景的存量形态）——读路径自愈砍掉
          { id: 'v1', fieldId: 'f1', text: 'x'.repeat(1999) + String.fromCharCode(0xd83d), source: '手动', createdAt: '', updatedAt: '' },
          // v2：孤立代理在**中间**——同样剥除（不再只砍末尾）
          { id: 'v2', fieldId: 'f1', text: 'a' + String.fromCharCode(0xd83d) + 'b', source: '手动', createdAt: '', updatedAt: '' },
        ],
        entries: [],
      }],
      trash: [],
    }));
    const { loadPoDocSync } = await import('../../src/main/features/po/store');
    const doc = loadPoDocSync(UID);
    const texts = doc.groups[0].values.map((v) => v.text);
    expect(LONE_SURROGATE.test(texts[0])).toBe(false);
    expect(LONE_SURROGATE.test(texts[1])).toBe(false);
    expect(texts[1]).toBe('ab'); // 中间孤立代理剥除后两侧相连
    void api;
  });
});

describe('修复复查：导入通道 meta 校验', () => {
  it('非法 asOf/ruleKind/verified 剥离，合法三件全保留', async () => {
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

describe('本体元数据写入与读取校验一致性', () => {
  // poAddValue 的 ruleKind 与 poUpdateValue 的 verified 均须使用合法枚举。
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
