/**
 * 旧双库→统一库迁移测试：完整来源保真、引用槽位、多值与受限态保留、
 * dryRun 不写、真实运行先备份、幂等重跑零新增。
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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-ck-mig-'));
  prevWs = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  process.env.COGSEED_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function cognitionDir(): string {
  return path.join(tmpDir, UID, 'cloud', 'cognition');
}

function recallRecordsDir(collection: string): string {
  return path.join(tmpDir, UID, 'cloud', 'recall', 'records', collection);
}

function writePoDoc(): void {
  const doc = {
    schemaVersion: 2,
    groups: [
      {
        id: 'g-fin',
        kind: 'user',
        title: '财务信息',
        createdAt: '2026-09-01T00:00:00Z',
        updatedAt: '2026-09-01T00:00:00Z',
        fields: [
          { id: 'f-bank', name: '银行卡号', origin: 'user', createdAt: '2026-09-01T00:00:00Z' },
          { id: 'f-dept', name: '部门', origin: 'user', createdAt: '2026-09-01T00:00:00Z' },
          { id: 'f-pref', name: '回复偏好', origin: 'user', createdAt: '2026-09-01T00:00:00Z' },
        ],
        values: [
          { id: 'v-bank', fieldId: 'f-bank', text: '6222…1234', source: 'manual', createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z' },
          { id: 'v-dept', fieldId: 'f-dept', text: '开源项目组', source: 'manual', createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z' },
          { id: 'v-proj', fieldId: 'f-pref', text: '我偏好简短中文回复', source: 'candidate', assetId: 'aa-pers-1', createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z' },
          { id: 'v-secret', fieldId: 'f-bank', text: '绝密：不该进任务注入的值', source: 'manual', restricted: true, createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z' },
        ],
        entries: [],
      },
    ],
    trash: [],
    updatedAt: '2026-09-01T00:00:00Z',
  };
  fs.mkdirSync(cognitionDir(), { recursive: true });
  fs.writeFileSync(path.join(cognitionDir(), 'personal-ontology.json'), JSON.stringify(doc), 'utf8');
}

function writeRecallFixtures(): void {
  const assetsDir = recallRecordsDir('ability-assets');
  fs.mkdirSync(assetsDir, { recursive: true });
  const mk = (id: string, type: string, title: string, statement: string, extra: Record<string, unknown> = {}) => ({
    id, schemaVersion: 2, ownerId: UID, evidenceRefs: [], origin: 'manual',
    candidateId: `c-${id}`,
    reviewDecisionId: `rd-${id}`,
    type,
    title,
    statement,
    scope: 'global',
    status: 'active',
    lifecycleStatus: 'user_confirmed_unverified',
    maturity: 'seed',
    version: '1',
    createdAt: '2026-09-01T00:00:00Z',
    updatedAt: '2026-09-01T00:00:00Z',
    ...extra,
  });
  fs.writeFileSync(path.join(assetsDir, 'aa-rule-1.json'), JSON.stringify(mk('aa-rule-1', 'rule', '报销规则', '住宿报销按城市封顶', { applicableWhen: ['出差住宿'], forbiddenWhen: ['节假日'] })), 'utf8');
  fs.writeFileSync(path.join(assetsDir, 'aa-pers-1.json'), JSON.stringify(mk('aa-pers-1', 'personal', '回复偏好', '我偏好简短中文回复')), 'utf8');
  fs.writeFileSync(path.join(assetsDir, 'aa-tpl-1.json'), JSON.stringify(mk('aa-tpl-1', 'template', '周报模板', '周报按进展/风险/下周计划三段写')), 'utf8');
  fs.writeFileSync(path.join(assetsDir, 'aa-del-1.json'), JSON.stringify(mk('aa-del-1', 'rule', '已删规则', '不应出现', { status: 'deleted' })), 'utf8');

  const candDir = recallRecordsDir('candidates');
  fs.mkdirSync(candDir, { recursive: true });
  fs.writeFileSync(path.join(candDir, 'rc-1.json'), JSON.stringify({ id: 'rc-1', schemaVersion: 2, ownerId: UID, status: 'pending_review', suggestedType: 'rule', value: '对外报价不承诺交期', createdAt: '2026-09-02T00:00:00Z' }), 'utf8');
  fs.writeFileSync(path.join(candDir, 'rc-2.json'), JSON.stringify({ id: 'rc-2', schemaVersion: 2, ownerId: UID, status: 'rejected', suggestedType: 'rule', value: '已驳回的历史候选', createdAt: '2026-09-02T00:00:00Z' }), 'utf8');
}

function mods() {
  return Promise.all([
    import('../../../../src/main/features/cognition_migration'),
    import('../../../../src/main/features/cognition_kernel/store'),
    import('../../../../src/main/features/cognition_kernel/pool'),
  ]).then(([mig, store, pool]) => ({ mig, store, pool }));
}

describe('cognition_migration — 三源迁移', () => {
  it('dryRun：只算不写（库/池/备份都不动），计数与差异正确', async () => {
    writePoDoc();
    writeRecallFixtures();
    const { mig, store, pool } = await mods();
    const report = await mig.migrateLegacyCognition(UID, { dryRun: true });
    expect(report.dryRun).toBe(true);
    expect(report.poValues.total).toBe(4);
    expect(report.poValues.skippedProjection).toBe(1);
    expect(report.poValues.skippedRestricted).toBe(0);
    expect(report.poValues.migrated).toBe(3);
    expect(report.assets.total).toBe(4);
    expect(report.assets.skippedTerminal).toBe(0);
    expect(report.assets.migrated).toBe(4); // rule + template + personal（personal 落投影槽位）
    expect(fs.existsSync(store.cognitionStorePath(UID))).toBe(false);
    expect(pool.loadPoolSync(UID).items).toHaveLength(0);
    const backups = fs.readdirSync(cognitionDir()).filter((f) => f.startsWith('migration-backup-'));
    expect(backups).toHaveLength(0);
  });

  it('真实运行：备份先行、完整治理与候选保留、正文条件分开存储', async () => {
    writePoDoc();
    writeRecallFixtures();
    const { mig, store, pool } = await mods();
    const report = await mig.migrateLegacyCognition(UID);
    expect(report.errors).toEqual([]);
    expect(report.backupDir).toBeTruthy();
    expect(fs.existsSync(report.backupDir as string)).toBe(true);

    const doc = store.loadCognitionStoreSync(UID);
    const objects = Object.values(doc.objects);
    // 断言：银行卡号 + 部门（投影值跳过，由资产侧落同一槽位）
    const bank = objects.find((o) => o.fieldName === '银行卡号');
    expect(bank?.statement).toBe('6222…1234');
    // 受限标记保真：迁移后仍不进入任务读取。
    expect(objects.find((o) => o.statement.includes('绝密'))).toMatchObject({ restricted: true });
    // personal 资产 aa-pers-1 的 po 投影（assetId 对上）→ 断言落投影槽位（回复偏好），
    // 槽位值=资产正文——「同一内容两处账」合一；规则资产独立成 rule 对象（带适用/禁止）
    const projected = objects.find((o) => o.fieldName === '回复偏好');
    expect(projected?.statement).toBe('我偏好简短中文回复');
    expect(projected?.kind).toBe('assertion');
    const dept = objects.find((o) => o.fieldName === '部门');
    expect(dept?.statement).toBe('开源项目组');
    const ruleObj = objects.find((o) => o.id === 'aa-rule-1');
    expect(ruleObj?.kind).toBe('rule');
    expect(ruleObj?.statement).toBe('住宿报销按城市封顶');
    expect(doc.compatibility?.records['ability-assets']['aa-rule-1'].applicableWhen).toEqual(['出差住宿']);
    expect(doc.compatibility?.records['ability-assets']['aa-rule-1'].forbiddenWhen).toEqual(['节假日']);
    // 模板资产 → bundle
    const tpl = objects.find((o) => o.kind === 'bundle');
    expect(tpl?.statement).toContain('周报');
    expect(tpl?.id).toBe('aa-tpl-1');
    // 删除态保留墓碑/恢复期，不会复活。
    expect(objects.find((o) => o.id === 'aa-del-1')).toMatchObject({ status: 'deleted' });

    // 候选按完整旧契约保留，不再复制一份未接线的统一池。
    const items = pool.loadPoolSync(UID).items;
    expect(items).toHaveLength(0);
    expect(Object.keys(doc.compatibility?.records.candidates ?? {})).toEqual(['rc-1', 'rc-2']);

    const reports = fs.readdirSync(cognitionDir()).filter((f) => f.startsWith('migration-report-'));
    expect(reports.length).toBe(0); // 报告由调用方展示，预检和迁移不留下含正文的额外报告副本。
  });

  it('幂等重跑：按身份核对零差异（对象数与池数不变）', async () => {
    writePoDoc();
    writeRecallFixtures();
    const { mig, store, pool } = await mods();
    await mig.migrateLegacyCognition(UID);
    const before = Object.keys(store.loadCognitionStoreSync(UID).objects).length;
    const poolBefore = pool.loadPoolSync(UID).items.length;
    const report2 = await mig.migrateLegacyCognition(UID);
    expect(report2.errors).toEqual([]);
    expect(Object.keys(store.loadCognitionStoreSync(UID).objects).length).toBe(before);
    expect(pool.loadPoolSync(UID).items.length).toBe(poolBefore);
  });
});
