import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * 摘要台账（spec 009 D12 / T009 / T010）—— `.history/<groupId>/audit.jsonl`。
 *
 * 覆盖：① 八个 groups 侧动作各恰好一行；② 受限值正文读盘零出现（只记
 * `[受限]`+长度）；③ changed:false 与失败分支不写；④ 台账目录不可写时
 * 主写路径仍成功；⑤ listGroupHistory 的可选 audit 附加字段（取不到不报错）。
 *
 * Mocks 同 personal_ontology_groups.test.ts：模块加载不拉 fastembed/sqlite-vec。
 */

let tmpDir: string;
let prevWs: string | undefined;
const UID = 'test-user-ledger';

vi.mock('../../../src/main/features/kb_indexer', () => ({
  enqueue: () => {},
  kbEvents: { on: () => {}, off: () => {}, emit: () => {} },
}));
vi.mock('../../../src/main/features/search', () => ({
  upsertContext: () => {},
  dropContext: () => {},
}));

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-onto-ledger-'));
  prevWs = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  process.env.COGSEED_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function loadModule() {
  return import('../../../src/main/features/personal_ontology_groups');
}

function groupHistoryDir(gid: string): string {
  // v2：台账随历史迁到 cognition/po-history（行格式不变）
  return path.join(tmpDir, UID, 'cloud', 'cognition', 'po-history', gid);
}

function auditPath(gid: string): string {
  return path.join(groupHistoryDir(gid), 'audit.jsonl');
}

/** 读盘原文（未解析）——受限正文断言必须对着它做。 */
function readAuditRaw(gid: string): string {
  return fs.readFileSync(auditPath(gid), 'utf8');
}

