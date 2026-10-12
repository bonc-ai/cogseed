import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// US-602（2026-09-25 验收修复）主进程侧：
//  ①「真实使用」白名单必须只有一类定义（REAL_USAGE_KINDS），随载荷下发；
//  ② 采用回执的视图投影——「实际采用」的唯一权威，按资产取、只透传 ref 元数据。

let tmpDir: string;
let prevRoot: string | undefined;
const UID = 'user-usage-view';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-usage-view-'));
  prevRoot = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  if (prevRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = prevRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('真实使用白名单（REAL_USAGE_KINDS）', () => {
  it('恰好是两类真实使用事件，且不含任何治理/版本/撤销事件', async () => {
    const timeline = await import('../../../../src/main/features/recall/timeline-service');

    expect([...timeline.REAL_USAGE_KINDS]).toEqual(['usage_recorded', 'projection_confirmed']);
    // 创建、版本、治理、撤销一律不是"使用"——它们抬高「最近使用」就是缺陷本体。
    for (const kind of ['asset_created', 'asset_version', 'asset_version_selected', 'asset_paused', 'asset_resumed', 'asset_revoked', 'asset_archived', 'asset_deleted', 'asset_purged', 'asset_restored', 'asset_rolled_back', 'projection_revoked']) {
      expect(timeline.REAL_USAGE_KINDS as readonly string[]).not.toContain(kind);
    }
  });

  it('从 features/recall 桶可导入（下游 specs/012 等直接引用这一份）', async () => {
    const recall = await import('../../../../src/main/features/recall');
    expect([...recall.REAL_USAGE_KINDS]).toEqual(['usage_recorded', 'projection_confirmed']);
  });
});

describe('采用回执视图（listAssetUsageReceiptViews）', () => {
  async function seedReceipts(projectionId = 'proj-view') {
    const users = await import('../../../../src/main/features/users');
    users.activateUser(UID);
    const receipts = await import('../../../../src/main/features/recall/asset-usage-receipt');
    const injection = await import('../../../../src/main/features/recall/injection-receipt');
    const taskRunId = 'turn-view-1';
    // 回执必须外键到真实存在的注入回执（taskRunId/projectionId/assetId/assetVersion
    // 四键一致校验），id 是哈希，不能编。
    const injectionReceipt = await injection.recordInjectionReceipt(UID, {
      taskRunId, projectionId, assetId: 'aa-view', assetVersion: '2', boundary: 'real', status: 'injected',
    });
    return { receipts, taskRunId, projectionId, injectionReceiptId: injectionReceipt.id };
  }

  it('按资产取、按时间倒序、只透传 ref 元数据（不含正文/摘录）', async () => {
    const { receipts, taskRunId, projectionId, injectionReceiptId } = await seedReceipts();
    const injection = await import('../../../../src/main/features/recall/injection-receipt');

    await receipts.recordAssetUsageReceipt(UID, {
      taskRunId, projectionId, assetId: 'aa-view', assetVersion: '2',
      injectionReceiptId, status: 'applied', evidenceKind: 'artifact', boundary: 'real',
      evidenceRefs: [{ kind: 'artifact_file', id: 'art-1', title: '季度报告.html', excerpt: '这段摘录不许透传' }],
    });
    // 回执按 (task,投影,资产,版本) 四元组幂等：要造第二条得换版本，注入回执也得对上。
    const v1Injection = await injection.recordInjectionReceipt(UID, {
      taskRunId, projectionId, assetId: 'aa-view', assetVersion: '1', boundary: 'real', status: 'injected',
    });
    await receipts.recordAssetUsageReceipt(UID, {
      taskRunId, projectionId, assetId: 'aa-view', assetVersion: '1',
      injectionReceiptId: v1Injection.id, status: 'usage_unknown', evidenceKind: 'none', boundary: 'real',
      evidenceRefs: [],
    });
    // 别的资产不该混进来：给它自己一条合法回执，验证按 assetId 过滤真的生效。
    const otherInjection = await injection.recordInjectionReceipt(UID, {
      taskRunId, projectionId: 'proj-other', assetId: 'aa-other', assetVersion: '1', boundary: 'real', status: 'injected',
    });
    await receipts.recordAssetUsageReceipt(UID, {
      taskRunId, projectionId: 'proj-other', assetId: 'aa-other', assetVersion: '1',
      injectionReceiptId: otherInjection.id, status: 'applied', evidenceKind: 'tool_call', boundary: 'real',
      evidenceRefs: [{ kind: 'conversation', id: 'conv-x' }],
    });

    const views = await receipts.listAssetUsageReceiptViews(UID, 'aa-view');
    expect(views).toHaveLength(2);
    expect(views.every((view) => view.id.startsWith('aur-'))).toBe(true);
    // 别的资产的回执不在结果里。
    expect(views.some((view) => view.evidenceKind === 'tool_call')).toBe(false);
    // 只透传 kind/id/title —— 摘录与正文一律不带。
    const applied = views.find((view) => view.status === 'applied');
    expect(applied).toMatchObject({ assetVersion: '2', evidenceKind: 'artifact', boundary: 'real' });
    expect(applied?.evidence[0]).toEqual({ kind: 'artifact_file', id: 'art-1', title: '季度报告.html' });
    expect(JSON.stringify(views)).not.toContain('这段摘录不许透传');
    expect(Object.keys(applied!).sort()).toEqual(['assetVersion', 'boundary', 'createdAt', 'evidence', 'evidenceKind', 'id', 'status', 'taskRunId']);
  });

  it('limit 生效，非法入参拒绝', async () => {
    const { receipts, taskRunId, projectionId, injectionReceiptId } = await seedReceipts();
    const injection = await import('../../../../src/main/features/recall/injection-receipt');
    await receipts.recordAssetUsageReceipt(UID, {
      taskRunId, projectionId, assetId: 'aa-view', assetVersion: '2',
      injectionReceiptId, status: 'applied', evidenceKind: 'artifact', boundary: 'real',
      evidenceRefs: [{ kind: 'artifact_file', id: 'art-1', title: '报告.html' }],
    });
    const v1Injection = await injection.recordInjectionReceipt(UID, {
      taskRunId, projectionId, assetId: 'aa-view', assetVersion: '1', boundary: 'real', status: 'injected',
    });
    await receipts.recordAssetUsageReceipt(UID, {
      taskRunId, projectionId, assetId: 'aa-view', assetVersion: '1',
      injectionReceiptId: v1Injection.id, status: 'contradicted', evidenceKind: 'agent_action', boundary: 'real',
      evidenceRefs: [{ kind: 'conversation', id: 'conv-y' }],
    });

    expect((await receipts.listAssetUsageReceiptViews(UID, 'aa-view', 1)).length).toBe(1);
    await expect(receipts.listAssetUsageReceiptViews(UID, '../escape')).rejects.toThrow('invalid asset usage receipt query');
  });
});
