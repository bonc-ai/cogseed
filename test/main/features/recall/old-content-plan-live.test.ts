/** Explicitly opt-in: one isolated nightly run with the real production model.
 * Credentials and all fixture data live under a disposable OS-temporary root. */
import { expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { drainMainRuntimeForTest } from '../../../helpers/drain-main-runtime';

const requireCjs = createRequire(import.meta.url);

it.skipIf(process.env.COGSEED_RECALL_LIVE !== '1')('real-model isolated old-content plan lifecycle', async () => {
  vi.resetModules();
  const authRoot = process.env.COGSEED_RECALL_LIVE_AUTH_ROOT;
  const authUid = process.env.COGSEED_RECALL_LIVE_AUTH_UID;
  if (!authRoot || !authUid) throw new Error('explicit live auth root and uid required');
  const root = process.env.COGSEED_RECALL_LIVE_FIXTURE_ROOT
    || await fs.mkdtemp(path.join(os.tmpdir(), 'cogseed-old-content-live-'));
  if (!(await fs.realpath(root)).startsWith(await fs.realpath(os.tmpdir()))) throw new Error('live fixtures require OS-temporary isolation');
  const targetConfig = path.join(root, authUid, 'local/config');
  await fs.mkdir(targetConfig, { recursive: true, mode: 0o700 });
  for (const name of ['auth-profiles.json', 'account.json']) {
    const source = path.join(authRoot, authUid, 'local/config', name);
    await fs.copyFile(source, path.join(targetConfig, name)).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    });
  }
  vi.stubEnv('COGSEED_WORKSPACE_ROOT', root);
  const budgetRoot = process.env.COGSEED_RECALL_LIVE_BUDGET_ROOT;
  if (!budgetRoot) throw new Error('explicit disposable live budget root required');
  let modelCalls = 0;
  const maxCalls = Number(process.env.COGSEED_RECALL_LIVE_MAX_REQUESTS || 8);
  const budgeted = requireCjs('../../../helpers/recall-live-budget.cjs').installRecallLiveBudget(budgetRoot, globalThis.fetch, {
    maxRequests: maxCalls, limitCny: 20, reservedCeilingCny: 20, billingMode: 'coding-plan',
  });
  globalThis.fetch = ((input: any, init: any) => {
    const url = String(typeof input === 'string' ? input : input?.url || '');
    const isModel = /\/chat\/completions$/.test(new URL(url).pathname)
      && String(init?.method || 'POST').toUpperCase() === 'POST';
    if (isModel) {
      if (modelCalls >= maxCalls) throw new Error('live request-count budget exhausted before dispatch');
      modelCalls += 1;
    }
    return budgeted(input, init);
  }) as typeof fetch;
  const uid = authUid;
  const report: Record<string, unknown> = { synthetic: true, planCount: 0, readyPlans: 0, unresolvedPlans: 0,
    executed: false, undone: false, stages: [], modelCalls: 0 };
  const users = await import('../../../../src/main/features/users');
  users.activateUser(uid);
  const storage = await import('../../../../src/main/storage');
  const layout = await import('../../../../src/main/util/project-layout');
  const chats = await import('../../../../src/main/features/chats');
  const { appendVisible } = await import('../../../../src/main/features/group_chat/visibility');
  const capture = await import('../../../../src/main/features/recall/capture-service');
  const routing = await import('../../../../src/main/features/recall/capture-model-routing');
  if (process.env.COGSEED_RECALL_LIVE_DUMP_RAW === '1') {
    const realRun = routing.runRecallCaptureModel;
    vi.spyOn(routing, 'runRecallCaptureModel').mockImplementation(async (owner, input) => {
      const output = await realRun(owner, input);
      if (String(input.sessionId).includes('value-recall')) {
        await fs.appendFile(path.join(root, 'value-raw.log'),
          JSON.stringify({ sessionId: input.sessionId, error: output.result.meta?.error || null,
            text: output.result.text }) + '\n');
      }
      return output;
    });
  }
  const settings = await import('../../../../src/main/features/recall/capture-settings');
  const candidates = await import('../../../../src/main/features/recall/candidate-service');
  const assets = await import('../../../../src/main/features/recall/asset-service');
  const service = await import('../../../../src/main/features/recall/old-content-plan-service');
  const undo = await import('../../../../src/main/features/recall/old-content-undo');
  const store = await import('../../../../src/main/features/recall/store');
  const bridge = await import('../../../../src/main/features/cognition_bridge');
  await bridge.replaceCognitionSources(uid, { mode: 'unified', revision: 1,
    records: { 'ability-assets': {}, candidates: {} }, po: { groups: [], trash: [] },
    pendingProjection: false, migratedAt: new Date().toISOString() });
  const seed = async (id: string, statement: string) => {
    const at = new Date().toISOString();
    const record = { schemaVersion: 2, ownerId: uid, id, candidateId: 'synthetic-seed', reviewDecisionId: 'rd_syntheticseed',
      type: 'rule', contentCategory: 'rule', title: id, statement, evidenceRefs: [], origin: 'manual', status: 'active',
      maturity: 'bud', lifecycleStatus: 'user_confirmed_unverified', scope: 'report', version: '1', activeVersion: '1',
      createdAt: at, updatedAt: at };
    await store.writeRecallJsonRecord(uid, 'ability-assets', id, record);
    await assets.initializeAbilityAsset(uid, record, { actor: 'user', reason: 'Synthetic old-content live seed' });
  };
  await seed('live-a', '提交报告前核对来源。');
  await seed('live-b', '提交报告前写结论。');
  const cid = 'old-content-live-conversation';
  if (!await chats.getConversation(uid, cid)) await chats.createConversation(uid, { conversationId: cid, title: '隔离验收：报告核对要求' });
  const message = { id: 'old-content-live-user-1', from: 'user' as const, to: ['commander'],
    text: '以后正式报告提交前，先核对来源，再写结论；这两条要求合在一起长期执行。',
    ts: new Date().toISOString() };
  await storage.appendJsonlAtomic(layout.conversationMessageFile(uid, cid), message);
  await appendVisible(uid, cid, message, ['commander']);
  await chats.updateConversation(uid, cid, {});
  await settings.updateRecallCaptureSettings(uid, { enabled: true, autoApproval: false, executionPolicy: 'nightly',
    nightlyStart: '02:00', nightlyEnd: '06:00', modelCandidates: [{ provider: 'zai', model: 'glm-5.2' }] });
  const beforeVersions = Object.fromEntries((await assets.listAbilityAssets(uid)).map(asset => [asset.id, asset.activeVersion || asset.version]));
  const sweep = await capture.runManualCaptureSweep(uid);
  const captureDir = path.dirname((await import('../../../../src/main/features/recall/paths')).recallJsonRecordPath(uid, 'captures', 'probe'));
  const captureIds = await fs.readdir(captureDir).then(names => names.filter(name => name.endsWith('.json')).map(name => name.slice(0, -5))).catch(() => []);
  for (const id of captureIds) {
    const row = await capture.readRecallCapture(uid, id);
    if (row?.status === 'queued') await capture.runRecallCapture(uid, id);
  }
  const captureRows = [];
  for (const id of captureIds) {
    const row = await capture.readRecallCapture(uid, id).catch(() => null);
    captureRows.push(row ? { id, status: row.status, errorCode: row.errorCode || '' } : { id, status: 'unreadable', errorCode: '' });
  }
  report.captureStatuses = captureRows;
  report.modelCalls = modelCalls;
  const plans = await service.listActionableOldContentPlans(uid);
  report.planCount = plans.length;
  report.readyPlans = plans.filter(plan => plan.status === 'ready').length;
  report.unresolvedPlans = plans.filter(plan => plan.status === 'needs_review').length;
  report.sweep = { ran: sweep.ran, phase: sweep.phase };
  report.captures = captureIds.length;
  report.candidates = (await candidates.listRecallCandidates(uid)).map(row => ({ id: row.id, status: row.status,
    hasPlan: Boolean(row.oldContentPlan), planStatus: row.oldContentPlanState }));
  const afterSweep = Object.fromEntries((await assets.listAbilityAssets(uid)).map(asset => [asset.id, asset.activeVersion || asset.version]));
  report.noWriteBeforeApproval = JSON.stringify(beforeVersions) === JSON.stringify(afterSweep);
  const ready = plans.find(plan => plan.status === 'ready');
  if (ready) {
    const plan = await service.readOldContentPlan(uid, ready.id);
    report.plan = { status: plan.status, unresolved: plan.unresolved.length,
      items: plan.items.map(item => ({ itemId: item.itemId, action: item.action,
        assetIds: item.assetIds, targetAssetId: item.targetAssetId, reasonCode: item.reasonCode })) };
    const executed = await service.executeOldContentPlan(uid, plan.id);
    report.executed = executed.results.some(result => result.status === 'applied' || result.status === 'kept');
    report.unitResults = executed.results;
    const applied = await service.readOldContentPlan(uid, plan.id);
    report.appliedStatus = applied.status;
    const audits = await assets.listAbilityAssetAudit(uid, plan.assetIds[0]);
    report.auditWritten = audits.some(row => row.action === 'old_content_applied');
    const preview = await undo.previewOldContentUndo(uid, plan.id);
    report.undoBlockers = preview.blockers;
    if (!preview.blockers.length) {
      const result = await undo.undoOldContentPlan(uid, plan.id, preview.token);
      report.undone = result.undone;
      const restored = await service.readOldContentPlan(uid, plan.id);
      report.undoneStatus = restored.status;
    }
  }
  await fs.writeFile(path.join(root, 'old-content-live-report.json'), JSON.stringify(report, null, 2));
  process.stdout.write(`OLD_CONTENT_LIVE ${JSON.stringify(report)}\n`);
  await drainMainRuntimeForTest(uid);
  expect(report.noWriteBeforeApproval).toBe(true);
  expect(modelCalls).toBeGreaterThan(0);
  const modelFailure = modelCalls === 0
    || captureRows.some(row => row.status === 'failed' || row.errorCode);
  expect(modelFailure ? 'model_failed' : 'model_ok').toBe('model_ok');
  // Transport alone is not acceptance: the run must also produce at least one
  // executable old-content plan before this gate can pass.
  expect(report.readyPlans).toBeGreaterThan(0);
}, 0);