function readAuditLines(gid: string): any[] {
  return readAuditRaw(gid).split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

describe('ontology audit ledger › action coverage', () => {
  it('every successful groups-side write appends exactly one line with its action', async () => {
    const groups = await loadModule();
    const created = await groups.createGroup(UID, '台账覆盖组');
    const gid = created.group!.group_id;

    await groups.appendFieldValue(UID, gid, '称呼', '阿康', '手动');            // value_add
    await groups.setFieldValue(UID, gid, '称呼', '阿康', '子安');              // value_edit
    await groups.appendFieldValue(UID, gid, '居住地', '北京', '手动');          // value_add
    await groups.setFieldValueSensitivity(UID, gid, '居住地', '北京', true);    // 枚举外 → 不写
    await groups.removeFieldValue(UID, gid, '称呼', '子安');                   // value_remove
    await groups.appendToGroup(UID, gid, '回复用简短中文');                     // 流水追加（枚举外）→ 不写
    await groups.appendToGroup(UID, gid, '临时备注一条');
    await groups.removeEntry(UID, gid, '临时备注一条');                        // entry_remove（data-model 枚举第 9 动作）
    await groups.promoteEntryToField(UID, gid, '回复用简短中文', '沟通风格');   // entry_promote
    await groups.removeField(UID, gid, '沟通风格');                            // field_remove
    await groups.renameGroup(UID, gid, '台账覆盖组新名');                       // group_rename

    const lines = readAuditLines(gid);
    // 台账号数 = 成功写操作次数（8 次有动作的写；sensitivity/append 无枚举动作不写）
    expect(lines.map((l) => l.action)).toEqual([
      'value_add',      // 称呼=阿康
      'value_edit',     // 阿康→子安
      'value_add',      // 居住地=北京
      'value_remove',   // 删 称呼=子安
      'entry_remove',   // 删流水「临时备注一条」
      'entry_promote',  // 流水升格
      'field_remove',   // 删字段
      'group_rename',   // 改名
    ]);
    for (const l of lines) {
      expect(l.actor).toBe('user');
      expect(l.groupId).toBe(gid);
      expect(l.at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    }
    const edit = lines.find((l) => l.action === 'value_edit')!;
    expect(edit.field).toBe('称呼');
    expect(edit.beforeSummary).toBe('阿康');
    expect(edit.afterSummary).toBe('子安');
    const rename = lines.find((l) => l.action === 'group_rename')!;
    expect(rename.beforeSummary).toBe('台账覆盖组');
    expect(rename.afterSummary).toBe('台账覆盖组新名');
  });

  it('snapshot_restore and group_delete land in the ledger', async () => {
    const groups = await loadModule();
    const created = await groups.createGroup(UID, '恢复删除台账组');
    const gid = created.group!.group_id;
    await groups.appendFieldValue(UID, gid, '版本', '第一版', '手动');
    await groups.appendFieldValue(UID, gid, '版本', '第二版', '手动');
    const history = groups.listGroupHistory(UID, gid);
    expect(history.length).toBe(1);
    const restored = await groups.restoreGroupSnapshot(UID, gid, history[0].id);
    expect(restored.ok).toBe(true);

    const lines = readAuditLines(gid);
    expect(lines.map((l) => l.action)).toEqual(['value_add', 'value_add', 'snapshot_restore']);
    // 恢复行的「依据」= 恢复到哪版快照；刻意不带正文摘要（快照可能含受限值）
    expect(lines[2].reason).toBe(history[0].id);
    expect(lines[2].beforeSummary).toBeUndefined();
    expect(lines[2].afterSummary).toBeUndefined();

    const del = await groups.deleteGroup(UID, gid);
    expect(del.ok).toBe(true);
    // 组已删但 .history/<groupId>/（含台账）保留，仍可追溯
    const after = readAuditLines(gid);
    expect(after[3].action).toBe('group_delete');
    expect(after[3].beforeSummary).toBe('恢复删除台账组');
  });
});

describe('ontology audit ledger › restricted values stay redacted', () => {
  it('restricted value text never appears in the ledger file (only [受限] + length)', async () => {
    const groups = await loadModule();
    const created = await groups.createGroup(UID, '受限台账组');
    const gid = created.group!.group_id;
    // 受限正文只在「已标记受限后」被写入/编辑/删除——构造上它从未以
    // 非受限状态进过任何台账行。
    const SECRET = '某小区8号楼302室';
    await groups.appendFieldValue(UID, gid, '家庭住址', '初始地址', '手动');        // 明文（从未受限，无妨）
    await groups.setFieldValueSensitivity(UID, gid, '家庭住址', '初始地址', true);   // 标记受限（不写台账）
    await groups.setFieldValue(UID, gid, '家庭住址', '初始地址', SECRET);            // value_edit：前后都脱敏
    await groups.removeFieldValue(UID, gid, '家庭住址', SECRET);                    // value_remove：脱敏

    // 读盘原文断言（I-6）：受限正文零出现，只见 [受限] + 长度
    const raw = readAuditRaw(gid);
    expect(raw).not.toContain(SECRET);
    expect(raw).toContain('[受限]');

    const lines = readAuditLines(gid);
    const edit = lines.find((l) => l.action === 'value_edit')!;
    expect(edit.beforeSummary).toBe(`[受限] ${'初始地址'.length}`);
    expect(edit.afterSummary).toBe(`[受限] ${SECRET.length}`);
    const remove = lines.find((l) => l.action === 'value_remove')!;
    expect(remove.beforeSummary).toBe(`[受限] ${SECRET.length}`);
  });

  it('summaries are clipped at 200 chars', async () => {
    const groups = await loadModule();
    const created = await groups.createGroup(UID, '截断组');
    const gid = created.group!.group_id;
    const long = '长'.repeat(500);
    await groups.appendFieldValue(UID, gid, '备注', long, '手动');
    const lines = readAuditLines(gid);
    expect(lines[0].afterSummary.length).toBe(200);
  });
});

describe('ontology audit ledger › write discipline', () => {
  it('changed:false and failed branches never append', async () => {
    const groups = await loadModule();
    const created = await groups.createGroup(UID, '台账纪律组');
    const gid = created.group!.group_id;

    await groups.appendFieldValue(UID, gid, '称呼', '子安', '手动');           // 1 行
    await groups.appendFieldValue(UID, gid, '称呼', '子安', '手动');           // 完全匹配去重 changed:false → 不写
    const failedEdit = await groups.setFieldValue(UID, gid, '称呼', '不存在', 'x'); // 失败分支 → 不写
    expect(failedEdit.ok).toBe(false);
    const noField = await groups.removeField(UID, gid, '没有这个字段');         // no-op ok changed:false → 不写
    expect(noField.ok).toBe(true);
    const missingValue = await groups.removeFieldValue(UID, gid, '称呼', '对不上'); // 值不存在 no-op → 不写
    expect(missingValue.ok).toBe(true);

    const lines = readAuditLines(gid);
    expect(lines.length).toBe(1);
    expect(lines[0].action).toBe('value_add');
  });

  it('ledger write failure never blocks the main write path', async () => {
    const groups = await loadModule();
    const created = await groups.createGroup(UID, '台账故障组');
    const gid = created.group!.group_id;
    // 用一个目录占住 audit.jsonl 的路径：appendFileSync 必然 EISDIR，
    // 确定性制造「台账目录不可写」，不依赖平台 chmod 语义。
    fs.mkdirSync(groupHistoryDir(gid), { recursive: true });
    fs.mkdirSync(auditPath(gid));

    const res = await groups.appendFieldValue(UID, gid, '称呼', '子安', '手动');
    expect(res.ok).toBe(true); // 主写路径仍成功
    expect((await groups.readGroupContent(UID, gid)).content).toContain('子安');
    // 台账确实没写成（仍是目录），且读取 helper 对这种形态也不报错
    expect(fs.statSync(auditPath(gid)).isDirectory()).toBe(true);
    expect(groups.readGroupAudit(UID, gid)).toEqual([]);
    expect(groups.listGroupHistory(UID, gid)).toEqual([]); // 首次写入无快照 + audit 附加不炸
  });
});

describe('ontology audit ledger › history.list optional audit attachment', () => {
  it('attaches the nearest audit line; absent when none matches', async () => {
    const groups = await loadModule();
    const created = await groups.createGroup(UID, '台账附加组');
    const gid = created.group!.group_id;
    // 无台账的孤立快照（手工放置 v2 JSON 快照，模拟旧存量）
    await groups.writeGroupContent(UID, gid, '种子内容');
    fs.mkdirSync(groupHistoryDir(gid), { recursive: true });
    const doc = JSON.parse(fs.readFileSync(path.join(tmpDir, UID, 'cloud', 'cognition', 'personal-ontology.json'), 'utf8'));
    const live = doc.groups.find((g: any) => g.id === gid);
    fs.writeFileSync(path.join(groupHistoryDir(gid), '2020-01-01T00-00-00-000Z.json'), JSON.stringify({
      savedAt: '2020-01-01T00:00:00.000Z', group: live,
    }), 'utf8');

    let history = groups.listGroupHistory(UID, gid);
    expect(history.length).toBe(1);
    expect(history[0].audit).toBeUndefined(); // 配不上台账 → 不带字段、不报错

    // 假时钟：快照（写前留档）与台账行（写成功后）同毫秒，配对确定
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-25T07:12:33.412Z'));
    try {
      await groups.appendFieldValue(UID, gid, '版本', '第一版', '手动');
      history = groups.listGroupHistory(UID, gid);
      expect(history.length).toBe(2);
      expect(history[0].preview).toContain('种子内容'); // 写前留档的那版
      expect(history[0].audit).toMatchObject({ action: 'value_add', field: '版本' });
      expect(history[0].audit?.at).toBe('2026-09-25T07:12:33.412Z');
      expect(history[0].audit?.afterSummary).toBe('第一版');
      expect(history[1].audit).toBeUndefined(); // 孤立快照离台账太远（6 年）→ 不配
    } finally {
      vi.useRealTimers();
    }
  });
});
