/**
 * 统一认知库存储内核测试。
 *
 * 覆盖：懒创建读路径零副作用、set 槽位建/更、幂等跳过、update/remove 语义
 * （软删墓碑、删后拒改）、全批原子（一败全不动）、experience/task_local 拒收、
 * proposed 拒收（候选池不进库）、坏档写侧拒绝、防御性归一、objectId 路径
 * 穿越拒绝、版本流/台账追加。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('../../../../src/main/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

let tmpDir: string;
let prevWs: string | undefined;
const UID = 'test-user-001';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-ck-store-'));
  prevWs = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  process.env.COGSEED_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function storeFile(): string {
  return path.join(tmpDir, UID, 'cloud', 'cognition', 'cognition-store.json');
}

function versionsDir(): string {
  return path.join(tmpDir, UID, 'cloud', 'cognition', 'cognition-versions');
}

function auditFile(): string {
  return path.join(tmpDir, UID, 'cloud', 'cognition', 'cognition-audit.jsonl');
}

function kernel() {
  return import('../../../../src/main/features/cognition_kernel/store');
}

function deltaMod() {
  return import('../../../../src/main/features/cognition_kernel/delta');
}

function build(delta: {
  op: 'add' | 'update' | 'remove' | 'set';
  home: string;
  after?: string;
  objectId?: string;
  groupId?: string;
  fieldName?: string;
  origin?: string;
  status?: 'applied' | 'proposed';
}) {
  return deltaMod().then(({ buildDelta }) =>
    buildDelta({
      op: delta.op,
      target: {
        home: delta.home as never,
        ...(delta.objectId ? { objectId: delta.objectId } : {}),
        ...(delta.groupId ? { groupId: delta.groupId } : {}),
        ...(delta.fieldName ? { fieldName: delta.fieldName } : {}),
      },
      origin: (delta.origin ?? 'user') as never,
      after: delta.after ?? null,
      ...(delta.status ? { status: delta.status } : {}),
    }),
  );
}

describe('cognition_kernel/store — 统一认知库内核', () => {
  it('ENOENT → 空库，读路径零副作用（不建目录不落盘）', async () => {
    const { loadCognitionStoreSync } = await kernel();
    const doc = loadCognitionStoreSync(UID);
    expect(doc.objects).toEqual({});
    expect(fs.existsSync(storeFile())).toBe(false);
    expect(fs.existsSync(path.dirname(storeFile()))).toBe(false);
  });

  it('set 断言槽位：无则建、有则原对象升版（同槽不建第二条）', async () => {
    const { applyCognitionDeltas, loadCognitionStoreSync } = await kernel();
    const d1 = await build({ op: 'set', home: 'personal_fact', fieldName: '银行卡号', after: '6222…1234', groupId: 'g-fin' });
    const r1 = await applyCognitionDeltas(UID, [d1]);
    expect(r1.ok).toBe(true);
    expect(r1.appliedCount).toBe(1);
    const doc1 = loadCognitionStoreSync(UID);
    const first = Object.values(doc1.objects)[0];
    expect(first.kind).toBe('assertion');
    expect(first.statement).toBe('6222…1234');
    expect(first.version).toBe(1);

    const d2 = await build({ op: 'set', home: 'personal_fact', fieldName: '银行卡号', after: '6222…5678', groupId: 'g-fin' });
    const r2 = await applyCognitionDeltas(UID, [d2]);
    expect(r2.ok).toBe(true);
    const doc2 = loadCognitionStoreSync(UID);
    expect(Object.keys(doc2.objects)).toHaveLength(1);
    expect(Object.values(doc2.objects)[0].statement).toBe('6222…5678');
    expect(Object.values(doc2.objects)[0].version).toBe(2);
    expect(r2.results[0]).toMatchObject({ applied: true, objectId: first.id });
  });

  it('幂等：同一 Delta 实例重放（双提交/崩溃重试）→ duplicate 跳过且不升版；新变更加常落地', async () => {
    const { applyCognitionDeltas, loadCognitionStoreSync } = await kernel();
    const d = await build({ op: 'set', home: 'personal_fact', fieldName: '部门', after: '开源项目组' });
    await applyCognitionDeltas(UID, [d]);
    // 精确重放：同一个 delta 对象再来一次（双提交/重试路径的形状）。
    const r = await applyCognitionDeltas(UID, [d]);
    expect(r.ok).toBe(true);
    expect(r.results[0]).toMatchObject({ applied: false, duplicate: true });
    const doc = loadCognitionStoreSync(UID);
    expect(Object.values(doc.objects)[0].version).toBe(1);
    // 同槽位的新内容变更不是重放：必须落地并升版（槽位键去重属候选池语义，不属存储侧）。
    const d2 = await build({ op: 'set', home: 'personal_fact', fieldName: '部门', after: '开源项目组·平台线' });
    const r2 = await applyCognitionDeltas(UID, [d2]);
    expect(r2.ok).toBe(true);
    expect(r2.results[0].applied).toBe(true);
    expect(loadCognitionStoreSync(UID).objects[Object.keys(doc.objects)[0]].version).toBe(2);
  });

  it('永久回执达到容量时拒绝新写，但精确重放仍幂等且不改正文', async () => {
    const { applyCognitionDelta, loadCognitionStoreSync } = await kernel();
    const doc = loadCognitionStoreSync(UID);
    const first = await build({ op: 'set', home: 'personal_fact', fieldName: '部门', after: '容量验收' });
    expect(applyCognitionDelta(doc, first).applied).toBe(true);
    for (let i = 0; i < 99999; i++) doc.deltaReceipts![`capacity-${i}`] = 'fixture';
    const before = JSON.stringify(doc.objects);
    expect(applyCognitionDelta(doc, first)).toMatchObject({ applied: false, duplicate: true });
    const next = await build({ op: 'set', home: 'personal_fact', fieldName: '部门', after: '不能保存' });
    expect(applyCognitionDelta(doc, next)).toMatchObject({ applied: false, reason: 'durable replay receipt capacity exceeded' });
    expect(JSON.stringify(doc.objects)).toBe(before);
    expect(doc.deltaReceipts![first.deltaId]).toBeTruthy();
  });

  it('add/update/remove：升版、软删墓碑、删后拒改', async () => {
    const { applyCognitionDeltas, loadCognitionStoreSync } = await kernel();
    const add = await build({ op: 'add', home: 'rule', after: '对外报价不承诺交期' });
    const r1 = await applyCognitionDeltas(UID, [add]);
    expect(r1.ok).toBe(true);
    const objectId = r1.results[0].applied ? r1.results[0].objectId : '';
    expect(objectId).toBeTruthy();

    const upd = await build({ op: 'update', home: 'rule', after: '对外报价不承诺交期（含口头）', objectId });
    const r2 = await applyCognitionDeltas(UID, [upd]);
    expect(r2.ok).toBe(true);
    const doc2 = loadCognitionStoreSync(UID);
    expect(doc2.objects[objectId].version).toBe(2);

    const rm = await build({ op: 'remove', home: 'rule', objectId });
    const r3 = await applyCognitionDeltas(UID, [rm]);
    expect(r3.ok).toBe(true);
    const doc3 = loadCognitionStoreSync(UID);
    expect(doc3.objects[objectId].status).toBe('deleted');
    expect(doc3.objects[objectId].deletedAt).toBeTruthy();

    const upd2 = await build({ op: 'update', home: 'rule', after: '复活尝试', objectId });
    const r4 = await applyCognitionDeltas(UID, [upd2]);
    expect(r4.ok).toBe(false);
  });

  it('全批原子：批内一个失败 → 主档保持原样（全或无）', async () => {
    const { applyCognitionDeltas, loadCognitionStoreSync } = await kernel();
    const good = await build({ op: 'set', home: 'personal_fact', fieldName: '称呼', after: '示例用户甲' });
    await applyCognitionDeltas(UID, [good]);
    const before = fs.readFileSync(storeFile(), 'utf8');

    const good2 = await build({ op: 'set', home: 'personal_fact', fieldName: '城市', after: '北京' });
    const bad = await build({ op: 'update', home: 'rule', after: '找不到对象', objectId: 'co-nonexistent' });
    const r = await applyCognitionDeltas(UID, [good2, bad]);
    expect(r.ok).toBe(false);
    expect(fs.readFileSync(storeFile(), 'utf8')).toBe(before);
  });

  it('experience / task_local 拒收（不在统一库）', async () => {
    const { applyCognitionDeltas } = await kernel();
    const exp = await build({ op: 'add', home: 'experience', after: '上次发票被退回' });
    const r1 = await applyCognitionDeltas(UID, [exp]);
    expect(r1.ok).toBe(false);
    const local = await build({ op: 'add', home: 'task_local', after: '本周上线支付网关' });
    const r2 = await applyCognitionDeltas(UID, [local]);
    expect(r2.ok).toBe(false);
  });

  it('proposed 拒收：候选池语义不进库', async () => {
    const { applyCognitionDeltas } = await kernel();
    const proposed = await build({ op: 'add', home: 'rule', after: '系统提议', origin: 'gap', status: 'proposed' });
    const r = await applyCognitionDeltas(UID, [proposed]);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('proposed');
  });

  it('坏档写侧拒绝：主档坏 JSON → 拒写且不覆盖', async () => {
    fs.mkdirSync(path.dirname(storeFile()), { recursive: true });
    fs.writeFileSync(storeFile(), '{not json', 'utf8');
    const { applyCognitionDeltas } = await kernel();
    const d = await build({ op: 'set', home: 'personal_fact', fieldName: 'x', after: 'y' });
    const r = await applyCognitionDeltas(UID, [d]);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('corrupt');
    expect(fs.readFileSync(storeFile(), 'utf8')).toBe('{not json');
    const backups = fs.readdirSync(path.dirname(storeFile())).filter((f) => f.includes('.corrupt-'));
    expect(backups.length).toBeGreaterThanOrEqual(1);
  });

  it('版本流与台账：落地后逐对象 jsonl 追加 + 全局台账', async () => {
    const { applyCognitionDeltas, listCognitionVersions, cognitionAuditPath } = await kernel();
    const add = await build({ op: 'add', home: 'template', after: '周报三段式：进展/风险/下周计划' });
    const r = await applyCognitionDeltas(UID, [add]);
    expect(r.ok).toBe(true);
    const objectId = r.results[0].applied ? r.results[0].objectId : '';
    const versions = listCognitionVersions(UID, objectId);
    expect(versions).toHaveLength(1);
    expect(versions[0].op).toBe('add');
    expect(versions[0].after).toContain('周报');
    expect(fs.existsSync(versionsDir())).toBe(true);
    const auditRaw = fs.readFileSync(cognitionAuditPath(UID), 'utf8');
    expect(auditRaw).toContain('"template"');
  });

  it('purge 清掉审计摘要、标题和版本流，保留治理坐标', async () => {
    const { applyCognitionDeltas, purgeCognitionObject, loadCognitionStoreSync, cognitionAuditPath } = await kernel();
    const marker = 'SYNTHETIC_AUDIT_PURGE_BODY';
    const add = await build({ op: 'add', home: 'template', after: marker });
    const applied = await applyCognitionDeltas(UID, [add]);
    expect(applied.ok).toBe(true);
    if (!applied.results[0]?.applied) throw new Error('synthetic add was not applied');
    const objectId = applied.results[0].objectId;
    expect(fs.readFileSync(cognitionAuditPath(UID), 'utf8')).toContain(marker);

    await purgeCognitionObject(UID, objectId);

    const raw = fs.readFileSync(cognitionAuditPath(UID), 'utf8');
    expect(raw).not.toContain(marker);
    const row = raw.split('\n').filter(Boolean).map(line => JSON.parse(line))
      .find(entry => entry.ops?.some((op: { objectId?: string }) => op.objectId === objectId));
    expect(row).toBeTruthy();
    expect(row.journalKey).toBeTruthy();
    expect(row.ops.find((op: { objectId?: string }) => op.objectId === objectId).summary).toBe('[已清除]');
    expect(fs.existsSync(path.join(versionsDir(), `${objectId}.jsonl`))).toBe(false);
    const purged = loadCognitionStoreSync(UID).objects[objectId];
    expect(purged.statement).toBe('');
    expect(purged.title).toBe('');
  });

  it('purge 先在 pending journal 内清洗审计摘要，再 drain', async () => {
    const { applyCognitionDeltas, purgeCognitionObject, loadCognitionStoreSync, cognitionAuditPath } = await kernel();
    const marker = 'SYNTHETIC_PENDING_AUDIT_BODY';
    const add = await build({ op: 'add', home: 'template', after: marker });
    const applied = await applyCognitionDeltas(UID, [add]);
    expect(applied.ok).toBe(true);
    if (!applied.results[0]?.applied) throw new Error('synthetic add was not applied');
    const objectId = applied.results[0].objectId;
    fs.rmSync(cognitionAuditPath(UID), { force: true });
    const doc = loadCognitionStoreSync(UID);
    doc.pendingJournal = [{
      key: 'audit-pending-test',
      line: { at: new Date().toISOString(), ops: [{ objectId, op: 'add', home: 'template', origin: 'user', summary: marker }] },
    }];
    fs.writeFileSync(storeFile(), JSON.stringify(doc, null, 2), 'utf8');

    await purgeCognitionObject(UID, objectId);

    const raw = fs.readFileSync(cognitionAuditPath(UID), 'utf8');
    expect(raw).not.toContain(marker);
    const row = raw.split('\n').filter(Boolean).map(line => JSON.parse(line))
      .find(entry => entry.journalKey === 'audit-pending-test');
    expect(row).toBeTruthy();
    expect(row.ops[0].summary).toBe('[已清除]');
  });

  it('purge 丢弃无法解析的审计行', async () => {
    const { applyCognitionDeltas, purgeCognitionObject, cognitionAuditPath } = await kernel();
    const marker = 'SYNTHETIC_MALFORMED_AUDIT_BODY';
    const add = await build({ op: 'add', home: 'template', after: marker });
    const applied = await applyCognitionDeltas(UID, [add]);
    expect(applied.ok).toBe(true);
    if (!applied.results[0]?.applied) throw new Error('synthetic add was not applied');
    const objectId = applied.results[0].objectId;
    fs.appendFileSync(cognitionAuditPath(UID), 'not-json\n');

    await purgeCognitionObject(UID, objectId);

    const raw = fs.readFileSync(cognitionAuditPath(UID), 'utf8');
    expect(raw).not.toContain('not-json');
    expect(raw).not.toContain(marker);
    for (const line of raw.split('\n').filter(Boolean)) expect(() => JSON.parse(line)).not.toThrow();
  });

  it('objectId 路径穿越拒绝', async () => {
    const { applyCognitionDeltas } = await kernel();
    const evil = await build({ op: 'add', home: 'rule', after: 'x', objectId: '../../evil' });
    const r = await applyCognitionDeltas(UID, [evil]);
    expect(r.ok).toBe(false);
  });

  it('防御性归一：坏对象剔除、非法枚举回默认、appliedDeltas 有界', async () => {
    const { normalizeCognitionStoreDocument, APPLIED_DELTA_INDEX_MAX } = await import(
      '../../../../src/main/features/cognition_kernel/object-model'
    );
    const doc = normalizeCognitionStoreDocument({
      schemaVersion: 1,
      objects: {
        ok: { id: 'ok', kind: 'rule', home: 'rule', title: 't', statement: 's', status: 'weird', version: -3 },
        bad: { kind: 'rule' },
      },
      appliedDeltas: { 'd-1': true },
      appliedOrder: ['d-1'],
    });
    expect(Object.keys(doc.objects)).toEqual(['ok']);
    expect(doc.objects.ok.status).toBe('active');
    expect(doc.objects.ok.version).toBe(1);
    expect(doc.appliedDeltas).toEqual({ 'd-1': true });
    expect(APPLIED_DELTA_INDEX_MAX).toBeGreaterThan(0);
  });

  it('家注册表：空档种子默认六家；自定义家可加并可存；未知家拒收', async () => {
    const { loadCognitionStoreSync, applyCognitionDeltas, replaceCognitionHomes } = await kernel();
    const seeded = loadCognitionStoreSync(UID);
    expect(seeded.homes.map((h) => h.home)).toEqual(
      expect.arrayContaining(['personal_fact', 'rule', 'template', 'method', 'task_local', 'experience']),
    );

    // 加一个自定义家（联系人，断言语义）。
    const withCustom = [...seeded.homes, {
      home: 'contact', label: '联系人', definition: '与我协作的人及其关键信息。',
      examples: ['示例联系人是支付网关的对接人'], pool: 'ontology' as const, store: { kind: 'assertion' as const },
    }];
    const replaced = await replaceCognitionHomes(UID, withCustom);
    expect(replaced.ok).toBe(true);

    const delta = await build({ op: 'set', home: 'contact', fieldName: '对接人', after: '示例联系人' });
    const r = await applyCognitionDeltas(UID, [delta]);
    expect(r.ok).toBe(true);
    const doc = loadCognitionStoreSync(UID);
    const contactObject = Object.values(doc.objects).find((o) => o.home === 'contact');
    expect(contactObject?.kind).toBe('assertion');

    const unknown = await build({ op: 'set', home: 'not_a_home', fieldName: 'x', after: 'y' });
    const r2 = await applyCognitionDeltas(UID, [unknown]);
    expect(r2.ok).toBe(false);
  });

  it('家注册表写口校验：内置家不可删、id 重复拒绝、内置存储映射强制回出厂', async () => {
    const { loadCognitionStoreSync, replaceCognitionHomes } = await kernel();
    const seeded = loadCognitionStoreSync(UID);

    // 删掉一个内置家 → 拒绝。
    const missingBuiltin = seeded.homes.filter((h) => h.home !== 'experience');
    const r1 = await replaceCognitionHomes(UID, missingBuiltin);
    expect(r1.ok).toBe(false);
    expect(r1.error).toContain('experience');

    // id 重复 → 拒绝。
    const dup = [...seeded.homes, { ...seeded.homes[0] }];
    const r2 = await replaceCognitionHomes(UID, dup);
    expect(r2.ok).toBe(false);

    // 篡改内置家的存储映射（rule→bundle）→ 落库时强制回出厂 rule。
    const tampered = seeded.homes.map((h) =>
      h.home === 'rule' ? { ...h, store: { kind: 'bundle' as const, bundleKind: 'template' as const } } : h,
    );
    const r3 = await replaceCognitionHomes(UID, tampered);
    expect(r3.ok).toBe(true);
    const after = loadCognitionStoreSync(UID).homes.find((h) => h.home === 'rule');
    expect(after?.store?.kind).toBe('rule');
  });
});


describe('durable delta journal', () => {
  it('keeps both versions of a same-object batch', async () => {
    const k = await kernel();
    const first = await build({ op: 'set', home: 'personal_fact', fieldName: '负责人', after: '甲' });
    const second = await build({ op: 'set', home: 'personal_fact', fieldName: '负责人', after: '乙' });
    const outcome = await k.applyCognitionDeltas(UID, [first, second]);
    expect(outcome.ok).toBe(true);
    const object = Object.values(k.loadCognitionStoreSync(UID).objects)[0];
    expect(k.listCognitionVersions(UID, object.id).map(v => v.after)).toEqual(['甲', '乙']);
  });
  it('preserves readable history when projection fails, then retries without duplicates', async () => {
    const k = await kernel();
    const delta = await build({ op: 'add', home: 'rule', after: '持久化记录' });
    fs.mkdirSync(path.dirname(storeFile()), { recursive: true });
    fs.writeFileSync(versionsDir(), 'blocked');
    const outcome = await k.applyCognitionDeltas(UID, [delta]);
    expect(outcome).toMatchObject({ ok: true, pendingHistory: true });
    const object = Object.values(k.loadCognitionStoreSync(UID).objects)[0];
    expect(k.listCognitionVersions(UID, object.id)).toHaveLength(1);
    fs.unlinkSync(versionsDir());
    expect(await k.applyCognitionDeltas(UID, [delta])).toMatchObject({ ok: true, appliedCount: 0, pendingHistory: false });
    expect(k.listCognitionVersions(UID, object.id)).toHaveLength(1);
    expect(k.loadCognitionStoreSync(UID).pendingJournal).toEqual([]);
  });
  it('rejects reuse of a durable delta identity with changed content', async () => {
    const k = await kernel();
    const delta = await build({ op: 'add', home: 'rule', after: '原始' });
    expect((await k.applyCognitionDeltas(UID, [delta])).ok).toBe(true);
    expect(await k.applyCognitionDeltas(UID, [{ ...delta, after: '篡改' }])).toMatchObject({ ok: false, appliedCount: 0 });
    expect(Object.values(k.loadCognitionStoreSync(UID).objects)[0].statement).toBe('原始');
  });
});


describe('崩溃后日志与重放边界', () => {
  it('残缺 JSONL 尾行不会吞掉后续有效版本', async () => {
    const k = await kernel();
    const first = await build({ op: 'set', home: 'personal_fact', fieldName: '测试字段', after: '原始' });
    await k.applyCognitionDeltas(UID, [first]);
    const object = Object.values(k.loadCognitionStoreSync(UID).objects)[0];
    fs.appendFileSync(path.join(versionsDir(), object.id + '.jsonl'), '{"journalKey":"partial');
    const next = await build({ op: 'set', home: 'personal_fact', fieldName: '测试字段', after: '后续' });
    expect((await k.applyCognitionDeltas(UID, [next])).ok).toBe(true);
    expect(k.listCognitionVersions(UID, object.id).map(line => line.after)).toEqual(['原始', '后续']);
  });
  it('超过快速索引容量后，旧提交仍不能重放生效', async () => {
    const k = await kernel();
    const deltas = await Promise.all(Array.from({ length: 502 }, (_, index) => build({ op: 'set', home: 'personal_fact', fieldName: '重放验收', after: String(index) })));
    expect((await k.applyCognitionDeltas(UID, deltas)).ok).toBe(true);
    const replay = await k.applyCognitionDeltas(UID, [deltas[0]]);
    expect(replay).toMatchObject({ ok: true, appliedCount: 0 });
    expect(Object.values(k.loadCognitionStoreSync(UID).objects)[0]).toMatchObject({ statement: '501', version: 502 });
    // 502 条增量（快速索引容量 + 2）逐条落盘 + 复读，满载的 Windows runner 上
    // 30s 会被吃光（本用例报的是 Test timed out，不是断言失败）。边界语义不变，
    // 只把这条重 IO 用例的上限抬到 90s。
  }, 90_000);
  it('无凭证的自动值拒绝进入权威版本', async () => {
    const k = await kernel();
    const delta = await build({ op: 'add', home: 'rule', after: '未确认建议', origin: 'gap', status: 'applied' });
    expect(await k.applyCognitionDeltas(UID, [delta])).toMatchObject({ ok: false, appliedCount: 0 });
    expect(fs.existsSync(storeFile())).toBe(false);
  });
});
