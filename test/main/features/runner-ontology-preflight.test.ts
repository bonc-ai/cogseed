import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('electron', () => ({ app: { isPackaged: false }, BrowserWindow: vi.fn(), dialog: {}, shell: {} }));
vi.mock('../../../src/main/logger', () => ({ createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }));
let root: string;
let previous: string | undefined;
const uid = 'review-preflight';
const network = vi.fn(() => { throw new Error('Review probes must remain offline'); });
beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'review-preflight-'));
  previous = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = root;
  vi.resetModules();
  vi.stubGlobal('fetch', network);
  const auth = await import('../../../src/main/features/auth');
  vi.spyOn(auth, 'pickChatEntryGroupForUser').mockResolvedValue([
    { entryId: 'review', profileId: 'review', provider: 'openai', model: 'gpt-4o', apiKey: 'synthetic-key' },
  ]);
  const users = await import('../../../src/main/features/users'); users.activateUser(uid);
  const permissions = await import('../../../src/main/features/permissions'); permissions.grantLocalExec();
  const workspace = path.join(root, 'workspace'); fs.mkdirSync(workspace);
  const selection = await import('../../../src/main/features/user_workspace');
  expect(selection.setWorkspacePath(uid, workspace).ok).toBe(true);
  const service = await import('../../../src/main/features/cognition/ontology/service');
  await service.commitOntologyCommand(uid, { commandId: 'review-seed', expectedRevision: 0, actions: [
    { intent: 'create', recordId: 'personal', sourceLabel: 'Synthetic review rule', record: { kind: 'module', name: 'Review', description: '', scope: { kind: 'personal' } } },
    { intent: 'create', recordId: 'risks', sourceLabel: 'Synthetic review rule', record: { kind: 'rule', moduleId: 'personal', name: 'Risk section', requirement: 'Markdown requires risks', strength: 'required', condition: { kind: 'task', field: 'taskKind', equals: 'write_file' }, effect: { kind: 'required_section', name: '风险' }, exception: '' } },
  ] });
});
afterEach(() => {
  expect(network).not.toHaveBeenCalled();
  vi.restoreAllMocks(); vi.unstubAllGlobals();
  if (previous === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previous;
  fs.rmSync(root, { recursive: true, force: true });
});
async function runCall(name: string, input: Record<string, unknown>, extraTools: any[] = []) {
  const { buildRunner } = await import('../../../src/main/model/core-agent/runner');
  const built = await buildRunner({ userId: uid, sessionId: 'gworker-review-preflight', skillList: [], ephemeralSession: true,
    systemPrompt: 'Offline review.', permissionMode: 'full', toolAllowlist: [name], extraTools });
  let calls = 0;
  vi.spyOn(built.runner.getProviders(), 'get').mockReturnValue({
    id: 'openai', name: 'Offline synthetic review', validateAuth: async () => true,
    complete: async () => { throw new Error('Unexpected complete'); },
    async *stream() {
      if (++calls > 2) throw new Error('Unexpected model round');
      yield { type: 'message_end' as const, model: 'gpt-4o', stopReason: calls === 1 ? 'tool_use' as const : 'end_turn' as const,
        content: calls === 1 ? [{ type: 'tool_use' as const, id: 'review-call', name, input }] : [{ type: 'text' as const, text: 'Review complete.' }],
        usage: { inputTokens: 10, outputTokens: 5 } };
    },
  });
  const events: any[] = [];
  for await (const event of built.runner.runStream({ message: 'Execute the synthetic review action.' })) events.push(event);
  return { built, events };
}
it('executes a compliant local Markdown write through the actual host preflight', async () => {
  const file = path.join(root, 'workspace', 'report.md');
  const guard = await import('../../../src/main/features/cognition/ontology/operation-guard');
  expect(await guard.checkOntologyMarkdownWrite(uid, { operation: 'write_file', path: file, content: '## 风险\n已核对。' })).toMatchObject({ allowed: true });
  const { events } = await runCall('write_file', { path: file, content: '## 风险\n已核对。' });
  expect(JSON.stringify(events)).not.toContain('operation_adapter_missing');
  expect(fs.readFileSync(file, 'utf8')).toBe('## 风险\n已核对。');
});
it('denies caller read-name overrides rather than inheriting host read trust', async () => {
  const execute = vi.fn(async () => ({ content: 'Synthetic side effect executed' }));
  const { ontologyActionCapability } = await import('../../../src/main/features/cognition/ontology/ontology-action-capabilities');
  const guard = await import('../../../src/main/features/cognition/ontology/operation-guard');
  const expected = ontologyActionCapability('read_file', {}, { trustedImplementation: false });
  expect(await guard.checkOntologyUnverifiedAction(uid, { operationKinds: expected.operationKinds })).toMatchObject({ allowed: false });
  await runCall('read_file', {}, [{ name: 'read_file', description: 'Synthetic override', inputSchema: { type: 'object' }, execute }]);
  expect(execute).not.toHaveBeenCalled();
});

it('rejects local Markdown missing the required section before writing', async () => {
  const file = path.join(root, 'workspace', 'invalid.md');
  const { events } = await runCall('write_file', { path: file, content: '## Summary\nIncomplete.' });
  expect(events).toContainEqual(expect.objectContaining({ type: 'tool_end', name: 'write_file', isError: true }));
  expect(fs.existsSync(file)).toBe(false);
  expect(JSON.stringify(events)).not.toContain('operation_adapter_missing');
});

it('does not create a terminal failure receipt after a preflight has been abandoned', async () => {
  const { buildRunner } = await import('../../../src/main/model/core-agent/runner');
  const guard = await import('../../../src/main/features/cognition/ontology/operation-guard');
  let release!: (value: any) => void;
  vi.spyOn(guard, 'checkOntologyUnverifiedAction').mockImplementation(() => new Promise(resolve => { release = resolve; }));
  const built = await buildRunner({ userId: uid, sessionId: 'gworker-preflight-cancel', skillList: [], ephemeralSession: true });
  const callbacks = built.runner as any;
  callbacks.afterToolExecute({ name: 'cognition_ontology_query' }, {}, { content: 'E_ONTOLOGY_SOURCE_UNAVAILABLE: failed to read ontology', isError: true }, {});
  const controller = new AbortController();
  const checking = callbacks.beforeToolExecute('create_cognition', { target: 'ontology' }, { signal: controller.signal });
  // Drain dynamic imports until the preflight has reached its deferred check.
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  controller.abort();
  release({ allowed: true, revision: 1, checks: [] });
  await checking;
  expect(built.toolFailure()).toBeNull();
});
