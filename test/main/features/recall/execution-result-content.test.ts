import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
vi.mock('../../../../src/main/features/chats', () => ({ getConversation: async () => ({ conversation_id: 'conv-a' }) }));
vi.mock('../../../../src/main/features/user_workspace', () => ({ getWorkspacePath: () => process.env.COGSEED_WORKSPACE_ROOT }));
let root: string;
beforeEach(async () => { vi.resetModules(); root = await fs.mkdtemp(path.join(os.tmpdir(), 'cogseed-result-binding-')); vi.stubEnv('COGSEED_WORKSPACE_ROOT', root); });
afterEach(async () => { vi.unstubAllEnvs(); await fs.rm(root, { recursive: true, force: true }); });
async function completed(produced?: string[]) {
  const records = await import('../../../../src/main/features/execution-records');
  const content = await import('../../../../src/main/features/recall/execution-result-content');
  const layout = await import('../../../../src/main/util/project-layout');
  const storage = await import('../../../../src/main/storage');
  await records.create('user-a', { executionId: 'turn-task-a', kind: 'core-agent', sessionId: 'one-shot-a', conversationId: 'conv-a', agentId: 'commander', boundary: 'real', permissionMode: 'read-only', bindResultMessage: true });
  await records.complete('user-a', 'turn-task-a', { status: 'completed', output: 'All requirements completed.' });
  const message = { id: 'reply-a', from: 'commander', text: 'All requirements completed.', turn_id: 'task-a', turn_end: true, produced };
  await storage.appendJsonlAtomic(layout.conversationMessageFile('user-a', 'conv-a'), message);
  await content.bindExecutionResultMessage('user-a', 'turn-task-a', 'conv-a', message);
  return { records, content, message };
}
describe('trusted execution result bindings', () => {
  it('persists an anonymous host result and recovers a manifest committed before its record binding', async () => {
    const records = await import('../../../../src/main/features/execution-records');
    const content = await import('../../../../src/main/features/recall/execution-result-content');
    const storage = await import('../../../../src/main/storage');
    const file = path.join(root, 'worker.md'); await fs.writeFile(file, '真实匿名成果的尾部限制。');
    await records.create('user-a', { executionId: 'turn-worker-a', kind: 'core-agent', sessionId: 'anon-a', conversationId: 'conv-a', agentId: 'worker-a', boundary: 'real', permissionMode: 'read-only', bindResultOutput: true });
    await records.complete('user-a', 'turn-worker-a', { status: 'completed', output: 'Worker final response.' });
    await content.bindExecutionResultOutput('user-a', 'turn-worker-a', 'conv-a', 'worker-a', 'Host-settled response.', [file]);
    let record = await records.read('user-a', 'turn-worker-a');
    expect(record.resultMessage).toBeUndefined();
    expect(JSON.stringify(record)).not.toContain(file);
    await storage.writeJson(records.executionRecordPath('user-a', record.executionId), { ...record, resultOutput: 'pending' });
    record = await records.read('user-a', record.executionId);
    const result = await content.readExecutionResultContent('user-a', record);
    expect(result.text).toContain('真实匿名成果的尾部限制');
    expect(result.refs[0].kind).toBe('execution_output');
    expect((await records.read('user-a', record.executionId)).resultOutput).not.toBe('pending');
    await fs.writeFile(file, '后续改动不能冒充原成果。');
    await expect(content.readExecutionResultContent('user-a', record)).rejects.toThrow('changed');
  });
  it('recovers a persisted official reply after interruption without rerunning its execution', async () => {
    const records = await import('../../../../src/main/features/execution-records');
    const { readExecutionResultContent } = await import('../../../../src/main/features/recall/execution-result-content');
    const storage = await import('../../../../src/main/storage');
    const layout = await import('../../../../src/main/util/project-layout');
    await records.create('user-a', { executionId: 'turn-interrupted', kind: 'core-agent', sessionId: 'session-a', conversationId: 'conv-a', agentId: 'commander', boundary: 'real', permissionMode: 'read-only', bindResultMessage: true });
    await records.complete('user-a', 'turn-interrupted', { status: 'completed', output: 'Persisted result.' });
    await storage.appendJsonlAtomic(layout.conversationMessageFile('user-a', 'conv-a'), { id: 'recovered-reply', from: 'commander', text: 'Persisted result.', turn_id: 'interrupted', turn_end: true });
    expect((await readExecutionResultContent('user-a', await records.read('user-a', 'turn-interrupted'))).text).toBe('Persisted result.');
  });
  it('reads actual produced content even when the reply claims success, then refuses a changed artifact', async () => {
    const file = path.join(root, 'report.md'); await fs.writeFile(file, 'Missing the required owner.');
    const { records, content } = await completed([file]);
    const record = await records.read('user-a', 'turn-task-a');
    const result = await content.readExecutionResultContent('user-a', record);
    expect(result.text).toContain('Missing the required owner.');
    expect(result.coverage).toEqual({ complete: true, totalFiles: 1, readableFiles: 1 });
    await fs.writeFile(file, 'Owner: a different later version.');
    await expect(content.readExecutionResultContent('user-a', record)).rejects.toThrow('changed');
    await expect(records.bindCompletedResultMessage('user-a', 'turn-task-a', 'conv-a', { id: 'other', refs: result.refs })).rejects.toThrow('rebound');
  });
  it('keeps missing/unsupported produced files insufficient, not a successful text-only result', async () => {
    const { records, content } = await completed([path.join(root, 'missing.md'), path.join(root, 'unsupported.pdf')]);
    await expect(content.readExecutionResultContent('user-a', await records.read('user-a', 'turn-task-a'))).rejects.toThrow('incomplete');
  });
  it('retains the original pure-text contract for old records without inventing file associations', async () => {
    const records = await import('../../../../src/main/features/execution-records');
    const { readExecutionResultContent } = await import('../../../../src/main/features/recall/execution-result-content');
    await records.create('user-a', { executionId: 'legacy-a', kind: 'core-agent', sessionId: 'old-a', boundary: 'real', permissionMode: 'read-only' });
    const record = await records.complete('user-a', 'legacy-a', { status: 'completed', output: 'Existing text result.' });
    expect(await readExecutionResultContent('user-a', record)).toEqual({ text: 'Existing text result.', refs: [], coverage: { complete: true, totalFiles: 0, readableFiles: 0 } });
  });
});
