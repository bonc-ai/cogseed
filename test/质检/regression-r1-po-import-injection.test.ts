/**
 * 红队探针 r1：导入通道（po.data.importApply）注入非法结构。
 *
 * 原推演（r1 甄别时漏洞成立）：poImportApply 把渲染层 items 原样交给
 * poAddValueToFieldByName，后者的 meta 分支对 asOf / ruleKind / verified
 * 零校验——含换行的非法 asOf 会撕裂方言 md 副本、污染 kb 索引、造成
 * 写读不对称（ruleKind 落盘后被 normalize 静默清除而脏 asOf 永久驻留）。
 *
 * 2026-09-30 r1 修复（F-r1-1）：poAddValueToFieldByName 写入前对 meta
 * 校验并剥离非法字段（合法部分照常落盘）。本探针已反转为回归测试：
 * 断言注入的非法结构被剥离、方言副本与 round-trip 无损。
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
const UID = 'probe-r1-import';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-probe-r1-imp-'));
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
function renderDir(): string {
  return path.join(tmpDir, UID, 'cloud', 'contexts', '.personal_ontology_groups');
}

async function loadApi() {
  return import('../../src/main/features/po/api');
}

describe('regression r1（F-r1-1 已修） › 导入通道注入非法结构', () => {
  // 2026-09-30 r1 修复反转：poAddValueToFieldByName 写入前对 meta 校验并
  // 剥离非法字段（asOf 用 isValidAsOfValue、ruleKind 枚举、verified 取值），
  // 探针从「证明漏洞」转为「钉住修复」的回归测试。
  it('直调 poImportApply 注入的非法 asOf/ruleKind/verified 被剥离，方言副本与 round-trip 无损', async () => {
    const api = await loadApi();
    const g = await api.poCreateGroup(UID, '导入目标');
    expect(g.ok).toBe(true);

    // 恶意 items：正常 preview 产不出这种 asOf/ruleKind（IPC 层可直传）
    const applied = await api.poImportApply(UID, [{
      title: '导入目标',
      fields: [{
        name: '注入字段',
        values: [{
          value: '正常值',
          asOf: '2026-09\nBOGUS-INJECTED @restricted',
          ruleKind: 'evil_kind',
          verified: 'yes' as any,
        }],
      }],
      entries: [],
    }]);

    // 值本身照常导入（批量导入不因单条坏 meta 中止）
    expect(applied.ok).toBe(true);
    expect(applied.applied).toBeGreaterThanOrEqual(1);

    // 磁盘 JSON：非法 asOf（含换行）/ruleKind/verified 全部被剥离，不落盘
    const doc = JSON.parse(fs.readFileSync(poDocFile(), 'utf8'));
    const group = doc.groups.find((x: any) => x.title === '导入目标');
    const value = group.values[0];
    expect(value.asOf).toBeUndefined();
    expect(value.ruleKind).toBeUndefined();
    expect(value.verified).toBeUndefined();

    // 渲染副本：方言行不再被撕裂（BOGUS 不出现，值行保持单行合法形态）
    const mdFiles = fs.readdirSync(renderDir()).filter((n) => n.endsWith('.md'));
    expect(mdFiles.length).toBe(1);
    const md = fs.readFileSync(path.join(renderDir(), mdFiles[0]), 'utf8');
    expect(md).not.toContain('BOGUS-INJECTED');
    const torn = md.split('\n').find((l) => l.includes('BOGUS-INJECTED'));
    expect(torn).toBeUndefined();

    // round-trip：值可完整读回，不再有撕裂丢正文
    const { parseGroupContent } = await import('../../src/main/features/po/dialect');
    const reparsed = parseGroupContent(md);
    expect(JSON.stringify(reparsed)).toContain('正常值');

    // 写读对称：重新 load 后三项仍为缺省（无「写成功、读变形」）
    const store = await import('../../src/main/features/po/store');
    const reloaded = store.loadPoDocSync(UID);
    const rv = reloaded.groups.find((x: any) => x.title === '导入目标')!.values[0];
    expect(rv.ruleKind).toBeUndefined();
    expect(rv.asOf).toBeUndefined();
    expect(rv.verified).toBeUndefined();
  });

  it('正式通道 poAddValue 拒绝同样的非法 asOf（对照组，两通道同口径）', async () => {
    const api = await loadApi();
    const g = await api.poCreateGroup(UID, '对照组');
    const gid = g.group!.group_id;
    const f = await api.poCreateField(UID, gid, '字段');
    const rejected = await api.poAddValue(UID, gid, f.field!.id, {
      text: '正常值',
      asOf: '2026-09\nBOGUS',
    } as any);
    expect(rejected.ok).toBe(false);
    expect(rejected.error).toBe('invalid asof');
  });
});
