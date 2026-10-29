import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../../../src/main/features/recall/store-events', () => ({ notifyCognitionWrite: vi.fn() }));
vi.mock('../../../src/main/logger', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));

const userId = 'ontology-usage-user';
let root: string, previousRoot: string | undefined;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-ontology-usage-'));
  previousRoot = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = root;
  vi.resetModules();
});
afterEach(() => {
  vi.restoreAllMocks();
  if (previousRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previousRoot;
  fs.rmSync(root, { recursive: true, force: true });
});

async function seedReadReceipt(taskRunId: string) {
  const { recordOntologyQueryReadReceipt } = await import('../../../src/main/features/cognition/ontology/query-receipt');
  return recordOntologyQueryReadReceipt(userId, taskRunId, [{ moduleId: 'project-module', recordId: 'owner-rule', recordVersion: 3,
    kind: 'rule', sourceKind: 'user' }]);
}

describe('ontology usage receipt', () => {
  it('records a same-turn citation from the persisted answer without copying answer text', async () => {
    const [{ finalizeOntologyUsageCitations, listOntologyUsageReceipts }, store] = await Promise.all([
      import('../../../src/main/features/cognition/ontology/usage-receipt'),
      import('../../../src/main/features/recall/store'),
    ]);
    const read = await seedReadReceipt('turn-ontology-applied');
    const citation = '[[ontology:project-module/owner-rule@3]]';
    const finalText = `本周报告按负责人规则整理。来源：${citation}`;
    const finalized = await finalizeOntologyUsageCitations(userId, { taskRunId: 'turn-ontology-applied', messageId: 'message-final', finalText });
    expect(finalized).toHaveLength(1);
    expect(finalized[0]).toMatchObject({ status: 'applied', boundary: 'real', evidenceKind: 'final_output',
      moduleId: 'project-module', recordId: 'owner-rule', recordVersion: 3, readReceiptId: read?.id, messageId: 'message-final', effectVerified: false });
    expect(await listOntologyUsageReceipts(userId, 'turn-ontology-applied')).toEqual(finalized);
    expect(await store.listRecallJsonlRecords(userId, 'ontology-usage-receipts', 'events', 0)).toHaveLength(1);
    const serialized = JSON.stringify(finalized[0]);
    expect(serialized).not.toContain(finalText);
    expect(serialized).not.toContain(citation);
    expect(await finalizeOntologyUsageCitations(userId, { taskRunId: 'turn-ontology-applied', messageId: 'message-final', finalText })).toEqual(finalized);
    expect(await store.listRecallJsonlRecords(userId, 'ontology-usage-receipts', 'events', 0)).toHaveLength(1);
  });

  it('does not turn a citation into adoption evidence unless that exact version was queried in this turn', async () => {
    const { finalizeOntologyUsageCitations, listOntologyUsageReceipts } = await import('../../../src/main/features/cognition/ontology/usage-receipt');
    await seedReadReceipt('turn-query-a');
    const wrongTurn = await finalizeOntologyUsageCitations(userId, { taskRunId: 'turn-query-b', messageId: 'message-final',
      finalText: '[[ontology:project-module/owner-rule@3]]' });
    const wrongVersion = await finalizeOntologyUsageCitations(userId, { taskRunId: 'turn-query-a', messageId: 'message-final',
      finalText: '[[ontology:project-module/owner-rule@2]]' });
    const unqueriedRecord = await finalizeOntologyUsageCitations(userId, { taskRunId: 'turn-query-a', messageId: 'message-final',
      finalText: '[[ontology:project-module/other-rule@3]]' });
    expect(wrongTurn).toEqual([]);
    expect(wrongVersion).toEqual([]);
    expect(unqueriedRecord).toEqual([]);
    expect(await listOntologyUsageReceipts(userId)).toEqual([]);
  });
});
