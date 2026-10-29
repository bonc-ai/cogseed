import { seedStoredAbilityAsset } from '../helpers/stored-ability-asset';
/** 审批审计动作与渲染标签、四语词条及时间线映射的对应关系。 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
const UID = 'probe-sm5-ap';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-probe-sm5-'));
  prevWs = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  process.env.COGSEED_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function mkAsset(id: string) {
  const assets = await import('../../src/main/features/recall/asset-service');
  const now = new Date().toISOString();
  return seedStoredAbilityAsset(UID, {
    schemaVersion: 2, ownerId: UID, id, candidateId: `cand-${id}`,
    sourceCandidateIds: [`cand-${id}`], reviewDecisionId: `rd_probe${id.slice(-6)}`.padEnd(16, 'x'),
    type: 'personal', title: `资产 ${id}`, statement: `陈述 ${id}。`,
    evidenceRefs: [{ kind: 'conversation', id: `conv-${id}` }], scope: 'general', status: 'active',
    lifecycleStatus: 'user_confirmed_unverified', maturity: 'bud', version: '1',
    createdAt: now, updatedAt: now,
  }, { actor: 'user', reason: 'probe seed' });
}

const APPROVAL_ACTIONS = ['approval_proposed', 'approval_confirmed', 'approval_rejected', 'approval_deferred', 'approval_edited'];

describe('审批审计动作的渲染契约', () => {
  it('审批提议与确认后的审计动作、标签表及四语词条映射', async () => {
    await mkAsset('aa-ap5audit1');
    const approval = await import('../../src/main/features/recall/asset-approval-service');
    const { proposal } = await approval.createAssetChangeProposal(UID, {
      assetId: 'aa-ap5audit1', baselineVersion: '1', fields: ['statement'],
      payload: { statement: '改后的陈述。' }, before: '陈述 aa-ap5audit1。', after: '改后的陈述。',
      reason: 'AI 提议补充说明',
    });
    const decision = await approval.decideAssetChangeProposal(UID, proposal.id, 'confirm');
    expect(decision.ok).toBe(true);

    // 数据面：审计流（渲染层 versions.list 的 audit 读的同一来源）含审批行。
    const { listRecallJsonlRecords } = await import('../../src/main/features/recall/store');
    const auditRows = await listRecallJsonlRecords(UID, 'ability-asset-audit', 'aa-ap5audit1', 0);
    const actions = auditRows.map((row) => String(row.action));
    expect(actions).toContain('approval_proposed');
    expect(actions).toContain('approval_confirmed');

    // 渲染面 1：views.js 台账标签表覆盖全部审批 action，不再裸出英文键。
    const viewsSrc = fs.readFileSync(path.resolve(__dirname, '../../src/renderer/modules/cognition-assets/views.js'), 'utf8');
    const labelBlock = viewsSrc.slice(viewsSrc.indexOf('AUDIT_ACTION_LABELS'), viewsSrc.indexOf('AUDIT_ACTOR_LABELS'));
    const missingLabels = APPROVAL_ACTIONS.filter((action) => !labelBlock.includes(`${action}:`));
    expect(missingLabels).toEqual([]);

    // 渲染面 2：四语 locale 具备 approval action 对应的审计词条。
    const localeKeys = APPROVAL_ACTIONS.map((action) => `cognition.audit_${action}`);
    for (const locale of ['zh', 'en', 'ja', 'pt']) {
      const localeJson = JSON.parse(fs.readFileSync(
        path.resolve(__dirname, `../../src/renderer/locales/${locale}.json`), 'utf8'));
      const keys = Object.keys(localeJson);
      expect(localeKeys.filter((key) => !keys.includes(key)), locale).toEqual([]);
    }
  });

  it('对照组：既有 26 键标签表对 updated 行照常命中（缺口仅审批族）', async () => {
    const assets = await import('../../src/main/features/recall/asset-service');
    await mkAsset('aa-ap5audit2');
    await assets.updateAbilityAsset(UID, 'aa-ap5audit2', { statement: '新正文。', reason: 'probe', actor: 'user' });
    const { listRecallJsonlRecords } = await import('../../src/main/features/recall/store');
    const actions = (await listRecallJsonlRecords(UID, 'ability-asset-audit', 'aa-ap5audit2', 0))
      .map((row) => String(row.action));
    expect(actions).toContain('created');
    expect(actions).toContain('updated');
    const viewsSrc = fs.readFileSync(path.resolve(__dirname, '../../src/renderer/modules/cognition-assets/views.js'), 'utf8');
    const labelBlock = viewsSrc.slice(viewsSrc.indexOf('AUDIT_ACTION_LABELS'), viewsSrc.indexOf('AUDIT_ACTOR_LABELS'));
    expect(labelBlock.includes('updated:')).toBe(true);
  });
});
